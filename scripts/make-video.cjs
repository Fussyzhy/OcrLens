/**
 * Operation-video recorder.
 *
 * Records the app's own window into mp4 by driving a real, visible window with
 * scripted clicks, a drawn-in mouse cursor, click rings and burned-in captions.
 *
 * Why not just use OBS
 * --------------------
 * The existing probes drive the renderer with `element.click()`, which is a
 * synthetic event: no OS cursor moves, so a screen recorder captures the UI
 * changing on its own. Rather than fight that, this script draws its own cursor
 * and therefore gets three things a manual recording cannot:
 *
 *   1. the cursor is always exactly where the click happens (it is derived from
 *      the target's own getBoundingClientRect, not from hand-aimed mouse moves)
 *   2. the same take can be re-recorded after any UI change, predictably
 *   3. privacy masking is part of the take rather than a manual blur pass, and
 *      captions are burned in from the recorder's own timeline
 *
 * How frames are obtained
 * -----------------------
 * `Page.startScreencast` was tried first and rejected: it re-delivers the same
 * frame about three times before the compositor produces a new one, and
 * `screencastFrameAck` does not suppress the duplicates. Since the frame count
 * was being treated as time, every take came out exactly three times too long.
 * Frames are therefore pulled with `capturePage()`, as fast as ffmpeg accepts
 * them (~39 fps idle, ~31 fps while driving the UI, because the encoder's stdout
 * backpressure throttles the loop).
 *
 * Because that rate is workload-dependent, it is **not** used as the frame rate.
 * The real duration is measured while recording and the take is stretched onto
 * it with `setpts` afterwards, so the video always plays at the speed the
 * operator saw. Both are reported and checked after every scene.
 *
 * Usage:
 *   yarn video                      # builds, then records all scenes in 16:9 + 9:16
 *   VIDEO_SCENES=results yarn video
 *
 * Environment:
 *   VIDEO_SCENES=overview,results   only these scenes (default: all)
 *   VIDEO_FPS=25                    output frame rate (does not change pacing)
 *   VIDEO_REPO=<substring>          which repository to drive (default: first row)
 *   VIDEO_REDACT=0                  show repository/session names unmasked
 *                                   (default 1: masked, so a recording never
 *                                   leaks a private project name)
 *   VIDEO_KEEP_FRAMES=1             also write last-frame.png, the exact buffer
 *                                   handed to ffmpeg (for mask debugging)
 *   VIDEO_FFMPEG=<path>             ffmpeg binary
 *
 * Artifacts land in smoke-out/video/:
 *
 *   {scene}.mp4        the raw capture, in the window's own pixel size. Not
 *                      disposable: the full-length cut is concatenated from
 *                      these, so deleting them breaks `full-*` until a re-run.
 *   {scene}-16x9.mp4   the cut to publish, captions burned in
 *   {scene}-9x16.mp4   the same take for phone feeds, separately styled
 *   full-16x9.mp4      every scene in order, when more than one was recorded
 *   full-9x16.mp4
 *   *.ass              the caption tracks that were burned in
 *   video-report.json  per-scene real vs. output duration, fps, caption count
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { app, BrowserWindow } = require('electron')

const FFMPEG = process.env.VIDEO_FFMPEG ?? 'C:\\msys64\\mingw64\\bin\\ffmpeg.exe'
const REPO_MATCH = process.env.VIDEO_REPO ?? ''
const REDACT = process.env.VIDEO_REDACT !== '0'

// The output frame rate. It is a presentation choice, not a pacing promise: the
// take is conformed to the measured real duration afterwards, so this number
// never changes how fast the video plays.
const FPS = Math.max(15, Number(process.env.VIDEO_FPS ?? 25) || 25)

const OUT_DIR = path.join(__dirname, '..', 'smoke-out', 'video')
fs.mkdirSync(OUT_DIR, { recursive: true })

// Writes the exact PNG buffer last handed to ffmpeg, alongside periodic mask
// counts. Used when the pixels and the DOM disagree, which they did: the DOM
// reported the mask applied while the frame still showed the name.
const KEEP_FRAMES = process.env.VIDEO_KEEP_FRAMES === '1'

/**
 * What gets masked out of a take, by default.
 *
 * This is the static half. The dynamic half is built from the client's own data
 * at record time (`dynamicMaskSelectors`) and covers views whose class names are
 * not listed here: the home page's recent-review list reused neither
 * `.repo-name` nor `.session-name`, so a class-only mask left a real project name
 * and a real session title on screen in the first take of the home page.
 *
 * The path in `.run-live-command` and the log lines matter as much as the name:
 * they carry the repository's full location.
 */
const MASK_SELECTORS = [
  '.repo-name',
  '.session-name',
  '.search-hit',
  '.view-head .sub',
  '.view-head h1',
  '.run-live-command',
  '.log-line',
  '.snippet-note code',
  '.findings-grid',
  '.finding-content',
  '.finding-lines',
  '.summary-bar',
  '.home-list',
  '.home-item',
  '.home-item-title',
  '.home-item-meta'
]

/** Never negative: a negative duration makes Node warn and clamp to 1ms. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(ms))))

function log(message) {
  console.log(`[video] ${message}`)
}

/* ------------------------------------------------------------------ *
 * ffmpeg helpers
 * ------------------------------------------------------------------ */

function ffmpegAvailable() {
  const probe = spawnSync(FFMPEG, ['-hide_banner', '-version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) {
    throw new Error(`ffmpeg not usable at ${FFMPEG} (set VIDEO_FFMPEG): ${probe.error ?? probe.status}`)
  }
  return (probe.stdout ?? '').split('\n')[0].trim()
}

function ffprobePath() {
  const beside = path.join(path.dirname(FFMPEG), 'ffprobe.exe')
  return fs.existsSync(beside) ? beside : 'ffprobe'
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], cwd })
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))))
  })
}

function probeValue(file, args) {
  const res = spawnSync(ffprobePath(), ['-v', 'error', ...args, file], { encoding: 'utf8' })
  if (res.error || res.status !== 0) return null
  const value = Number((res.stdout ?? '').trim())
  return Number.isFinite(value) ? value : null
}

/** Duration in seconds, or null when ffprobe cannot read the file. */
function probeDuration(file) {
  return probeValue(file, ['-show_entries', 'format=duration', '-of', 'csv=p=0'])
}

/** Frame count of a take, needed to conform it to the measured duration. */
function probeFrameCount(file) {
  return probeValue(file, [
    '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0'
  ])
}

/**
 * Frame-count-to-duration factor for `setpts`.
 *
 * The raw take is written at `fps`, so its frame count implies a duration of
 * `frames / fps`. The measured real duration divided by that gives the factor
 * that puts the take back onto wall-clock time.
 */
function conformFactor(src, fps, realSeconds) {
  const frames = probeFrameCount(src)
  if (!frames || !realSeconds) {
    log('warning: could not read the raw frame count; passing the take through unchanged')
    return 1
  }
  return realSeconds / (frames / fps)
}

/* ------------------------------------------------------------------ *
 * Frame capture
 * ------------------------------------------------------------------ */

/**
 * Pulls frames from the window and pipes them to ffmpeg.
 *
 * Time starts at `begin()`, which is when the scene starts, so caption times and
 * the measured real duration share one origin.
 */
class FrameWriter {
  constructor(enc) {
    this.enc = enc
    this.t0Ms = null
    this.captured = 0
    this.written = 0
    this.errors = []
    this.lastPng = null
    enc.stdin.on('error', (err) => this.errors.push(String(err && err.message ? err.message : err)))
  }

  begin() {
    this.t0Ms = Date.now()
  }

  now() {
    return this.t0Ms === null ? null : (Date.now() - this.t0Ms) / 1000
  }

  async capture(win) {
    const image = await win.webContents.capturePage()
    const png = image.toPNG()
    if (png.length) {
      this.lastPng = png
      this.captured++
      return png
    }
    return this.lastPng
  }

  async write(png) {
    if (!png) return
    if (this.enc.stdin.destroyed || this.enc.stdin.writableEnded) return
    const ok = this.enc.stdin.write(png)
    this.written++
    if (!ok) await new Promise((resolve) => this.enc.stdin.once('drain', resolve))
  }

  stats(realSeconds) {
    return {
      captured: this.captured,
      written: this.written,
      realSeconds: Number(realSeconds.toFixed(2)),
      fpsAchieved: realSeconds > 0 ? Number((this.captured / realSeconds).toFixed(1)) : 0
    }
  }

  async finish() {
    await new Promise((resolve) => {
      if (this.enc.stdin.destroyed || this.enc.stdin.writableEnded) return resolve()
      this.enc.stdin.end(resolve)
    })
    await new Promise((resolve) => this.enc.on('close', resolve))
  }
}

/* ------------------------------------------------------------------ *
 * Recorder
 * ------------------------------------------------------------------ */

class Recorder {
  constructor(win) {
    this.win = win
    this.wc = win.webContents
    this.captions = []
    this.writer = null
    this.fps = FPS
    this.cursor = { x: 0, y: 0 }
  }

  /* ---- overlay injection ---- */

  async install() {
    await this.wc.executeJavaScript(`(() => {
      const REDACT = ${REDACT};

      const root = document.createElement('div');
      root.id = 'video-overlay';
      root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;'
        + 'font-family:system-ui,-apple-system,"Segoe UI",sans-serif';
      root.innerHTML = \`
        <style>
          #video-overlay .vo-cursor {
            position:absolute; left:0; top:0; width:26px; height:26px;
            transform:translate(-100px,-100px);
            filter:drop-shadow(0 2px 6px rgba(0,0,0,.85));
          }
          #video-overlay .vo-ring {
            position:absolute; left:0; top:0; width:14px; height:14px; margin:-7px 0 0 -7px;
            border:3px solid #2bde5e; border-radius:50%; opacity:0;
          }
          #video-overlay .vo-ring.go { animation: vo-ring .55s ease-out 1; }
          @keyframes vo-ring {
            0%   { opacity:.95; transform:scale(.4); }
            100% { opacity:0;   transform:scale(3.4); }
          }
        </style>
        <style id="vo-mask-style">
          /* Deliberately NOT scoped to #video-overlay: the elements being masked
             belong to the application, not to the overlay. Scoping this rule to
             the overlay is why an earlier take recorded the mask applied and the
             name still perfectly readable — the rule simply never matched.
             CSS is also the only part of the mask that Vue cannot undo: it stays
             in effect until the class is removed, whatever re-renders happen in
             between, unlike a substituted text node which a patch overwrites. */
          .vo-mask {
            background:#0d1410 !important; color:transparent !important;
            text-shadow:none !important; user-select:none; pointer-events:none;
            filter:blur(6px); border-radius:4px; box-decoration-break:clone;
          }
        </style>
        <div class="vo-ring"></div>
        <svg class="vo-cursor" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 2 L4 20.5 L9.1 15.7 L12.3 22.4 L15.2 21 L12 14.4 L18.6 14.2 Z"
                fill="#ffffff" stroke="#0b0f0c" stroke-width="1.4" stroke-linejoin="round"/>
        </svg>
      \`;
      document.body.appendChild(root);

      window.__vo = {
        root,
        cursor: root.querySelector('.vo-cursor'),
        ring: root.querySelector('.vo-ring'),

        move(x, y) {
          this.cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
        },
        ripple(x, y) {
          this.ring.style.left = x + 'px';
          this.ring.style.top = y + 'px';
          this.ring.classList.remove('go');
          void this.ring.offsetWidth;
          this.ring.classList.add('go');
        },
        // Captions are deliberately NOT drawn in the page. Both cuts render from
        // one raw take, so a caption in the DOM ends up in both, and the vertical
        // cut would then show it alongside its own burned-in one. They are burned
        // in afterwards from the timing the recorder collects.
        say() {},
        hush() {},

        centerOf(selector, index) {
          const nodes = [...document.querySelectorAll(selector)];
          const el = index === undefined ? nodes[0] : nodes[index];
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
                   w: Math.round(r.width), h: Math.round(r.height), text: (el.innerText || '').trim().slice(0, 60) };
        },
        click(selector, index) {
          const nodes = [...document.querySelectorAll(selector)];
          const el = index === undefined ? nodes[0] : nodes[index];
          if (!el) return false;
          el.click();
          return true;
        },
        exists(selector) { return !!document.querySelector(selector); },
        scrollBy(dy) {
          const scroller = document.querySelector('.view-body') || document.scrollingElement;
          if (!scroller) return false;
          scroller.scrollBy({ top: dy, behavior: 'auto' });
          return true;
        },
        // Masks are applied to text nodes, not whole elements: masking a leaf
        // element leaves a row like ".home-item-meta" readable whenever only
        // some of its text nodes live in masked children.
        maskTextNodes(selectors) {
          let n = 0;
          const walk = (el) => {
            for (const node of [...el.childNodes]) {
              if (node.nodeType === 3) {
                if (!node.textContent.trim()) continue;
                const span = document.createElement('span');
                span.className = 'vo-mask';
                span.textContent = node.textContent;
                el.replaceChild(span, node);
                n++;
              } else if (node.nodeType === 1) {
                if (node.classList && node.classList.contains('vo-mask')) continue;
                walk(node);
              }
            }
          };
          for (const sel of selectors) {
            for (const el of document.querySelectorAll(sel)) {
              if (el.classList.contains('vo-mask')) continue;
              walk(el);
            }
          }
          return n;
        },

        // Masks the smallest element whose text contains each given string.
        // Superseded by maskLiterals, which walks the whole tree.
        // Masks every text node that contains one of the given strings. Kept
        // independent of class names on purpose: a name on screen is by
        // definition one of these strings, so this cannot miss a view the way a
        // selector list can.
        maskLiterals(values) {
          if (!values || !values.length) return 0;
          let n = 0;
          const walk = (el) => {
            for (const node of [...el.childNodes]) {
              if (node.nodeType === 3) {
                const text = node.textContent || '';
                if (!values.some((v) => text.includes(v))) continue;
                if (!text.trim()) continue;
                const span = document.createElement('span');
                span.className = 'vo-mask';
                span.textContent = text;
                el.replaceChild(span, node);
                n++;
              } else if (node.nodeType === 1) {
                if (node.classList && node.classList.contains('vo-mask')) continue;
                walk(node);
              }
            }
          };
          walk(document.body);
          return n;
        },

        // Reports whether any secret string is still readable. Looks at direct
        // text nodes, so an element whose children are masked is not reported as
        // a leak merely because its textContent still concatenates to a secret.
        auditMask(values) {
          const leaks = [];
          for (const value of values) {
            for (const el of document.querySelectorAll('body *')) {
              if (el.closest('.vo-mask')) continue;
              const text = [...el.childNodes]
                .filter((n) => n.nodeType === 3)
                .map((n) => n.textContent)
                .join('');
              if (!text.includes(value)) continue;
              leaks.push({
                tag: el.tagName,
                cls: (el.className || '').toString().slice(0, 50),
                sample: text.trim().slice(0, 40)
              });
            }
          }
          return leaks;
        },
        maskStats(selectors) {
          const out = {};
          for (const sel of selectors) {
            const els = [...document.querySelectorAll(sel)];
            out[sel] = {
              elements: els.length,
              leaves: els.filter(e => !e.children.length).length,
              unmasked: els.filter(e => !e.classList.contains('vo-mask')
                && !e.querySelector('.vo-mask')).length
            };
          }
          return out;
        }
      };
      return true;
    })()`)

    // Mask the names that would leak a private project. The default is on: a
    // recording is meant to be publishable without a second pass.
    if (REDACT) {
      await this.buildMaskLiterals()
      // Order matters: the secret set must exist before the masker reads it, and
      // the masker must be armed before the first frame is captured.
      await this.watchForNewLiterals()
      await this.armMasker()
      log(`mask coverage: ${JSON.stringify(await this.maskStats())}`)
      log(`masked: ${JSON.stringify(await this.maskNames())}`)
    }
  }

  /**
   * Installs an event-driven masker inside the page.
   *
   * The polling interval alone is not enough. Vue patches a text node by writing
   * `textContent`, which deletes a substituted mask span outright, and until the
   * next poll the name is fully readable — the frame handed to the encoder was
   * exactly such a gap. A MutationObserver re-marks as soon as the DOM changes,
   * so a re-render cannot open a window at all. The stylesheet does the actual
   * hiding, so marking is idempotent and cheap.
   */
  async armMasker() {
    const selectors = MASK_SELECTORS
    return this.wc.executeJavaScript(`(() => {
      const apply = () => {
        const values = window.__voSecrets ? [...window.__voSecrets] : [];
        window.__vo.maskTextNodes(${JSON.stringify(selectors)});
        window.__vo.maskLiterals(values);
      };
      window.__voMaskApply = apply;
      apply();
      if (window.__voObserver) window.__voObserver.disconnect();
      let pending = false;
      window.__voObserver = new MutationObserver(() => {
        if (pending) return;
        pending = true;
        Promise.resolve().then(() => { pending = false; apply(); });
      });
      window.__voObserver.observe(document.body, {
        childList: true, subtree: true, characterData: true
      });
      return true;
    })()`)
  }

  /**
   * Keeps the literal list growing as the app renders new text.
   *
   * The list cannot be complete at install time. The review-configuration view
   * shows the exact command line it will run, which embeds the repository's full
   * path — text that does not exist until that view renders. Feeding the set from
   * the DOM means the mask does not depend on having anticipated every view.
   */
  async watchForNewLiterals() {
    const added = await this.wc.executeJavaScript(`(() => {
      window.__voSecrets = new Set(window.__voSecrets || []);
      const note = (text) => {
        const value = (text || '').trim();
        if (value.length < 3 || value.length > 60) return;
        // Only the first segment of a metadata line is a name; the rest is the
        // review mode and a relative timestamp, which are not secrets and would
        // make every other row's ordinary metadata look like a leak.
        const name = value.includes('·') ? value.split('·')[0].trim() : value;
        if (name.length >= 3) window.__voSecrets.add(name);
      };
      window.__voNoteSecret = note;
      const scan = () => {
        for (const sel of ['.view-head .sub', '.mono.muted', '.run-live-command']) {
          for (const el of document.querySelectorAll(sel)) note(el.textContent);
        }
      };
      scan();
      if (window.__voSecretObserver) window.__voSecretObserver.disconnect();
      window.__voSecretObserver = new MutationObserver(scan);
      window.__voSecretObserver.observe(document.body, { childList: true, subtree: true });
      return [...window.__voSecrets];
    })()`)
    this.maskStrings = [...new Set([...(this.maskStrings ?? []), ...(added ?? [])])]
    log(`secret observer armed; starting set: ${JSON.stringify(this.maskStrings)}`)
  }

  /** Everything the observer has collected so far. */
  async refreshMaskLiterals() {
    if (!REDACT) return this.maskStrings ?? []
    const collected = await this.wc.executeJavaScript(
      'window.__voSecrets ? [...window.__voSecrets] : []'
    )
    this.maskStrings = [...new Set([...(this.maskStrings ?? []), ...(collected ?? [])])]
    return this.maskStrings
  }


  /**
   * Applies both masks, idempotently.
   *
   * This has to be re-applied continuously rather than once: Vue patches a text
   * node in place when the bound value changes, so a mask applied on first render
   * is simply discarded the next time a list updates. A single application left
   * the repository name fully readable in the recorded take.
   */
  async maskNames() {
    if (!REDACT) return { byClass: 0, byLiteral: 0 }
    const selectors = MASK_SELECTORS
    // Pulled fresh each pass: the observer may have seen a new path since the
    // last one, and a stale list is exactly how a path leaks into a take.
    const literals = await this.refreshMaskLiterals()
    const [byClass, byLiteral] = await Promise.all([
      this.wc.executeJavaScript(`window.__vo.maskTextNodes(${JSON.stringify(selectors)})`),
      this.wc.executeJavaScript(`window.__vo.maskLiterals(${JSON.stringify(literals)})`)
    ])
    return { byClass, byLiteral, literals: literals.length }
  }

  async maskStats() {
    return this.wc.executeJavaScript(
      `window.__vo.maskStats(${JSON.stringify(MASK_SELECTORS)})`
    )
  }

  /** Any secret string still readable on screen, right now. */
  async auditMask() {
    if (!REDACT) return []
    const literals = await this.refreshMaskLiterals()
    return this.wc.executeJavaScript(`window.__vo.auditMask(${JSON.stringify(literals)})`)
  }

  /**
   * Collects the literals that must never appear in a take.
   *
   * Masking by class alone is a guessing game across views, and the home page
   * proved it: the leak there was a recent-review row whose classes the mask did
   * not know about. Matching on the actual repository names cannot miss a view,
   * because a name on screen is by definition one of these strings.
   *
   * The names are read from the rendered DOM rather than over IPC on purpose.
   * Calling `window.ocr.listRepos()` from here threw inside the app's own layout
   * code ("reading 'muted'"), because the rail's settings are not necessarily
   * bootstrapped yet. Waiting for the app to render and then reading the text it
   * rendered is both safer and a better definition of "what must not leak".
   */
  async buildMaskLiterals() {
    // Wait for the home view to have finished its own load, so the names below
    // are the ones actually on screen rather than an empty skeleton.
    await this.waitFor('.home-item-title, .repo-row, .empty', {
      timeoutMs: 60000,
      label: 'the application to finish loading'
    }).catch(() => log('warning: the app did not report a loaded view; masking what is present'))

    const literals = await this.wc.executeJavaScript(`(() => {
      const out = new Set();
      const push = (text) => {
        const value = (text || '').trim();
        // Long enough to be a name, short enough not to be a paragraph.
        if (value.length >= 3 && value.length <= 60) out.add(value);
      };
      // Repository and session names are the primary secrets.
      for (const el of document.querySelectorAll('.repo-name, .session-name, .home-item-title')) {
        push(el.textContent);
      }
      // The home list's metadata line is "名称 · 模式 · 时间 · 状态", so only its
      // first segment is a name. Taking the whole line would add the review mode
      // and a relative timestamp to the secret list, which then reports every
      // other row's ordinary metadata as a leak.
      for (const el of document.querySelectorAll('.home-item-meta')) {
        push((el.textContent || '').split('·')[0]);
      }
      return [...out];
    })()`)

    this.maskStrings = Array.isArray(literals) ? literals : []
    log(`mask literals (${this.maskStrings.length}): ${JSON.stringify(this.maskStrings.slice(0, 6))}`)
    return this.maskStrings.length
  }

  /**
   * Captions are burned in by ffmpeg for both cuts, so there is nothing to hide
   * in the page. Kept as a no-op because the scenes call it around recording.
   */
  async setDomCaption() {
    return true
  }
  /* ---- recording ---- */

  async startRecording(name) {
    const size = await this.wc.executeJavaScript('({ w: window.innerWidth, h: window.innerHeight })')
    this.width = size.w
    this.height = size.h

    const file = path.join(OUT_DIR, `${name}.mp4`)
    this.enc = spawn(
      FFMPEG,
      [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'image2pipe', '-vcodec', 'png',
        '-framerate', String(this.fps),
        '-i', 'pipe:0',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        '-y', file
      ],
      { stdio: ['pipe', 'inherit', 'inherit'] }
    )

    this.writer = new FrameWriter(this.enc)
    this.captions = []
    this.writer.begin()

    // The capture loop is deliberately not awaited: it runs for as long as the
    // scene does, and the scene decides when recording ends. Errors surface
    // through `captureError` instead of becoming an unhandled rejection.
    this.capturing = true
    this.captureError = null
    this.captureLoop = this.runCaptureLoop()
      .catch((err) => {
        this.captureError = err
      })
      .finally(() => {
        this.capturing = false
      })

    log(`recording '${name}' at ${this.width}x${this.height}`)
    return file
  }

  /** Tight capture loop; ffmpeg's stdout backpressure bounds the rate. */
  async runCaptureLoop() {
    // Audited during the take, not only at the end: a name that is visible for
    // two seconds in the middle is just as published as one visible throughout.
    let nextAudit = 0
    let lastAudit = 0
    const leaks = []
    while (this.capturing) {
      const png = await this.writer.capture(this.win)
      // Keeping the exact buffer that was handed to ffmpeg removes all doubt
      // about what the encoder received versus what the DOM claimed.
      if (KEEP_FRAMES) fs.writeFileSync(path.join(OUT_DIR, 'last-frame.png'), png)
      await this.writer.write(png)
      const at = this.elapsed()
      if (at >= nextAudit) {
        nextAudit = at + 3
        try {
          const found = await this.auditMask()
          const maskCount = await this.wc.executeJavaScript(
            `document.querySelectorAll('.vo-mask').length`
          )
          log(`  t=${at.toFixed(1)}s masks=${maskCount} leaks=${found.length}`)
          if (found.length && at - lastAudit > 2) {
            lastAudit = at
            leaks.push({ at: Number(at.toFixed(1)), found })
            log(`  LEAK @${at.toFixed(1)}s: ${JSON.stringify(found.slice(0, 3))}`)
          }
        } catch {
          /* an audit must never break the take */
        }
      }
    }
    this.maskLeaks = leaks
    // Close out the final partial frame so the last interaction is not cut off.
    const tail = await this.writer.capture(this.win)
    await this.writer.write(tail)
  }

  async stopRecording() {
    this.polish()
    this.capturing = false
    await this.captureLoop
    const w = this.writer
    // Measured before the encoder is closed, so it is not inflated by however
    // long ffmpeg takes to flush the frames it is still holding.
    const realSeconds = w.now() ?? 0
    await w.finish()
    if (this.captureError) throw this.captureError
    const stats = w.stats(realSeconds)
    log(
      `stopped: ${stats.captured} frames in ${stats.realSeconds}s real ` +
        `(${stats.fpsAchieved} fps captured)`
    )
    if (w.errors.length) log(`pipe errors: ${w.errors.slice(0, 3).join('; ')}`)
    this.lastStats = stats
    this.writer = null
    return realSeconds
  }

  /* ---- interaction primitives ---- */

  /** Animates the drawn cursor with easing, one short JS hop at a time. */
  async moveTo(x, y, ms = 520) {
    const from = { ...this.cursor }
    const steps = Math.max(6, Math.round(ms / 16))
    for (let i = 1; i <= steps; i++) {
      const p = i / steps
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2
      const cx = Math.round(from.x + (x - from.x) * e)
      const cy = Math.round(from.y + (y - from.y) * e)
      await this.wc.executeJavaScript(`window.__vo.move(${cx},${cy})`)
      this.cursor = { x: cx, y: cy }
      await sleep(16)
    }
  }

  async center(selector, index) {
    return this.wc.executeJavaScript(
      `window.__vo.centerOf(${JSON.stringify(selector)}, ${index === undefined ? 'undefined' : index})`
    )
  }

  /** Move to a target, ring it, click it, then let the UI animation play out. */
  async clickOn(selector, { index, settle = 900, moveMs = 520 } = {}) {
    const box = await this.center(selector, index)
    if (!box) throw new Error(`nothing matches ${selector}${index === undefined ? '' : `[${index}]`}`)
    await this.moveTo(box.x, box.y, moveMs)
    await sleep(230)
    await this.wc.executeJavaScript(`window.__vo.ripple(${box.x},${box.y})`)
    const ok = await this.wc.executeJavaScript(
      `window.__vo.click(${JSON.stringify(selector)}, ${index === undefined ? 'undefined' : index})`
    )
    if (!ok) throw new Error(`click failed on ${selector}`)
    await sleep(settle)
    return box
  }

  /** Clicks the first element matching `selector` whose text contains `text`. */
  async clickByText(selector, text, { settle = 1200, moveMs = 520 } = {}) {
    const find = `[...document.querySelectorAll(${JSON.stringify(selector)})]
      .find(n => (n.innerText || '').includes(${JSON.stringify(text)}))`
    const box = await this.wc.executeJavaScript(`(() => {
      const el = ${find};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
               text: (el.innerText || '').trim().slice(0, 60) };
    })()`)
    if (!box) throw new Error(`no ${selector} containing "${text}"`)
    await this.moveTo(box.x, box.y, moveMs)
    await sleep(220)
    await this.wc.executeJavaScript(`window.__vo.ripple(${box.x},${box.y})`)
    await this.wc.executeJavaScript(`(() => { const el = ${find}; if (el) el.click(); return true })()`)
    await sleep(settle)
    return box
  }

  async scrollBy(dy) {
    await this.wc.executeJavaScript(`window.__vo.scrollBy(${dy})`)
  }

  async eval(expression) {
    return this.wc.executeJavaScript(expression)
  }

  /**
   * Shows a caption and records when it appeared, for the ASS subtitle pass.
   *
   * Deliberately non-blocking: blocking here would freeze the drawn cursor
   * mid-glide and let a UI transition finish underneath the caption, which is
   * what makes scripted demos look stitched together. The script instead chains
   * a caption with the interaction that follows it and awaits the interaction;
   * the timeline only has to guarantee that no caption is cut off before it can
   * be read.
   */
  async describe(text, hold = 2600, { minHold = 1.1 } = {}) {
    const now = this.elapsed()
    let start = now
    const previous = this.captions[this.captions.length - 1]
    if (previous) {
      const previousEnd = previous.start + previous.hold / 1000
      if (previousEnd + minHold > now) {
        start = previousEnd + 0.12
        await sleep((start - now) * 1000)
      }
    }
    log(`  caption @${start.toFixed(1)}s: ${text.replace(/\*/g, '')}`)
    // Recorded here and burned in later; nothing is drawn into the page.
    this.captions.push({ start, text: text.replace(/\*/g, ''), hold })
  }

  /** Caption plus a pause, for beats that have nothing else to wait on. */
  async say(text, holdSeconds = 2.6, options) {
    await this.describe(text, holdSeconds * 1000, options)
    await sleep(holdSeconds * 1000)
  }

  async hideCaption() {
    return true
  }

  /** Keeps the final caption up long enough to read before the scene ends. */
  polish(minTail = 1.4) {
    const last = this.captions[this.captions.length - 1]
    if (!last) return
    const tail = this.elapsed() - last.start
    if (tail < minTail) last.hold = minTail * 1000
  }

  async waitFor(selector, { timeoutMs = 240000, pollMs = 500, label } = {}) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const found = await this.wc.executeJavaScript(`window.__vo.exists(${JSON.stringify(selector)})`)
      if (found) return true
      await sleep(pollMs)
    }
    throw new Error(`timed out waiting for ${label ?? selector}`)
  }

  /** Length of the take so far, on the video's own clock. */
  elapsed() {
    if (!this.writer) return 0
    return this.writer.now() ?? 0
  }
}

/* ------------------------------------------------------------------ *
 * Scenes
 * ------------------------------------------------------------------ */

/**
 * Every scene receives the recorder. Scenes are self-contained: any one of them
 * can be recorded alone with VIDEO_SCENES=..., because each navigates to where
 * it needs to be before it starts.
 */
const SCENES = {
  /**
   * Sidebar and home: what the client already knows about.
   *
   * The sessions are expanded *before* anything is clicked that navigates away,
   * because the rail is replaced by the review configuration once a repository is
   * opened. Recording it the other way round produced a take where the session
   * list was never visible at all.
   */
  async overview(rec) {
    const repoIndex = await pickRepoIndex(rec)
    await rec.describe('审查结果不该是终端里滚过去的 JSON', 2600)
    await rec.clickOn('.chevron', { index: repoIndex, settle: 1800, moveMs: 700 })
    await rec.describe('左栏是历史记录：*每条会话都有自动生成的中文标题*', 3000)
    await rec.clickOn('.repo-row', { index: repoIndex, settle: 1600, moveMs: 620 })
    await rec.describe('*点仓库名* 就能发起一次新的审查', 2400)
    await rec.clickOn('.brand', { settle: 1500, moveMs: 560 })
    await rec.say('首页一屏告诉你：环境是否正常、最近审过什么', 2.8)
  },

  /** New review: scope picker and the free preview. */
  async configure(rec) {
    await ensureReviewView(rec)
    await rec.describe('四种范围：工作区 / 分支区间 / 单提交 / 全量扫描', 3000)
    await rec.clickOn('.mode', { index: 1, settle: 1100, moveMs: 620 })
    await rec.clickOn('.mode', { index: 0, settle: 900, moveMs: 420 })
    await rec.describe('先点 *预览* —— 这一步不调用模型，不花钱', 2200)
    await rec.clickByText('.card-head .btn', '预览', { settle: 2400 })
    await rec.describe('待审文件、增删行数，*以及被排除的文件和原因*，一次看清', 3400)
    await rec.scrollBy(240)
    await sleep(1200)
    await rec.say('确认没问题，再启动审查', 2.4)
  },

  /** Advanced options and the exact command line that will run. */
  async params(rec) {
    await ensureReviewView(rec)
    await rec.describe('高级选项都在这里：力度、并发、超时、token 预算', 3000)
    await rec.clickOn('.advanced summary', { settle: 1500, moveMs: 640 })
    await rec.describe('启动前会把*将要执行的命令行*原样列出来', 2600)
    await rec.scrollBy(760)
    await sleep(1300)
    await rec.say('该花多少模型额度，由你决定', 2.6)
  },

  /** Results: grouped findings, filtering, inline diff. */
  async results(rec) {
    await openLatestSession(rec)
    await rec.waitFor('.summary-bar', { label: 'the results view' })
    await rec.describe('审查结果按文件分组，*不再是满屏 JSON*', 3000)
    await rec.describe('按 *严重度* 和类别筛选，实时联动', 2000)
    await rec.clickOn('.sev-toggle', { index: 2, settle: 1100, moveMs: 560 })
    await rec.clickOn('.sev-toggle', { index: 0, settle: 1600, moveMs: 480 })
    await rec.describe('每条 finding 都带*行内 diff*：现有代码 / 建议改为', 3200)
    await rec.scrollBy(430)
    await sleep(1500)
    await rec.say('复制建议、查看上下文、在编辑器里打开，都在这一张卡上', 3.0)
  }
}

/** Which repository row to drive. VIDEO_REPO matches on text, else the first. */
async function pickRepoIndex(rec) {
  const rows = await rec.eval(
    `[...document.querySelectorAll('.repo-row')].map(r => (r.innerText || '').trim().slice(0, 40))`
  )
  if (!Array.isArray(rows) || !rows.length) throw new Error('the sidebar has no repository rows')
  log(`repositories: ${JSON.stringify(rows)}`)
  if (!REPO_MATCH) return 0
  const index = rows.findIndex((r) => r.includes(REPO_MATCH))
  if (index < 0) throw new Error(`VIDEO_REPO=${REPO_MATCH} matched none of ${JSON.stringify(rows)}`)
  return index
}

/** Clicks a repository so the review-configuration view is on screen. */
async function ensureReviewView(rec) {
  const already = await rec.eval(`!!document.querySelector('.review-grid')`)
  if (already) return
  const repoIndex = await pickRepoIndex(rec)
  await rec.clickOn('.repo-row', { index: repoIndex, settle: 1500, moveMs: 620 })
}

/** Expands the chosen repository and opens its newest session. */
async function openLatestSession(rec) {
  const repoIndex = await pickRepoIndex(rec)
  const expanded = await rec.eval(
    `(() => { const rows = [...document.querySelectorAll('.repo-row')];
       const row = rows[${repoIndex}];
       if (!row) return false;
       const box = row.closest('.repo')?.querySelector('.sessions');
       return !!(box && box.querySelector('.session-row')); })()`
  )
  if (!expanded) {
    await rec.clickOn('.chevron', { index: repoIndex, settle: 2000, moveMs: 520 })
  }
  await rec.describe('点一条历史会话，直接看结果', 2200)
  await rec.clickOn('.session-row', { index: 0, settle: 2600, moveMs: 640 })
}

/* ------------------------------------------------------------------ *
 * Post-production
 * ------------------------------------------------------------------ */

/**
 * Builds an ASS subtitle file.
 *
 * The style values are fractions of the script's own resolution, so the same
 * caption text can be rendered into a 1440x920 working frame, a 1920x1080 cut or
 * a 1080x1920 cut and scale sensibly each time.
 */
function writeAss(file, captions, { width, height, style }) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')')
  const stamp = (seconds) => {
    const t = Math.max(0, seconds)
    const h = Math.floor(t / 3600)
    const m = Math.floor((t % 3600) / 60)
    const s = (t % 60).toFixed(2).padStart(5, '0')
    return `${h}:${String(m).padStart(2, '0')}:${s}`
  }
  const fontSize = Math.round(height * style.fontSize)
  const marginV = Math.round(height * style.marginV)
  const marginX = Math.round(width * style.marginX)

  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,'
      + ' Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline,'
      + ' Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // BorderStyle=3 draws the opaque box, which is what makes a caption readable
    // over a screenshot of a code review.
    `Style: Cap,Microsoft YaHei,${fontSize},&H00E6FFEF,&H00E6FFEF,&H00202020,&HCC000000,`
      + `-1,0,0,0,100,100,0,0,3,3,0,${style.align},${marginX},${marginX},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]

  captions.forEach((c, i) => {
    const next = captions[i + 1]
    const own = c.start + (c.hold ?? 2600) / 1000
    const end = next ? Math.min(next.start, own + 0.4) : own + 0.4
    if (end <= c.start) return
    lines.push(`Dialogue: 0,${stamp(c.start)},${stamp(end)},Cap,,0,0,0,,${esc(c.text)}`)
  })

  fs.writeFileSync(file, lines.join('\n'), 'utf8')
  return file
}

/**
 * Subtitle styling for the landscape cut.
 *
 * A caption here is centred near the bottom with a small side margin, so it reads
 * as a normal subtitle under a screen recording.
 */
const ASS_LANDSCAPE = { fontSize: 0.045, marginV: 0.04, marginX: 0.02, align: 2 }

/**
 * Subtitle styling for the phone cut.
 *
 * The recording is padded top and bottom, and the caption goes into the lower
 * band, aligned left so it sits under the subject rather than centred over it.
 * `Alignment: 3` means `MarginV` measures from the bottom, so the value is large
 * on purpose: it lifts the caption back over the padded frame's near edge.
 */
const ASS_VERTICAL = { fontSize: 0.035, marginV: 0.17, marginX: 0.07, align: 3 }

/**
 * Captions are burned in for both cuts by ffmpeg.
 *
 * An earlier version put the caption for the 16:9 cut in the DOM instead. That
 * cannot work, because both cuts render from one raw take: the DOM caption is
 * already in the recorded pixels, so the vertical render showed it *and* the
 * burned-in one at the same time. Burning both from the same ASS file also means
 * each cut gets styling chosen for its own aspect ratio.
 */
async function renderLandscape(src, dst, assFile, { fps, realSeconds }) {
  const factor = conformFactor(src, fps, realSeconds)
  const vf = [
    `setpts=PTS*${factor.toFixed(6)}`,
    `fps=${fps}`,
    'scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos',
    'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x050807',
    `subtitles=${path.basename(assFile)}`
  ].join(',')
  await run(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error', '-i', src,
      '-vf', vf, '-c:v', 'libx264', '-preset', 'slow', '-crf', '19',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', dst
    ],
    OUT_DIR
  )
  return { dst, factor }
}

/**
 * 9:16 cut for phone feeds, with the captions burned in along the lower band.
 *
 * ffmpeg runs with `cwd` set to the artifact directory and refers to the
 * subtitle file by bare name on purpose: the `subtitles` filter splits its
 * argument on `:` and `/`, so a Windows path like `C:/Users/...` is parsed as an
 * option list ("Unable to parse original_size option value") unless every
 * separator is escaped. A bare filename has neither character.
 */
async function renderVertical(src, dst, assFile, { fps, realSeconds }) {
  const factor = conformFactor(src, fps, realSeconds)
  const vf = [
    `setpts=PTS*${factor.toFixed(6)}`,
    `fps=${fps}`,
    'scale=1080:-2:flags=lanczos',
    'pad=1080:1920:0:170:color=0x050807',
    `subtitles=${path.basename(assFile)}`
  ].join(',')
  await run(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error', '-i', src,
      '-vf', vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', '19',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', dst
    ],
    OUT_DIR
  )
  return dst
}

/**
 * Joins the raw scene captures into one file for the full-length cut.
 *
 * The pieces are the raw, un-conformed captures, so their timestamps are frame
 * counts at the recorder's nominal rate rather than real time — the per-scene
 * `setpts` conform happens afterwards on the joined file. `-c copy` is enough
 * because every piece came from this same encoder invocation, and the resulting
 * duration is checked against the sum of the measured scene durations by the
 * caller's reported figure.
 */
async function concat(parts, dst) {
  const listFile = path.join(OUT_DIR, 'concat.txt')
  fs.writeFileSync(listFile, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'), 'utf8')
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
    '-i', listFile, '-c', 'copy', '-movflags', '+faststart', '-y', dst
  ])
  return dst
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  log(ffmpegAvailable())

  const wanted = (process.env.VIDEO_SCENES ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const names = wanted.length ? wanted : Object.keys(SCENES)
  for (const name of names) {
    if (!SCENES[name]) throw new Error(`unknown scene '${name}'; known: ${Object.keys(SCENES).join(', ')}`)
  }

  await sleep(9000)
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) throw new Error('no BrowserWindow was created — did `yarn compile` run?')

  // A visible, focused window is required. `capturePage()` returns what has been
  // composited, and an unfocused or occluded window can hand back a stale frame:
  // an earlier take showed DOM masks that the audit had confirmed were applied
  // and yet the pixels still contained the unmasked name, because the compositor
  // was not repainting. Focusing costs nothing here — nothing else is typed
  // during a recording — and it is what makes the captured pixels match the DOM.
  win.show()
  win.focus()
  await sleep(1500)

  const rec = new Recorder(win)
  try {
    await rec.install()
  } catch (err) {
    console.error('[video] install() failed:', err && err.stack ? err.stack : err)
    throw err
  }

  const produced = []
  for (const name of names) {
    const rawFile = await rec.startRecording(name)
    try {
      await SCENES[name](rec)
    } catch (err) {
      log(`scene '${name}' failed: ${err && err.message ? err.message : err}`)
      await rec.stopRecording()
      throw err
    }
    await rec.stopRecording()
    await sleep(400)

    const conform = { fps: rec.fps, realSeconds: rec.lastStats.realSeconds }
    const landscape = path.join(OUT_DIR, `${name}-16x9.mp4`)
    const vertical = path.join(OUT_DIR, `${name}-9x16.mp4`)
    // One ASS per cut, because the two frame shapes want different caption
    // sizes, margins and alignment. Both are burned in: the raw take carries no
    // captions at all, so each cut gets exactly one set.
    const landAss = writeAss(path.join(OUT_DIR, `${name}-16x9.ass`), rec.captions, {
      width: 1920, height: 1080, style: ASS_LANDSCAPE
    })
    const vertAss = writeAss(path.join(OUT_DIR, `${name}-9x16.ass`), rec.captions, {
      width: 1080, height: 1920, style: ASS_VERTICAL
    })
    const result = await renderLandscape(rawFile, landscape, landAss, conform)
    await renderVertical(rawFile, vertical, vertAss, conform)

    const outSeconds = probeDuration(landscape)
    const drift = outSeconds === null ? null : outSeconds - rec.lastStats.realSeconds
    log(
      `wrote ${path.basename(landscape)} (${outSeconds?.toFixed(2)}s) + ` +
        `${path.basename(vertical)} — conform ${result.factor.toFixed(3)}x` +
        (drift === null ? '' : `, drift ${drift >= 0 ? '+' : ''}${drift.toFixed(2)}s`)
    )
    if (drift !== null && Math.abs(drift) > 0.5) {
      log(`warning: ${name} is off real time by ${drift.toFixed(2)}s — check the capture rate`)
    }

    produced.push({
      name,
      rawFile,
      landscape,
      vertical,
      captions: rec.captions,
      size: { w: rec.width, h: rec.height },
      fps: rec.fps,
      stats: rec.lastStats,
      outputSeconds: outSeconds
    })
  }

  // A full-length take, plus its vertical counterpart, when every scene ran.
  if (produced.length > 1) {
    const fullRaw = path.join(OUT_DIR, 'full-raw.mp4')
    await concat(produced.map((p) => p.rawFile), fullRaw)

    const allCaptions = []
    let offset = 0
    for (const part of produced) {
      for (const c of part.captions) allCaptions.push({ ...c, start: c.start + offset })
      offset += part.stats.realSeconds
    }
    const fullConform = { fps: produced[0].fps, realSeconds: offset }
    const fullLandAss = writeAss(path.join(OUT_DIR, 'full-16x9.ass'), allCaptions, {
      width: 1920, height: 1080, style: ASS_LANDSCAPE
    })
    const fullVertAss = writeAss(path.join(OUT_DIR, 'full-9x16.ass'), allCaptions, {
      width: 1080, height: 1920, style: ASS_VERTICAL
    })
    await renderLandscape(fullRaw, path.join(OUT_DIR, 'full-16x9.mp4'), fullLandAss, fullConform)
    await renderVertical(fullRaw, path.join(OUT_DIR, 'full-9x16.mp4'), fullVertAss, fullConform)
    log(`wrote full-16x9.mp4 and full-9x16.mp4 (${offset.toFixed(1)}s)`)
  }

  const summary = produced.map((p) => ({
    scene: p.name,
    realSeconds: p.stats.realSeconds,
    videoSeconds: p.outputSeconds,
    fps: p.fps,
    '16x9': path.basename(p.landscape),
    '9x16': path.basename(p.vertical),
    captions: p.captions.length,
    bytes: fs.existsSync(p.landscape) ? fs.statSync(p.landscape).size : 0
  }))
  const reportFile = path.join(OUT_DIR, 'video-report.json')
  fs.writeFileSync(
    reportFile,
    JSON.stringify(
      { window: produced[0]?.size, outputFps: FPS, redacted: REDACT, scenes: summary },
      null,
      2
    )
  )
  log(`report: ${reportFile}`)
  console.table(summary)
}

// Must be required before our own whenReady handler is registered, because the
// app registers its createWindow() handler at require time and both handlers run
// in registration order.
require('../out/main/index.js')

app.whenReady().then(async () => {
  try {
    await main()
    app.exit(0)
  } catch (err) {
    console.error('[video] FATAL', err && err.stack ? err.stack : err)
    app.exit(1)
  }
})
