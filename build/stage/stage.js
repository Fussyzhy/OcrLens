/**
 * Promo stage: "information explosion" (beat ② of the OcrLens promo).
 *
 * Everything on screen is drawn by `frame(f)` on a canvas, where `f` is the frame
 * number off a virtual clock. That is the whole point of this renderer: the
 * animation is a pure function of time, so a capture can never land mid-
 * transition and the output can never drift from the timeline. There are no CSS
 * transitions and no `requestAnimationFrame` anywhere in this file.
 *
 * Timeline at 30fps (150 frames = 5.000s):
 *
 *   f   0- 45   the terminal prints `finding`, one line every ~0.75 frame
 *   f  48- 66   the terminal frame fades out, the field takes over
 *   f  45- 90   the 60 glyphs scatter outward from their printed positions
 *   f  69- 90   they turn around and converge on the centre point
 *   f  90-120   the number bursts out of that centre point
 *   f 120-150   the number holds; the label settles in underneath
 *
 * The stage is authored at the output resolution on purpose. The natural idea is
 * to draw small and capture at 2x, but an offscreen Electron window is capped at
 * 1920x1032 (measured — every larger request is silently clamped), so there is no
 * headroom to supersample into. Drawing at 1920x1032 and padding to 1920x1080 is
 * therefore the sharpest available path: the frame the encoder receives is the
 * frame that was drawn, with no magnification anywhere.
 *
 * Usage from the renderer: `window.stageInstall({ w, h })` once, then
 * `window.frame(f)` per frame.
 */

;(() => {
  'use strict'

  /**
   * Stage geometry. Set by stageInstall from the renderer, because the real
   * constraint is the offscreen window's clamp: the canvas must not be larger
   * than the bitmap that will carry it, or the extra pixels are thrown away.
   */
  let W = 1920
  let H = 1032

  /**
   * When set, the stage composes in a portrait space that is drawn rotated onto a
   * landscape canvas. The canvas is a rectangle either way, so the rotated cut
   * gets native pixels instead of being rendered small and magnified — the whole
   * reason this renderer draws instead of recording.
   */
  let rotate = false

  /** Everything below is laid out against this width and scaled by `k`, so the
   *  same beat composes correctly at 16:9 and at 9:16 without a second script. */
  const DESIGN_W = 1920
  let k = 1

  /** Layout metrics, derived from `k` in `layout()`. */
  let TERM = null
  let LINE_H = 0
  let FONT = 0
  let TITLE_FONT = 0
  let DOT_R = 0
  let COUNT_FONT = 0
  let LABEL_FONT = 0
  let LABEL_GAP = 0
  let CENTER = { x: 0, y: 0 }

  const layout = () => {
    k = W / DESIGN_W
    CENTER = { x: W / 2, y: H / 2 }
    // The terminal keeps its aspect and stays inside the frame, so the vertical
    // cut narrows it instead of letting it run off the edges.
    const tw = Math.min(980 * k, W - 120 * k)
    const th = Math.min(780 * k, H - 120 * k)
    TERM = { x: (W - tw) / 2, y: (H - th) / 2, w: tw, h: th }
    LINE_H = 33 * k
    FONT = 25 * k
    TITLE_FONT = 19 * k
    DOT_R = 7 * k
    COUNT_FONT = 330 * k
    LABEL_FONT = 38 * k
    LABEL_GAP = 236 * k
  }

  /* ---------------------------------------------------------------- *
   * Configuration
   * ---------------------------------------------------------------- */

  /** How many `finding` glyphs exist. The real session had 389 findings; the
   *  count drawn is 96 because more than that reads as noise rather than volume,
   *  and the number they become is the real 389. */
  const GLYPHS = 96
  const GLYPH_TEXT = 'finding'

  /** The one number this beat lands on: the real finding count of the recorded
   *  session. Not invented. */
  const COUNT = '389'
  const LABEL = 'FINDINGS'

  const TERM_PAD = 34

  const T = {
    printFrom: 0,
    printPer: 0.42, // frames between printed lines
    printDur: 9, // frames for a line to fade in
    frameFadeFrom: 48,
    frameFadeTo: 66,
    scatterFrom: 45,
    scatterTo: 90,
    scatterDur: 90, // frames for one glyph to travel its arc
    convergeFrom: 69,
    convergeTo: 90,
    burstFrom: 90,
    burstTo: 120,
    labelFrom: 108,
    labelTo: 126
  }

  /* ---------------------------------------------------------------- *
   * Easing
   * ---------------------------------------------------------------- */

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
  /** Frame-range progress, clamped. */
  const span = (f, a, b) => clamp01((f - a) / (b - a))
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)
  /** Overshoots past 1 then settles: this is what makes the number land hard. */
  const easeOutBack = (t) => {
    const c = 1.70158
    const p = t - 1
    return 1 + (c + 1) * p * p * p + c * p * p
  }
  const lerp = (a, b, t) => a + (b - a) * t

  /* ---------------------------------------------------------------- *
   * Deterministic randomness
   *
   * A seeded generator, not Math.random: the same frame must produce the same
   * pixels on every re-render, otherwise a fixed caption or a re-run after a
   * one-word edit would shift the whole composition.
   * ---------------------------------------------------------------- */

  function mulberry32(seed) {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  /* ---------------------------------------------------------------- *
   * The glyph field
   *
   * Each glyph has a printed position (inside the terminal), an exploded
   * position (out in the frame) and a rotation. All three are computed once, so
   * the per-frame work is only interpolation.
   * ---------------------------------------------------------------- */

  let glyphs = []

  function buildGlyphs() {
    const rand = mulberry32(0x0c1e2f3d)
    glyphs = []
    for (let i = 0; i < GLYPHS; i++) {
      const px = TERM.x + TERM_PAD * k
      const py = TERM.y + TERM_PAD * k + 46 * k + i * LINE_H

      // Explode along a direction individual to each glyph, biased away from the
      // frame centre so the field opens *outward* rather than gathering in the
      // middle.
      //
      // Three earlier versions failed here, all for one reason: the destination
      // was derived from the printed position. Every glyph is printed in the same
      // narrow column left of centre, so anything based on that column is nearly
      // the same for all 60 — the measured spread went from x 80-285 to x 70-788
      // to 54-left/6-right of 1920 across those attempts. Jittering around a
      // derived angle does not help, because the underlying angles are all
      // clustered to begin with. Distributing the angle evenly over the full
      // circle is what actually guarantees the frame fills, and it costs nothing
      // in quality: the golden angle keeps successive glyphs far apart so the
      // motion still looks unordered.
      const angle = i * 2.39996 + rand() * 0.45
      const radius = (450 + rand() * 500) * k
      // The horizontal term is stretched because the stage is wider than it is
      // tall: an even angular spread on an oblong frame still leaves the top and
      // bottom sparse.
      let ex = CENTER.x + Math.cos(angle) * radius * 1.06
      let ey = CENTER.y + Math.sin(angle) * radius * 0.86

      // Keep every glyph fully inside the frame. Letting them fly off the edge
      // loses the mass that makes the explosion read as "too much information".
      const marginX = 70 * k
      const marginY = 60 * k
      ex = Math.min(W - marginX, Math.max(marginX, ex))
      ey = Math.min(H - marginY, Math.max(marginY, ey))

      glyphs.push({
        i,
        printed: { x: px, y: py },
        exploded: { x: ex, y: ey },
        rot: (rand() - 0.5) * 1.5,
        printAt: T.printFrom + i * T.printPer
      })
    }
  }

  /* ---------------------------------------------------------------- *
   * Drawing
   * ---------------------------------------------------------------- */

  let ctx = null

  function drawBackground(f) {
    ctx.fillStyle = '#050807'
    ctx.fillRect(0, 0, W, H)

    // A soft green glow gathers at the centre as the number forms, which is what
    // makes the burst feel like it has a light source behind it.
    const rise = span(f, 80, 120)
    if (rise > 0) {
      const g = ctx.createRadialGradient(CENTER.x, CENTER.y, 0, CENTER.x, CENTER.y, 780 * k)
      g.addColorStop(0, `rgba(43,222,94,${(0.16 * rise).toFixed(4)})`)
      g.addColorStop(0.45, `rgba(43,222,94,${(0.05 * rise).toFixed(4)})`)
      g.addColorStop(1, 'rgba(43,222,94,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, W, H)
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }

  /** The terminal frame and its title bar. Drawn only while it is visible. */
  function drawTerminalShell(opacity) {
    if (opacity <= 0.001) return
    ctx.save()
    ctx.globalAlpha = opacity

    roundRect(TERM.x, TERM.y, TERM.w, TERM.h, 14 * k)
    ctx.fillStyle = '#080d0a'
    ctx.fill()
    ctx.strokeStyle = 'rgba(43,222,94,0.22)'
    ctx.lineWidth = 1.8 * k
    ctx.stroke()

    // Title bar
    roundRect(TERM.x, TERM.y, TERM.w, 48 * k, 14 * k)
    ctx.fillStyle = '#0d1410'
    ctx.fill()

    const dots = ['#ff5f57', '#febc2e', '#28c840']
    dots.forEach((color, i) => {
      ctx.beginPath()
      ctx.arc(TERM.x + 26 * k + i * 24 * k, TERM.y + 24 * k, DOT_R, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
    })

    ctx.font = `${TITLE_FONT}px Consolas, monospace`
    ctx.fillStyle = 'rgba(210,235,220,0.55)'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('ocr review --repo my-project', TERM.x + 116 * k, TERM.y + 25 * k)

    ctx.restore()
  }

  /**
   * Draws every glyph at its current position for frame `f`.
   *
   * Three segments, blended so nothing pops:
   *   print     in place inside the terminal, fading in and rising 8px
   *   scatter   travelling to the exploded position
   *   converge  travelling back to the centre point, shrinking away
   */
  function drawGlyphs(f) {
    const shellAlpha = 1 - span(f, T.frameFadeFrom, T.frameFadeTo)

    for (const g of glyphs) {
      const appear = span(f, g.printAt, g.printAt + T.printDur)
      if (appear <= 0) continue

      // Rising into place, 8px, as the line fades in.
      const rise = (1 - easeOutCubic(appear)) * 8 * k

      let x = g.printed.x
      let y = g.printed.y + rise
      let scale = 1
      let rot = 0
      let alpha = appear

      // Scatter: individual start spread across the field so the explosion has a
      // visible order to it instead of all 60 leaving on the same frame.
      const sStart = T.scatterFrom + (g.i / GLYPHS) * 26
      const sP = span(f, sStart, sStart + T.scatterDur)
      if (sP > 0) {
        const e = easeOutCubic(sP)
        x = lerp(x, g.exploded.x, e)
        y = lerp(y, g.exploded.y, e)
        rot = g.rot * e
      }

      // Converge: same trick in reverse, aimed at one shared point.
      const cP = span(f, T.convergeFrom, T.convergeTo)
      if (cP > 0) {
        const e = Math.pow(cP, 1.6)
        x = lerp(x, CENTER.x, e)
        y = lerp(y, CENTER.y, e)
        scale = lerp(1, 0.05, e)
        // Inside the terminal the text rides on the shell's own fade; once it has
        // escaped it stays legible, otherwise the explosion reads as dissolving
        // rather than overwhelming.
        alpha *= (1 - e) * (shellAlpha + (1 - shellAlpha) * 0.72)
      } else if (shellAlpha < 1) {
        alpha *= shellAlpha + (1 - shellAlpha) * 0.72
      }

      if (alpha <= 0.004 || scale <= 0.02) continue

      ctx.save()
      ctx.globalAlpha = alpha
      ctx.translate(x, y)
      if (rot) ctx.rotate(rot)
      ctx.scale(scale, scale)
      ctx.font = `${FONT}px Consolas, 'Cascadia Mono', monospace`
      ctx.fillStyle = '#7ef0a4'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(GLYPH_TEXT, 0, 0)
      ctx.restore()
    }
  }

  /** The pay-off: the scattered mess becomes one large real number. */
  function drawCount(f) {
    const p = span(f, T.burstFrom, T.burstTo)
    if (p <= 0) return
    const e = easeOutBack(p)

    ctx.save()
    ctx.translate(CENTER.x, CENTER.y)
    ctx.scale(e, e)
    ctx.globalAlpha = clamp01(p * 3)

    ctx.font = `600 ${COUNT_FONT}px Consolas, 'Cascadia Mono', monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    // A solid body with the accent colour rising through the lower half.
    const grad = ctx.createLinearGradient(0, -150 * k, 0, 150 * k)
    grad.addColorStop(0, '#ffffff')
    grad.addColorStop(0.55, '#e8fff0')
    grad.addColorStop(1, '#2bde5e')
    ctx.fillStyle = grad
    ctx.shadowColor = 'rgba(43,222,94,0.55)'
    ctx.shadowBlur = 58 * k
    ctx.fillText(COUNT, 0, 0)
    ctx.restore()

    const lp = span(f, T.labelFrom, T.labelTo)
    if (lp > 0) {
      ctx.save()
      ctx.globalAlpha = easeOutCubic(lp)
      ctx.font = `500 ${LABEL_FONT}px Consolas, monospace`
      ctx.fillStyle = 'rgba(160,205,178,0.85)'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      // Letter-spacing by hand: canvas has no tracking property.
      const track = 12 * k
      const width = ctx.measureText(LABEL).width + track * (LABEL.length - 1)
      let cx = CENTER.x - width / 2
      for (const ch of LABEL) {
        ctx.fillText(ch, cx, CENTER.y + LABEL_GAP)
        cx += ctx.measureText(ch).width + track
      }
      ctx.restore()
    }
  }

  /* ---------------------------------------------------------------- *
   * Public entry points
   * ---------------------------------------------------------------- */

  /**
   * Sizes the canvas, builds the field and draws frame 0.
   *
   * `opts.w`/`opts.h` come from the renderer so the stage fills exactly the
   * bitmap the offscreen window will hand back. Drawing at that size and padding
   * to 1920x1080 in the encoder is the sharpest available path: there is no
   * magnification between what is drawn and what is published.
   */
  function install(opts) {
    const o = opts || {}
    rotate = Boolean(o.rotate)
    // W/H are the space the composition is authored in. For a rotated cut that is
    // portrait, while the canvas underneath stays landscape: the axes are swapped.
    const drawW = Math.round(Number(o.w) || W)
    const drawH = Math.round(Number(o.h) || H)
    W = drawW
    H = drawH
    layout()

    const canvas = document.getElementById('stage')
    const physW = rotate ? H : W
    const physH = rotate ? W : H
    canvas.width = Math.max(physW, window.innerWidth || 0)
    canvas.height = Math.max(physH, window.innerHeight || 0)
    canvas.style.width = `${canvas.width}px`
    canvas.style.height = `${canvas.height}px`

    ctx = canvas.getContext('2d', { alpha: false })
    ctx.textRendering = 'geometricPrecision'
    buildGlyphs()

    window.__stageInfo = {
      draw: [W, H],
      canvas: [canvas.width, canvas.height],
      rotate,
      k: Number(k.toFixed(4)),
      glyphs: GLYPHS,
      frames: 150
    }
    // Reported so the renderer can check the field actually spreads across the
    // frame instead of assuming it does from a screenshot.
    window.__fieldStats = () => {
      const xs = glyphs.map((g) => g.exploded.x)
      const ys = glyphs.map((g) => g.exploded.y)
      const inLeft = xs.filter((x) => x < W / 2).length
      const inRight = xs.filter((x) => x >= W / 2).length
      const inTop = ys.filter((y) => y < H / 2).length
      const inBottom = ys.filter((y) => y >= H / 2).length
      return {
        x: [Math.round(Math.min(...xs)), Math.round(Math.max(...xs))],
        y: [Math.round(Math.min(...ys)), Math.round(Math.max(...ys))],
        left: inLeft,
        right: inRight,
        top: inTop,
        bottom: inBottom,
        center: [Math.round(CENTER.x), Math.round(CENTER.y)]
      }
    }
    window.frame(0)
    return window.__stageInfo
  }

  const frame = (f) => {
    if (!ctx) return

    // Reset to physical pixels to clear, then re-apply the (possibly rotated)
    // drawing transform. Clearing under the rotated transform would only cover
    // part of the canvas.
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#050807'
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)

    // Rotate the portrait draw space onto the landscape canvas. The encoder then
    // rotates the frame 90 degrees clockwise, and the two must compose to the
    // identity or the cut comes back rotated.
    //
    // The direction is not obvious and was settled by measurement, not algebra:
    // with (0, 1, -1, 0, H, 0) the marked top edge of the composition landed on
    // the *bottom* of the published frame (red bar measured at y 1857..1919 of
    // 1920). The transpose that cancels the encoder's clockwise turn is the
    // counter-clockwise one, which here is (0, -1, 1, 0, 0, W) — canvas height
    // must equal the draw width for this to be exact, which is why the window and
    // draw space are kept the same shape.
    if (rotate) ctx.setTransform(0, -1, 1, 0, 0, W)
    else ctx.setTransform(1, 0, 0, 1, 0, 0)

    if (f === null) {
      // Diagnostic frame: a deliberately asymmetric marker set. "TL" is the
      // top-left of the *composed* frame, and the bar is its top edge, so the
      // published file can be checked for orientation without reasoning about
      // rotation matrices in the abstract.
      const bw = Math.round(24 * k)
      ctx.fillStyle = '#ff3b30'
      ctx.fillRect(0, 0, W, bw)
      ctx.fillStyle = '#ffffff'
      ctx.font = `bold ${Math.round(90 * k)}px Consolas, monospace`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText('TL', 40 * k, 60 * k)
      ctx.textAlign = 'right'
      ctx.textBaseline = 'bottom'
      ctx.fillStyle = '#2bde5e'
      ctx.fillText('BR', W - 40 * k, H - 40 * k)
      return
    }

    drawBackground(f)
    drawTerminalShell(1 - span(f, T.frameFadeFrom, T.frameFadeTo))
    drawGlyphs(f)
    drawCount(f)
  }

  window.frame = frame
  window.stageInstall = install

  // Draw immediately so the first paint the window produces is already frame 0.
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    install()
  } else {
    document.addEventListener('DOMContentLoaded', () => install())
  }
})()
