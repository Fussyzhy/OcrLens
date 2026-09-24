/**
 * UI polish probe.
 *
 * Loads the built app, drives it to each view, and captures screenshots plus
 * the measurements the visual pass is judged on — at the default window size
 * and again maximised, because "does it use the extra width" is a claim that
 * only a maximised window can settle.
 *
 * This is deliberately separate from `smoke.cjs`: the smoke asserts behaviour
 * (data flows, exports, naming) and takes ~2 minutes; this only looks at
 * layout and renders, so it can be run repeatedly while iterating on CSS.
 *
 * Usage:
 *   yarn compile
 *   node_modules\.bin\electron scripts\probe-ui.cjs
 *
 * Environment:
 *   PROBE_ISOLATE=1   make the window click-through and unfocused, so a stray
 *                     click on the desktop cannot disturb the run
 *
 * Artifacts land in smoke-out/probe-*.png and smoke-out/probe.json.
 */

const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const OUT_DIR = path.join(__dirname, '..', 'smoke-out')
fs.mkdirSync(OUT_DIR, { recursive: true })

const report = { steps: [], consoleErrors: [], violations: [] }

function step(name, data) {
  report.steps.push({ ...data, name })
  console.log(`[probe] ${name}: ${JSON.stringify(data)}`)
}

function assert(condition, message) {
  if (condition) return true
  report.violations.push(message)
  console.error(`[probe] VIOLATION: ${message}`)
  return false
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The app registers its own app.whenReady() handler on require, so the window
// exists by the time ours below runs.
require('../out/main/index.js')

async function shot(win, name) {
  const image = await win.webContents.capturePage()
  const size = image.getSize()
  if (!size.width || !size.height) return null
  fs.writeFileSync(path.join(OUT_DIR, `probe-${name}.png`), image.toPNG())
  console.log(`[probe] shot ${name}: ${size.width}x${size.height}`)
  return `${name}.png`
}

/**
 * Samples a strip of the pane that holds nothing but background.
 *
 * Presence of `.bg-fx` in the DOM proves nothing — a layer can exist and be
 * painted behind an opaque ancestor, or behind the canvas. Measured pixels are
 * the only evidence that the ambient layer is actually on screen, and they are
 * also the check that it stayed subtle: the strip must be visible but nowhere
 * near text contrast.
 *
 * @returns {{ max: number, min: number, nonBlack: number, sampled: number }}
 */
async function sampleBackground(win, band) {
  const image = await win.webContents.capturePage()
  const size = image.getSize()
  const bitmap = image.toBitmap() // BGRA, top-down
  let max = 0
  let min = 255
  let nonBlack = 0
  let sampled = 0

  for (let x = band.fromX; x < band.toX; x += 7) {
    const i = (band.y * size.width + x) * 4
    // Green is the channel the orbs actually carry.
    const value = bitmap[i + 1]
    max = Math.max(max, value)
    min = Math.min(min, value)
    if (value > 0) nonBlack += 1
    sampled += 1
  }

  return { max, min, nonBlack, sampled }
}

/**
 * Everything the polish pass has to be judged on, read from the live layout
 * rather than from the stylesheet: a rule that exists but loses a specificity
 * fight looks identical to a rule that was never written.
 */
const MEASURE = `(() => {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) };
  };
  const style = (el, pseudo) => {
    if (!el) return null;
    return getComputedStyle(el, pseudo || null);
  };
  const pane = document.querySelector('.pane');
  const body = document.querySelector('.view-body');
  const head = document.querySelector('.view-head');

  const bgLayers = [...document.querySelectorAll('.bg-fx > *')].map((el) => ({
    cls: el.className,
    anim: getComputedStyle(el).animationName,
    opacity: getComputedStyle(el).opacity,
    display: getComputedStyle(el).display,
    zIndex: getComputedStyle(el).zIndex
  }));

  const sessionsEl = document.querySelector('.sessions');
  const chevron = document.querySelector('.chevron');
  const footIcons = [...document.querySelectorAll('.sidebar-foot .foot-icon')];
  const grid = document.querySelector('.findings-grid');
  const filters = document.querySelector('.filter-grid');
  const reviewGrid = document.querySelector('.review-grid');
  const homeCols = document.querySelector('.home-cols');

  return {
    windowSize: { w: window.innerWidth, h: window.innerHeight },
    paneWidth: pane ? Math.round(pane.getBoundingClientRect().width) : null,
    bodyRect: rect(body),
    bodyMaxWidth: body ? getComputedStyle(body).maxWidth : null,
    bodyPadLeft: body ? getComputedStyle(body).paddingLeft : null,
    headPadLeft: head ? getComputedStyle(head).paddingLeft : null,
    // The title must sit directly above the cards it belongs to.
    headContentOffset: rect(head ? head.querySelector('h1') : null),
    sidebarBg: style(document.querySelector('.sidebar'))?.backgroundColor ?? null,
    paneBg: style(pane)?.backgroundColor ?? null,
    bgFxZ: style(document.querySelector('.bg-fx'))?.zIndex ?? null,
    bgLayers,
    sessionsGap: sessionsEl ? getComputedStyle(sessionsEl).rowGap : null,
    sessionRows: [...document.querySelectorAll('.session-row')].slice(0, 3).map((el) => rect(el)),
    chevronBox: rect(chevron),
    chevronGlyph: chevron ? { w: getComputedStyle(chevron, '::before').width } : null,
    chevronOpen: !!document.querySelector('.chevron.open'),
    footIcons: footIcons.map((el) => ({
      rect: rect(el),
      fontSize: getComputedStyle(el).fontSize,
      glyph: el.textContent.trim()
    })),
    footLabels: [...document.querySelectorAll('.sidebar-foot button')].map((b) =>
      b.textContent.trim()
    ),
    cardCount: document.querySelectorAll('.card').length,
    statCount: document.querySelectorAll('.stat').length,
    homeItems: document.querySelectorAll('.home-item').length,
    skeletons: document.querySelectorAll('.skeleton').length,
    findingsColumns: grid ? getComputedStyle(grid).gridTemplateColumns : null,
    gridRect: rect(grid),
    // Where each file group actually ends, so "does the layout use the width"
    // can be checked instead of inferred from the track list (auto-fit reports
    // collapsed tracks, which a naive column count would read as in use).
    groupRects: [...document.querySelectorAll('.file-group')].map((el) => rect(el)),
    filterColumns: filters ? getComputedStyle(filters).gridTemplateColumns : null,
    reviewColumns: reviewGrid ? getComputedStyle(reviewGrid).gridTemplateColumns : null,
    // Cards sharing a y coordinate are sharing a row — the actual claim being
    // made about the workbench layout, which the track list alone does not prove.
    reviewCards: [...document.querySelectorAll('.review-grid > .card')].map((el) => rect(el)),
    homeColumns: homeCols ? getComputedStyle(homeCols).gridTemplateColumns : null,
    homeCardRects: [...document.querySelectorAll('.home-cols > .card')].map((el) => rect(el)),
    paneScrollHeight: pane ? pane.scrollHeight : null,
    paneClientHeight: pane ? pane.clientHeight : null,
    fileGroups: document.querySelectorAll('.file-group').length,
    findings: document.querySelectorAll('.finding').length,
    // Animation presence: a rule that lost a fight shows as 'none' here.
    viewBodyAnim: body ? getComputedStyle(body).animationName : null,
    firstCardAnim: style(document.querySelector('.view-body > *'))?.animationName ?? null,
    sessionRowAnim: style(document.querySelector('.session-row'))?.animationName ?? null,
    toastHostTag: document.querySelector('.toast-host')?.tagName ?? null
  };
})()`

async function measure(wc, label) {
  const data = await wc.executeJavaScript(MEASURE)
  step(label, data)
  return data
}

app.whenReady().then(async () => {
  await sleep(300)

  const windows = BrowserWindow.getAllWindows()
  if (!windows.length) {
    report.fatal = 'no BrowserWindow was created'
    finish(1)
    return
  }

  const win = windows[0]
  const wc = win.webContents

  wc.on('console-message', (event) => {
    const level = event.level ?? 'info'
    if (level === 'error' || level === 'warning') {
      report.consoleErrors.push(`${level}: ${event.message ?? ''}`)
    }
  })

  if (process.env.PROBE_ISOLATE === '1') {
    win.setIgnoreMouseEvents(true)
    win.blur()
    console.log('[probe] window is click-through and unfocused (PROBE_ISOLATE=1)')
  }

  try {
    if (wc.isLoading()) {
      await new Promise((resolve) => wc.once('did-finish-load', resolve))
    }
    // Environment probing spawns git in throwaway repositories.
    await sleep(11000)

    // The home page reads recent history in the background, so wait for it to
    // settle before measuring — otherwise the screenshot shows skeletons and
    // the recent-count assertion tests nothing.
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const state = await wc.executeJavaScript(
        `({ items: document.querySelectorAll('.home-item').length,
            stats: document.querySelectorAll('.stat').length,
            loading: document.querySelectorAll('.skeleton').length })`
      )
      if (state.stats >= 4 && state.items > 0) break
      await sleep(1000)
    }

    /* ---------------- 1. home at the default size ---------------- */
    const welcome = await measure(wc, 'home-default')
    await shot(win, '01-home-default')

    // Bottom padding of the pane: no card, no text, no sidebar.
    const bg = await sampleBackground(win, { y: welcome.windowSize.h - 14, fromX: 320, toX: 1420 })
    step('ambient-pixels', bg)
    // The threshold is deliberately loose. This strip sits under the vignette
    // where the glow is at its weakest, and the sheen crosses it periodically,
    // so the exact count moves between runs. What is being tested is the
    // difference between "the layer renders" and "an opaque ancestor paints over
    // it" — the latter is exactly zero everywhere, not slightly fewer samples.
    assert(
      bg.nonBlack >= 8,
      `the pane background is painted over the ambient layer (${JSON.stringify(bg)})`
    )
    assert(
      bg.max <= 40,
      `the ambient layer is bright enough to fight the text (max channel ${bg.max})`
    )

    assert(welcome.statCount === 4, `expected 4 environment cards, saw ${welcome.statCount}`)
    assert(
      welcome.homeItems > 0,
      `the home page shows no recent history (items ${welcome.homeItems}, loading ${welcome.skeletons})`
    )
    assert(!!welcome.bgLayers.length, 'the ambient background did not render')
    assert(
      welcome.bgLayers.some((layer) => layer.anim && layer.anim !== 'none'),
      `no ambient layer is animating: ${JSON.stringify(welcome.bgLayers)}`
    )
    // Both halves of the landing page must be visible together at the default
    // window size; stacking them put the workflow card below the fold.
    const homeRows = new Map()
    for (const card of welcome.homeCardRects) {
      homeRows.set(card.y, (homeRows.get(card.y) ?? 0) + 1)
    }
    assert(
      [...homeRows.values()].some((count) => count >= 2),
      `the home cards are stacked at ${welcome.windowSize.w}px ` +
        `(${JSON.stringify(welcome.homeCardRects)}, tracks ${welcome.homeColumns})`
    )
    console.log(
      `[probe] home page height ${welcome.paneScrollHeight} vs viewport ${welcome.paneClientHeight}`
    )

    /* ---------------- 2. home maximised ---------------- */
    win.maximize()
    await sleep(1400)
    const homeMax = await measure(wc, 'home-maximized')
    await shot(win, '02-home-maximized')
    assert(
      homeMax.paneWidth > welcome.paneWidth,
      `maximising did not widen the pane (${welcome.paneWidth} -> ${homeMax.paneWidth})`
    )
    assert(
      Math.abs(Number.parseInt(homeMax.headPadLeft) - Number.parseInt(homeMax.bodyPadLeft)) <= 1 ||
        !homeMax.headPadLeft,
      `header padding ${homeMax.headPadLeft} does not match body padding ${homeMax.bodyPadLeft}`
    )

    /* ---------------- 3. review workbench, maximised ---------------- */
    const opened = await wc.executeJavaScript(`(() => {
      const row = document.querySelector('.repo-row');
      if (!row) return { clicked: null };
      row.click();
      return { clicked: row.querySelector('.repo-name')?.textContent?.trim() ?? null };
    })()`)
    step('open-repo', opened)
    await sleep(2600)
    const review = await measure(wc, 'review-maximized')
    await shot(win, '03-review-maximized')

    // The whole point of the fluid layout: a maximised window must actually
    // give the content more room than the old fixed 1180px cap did.
    if (review.paneWidth > 1180) {
      assert(
        review.bodyRect.w > 1180,
        `the workbench body is still capped at ${review.bodyRect.w}px on a ${review.paneWidth}px pane`
      )
    }
    // Block width is min(pane, --content-max); the gutters live inside it.
    assert(
      Math.abs(review.bodyRect.w - Math.min(review.paneWidth, 1760)) <= 2,
      `the body (${review.bodyRect.w}) does not track the pane (${review.paneWidth}) up to its cap`
    )

    if (review.windowSize.w >= 1600) {
      // Two cards must actually sit side by side, not merely have two tracks.
      const rows = new Map()
      for (const card of review.reviewCards) rows.set(card.y, (rows.get(card.y) ?? 0) + 1)
      const paired = [...rows.values()].some((count) => count >= 2)
      assert(
        paired,
        `the review cards did not reflow into columns on a ${review.windowSize.w}px window ` +
          `(${JSON.stringify(review.reviewCards)}, tracks ${review.reviewColumns})`
      )
    } else {
      console.log(`[probe] review page stays a single column at ${review.windowSize.w}px`)
    }

    /* ---------------- 4. sidebar with sessions expanded ---------------- */
    await wc.executeJavaScript(`(() => {
      const row = document.querySelector('.repo-row');
      row?.querySelector('.chevron')?.click();
      return true;
    })()`)
    await sleep(7000)

    const sidebar = await measure(wc, 'sidebar-expanded')
    await shot(win, '04-sidebar-expanded')

    assert(
      Number.parseFloat(sidebar.sessionsGap) >= 3,
      `session rows are packed together (gap ${sidebar.sessionsGap})`
    )
    assert(
      sidebar.sessionRows.length >= 2 &&
        sidebar.sessionRows[1].x === sidebar.sessionRows[0].x &&
        sidebar.sessionRows[1].h > 0,
      'session rows did not render'
    )
    assert(
      Number.parseInt(sidebar.chevronGlyph.w) <= 8,
      `the expander glyph is still oversized (${sidebar.chevronGlyph.w})`
    )
    assert(
      sidebar.footIcons.length === 2 &&
        sidebar.footIcons.every((icon) => icon.rect.w >= 30 && icon.rect.h >= 28),
      `sidebar footer icons are too small: ${JSON.stringify(sidebar.footIcons)}`
    )
    assert(
      sidebar.footIcons.every((icon) => Number.parseFloat(icon.fontSize) >= 15),
      `the footer glyphs are still set at a label's size: ${JSON.stringify(sidebar.footIcons)}`
    )

    /* ---------------- 5. session detail, maximised ---------------- */
    const sessionClick = await wc.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('.session-row')];
      if (!rows.length) return { clicked: false };
      const withFindings = rows.find((r) => /[1-9]\\d* 项/.test(r.textContent)) ?? rows[0];
      withFindings.click();
      return { clicked: true };
    })()`)
    step('open-session', sessionClick)
    await sleep(9000)

    const results = await measure(wc, 'results-maximized')
    await shot(win, '05-results-maximized')

    if (results.findings && results.windowSize.w >= 1700) {
      // The invariant is "the findings use the width they were given", not a
      // particular column count: with one file group, filling the row is the
      // right answer and a fixed two-column split would leave half the pane
      // blank.
      const gridRight = results.gridRect ? results.gridRect.x + results.gridRect.w : 0
      const reachesEdge = results.groupRects.some((g) => g.x + g.w >= gridRight - 8)
      assert(
        reachesEdge,
        `the findings leave a blank band on a ${results.windowSize.w}px window ` +
          `(grid ${JSON.stringify(results.gridRect)}, groups ${JSON.stringify(results.groupRects)})`
      )
      assert(
        results.filterColumns && results.filterColumns.split(' ').length === 2,
        `the filter card did not split into two columns (${results.filterColumns})`
      )
    } else {
      console.log(
        `[probe] skipping the wide-grid assertions (window ${results.windowSize.w}px, ` +
          `${results.findings} findings)`
      )
    }

    assert(
      results.viewBodyAnim === 'view-in',
      `the view body does not animate in (${results.viewBodyAnim})`
    )
    assert(
      results.firstCardAnim === 'card-in',
      `sections do not stagger in (${results.firstCardAnim})`
    )

    /* ---------------- 6. a narrow window ---------------- */
    win.unmaximize()
    win.setSize(1040, 760)
    await sleep(1400)
    const narrow = await measure(wc, 'narrow')
    await shot(win, '06-narrow')
    assert(
      narrow.bodyRect.w <= narrow.paneWidth,
      `the body overflows the pane at the minimum window size (${narrow.bodyRect.w} > ${narrow.paneWidth})`
    )
    assert(
      narrow.filterColumns && narrow.filterColumns.split(' ').length === 1,
      `the filter grid stayed multi-column on a narrow window (${narrow.filterColumns})`
    )

    finish(0)
  } catch (err) {
    report.fatal = err && err.stack ? err.stack : String(err)
    console.error(`[probe] FATAL ${report.fatal}`)
    finish(1)
  }
})

function finish(code) {
  const exit = report.violations.length ? 1 : code
  report.exitCode = exit
  fs.writeFileSync(path.join(OUT_DIR, 'probe.json'), JSON.stringify(report, null, 2))
  console.log(
    `[probe] done, exit=${exit}` +
      (report.violations.length ? ` (${report.violations.length} violations)` : '') +
      `, console errors: ${report.consoleErrors.length}`
  )
  app.exit(exit)
}
