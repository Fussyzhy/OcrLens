/**
 * Promo animation renderer.
 *
 * Renders `build/stage/` frame by frame off a virtual clock and encodes the
 * frames to mp4. This is a different instrument from `make-video.cjs`:
 *
 *   make-video.cjs   drives the real app through real clicks and records what
 *                    the compositor shows. Timing is measured after the fact and
 *                    conformed with `setpts`, because a capture loop cannot hit
 *                    an exact frame rate.
 *   make-promo.cjs   draws every frame itself. Frame N *is* time N/fps, so there
 *                    is no capture rate to reconcile, no dropped frame, and no
 *                    drift. The trade-off is that the motion has to be authored
 *                    rather than performed.
 *
 * Frames are pulled from an offscreen window's `paint` event, which hands over
 * the composited bitmap directly — no PNG encode, no capture round-trip. The
 * window is created at 2x device scale so that when the 1440x920 stage is scaled
 * up to 1920x1080, text is still rendered from native pixels rather than
 * magnified ones. That is the reason to animate in code at all.
 *
 * Usage:
 *   node scripts/make-promo.cjs
 *   node scripts/make-promo.cjs --beat explosion --fps 30 --scale 2
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { app, BrowserWindow } = require('electron')

const FFMPEG = process.env.PROMO_FFMPEG ?? 'C:\\msys64\\mingw64\\bin\\ffmpeg.exe'
const STAGE_DIR = path.join(__dirname, '..', 'build', 'stage')
const OUT_DIR = path.join(__dirname, '..', 'smoke-out', 'promo')

/**
 * Publication sizes.
 *
 * The stage is the offscreen window, and the window is clamped to the display
 * work area (measured: 1920x1032 here, the screen minus the taskbar). A vertical
 * stage therefore cannot be taller than 1032 — and rendering a *smaller* vertical
 * stage and blowing it up to 1080x1920 would magnify everything, which is the one
 * thing this renderer exists to avoid.
 *
 * So the vertical cut is rendered rotated. The window stays landscape, the canvas
 * is drawn sideways, and the encoder rotates it back. The result is native
 * resolution in both orientations instead of one sharp cut and one soft one.
 *
 * `draw` is the coordinate space the stage composes in — it is the window with
 * width and height swapped when `rotate` is set. `k` inside the stage is derived
 * from `draw.w`, so the composition scales to each cut automatically.
 */
const ASPECTS = {
  '16x9': { out: [1920, 1080], window: [1920, 1032], rotate: false },
  '9x16': { out: [1080, 1920], window: [1920, 1032], rotate: true }
}

/** Clockwise rotation applied by the encoder when a cut is rendered rotated. */
const ROTATE_FILTER = 'transpose=1'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const BEAT = arg('beat', 'explosion')
const FPS = Number(arg('fps', '30'))
const ASPECT_ARG = arg('aspect', 'both')
/** Diagnostic run: one marked frame per cut, as a PNG, instead of the video. */
const diag = process.argv.includes('--diag')
const ALL = process.argv.includes('--all')

const log = (msg) => console.log(`[promo] ${msg}`)

/** The beats this renderer knows. Each is a stage page plus a frame count. */
const BEATS = {
  explosion: { dir: '.', frames: 150, note: 'terminal prints findings, they scatter, they become 389' }
}

function ffmpegAvailable() {
  if (!fs.existsSync(FFMPEG)) return `ffmpeg not found at ${FFMPEG} (set PROMO_FFMPEG)`
  const probe = spawnSync(FFMPEG, ['-hide_banner', '-version'], { encoding: 'utf8' })
  if (probe.status !== 0) return `ffmpeg failed to start: ${probe.stderr?.slice(0, 200)}`
  return (probe.stdout || '').split('\n')[0].trim()
}

/**
 * Loads the stage page, retrying once.
 *
 * Loading the same file:// page into a second window in the same process fails
 * with ERR_FAILED if the previous window has only just been destroyed, so a
 * single retry after a beat is what lets both cuts render in one run.
 */
async function loadStage(wc, file, attempts = 4) {
  let last
  for (let i = 0; i < attempts; i++) {
    try {
      await wc.loadFile(file)
      return
    } catch (err) {
      last = err
      log(`stage load attempt ${i + 1} failed (${err.message}); retrying`)
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }
  throw last
}

/**
 * Renders one beat in every requested aspect.
 *
 * One window serves all of the beat's cuts, and it is destroyed only once they
 * are all done. That is not tidiness: destroying an offscreen window corrupts the
 * GPU process in this Electron version (`GPU state invalid after
 * WaitForGetOffsetInRange`), after which the next window cannot load a page at
 * all — the failure surfaces as a bare ERR_FAILED on the following load. A single
 * window per beat sidesteps it entirely.
 *
 * The window is sized to whatever it actually reports rather than what was asked
 * for, because an offscreen window silently clamps to the display work area
 * (every request above 1920x1032 here measured back as 1920x1032). Sizing the
 * canvas to the real bitmap keeps drawn and captured pixels in one-to-one
 * correspondence, so nothing is magnified on the way to the encoder — and for a
 * rotated cut the same guarantee holds, with the rotation doing the work of
 * turning a landscape bitmap into a portrait frame.
 */
async function renderBeat(name, beat, wanted) {
  const [winW, winH] = ASPECTS[wanted[0]].window

  // offscreen:true makes the window paint on demand and hand us the bitmap,
  // which is what makes a deterministic frame loop possible.
  const win = new BrowserWindow({
    width: winW,
    height: winH,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#050807',
    webPreferences: {
      offscreen: true,
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  const wc = win.webContents
  wc.setFrameRate(FPS)
  if (typeof wc.setBackgroundThrottling === 'function') wc.setBackgroundThrottling(false)

  const size = win.getContentSize()
  const raw = { w: size[0], h: size[1] }
  if (raw.w !== winW || raw.h !== winH) {
    log(`note: window clamped ${winW}x${winH} -> ${raw.w}x${raw.h}; drawing at the clamped size`)
  }

  const results = []
  try {
    await loadStage(wc, path.join(STAGE_DIR, beat.dir, 'index.html'))
    for (const key of wanted) {
      results.push(await renderAspect(wc, raw, name, beat, key, ASPECTS[key]))
    }
  } finally {
    win.destroy()
  }
  return results
}

/**
 * Renders one cut of one beat through an already-loaded window and writes
 * `<beat>-<aspect>.mp4`.
 *
 * The encoder reads raw BGRA on stdin at a fixed size, so it has to be told that
 * size up front; everything downstream of that is a straight copy of what the
 * stage drew.
 */
async function renderAspect(wc, raw, name, beat, aspectKey, aspect) {
  const frames = diag ? 1 : beat.frames
  const outFile = path.join(OUT_DIR, diag ? `_diag-${aspectKey}.png` : `${name}-${aspectKey}.mp4`)
  const [outW, outH] = aspect.out
  const rotate = Boolean(aspect.rotate)

  // The space the stage composes in. A rotated cut swaps the axes so the
  // composition is authored portrait while the bitmap underneath stays landscape.
  const draw = rotate ? { w: raw.h, h: raw.w } : { w: raw.w, h: raw.h }
  // The frame the encoder receives, after any rotation. For a rotated cut that is
  // the window's shape turned on its side, so the scale step has to be told the
  // rotated shape: using the pre-rotation size made `force_original_aspect_ratio`
  // letterbox a landscape frame into a portrait one and produce 1032x1920 instead
  // of 1080x1920.
  const enc = rotate ? { w: raw.h, h: raw.w } : { w: raw.w, h: raw.h }
  log(
    `rendering '${name}' ${aspectKey}: ${frames} frames @ ${FPS}fps, ` +
      `bitmap ${raw.w}x${raw.h}, draw ${draw.w}x${draw.h}${rotate ? ' rotated' : ''} -> ${outW}x${outH}`
  )

  const info = await wc.executeJavaScript(
    `window.stageInstall(${JSON.stringify({ w: draw.w, h: draw.h, rotate })})`
  )
  log(`stage reports ${JSON.stringify(info)}`)
  // A still can lie about this — dim text on black reads as narrower than it is —
  // so the spread is measured rather than eyeballed.
  const field = await wc.executeJavaScript('window.__fieldStats()')
  log(`field spread ${JSON.stringify(field)}`)

  const ff = spawn(
    FFMPEG,
    diag
      ? [
          '-hide_banner', '-loglevel', 'error',
          '-f', 'rawvideo', '-pixel_format', 'bgra', '-video_size', `${raw.w}x${raw.h}`,
          '-framerate', String(FPS), '-i', 'pipe:0',
          '-vf', rotate ? ROTATE_FILTER : 'null',
          '-frames:v', '1', '-y', outFile
        ]
      : [
          '-hide_banner', '-loglevel', 'error',
          '-f', 'rawvideo',
          '-pixel_format', 'bgra',
          '-video_size', `${raw.w}x${raw.h}`,
          '-framerate', String(FPS),
          '-i', 'pipe:0',
          '-vf',
          [
            // Rotate first so the padding is applied in the final orientation, then
            // fit into the publication frame without ever stretching it.
            rotate ? ROTATE_FILTER : null,
            `scale=${outW}:${outH}:force_original_aspect_ratio=decrease:flags=lanczos`,
            `pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=0x050807`,
            // x264 needs even dimensions; libx264 rejects odd ones outright.
            'scale=trunc(iw/2)*2:trunc(ih/2)*2'
          ]
            .filter(Boolean)
            .join(','),
          '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
          '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
          '-y', outFile
        ],
    { stdio: ['pipe', 'inherit', 'inherit'] }
  )

  let ffError = null
  ff.on('error', (err) => { ffError = err })
  const encoderDone = new Promise((resolve) => {
    ff.on('close', (code) => resolve(code))
  })

  /**
   * Captures exactly one composited frame.
   *
   * The handler is attached before the paint is requested, so there is no window
   * in which the event could arrive unattended. `paint` fires once per
   * `setFrameRate` tick while the window is dirty, which is exactly the
   * granularity needed: set the clock, ask for a paint, take the bitmap.
   */
  let pending = null
  const onPaint = (_event, _dirty, image) => {
    if (!pending) return
    const done = pending
    pending = null
    done(image)
  }
  wc.on('paint', onPaint)

  function nextPaint(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending === take) pending = null
        reject(new Error('timed out waiting for a paint event'))
      }, timeoutMs)
      function take(image) {
        clearTimeout(timer)
        resolve(image)
      }
      pending = take
    })
  }

  const started = Date.now()
  let bytes = 0
  let firstFrameMs = null

  try {
    for (let f = 0; f < frames; f++) {
      await wc.executeJavaScript(`window.frame(${diag ? 'null' : f})`)
      const image = await nextPaint()
      const buf = typeof image.toBitmap === 'function' ? image.toBitmap() : image.getBitmap()
      if (f === 0) {
        firstFrameMs = Date.now() - started
        const actual = `${image.getSize().width}x${image.getSize().height}`
        if (actual !== `${raw.w}x${raw.h}`) {
          throw new Error(`bitmap is ${actual}, expected ${raw.w}x${raw.h}`)
        }
      }
      bytes += buf.length
      if (!ff.stdin.write(buf)) {
        await new Promise((resolve) => ff.stdin.once('drain', resolve))
      }
      if ((f + 1) % 30 === 0) {
        const secs = (Date.now() - started) / 1000
        log(`  ${f + 1}/${frames} frames, ${((f + 1) / secs).toFixed(1)} fps render rate`)
      }
    }
  } finally {
    wc.removeListener('paint', onPaint)
  }

  ff.stdin.end()
  const code = await encoderDone
  const elapsed = (Date.now() - started) / 1000

  if (ffError) throw ffError
  if (code !== 0) throw new Error(`ffmpeg exited ${code} for ${aspectKey}`)

  const stat = fs.statSync(outFile)
  log(
    `wrote ${path.basename(outFile)} — ${frames} frames in ${elapsed.toFixed(1)}s ` +
      `(${(frames / elapsed).toFixed(1)} fps render rate, first frame ${firstFrameMs}ms, ` +
      `${(stat.size / 1024 / 1024).toFixed(2)} MB, ${(bytes / 1024 / 1024).toFixed(1)} MB piped)`
  )

  return { outFile, aspectKey, frames, elapsed, bytes }
}

async function main() {
  const version = ffmpegAvailable()
  if (version.startsWith('ffmpeg not found') || version.startsWith('ffmpeg failed')) {
    throw new Error(version)
  }
  log(version)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const beat = BEATS[BEAT]
  if (!beat) throw new Error(`unknown beat '${BEAT}'; known: ${Object.keys(BEATS).join(', ')}`)

  const wanted = ASPECT_ARG === 'both' ? Object.keys(ASPECTS) : [ASPECT_ARG]
  for (const key of wanted) {
    if (!ASPECTS[key]) {
      throw new Error(`unknown aspect '${key}'; known: ${Object.keys(ASPECTS).join(', ')}, both`)
    }
  }

  // The acceptance check for this renderer: frame count and duration must be
  // exact, because that is the entire promise of a virtual clock.
  const ffprobe = FFMPEG.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'))
  const expected = beat.frames / FPS

  const results = await renderBeat(BEAT, beat, wanted)

  for (const result of results) {
    if (diag || !fs.existsSync(ffprobe)) continue

    const probe = spawnSync(
      ffprobe,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=nb_frames,width,height,avg_frame_rate',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1',
        result.outFile
      ],
      { encoding: 'utf8' }
    )
    const fields = Object.fromEntries(
      (probe.stdout || '')
        .split('\n')
        .map((line) => line.split('='))
        .filter((pair) => pair.length === 2)
        .map(([pairKey, v]) => [pairKey.trim(), v.trim()])
    )
    const actual = Number(fields.duration)
    const drift = actual - expected
    log(
      `${result.aspectKey} verify: ${fields.width}x${fields.height} ${fields.avg_frame_rate} ` +
        `nb_frames=${fields.nb_frames} duration=${actual.toFixed(3)}s ` +
        `expected=${expected.toFixed(3)}s drift=${drift >= 0 ? '+' : ''}${drift.toFixed(3)}s`
    )
    const wantW = ASPECTS[result.aspectKey].out[0]
    const wantH = ASPECTS[result.aspectKey].out[1]
    const sizeOk = Number(fields.width) === wantW && Number(fields.height) === wantH
    if (Number(fields.nb_frames) !== beat.frames || Math.abs(drift) > 0.02 || !sizeOk) {
      log(`FAIL: ${result.aspectKey} does not match the timeline — the virtual clock is not exact`)
      process.exitCode = 1
    } else {
      log(`OK: ${result.aspectKey} is ${wantW}x${wantH}, frame count and duration match exactly`)
    }
  }
}

app.disableHardwareAcceleration()
app.whenReady().then(() =>
  main().then(
    () => app.exit(process.exitCode ?? 0),
    (err) => {
      console.error('[promo] FATAL', err && err.stack ? err.stack : err)
      app.exit(1)
    }
  )
)
