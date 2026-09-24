/**
 * End-to-end smoke test.
 *
 * Loads the built main process (which creates the real window and registers the
 * real IPC handlers), then drives the renderer through the actual click paths a
 * user would take, asserting on the DOM and capturing screenshots.
 *
 * This exists because "the process is still alive" proves nothing about whether
 * the window rendered, the environment probe found git, or a session's findings
 * made it onto the screen.
 *
 * It drives the user's real repositories and history on purpose — that is what
 * makes it a smoke test rather than a fixture — but it must not write to the user's
 * *client* state, and a run that drags rows, renames a repository or expands one to
 * generate titles does write. So `userData` is always pointed at a throwaway
 * directory (see below): the client's own settings, titles, layout and config
 * backups stay out of reach, while the CLI's session store is read as usual.
 *
 * Usage:
 *   yarn compile
 *   node_modules\.bin\electron scripts\smoke.cjs
 *
 * Environment:
 *   SMOKE_REPO=<dir>      also run a real review in that repo (costs one model call)
 *   SMOKE_CANCEL=1        start that review and cancel it instead
 *   SMOKE_MUTATE=1        also run the title/search/delete stage — it writes:
 *                         every untitled session in SMOKE_REPO gets a generated
 *                         title, and one session is moved to the trash
 *   SMOKE_TITLE_POLL=<n>  poll attempts (×2s) for automatic naming; default 90
 *   SMOKE_ISOLATE=1       make the window click-through and unfocused
 *   SMOKE_USERDATA=<dir>  where the client's own state is written; defaults to
 *                         <tmp>/ocr-smoke-userdata
 *
 * Artifacts land in smoke-out/ (log, JSON report, PNG screenshots).
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, dialog } = require('electron')

const OUT_DIR = path.join(__dirname, '..', 'smoke-out')
fs.mkdirSync(OUT_DIR, { recursive: true })

/**
 * Keep the client's own state out of the user's profile.
 *
 * Must happen before the app's modules ask for a path. Without it the window ran
 * under Electron's default profile — which happens to be a different directory from
 * the packaged app's, so nothing leaked, but only by accident: run the smoke as
 * `electron .` and the drag and rename stages would rewrite the real
 * `sidebar-layout.json` and every repo would come out "arranged".
 */
const USER_DATA = process.env.SMOKE_USERDATA || path.join(os.tmpdir(), 'ocr-smoke-userdata')
fs.mkdirSync(USER_DATA, { recursive: true })
app.setPath('userData', USER_DATA)

const LOG_PATH = path.join(OUT_DIR, 'smoke.log')
fs.writeFileSync(LOG_PATH, '')

function log(message) {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${message}`
  fs.appendFileSync(LOG_PATH, line + '\n')
}

const report = { steps: [], consoleErrors: [], pageExceptions: [], violations: [] }
const consoleErrors = []
/** Real OS input events seen by the window; see the listener in the run body. */
const externalInput = []

function step(name, data) {
  // `name` goes last on purpose: several stages pass DOM readings that happen to
  // carry a `name` field (a repo name, a session label), and spreading them after
  // the step name silently renamed the step in the report.
  report.steps.push({ ...data, name })
  log(`STEP ${name}: ${JSON.stringify(data)}`)
}

/**
 * Records a broken invariant. A violation makes the whole run fail, because
 * "the UI showed something" is not the same as "the UI showed the right thing" —
 * once a repo click opened a *different* repository's settings, which no
 * screenshot would have made obvious.
 */
function assert(condition, message) {
  if (condition) return true
  report.violations.push(message)
  log(`VIOLATION: ${message}`)
  return false
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Load the application. It registers its own app.whenReady() handler, so the
// window exists by the time our handler below runs.
require('../out/main/index.js')

async function shot(win, name) {
  try {
    const image = await win.webContents.capturePage()
    const size = image.getSize()
    if (!size.width || !size.height) {
      log(`shot ${name}: EMPTY IMAGE`)
      return null
    }
    fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), image.toPNG())
    log(`shot ${name}: ${size.width}x${size.height}`)
    return `${name}.png`
  } catch (err) {
    log(`shot ${name}: FAILED ${err.message}`)
    return null
  }
}

/**
 * Collects toast texts over a window.
 *
 * Toasts auto-dismiss after a few seconds, so sampling once at the end of a long
 * wait proves nothing — the notification may have come and gone. Polling is the
 * only way to observe a transient signal.
 */
async function collectToasts(wc, durationMs) {
  const seen = new Set()
  const deadline = Date.now() + durationMs

  while (Date.now() < deadline) {
    const batch = await wc.executeJavaScript(
      `[...document.querySelectorAll('.toast')].map(e => e.textContent.trim())`
    )
    for (const text of batch) seen.add(text)
    await sleep(400)
  }

  return [...seen]
}

/**
 * Reads a session's stored title and how the sidebar row currently renders it.
 *
 * The stage-8 assertions all need the same two things — the CLI's view and the
 * rail's view — and each used to scrape them inline, so one DOM change had to be
 * chased in four places.
 */
function titleSnapshot(wc, repo, sessionId) {
  return wc.executeJavaScript(
    `window.ocr.listSessions(${JSON.stringify(repo)}, 0).then(r => {
       const s = r.ok ? r.data.find(x => x.session_id === ${JSON.stringify(sessionId)}) : null;
       const row = document.querySelector('.session-row[data-session-id="${sessionId}"]');
       return {
         listed: r.ok,
         error: r.ok ? null : r.error,
         rowFound: !!row,
         stored: s ? (s.title ?? null) : null,
         source: s ? (s.titleSource ?? null) : null,
         railName: row?.querySelector('.session-name')?.textContent?.trim() ?? null,
         railUntitled: row?.querySelector('.session-name')?.classList.contains('untitled') ?? null,
         renameFieldOpen: !!document.querySelector('.rename-input')
       };
     })`
  )
}

app.whenReady().then(async () => {
  await sleep(300)

  const windows = BrowserWindow.getAllWindows()
  log(`windows after ready: ${windows.length}`)
  if (!windows.length) {
    report.fatal = 'no BrowserWindow was created'
    finish(1)
    return
  }

  const win = windows[0]
  const wc = win.webContents

  wc.on('console-message', (event) => {
    // Electron 44 passes an event object; keep only warnings and errors.
    const level = event.level ?? 'info'
    const message = event.message ?? ''
    if (level === 'error' || level === 'warning') {
      consoleErrors.push(`${level}: ${message}`)
    }
  })

  wc.on('render-process-gone', (_e, details) =>
    report.pageExceptions.push(`render-process-gone: ${JSON.stringify(details)}`)
  )

  /**
   * Real *keyboard* input reaching this window is a test hazard.
   *
   * The smoke drives the UI through `element.click()`, which never produces a
   * `before-input-event`. Note the limit of this listener: Electron only raises
   * it for key down/up/char dispatch, so a human's stray **mouse** click is not
   * recorded here at all — and `Input` carries no coordinates, so there is
   * nothing to log but the key. A stray click is excluded structurally instead,
   * by running the smoke with `SMOKE_ISOLATE=1` (click-through window).
   */
  wc.on('before-input-event', (_event, input) => {
    externalInput.push({
      type: input.type,
      key: input.key ?? null
    })
    log(`REAL-INPUT ${input.type} key=${input.key ?? ''}`)
  })

  // Opt-in isolation: a click-through window cannot be disturbed from outside.
  // Left off by default so a run still reports what the outside world did to it.
  if (process.env.SMOKE_ISOLATE === '1') {
    // Mouse events pass through to whatever is behind; blurring drops the
    // keyboard path too, so the only input is what this script synthesises.
    win.setIgnoreMouseEvents(true)
    win.blur()
    log('window is click-through and unfocused (SMOKE_ISOLATE=1)')
  }

  try {
    if (wc.isLoading()) {
      await new Promise((resolve) => wc.once('did-finish-load', resolve))
    }
    log(`loaded: ${wc.getURL()}`)
    log(`client state: ${app.getPath('userData')}`)

    // Environment probing spawns git in throwaway repos; give it real time.
    await sleep(9000)

    /* ---------------- 1. initial shell ---------------- */

    const shell = await wc.executeJavaScript(`(() => {
      const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
      return {
        hasApp: !!document.querySelector('#app')?.children.length,
        shell: !!document.querySelector('.shell'),
        brand: text('.brand'),
        repoRows: document.querySelectorAll('.repo-row').length,
        repoNames: [...document.querySelectorAll('.repo-name')].map(e => e.textContent.trim()),
        toasts: [...document.querySelectorAll('.toast')].map(e => e.textContent.trim()),
        viewHead: text('.view-head h1'),
        bodyText: document.body.innerText.slice(0, 600)
      };
    })()`)

    step('initial-shell', shell)
    await shot(win, '01-welcome')

    /* ---------------- 2. open a repository ---------------- */

    // Prefer the repo with real findings; fall back to whatever is first.
    const opened = await wc.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('.repo-row')];
      if (!rows.length) return { clicked: null, reason: 'no repo rows' };
      const preferred = rows.find(r => /city-builder/i.test(r.textContent)) ?? rows[0];
      const nameEl = preferred.querySelector('.repo-name');
      const name = nameEl?.textContent?.trim() ?? null;
      const dir = nameEl?.getAttribute('title') ?? null;
      preferred.click();
      return { clicked: name, clickedDir: dir };
    })()`)

    await sleep(2500)
    step('open-repo', opened)

    // Diagnostic: expose each row's (name, dir, active) so a mislabelled or
    // duplicated entry is visible in the report rather than inferred later.
    const rowsDiag = await wc.executeJavaScript(`(() => {
      return [...document.querySelectorAll('.repo-row')].map(r => {
        const nameEl = r.querySelector('.repo-name');
        return {
          name: nameEl?.textContent?.trim() ?? null,
          dir: nameEl?.getAttribute('title') ?? null,
          active: r.classList.contains('active')
        };
      });
    })()`)
    step('sidebar-rows', { rows: rowsDiag })

    const reviewPanel = await wc.executeJavaScript(`(() => {
      const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
      return {
        head: text('.view-head h1'),
        sub: text('.view-head .sub'),
        modes: [...document.querySelectorAll('.mode-title')].map(e => e.textContent.trim()),
        selectedMode: document.querySelector('.mode.selected .mode-title')?.textContent?.trim() ?? null,
        command: text('.mono.muted'),
        warnings: [...document.querySelectorAll('.banner.warn')].map(e => e.textContent.trim()),
        errors: [...document.querySelectorAll('.banner.error')].map(e => e.textContent.trim()),
        cardHeads: [...document.querySelectorAll('.card-head')].map(e => e.textContent.trim()),
        startDisabled: document.querySelector('.btn.primary')?.disabled ?? null
      };
    })()`)

    step('review-panel', reviewPanel)
    await shot(win, '02-new-review')

    // The clicked repo must be the repo the panel is configured for. This is the
    // invariant that a single observed (and never reproduced) run violated.
    assert(
      reviewPanel.head === opened.clicked,
      `panel head ${JSON.stringify(reviewPanel.head)} != clicked repo ${JSON.stringify(opened.clicked)}`
    )
    assert(
      reviewPanel.sub === opened.clickedDir,
      `panel dir ${JSON.stringify(reviewPanel.sub)} != clicked row dir ${JSON.stringify(opened.clickedDir)}`
    )

    /* ---------------- 2b. mode pickers (branch / commit lists) ---------------- */

    const clickMode = (title) =>
      wc.executeJavaScript(`(() => {
        const mode = [...document.querySelectorAll('.mode')].find(m =>
          m.querySelector('.mode-title')?.textContent.trim() === ${JSON.stringify(title)});
        if (!mode) return 'mode not found';
        mode.querySelector('input').click();
        return 'clicked';
      })()`)

    /* The mode pickers are this app's own dropdowns (components/SelectMenu.vue),
     * not native selects: the OS draws a select's popup in its own colours, so it
     * was the one control the theme could not reach. Driving one here from end to
     * end is what keeps that replacement honest — the rest of the suite would pass
     * just as happily if the control rendered nothing. */
    log(`range mode: ${await clickMode('分支区间')}`)
    await sleep(3000)
    const rangeMode = await wc.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const byLabel = (label) => [...document.querySelectorAll('.picker')].find(p =>
        p.querySelector('[aria-label]')?.getAttribute('aria-label') === label);
      const out = {
        labels: [...document.querySelectorAll('.picker [aria-label]')].map(e => e.getAttribute('aria-label'))
      };

      const from = byLabel('基准分支');
      out.fromFound = !!from;
      from?.querySelector('.picker-trigger')?.click();
      await sleep(300);
      const menu = document.querySelector('.picker-menu');
      const rows = [...(menu?.querySelectorAll('.picker-item') ?? [])];
      out.menuFound = !!menu;
      out.rowCount = rows.length;
      out.sampleRows = rows.slice(0, 6).map(r => r.textContent.trim());
      if (menu) {
        // The list has to be painted over the card it belongs to, and inside the
        // window: the cards clip their overflow, and an ancestor with a finished
        // animation is enough to move a fixed box somewhere else entirely.
        const box = menu.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(box.height / 2, 10));
        out.paintedOnTop = !!(hit && menu.contains(hit));
        out.insideWindow = box.top >= -1 && box.bottom <= window.innerHeight + 1;
      }

      out.firstRow = rows[1]?.textContent.trim() ?? null;
      rows[1]?.click();
      await sleep(300);
      out.picked = from?.querySelector('.picker-value')?.textContent.trim() ?? null;
      out.closedAfterPick = !document.querySelector('.picker-menu');
      out.expandedAfterPick = from?.querySelector('[role="combobox"]')?.getAttribute('aria-expanded') ?? null;
      return out;
    })()`)
    step('range-mode', rangeMode)
    assert(rangeMode.fromFound === true, `the 分支区间 mode has no 基准分支 dropdown (${JSON.stringify(rangeMode)})`)
    assert(
      rangeMode.rowCount > 1 && rangeMode.sampleRows?.[0]?.includes('请选择') === true,
      `the 基准分支 dropdown listed no branches (${JSON.stringify(rangeMode)})`
    )
    assert(
      rangeMode.paintedOnTop === true && rangeMode.insideWindow === true,
      `the branch list was not painted over its card inside the window (${JSON.stringify(rangeMode)})`
    )
    assert(
      rangeMode.picked === rangeMode.firstRow && rangeMode.closedAfterPick === true,
      `picking a branch did not land on it and close the list (${JSON.stringify(rangeMode)})`
    )
    await shot(win, '10-range-mode')

    log(`commit mode: ${await clickMode('单提交')}`)
    await sleep(3000)
    const commitMode = await wc.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const commit = [...document.querySelectorAll('.picker')].find(p =>
        p.querySelector('[aria-label]')?.getAttribute('aria-label') === '提交');
      const out = { found: !!commit };
      out.label = commit?.querySelector('.picker-value')?.textContent.trim() ?? null;
      commit?.querySelector('.picker-trigger')?.click();
      await sleep(300);
      const rows = [...document.querySelectorAll('.picker-menu .picker-item')];
      out.rowCount = rows.length;
      out.sampleRows = rows.slice(1, 5).map(r => r.textContent.trim());
      // A click anywhere else closes it; the list is teleported to the body, so
      // "outside" has to include everything that is not the list or its control.
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await sleep(250);
      out.closedByOutsideClick = !document.querySelector('.picker-menu');
      return out;
    })()`)
    step('commit-mode', commitMode)
    assert(
      commitMode.found === true && commitMode.rowCount > 1 && commitMode.closedByOutsideClick === true,
      `the 提交 dropdown did not list commits or did not close on an outside click (${JSON.stringify(commitMode)})`
    )
    await shot(win, '11-commit-mode')

    /* The third picker sits in the folded 高级选项 panel, where nothing has been
     * rendered before the summary is clicked — which is exactly the state a
     * dropdown must survive, since it measures its control when it opens.
     *
     * 分批策略 belongs to 全量扫描: the other three modes show 关闭结果后过滤 in its
     * place, so this stage enters that mode and the click below takes the page back
     * to 工作区 for the preview. */
    log(`scan mode: ${await clickMode('全量扫描')}`)
    await sleep(2500)
    const batchPicker = await wc.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const summary = document.querySelector('details.advanced summary');
      summary?.click();
      await sleep(500);
      const picker = [...document.querySelectorAll('.picker')].find(p =>
        p.querySelector('[aria-label]')?.getAttribute('aria-label') === '分批策略');
      const out = { found: !!picker };
      out.value = picker?.querySelector('.picker-value')?.textContent.trim() ?? null;
      picker?.querySelector('.picker-trigger')?.click();
      await sleep(300);
      const rows = [...document.querySelectorAll('.picker-menu .picker-item')];
      out.rowCount = rows.length;
      out.sampleRows = rows.map(r => r.textContent.trim());
      out.insideWindow = (() => {
        const box = document.querySelector('.picker-menu')?.getBoundingClientRect();
        return box ? box.top >= -1 && box.bottom <= window.innerHeight + 1 : null;
      })();
      picker?.querySelector('[role="combobox"]')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
      await sleep(250);
      out.closedByEscape = !document.querySelector('.picker-menu');
      // Folded again, and back on the default, so the preview below runs the same
      // options it did before this stage existed.
      out.valueUnchanged = picker?.querySelector('.picker-value')?.textContent.trim() === out.value;
      summary?.click();
      await sleep(300);
      return out;
    })()`)
    step('batch-picker', batchPicker)
    assert(
      batchPicker.found === true &&
        batchPicker.rowCount === 4 &&
        batchPicker.insideWindow === true &&
        batchPicker.closedByEscape === true &&
        batchPicker.valueUnchanged === true,
      `the 分批策略 dropdown in 高级选项 is not usable (${JSON.stringify(batchPicker)})`
    )

    // Back to workspace so the preview stage below exercises the default path.
    log(`back to workspace: ${await clickMode('工作区')}`)
    await sleep(1200)

    /* ---------------- 3. run the free preview ---------------- */

    const previewClicked = await wc.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '预览');
      if (!btn) return 'no preview button';
      btn.click();
      return 'clicked';
    })()`)
    log(`preview click: ${previewClicked}`)
    await sleep(12000)

    const previewResult = await wc.executeJavaScript(`(() => {
      const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
      const rows = [...document.querySelectorAll('.preview-table tbody tr')];
      return {
        pills: [...document.querySelectorAll('.pill')].map(e => e.textContent.trim()),
        rowCount: rows.length,
        sampleRows: rows.slice(0, 8).map(r => [...r.querySelectorAll('td')].map(c => c.textContent.trim())),
        error: text('.banner.error')
      };
    })()`)

    step('preview-result', previewResult)
    await shot(win, '03-preview')

    /* ---------------- 4. expand sessions and open one ---------------- */

    const sessionOpen = await wc.executeJavaScript(`(async () => {
      const rows = [...document.querySelectorAll('.repo-row')];
      const target = rows.find(r => /city-builder/i.test(r.textContent)) ?? rows[0];
      target.querySelector('.chevron')?.click();
      return 'expanded';
    })()`)
    log(`expand: ${sessionOpen}`)
    await sleep(6000)

    const sessionList = await wc.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('.session-row')];
      return {
        count: rows.length,
        labels: rows.slice(0, 6).map(r => r.innerText.replace(/\\s+/g, ' ').trim())
      };
    })()`)
    step('session-list', sessionList)
    await shot(win, '04-sessions-expanded')

    assert(sessionList.count > 0, `expanding the repo produced no session rows`)

    const clickedSession = await wc.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('.session-row')];
      if (!rows.length) return { clicked: false };
      // Prefer a session that reports findings.
      const withFindings = rows.find(r => /[1-9]\\d* 项/.test(r.textContent)) ?? rows[0];
      withFindings.click();
      return { clicked: true, label: withFindings.innerText.replace(/\\s+/g, ' ').trim() };
    })()`)
    step('open-session', clickedSession)
    await sleep(8000)

    const results = await wc.executeJavaScript(`(() => {
      const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
      const metrics = [...document.querySelectorAll('.metric')].map(m => m.innerText.replace(/\\s+/g, ' ').trim());
      const findings = [...document.querySelectorAll('.finding')];
      const first = findings[0];
      return {
        head: text('.view-head h1'),
        metrics,
        fileGroups: document.querySelectorAll('.file-group').length,
        findingCount: findings.length,
        severityChips: [...document.querySelectorAll('.chip.sev')].slice(0, 5).map(e => e.textContent.trim()),
        categoryChips: [...document.querySelectorAll('.chip.cat-bug, .chip.cat-security, .chip[class*="cat-"]')].slice(0, 5).map(e => e.textContent.trim()),
        firstFindingText: first ? first.innerText.slice(0, 700) : null,
        diffBlocks: document.querySelectorAll('.diff').length,
        codeLines: document.querySelectorAll('.code-line').length,
        filterToggles: [...document.querySelectorAll('.sev-toggle')].map(e => e.textContent.replace(/\\s+/g, ' ').trim()),
        error: text('.banner.error'),
        empty: text('.empty')
      };
    })()`)

    step('results', results)
    await shot(win, '05-results')

    assert(
      results.head === opened.clicked,
      `results head ${JSON.stringify(results.head)} != clicked repo ${JSON.stringify(opened.clicked)}`
    )
    assert(
      Boolean(results.error) === false,
      `results view reported an error: ${results.error}`
    )

    /* ---------------- 5. exercise a filter toggle ---------------- */

    const toggled = await wc.executeJavaScript(`(() => {
      const before = document.querySelectorAll('.finding').length;
      const first = document.querySelector('.sev-toggle');
      if (!first) return { toggled: false };
      const label = first.textContent.replace(/\\s+/g, ' ').trim();
      first.click();
      return { toggled: true, label, before };
    })()`)
    await sleep(900)

    const afterToggle = await wc.executeJavaScript(`(() => ({
      after: document.querySelectorAll('.finding').length,
      shown: document.querySelector('.card .muted.nowrap')?.textContent?.trim() ?? null
    }))()`)

    step('filter-toggle', { ...toggled, ...afterToggle })
    await shot(win, '06-filtered')

    /* ---------------- 5b. Markdown export ----------------
     * A native save dialog is the one step that cannot be driven from the
     * renderer, so it is stubbed here. Everything else is real: the Markdown the
     * renderer builds, the IPC hop, the file name handling and the write.
     */

    const exportDir = path.join(OUT_DIR, 'export')
    fs.rmSync(exportDir, { recursive: true, force: true })
    fs.mkdirSync(exportDir, { recursive: true })

    const realShowSaveDialog = dialog.showSaveDialog
    let saveTarget = path.join(exportDir, 'session.md')
    let lastDialogOptions = null

    dialog.showSaveDialog = async (winOrOptions, maybeOptions) => {
      lastDialogOptions = maybeOptions ?? winOrOptions ?? null
      return saveTarget === null
        ? { canceled: true, filePath: undefined }
        : { canceled: false, filePath: saveTarget }
    }

    /**
     * Waits for a finished report.
     *
     * `fs.existsSync` is not enough: `writeFile` creates the file and *then*
     * writes into it, so a read that races the write sees an empty document. The
     * footer is the document's last line, so it marks completion.
     */
    const REPORT_FOOTER = '之后可能已经变化。'
    const waitForReport = async (target, attempts = 50) => {
      for (let i = 0; i < attempts; i += 1) {
        if (fs.existsSync(target)) {
          const text = fs.readFileSync(target, 'utf8')
          if (text.includes(REPORT_FOOTER)) return text
        }
        await sleep(200)
      }
      return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null
    }

    const clickHeadAction = (label) =>
      wc.executeJavaScript(`(() => {
        const buttons = [...document.querySelectorAll('.head-actions button')];
        const btn = buttons.find(b => b.textContent.trim() === ${JSON.stringify(label)});
        if (!btn) return { found: false, buttons: buttons.map(b => b.textContent.trim()) };
        btn.click();
        return { found: true };
      })()`)

    const callExport = (request) =>
      wc.executeJavaScript(
        `window.ocr.exportSessionMarkdown(${JSON.stringify(request)})
           .then(r => (r.ok ? r.data : { error: r.error }))`
      )

    try {
      const controls = await wc.executeJavaScript(`(() => ({
        text: document.querySelector('.head-actions')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
        buttons: [...document.querySelectorAll('.head-actions button')].map(b => b.textContent.trim()),
        counts: document.querySelector('.card .muted.nowrap')?.textContent?.trim() ?? null,
        visible: document.querySelectorAll('.finding').length
      }))()`)
      step('export-controls', controls)

      // `显示 3 / 9` — the numbers the report has to agree with.
      const ratio = /(\d+)\s*\/\s*(\d+)/.exec(controls.counts ?? '')
      const visible = Number(ratio ? ratio[1] : controls.visible)
      const total = Number(ratio ? ratio[2] : controls.visible)

      const clickedVisible = await clickHeadAction('导出 MD')
      const visibleReport = await waitForReport(saveTarget)
      assert(clickedVisible.found, `no 导出 MD button (saw ${JSON.stringify(clickedVisible.buttons)})`)
      assert(visibleReport !== null, `clicking 导出 MD did not write ${saveTarget}`)

      if (visibleReport) {
        const visibleText = visibleReport
        const detail = {
          visible,
          total,
          headings: (visibleText.match(/^#### /gm) ?? []).length,
          fenceMarkers: (visibleText.match(/^`{3,}/gm) ?? []).length,
          title: visibleText.split('\n')[0],
          bytes: Buffer.byteLength(visibleText, 'utf8')
        }
        report.exportFile = detail
        step('export-visible', detail)

        assert(
          detail.title === `# OCR 审查报告 · ${results.head}`,
          `exported title ${JSON.stringify(detail.title)} does not name the session's repo ${JSON.stringify(results.head)}`
        )
        assert(
          /^- \*\*会话 ID\*\*：`[^`]+`$/m.test(visibleText),
          'the exported document does not record the session id'
        )
        assert(
          detail.headings === visible,
          `the export contains ${detail.headings} findings but the view showed ${visible}`
        )
        assert(
          detail.fenceMarkers % 2 === 0,
          `the exported Markdown has unbalanced code fences (${detail.fenceMarkers} markers)`
        )
      }

      // Any filter change makes the export ambiguous, so the all-findings
      // variant has to exist and has to cover everything.
      const allTarget = path.join(exportDir, 'all.md')
      saveTarget = allTarget
      const clickedAll = await clickHeadAction('导出全部')
      step('export-all-click', clickedAll)

      if (clickedAll.found) {
        const all = await waitForReport(allTarget)
        assert(all !== null, `导出全部 did not write ${allTarget}`)
        if (all) {
          const headings = (all.match(/^#### /gm) ?? []).length
          report.exportAll = { headings, total }
          step('export-all', report.exportAll)
          assert(
            headings === total,
            `导出全部 wrote ${headings} findings, the session has ${total}`
          )
        }
      } else {
        log('导出全部 button unavailable; skipping the all-findings assertion')
      }

      // A renderer-supplied name must never escape the chosen directory, and a
      // name without an extension is still written as Markdown.
      const traversalTarget = path.join(exportDir, 'no-extension')
      saveTarget = traversalTarget
      await callExport({ suggestedName: '../../evil.md', content: '# x' })

      const dialogName = lastDialogOptions ? path.basename(lastDialogOptions.defaultPath) : null
      report.exportDialog = { dialogName, defaultPath: lastDialogOptions?.defaultPath ?? null }
      step('export-dialog', report.exportDialog)

      assert(dialogName === 'evil.md', `save dialog proposed ${JSON.stringify(dialogName)}`)
      assert(
        path.dirname(lastDialogOptions?.defaultPath ?? '') === app.getPath('documents'),
        `save dialog defaulted outside Documents: ${JSON.stringify(lastDialogOptions?.defaultPath)}`
      )
      assert(
        fs.existsSync(`${traversalTarget}.md`),
        'a save path without an extension was not written as Markdown'
      )

      // Cancelling is an ordinary outcome: no error, no file, and the button
      // must be usable again. The cancelled file is the one the stub refuses to
      // return, so it doubles as proof that nothing was written.
      saveTarget = null
      const cancelTarget = path.join(exportDir, 'cancelled.md')
      const clickedCancel = await clickHeadAction('导出 MD')
      await sleep(1500)

      const cancelState = await wc.executeJavaScript(`(() => ({
        buttons: [...document.querySelectorAll('.head-actions button')].map(b => ({ label: b.textContent.trim(), disabled: b.disabled })),
        errorToasts: [...document.querySelectorAll('.toast.error')].map(t => t.textContent.trim())
      }))()`)
      const cancelled = await callExport({ suggestedName: 'x.md', content: '# x' })

      report.exportCancelled = { clickedCancel, ...cancelState, result: cancelled }
      step('export-cancelled', report.exportCancelled)

      assert(clickedCancel.found, 'the 导出 MD button disappeared')
      assert(cancelled.cancelled === true, `a cancelled save returned ${JSON.stringify(cancelled)}`)
      assert(
        !fs.existsSync(cancelTarget),
        `a cancelled save still wrote ${cancelTarget}`
      )
      assert(
        cancelState.errorToasts.length === 0,
        `a cancelled save raised an error toast: ${JSON.stringify(cancelState.errorToasts)}`
      )
      assert(
        cancelState.buttons.some((b) => b.label.includes('导出') && b.disabled === false),
        `the export button stayed disabled after a cancelled save (${JSON.stringify(cancelState.buttons)})`
      )
    } finally {
      dialog.showSaveDialog = realShowSaveDialog
      await shot(win, '13-export-state')
    }

    /* ---------------- 5c. rail: preview, drag ordering, rename, delete dialog ----------------
     * Driven through the real DOM and the real IPC. The mutations are undone in
     * place (the renamed repository gets its original name back, every dragged row
     * is dragged back), so a run leaves the rail as it found it — the only lasting
     * write is the stored order, and that ends up describing the order that was on
     * screen all along.
     */
    const rail = await wc.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const repoRows = () => [...document.querySelectorAll('.repo-row')];
      const repoNames = () => repoRows().map(r => r.querySelector('.repo-name')?.textContent?.trim() ?? null);
      const expandedBlock = () =>
        [...document.querySelectorAll('.repo')].find(b => b.querySelector('.sessions')) ?? null;
      const fire = (el, type, y, dt) => el.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, dataTransfer: dt, clientY: y
      }));
      const out = { repoNamesBefore: repoNames(), repoCount: repoRows().length };

      /* A long history is folded behind a button rather than pushing every other
         repository off the rail. */
      const withMore = [...document.querySelectorAll('.repo')].find(b => b.querySelector('.sessions-more'));
      out.moreLabel = withMore?.querySelector('.sessions-more')?.textContent?.trim() ?? null;
      if (withMore) {
        const shown = withMore.querySelectorAll('.session-row').length;
        withMore.querySelector('.sessions-more').click();
        await sleep(600);
        const all = withMore.querySelectorAll('.session-row').length;
        const collapseLabel = withMore.querySelector('.sessions-more')?.textContent?.trim() ?? null;
        withMore.querySelector('.sessions-more')?.click();
        await sleep(400);
        out.preview = { shown, all, collapseLabel, backTo: withMore.querySelectorAll('.session-row').length };
        // Left expanded on purpose: the drag checks below need more than one row.
        withMore.querySelector('.sessions-more')?.click();
        await sleep(600);
        out.preview.reexpanded = withMore.querySelectorAll('.session-row').length;
      }

      /* The session checks below need an expanded repository, and the preview
         button only exists past the fold. Open the second one through its chevron
         so a short history still exercises them (and so the repository drag below
         has a session list to land on). */
      const secondBlock = repoRows()[1]?.closest('.repo');
      out.secondExpanded = false;
      if (secondBlock && !secondBlock.querySelector('.session-row')) {
        secondBlock.querySelector('.chevron')?.click();
        await sleep(900);
        out.secondExpanded = !!secondBlock.querySelector('.session-row');
      } else if (secondBlock) {
        out.secondExpanded = true;
      }

      /* Dragging a repository below its neighbour, then back. */
      if (repoRows().length >= 2) {
        const before = repoNames();
        const dt = new DataTransfer();
        let from = repoRows()[0];
        let onto = repoRows()[1];
        out.dragFrom = from.querySelector('.repo-name').textContent.trim();
        out.dragOnto = onto.querySelector('.repo-name').textContent.trim();

        fire(from, 'dragstart', 0, dt);
        fire(onto, 'dragover', onto.getBoundingClientRect().bottom - 2, dt);
        fire(onto, 'drop', onto.getBoundingClientRect().bottom - 2, dt);
        fire(from, 'dragend', 0, dt);
        await sleep(1800);
        out.afterDrag = repoNames();
        const persisted = await window.ocr.listRepos();
        out.persistedRepoNames = persisted.ok ? persisted.data.map(r => r.name) : null;

        from = repoRows()[1];
        onto = repoRows()[0];
        fire(from, 'dragstart', 0, dt);
        fire(onto, 'dragover', onto.getBoundingClientRect().top + 2, dt);
        fire(onto, 'drop', onto.getBoundingClientRect().top + 2, dt);
        fire(from, 'dragend', 0, dt);
        await sleep(1800);
        out.afterUndo = repoNames();
        out.orderRestored = JSON.stringify(out.afterUndo) === JSON.stringify(before);
      }

      /* Dragging a repository onto the expanded session list of another one.
         The repository's drop zone is its whole block, session list included, so a
         drop that lands on a session row has to reorder repositories — it used to be
         swallowed by the session row's own handler while the insert line was shown. */
      {
        const expandTarget = repoRows().find((row, index) =>
          index > 0 && row.closest('.repo')?.querySelector('.session-row')
        );
        const dragSource = repoRows()[0];
        if (expandTarget && dragSource) {
          const before = repoNames();
          const dt = new DataTransfer();
          const firstSession = expandTarget.closest('.repo').querySelector('.session-row');
          out.sessionDropFrom = dragSource.querySelector('.repo-name').textContent.trim();
          out.sessionDropOnto = expandTarget.querySelector('.repo-name').textContent.trim();
          fire(dragSource, 'dragstart', 0, dt);
          fire(firstSession, 'dragover', firstSession.getBoundingClientRect().bottom - 2, dt);
          fire(firstSession, 'drop', firstSession.getBoundingClientRect().bottom - 2, dt);
          fire(dragSource, 'dragend', 0, dt);
          await sleep(1800);
          out.afterSessionDrop = repoNames();
          // Compared by relative position: the dragged repository has to land
          // immediately after the one whose session list it was dropped on.
          out.reorderedOnSessionDrop =
            out.afterSessionDrop.indexOf(out.sessionDropFrom) ===
            out.afterSessionDrop.indexOf(out.sessionDropOnto) + 1;

          // Put it back the way it was.
          const back = repoRows()[1];
          const backOnto = repoRows()[0];
          fire(back, 'dragstart', 0, dt);
          fire(backOnto, 'dragover', backOnto.getBoundingClientRect().top + 2, dt);
          fire(backOnto, 'drop', backOnto.getBoundingClientRect().top + 2, dt);
          fire(back, 'dragend', 0, dt);
          await sleep(1800);
          out.afterSessionDropUndo = repoNames();
          out.sessionDropRestored = JSON.stringify(out.afterSessionDropUndo) === JSON.stringify(before);
        }
      }

      /* Renaming a repository touches its label only. */
      const renameRow = repoRows().find(r => r.querySelector('.icon-btn[title="重命名项目"]'));
      if (renameRow) {
        const original = renameRow.querySelector('.repo-name').textContent.trim();
        out.renameOriginal = original;
        renameRow.querySelector('.icon-btn[title="重命名项目"]').click();
        await sleep(400);
        const field = document.querySelector('.rename-input.repo-rename');
        out.renameFieldOpen = !!field;
        if (field) {
          field.value = '烟雾测试项目';
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          await sleep(1500);
          out.renamedLabel = repoNames().includes('烟雾测试项目');

          const again = repoRows().find(r => r.querySelector('.repo-name')?.textContent?.trim() === '烟雾测试项目');
          again?.querySelector('.icon-btn[title="重命名项目"]')?.click();
          await sleep(400);
          const restore = document.querySelector('.rename-input.repo-rename');
          if (restore) {
            restore.value = original;
            restore.dispatchEvent(new Event('input', { bubbles: true }));
            restore.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await sleep(1500);
          }
          out.renameRestored = repoNames().includes(original);
        }
      }

      /* Dragging a session inside its repository, then back. */
      let block = expandedBlock();
      if (block) {
        const before = [...block.querySelectorAll('.session-row')].map(r => r.dataset.sessionId);
        out.sessionOrderBefore = before;
        if (before.length >= 2) {
          const dt = new DataTransfer();
          let rows = [...block.querySelectorAll('.session-row')];
          fire(rows[0], 'dragstart', 0, dt);
          fire(rows[1], 'dragover', rows[1].getBoundingClientRect().bottom - 1, dt);
          fire(rows[1], 'drop', rows[1].getBoundingClientRect().bottom - 1, dt);
          fire(rows[0], 'dragend', 0, dt);
          await sleep(2000);

          block = expandedBlock();
          out.sessionOrderAfterDrag = [...(block?.querySelectorAll('.session-row') ?? [])].map(r => r.dataset.sessionId);
          const dir = block?.querySelector('.repo-name')?.getAttribute('title') ?? null;
          const persisted = dir ? await window.ocr.listSessions(dir, 0) : null;
          out.sessionOrderPersisted = persisted?.ok ? persisted.data.map(s => s.session_id) : null;

          rows = [...(block?.querySelectorAll('.session-row') ?? [])];
          if (rows.length >= 2) {
            fire(rows[1], 'dragstart', 0, dt);
            fire(rows[0], 'dragover', rows[0].getBoundingClientRect().top + 1, dt);
            fire(rows[0], 'drop', rows[0].getBoundingClientRect().top + 1, dt);
            fire(rows[1], 'dragend', 0, dt);
            await sleep(2000);
            block = expandedBlock();
            out.sessionOrderAfterUndo = [...(block?.querySelectorAll('.session-row') ?? [])].map(r => r.dataset.sessionId);
            out.sessionOrderRestored = JSON.stringify(out.sessionOrderAfterUndo) === JSON.stringify(before);
          }
        }
      }

      /* Deleting asks first; cancelling must change nothing. */
      const deleteRow = repoRows().find(r => r.querySelector('.icon-btn[title="删除项目及其全部审查历史"]'));
      if (deleteRow) {
        deleteRow.querySelector('.icon-btn[title="删除项目及其全部审查历史"]').click();
        await sleep(500);
        const modal = document.querySelector('.modal');
        out.deleteDialog = modal ? {
          heading: modal.querySelector('h3')?.textContent?.trim() ?? null,
          message: modal.querySelector('.modal-message')?.textContent?.trim() ?? null,
          detail: modal.querySelector('.modal-detail')?.textContent?.trim() ?? null,
          buttons: [...modal.querySelectorAll('.modal-actions button')].map(b => b.textContent.trim())
        } : null;
        const cancel = modal
          ? [...modal.querySelectorAll('.modal-actions button')].find(b => b.textContent.trim() === '取消')
          : null;
        if (cancel) cancel.click();
        await sleep(600);
        out.dialogDismissed = !document.querySelector('.modal');
        out.repoCountUnchanged = repoRows().length === out.repoCount;
      }

      return out;
    })()`)

    report.rail = rail
    step('rail-interactions', rail)
    await shot(win, '06b-rail-interactions')

    // Read the client's own layout file for the one thing the page cannot show:
    // whether restoring a name by typing it left an alias behind.
    const layoutFile = path.join(app.getPath('userData'), 'sidebar-layout.json')
    try {
      const layout = JSON.parse(fs.readFileSync(layoutFile, 'utf8'))
      rail.layoutAliases = layout.repoAliases ?? {}
      const redundant = Object.values(rail.layoutAliases).filter(
        (alias) => alias === rail.renameOriginal
      )
      assert(
        redundant.length === 0,
        `restoring the original name stored it as an alias (${JSON.stringify(rail.layoutAliases)})`
      )
    } catch (err) {
      log(`could not read ${layoutFile}: ${err instanceof Error ? err.message : String(err)}`)
    }

    assert(rail.renameFieldOpen === true, `the repository rename field did not open (${JSON.stringify(rail)})`)
    assert(
      rail.renamedLabel === true && rail.renameRestored === true,
      `renaming a repository did not stick or could not be undone (${JSON.stringify(rail)})`
    )
    assert(
      rail.deleteDialog?.heading === '删除这个项目？',
      `the repository delete confirmation was not shown (${JSON.stringify(rail.deleteDialog)})`
    )
    assert(
      JSON.stringify(rail.deleteDialog?.buttons) === JSON.stringify(['取消', '删除项目']),
      `the repository delete dialog does not offer cancel/confirm (${JSON.stringify(rail.deleteDialog?.buttons)})`
    )
    assert(
      rail.dialogDismissed === true && rail.repoCountUnchanged === true,
      `cancelling the repository delete dialog changed the rail (${JSON.stringify(rail)})`
    )

    // A repository dragged onto another one's expanded session list is still a drop
    // on that repository's block; the session row's own handler used to eat it.
    if (rail.sessionDropOnto) {
      assert(
        rail.reorderedOnSessionDrop === true,
        `dropping a repository on an expanded session list did nothing (${JSON.stringify({
          from: rail.sessionDropFrom,
          onto: rail.sessionDropOnto,
          after: rail.afterSessionDrop
        })})`
      )
      assert(
        rail.sessionDropRestored === true,
        `the drop on a session list could not be undone (${JSON.stringify(rail.afterSessionDropUndo)})`
      )
    } else {
      log('no expanded repository below the first one; the drop-on-session-list path was not exercised')
    }

    if (rail.preview) {
      assert(
        rail.preview.all > rail.preview.shown && rail.preview.collapseLabel === '收起',
        `the session preview did not expand or collapse as expected (${JSON.stringify(rail.preview)})`
      )
      assert(
        rail.preview.backTo === rail.preview.shown,
        `collapsing the session list did not return to the preview (${JSON.stringify(rail.preview)})`
      )
    } else {
      log('no repository has more than the preview limit; the 展开其余会话 button was not exercised')
    }

    if (rail.afterDrag) {
      assert(
        rail.afterDrag[1] === rail.dragFrom,
        `dragging a repository did not move it (${JSON.stringify(rail.afterDrag)} from ${rail.dragFrom})`
      )
      assert(
        JSON.stringify(rail.persistedRepoNames) === JSON.stringify(rail.afterDrag),
        `the dragged repository order was not stored (${JSON.stringify(rail.persistedRepoNames)} vs ${JSON.stringify(rail.afterDrag)})`
      )
      assert(
        rail.orderRestored === true,
        `the repository order did not come back after dragging it back (${JSON.stringify(rail.afterUndo)})`
      )
    }

    if (rail.sessionOrderAfterDrag) {
      assert(
        rail.sessionOrderAfterDrag[0] === rail.sessionOrderBefore[1] &&
          rail.sessionOrderAfterDrag[1] === rail.sessionOrderBefore[0],
        `dragging a session did not swap the two rows (${JSON.stringify(rail.sessionOrderAfterDrag)})`
      )
      assert(
        JSON.stringify(rail.sessionOrderPersisted) === JSON.stringify(rail.sessionOrderAfterDrag),
        `the dragged session order was not stored (${JSON.stringify(rail.sessionOrderPersisted)})`
      )
      assert(
        rail.sessionOrderRestored === true,
        `the session order did not come back after dragging it back (${JSON.stringify(rail.sessionOrderAfterUndo)})`
      )
    }

    /* ---------------- 6. settings page ---------------- */

    await wc.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('.sidebar-foot button')].find(b => b.textContent.includes('⚙'));
      if (btn) btn.click();
      return true;
    })()`)
    await sleep(4000)

    const settings = await wc.executeJavaScript(`(() => {
      const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
      const kv = [...document.querySelectorAll('.kv dt')].map((dt, i) => {
        const dd = document.querySelectorAll('.kv dd')[i];
        return dt.textContent.trim() + ' = ' + (dd?.textContent?.trim() ?? '');
      });
      const titleCard = [...document.querySelectorAll('.card')]
        .find(c => c.querySelector('.card-head')?.textContent.includes('历史记录标题'));
      const channelRows = [...document.querySelectorAll('.channel-row')];
      const currentRow = channelRows.find(r => r.classList.contains('current')) ?? null;
      return {
        head: text('.view-head h1'),
        diagnostics: kv,
        warnings: [...document.querySelectorAll('.banner.warn')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()),
        cards: [...document.querySelectorAll('.card-head')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()),
        channelRows: channelRows.slice(0, 6).map(r => r.innerText.replace(/\\s+/g, ' ').trim()),
        currentProvider: text('.current-route .pill'),
        // The 当前模型 field is a text box plus a list toggle, found by the name on
        // the box and the label on the button rather than by document order: the
        // page also holds a protocol dropdown inside the create form.
        modelInput: document.querySelector('.picker input[aria-label="当前模型"]')?.value ?? null,
        modelPicker: Boolean(document.querySelector('.picker [aria-label="展开模型列表"]')),
        modelChips: [...document.querySelectorAll('.model-chip')].map(b => b.textContent.trim()),
        currentRowActions: currentRow
          ? [...currentRow.querySelectorAll('.channel-actions button')].map(b => b.textContent.trim())
          : null,
        builtinToggle: text('.section-head .link-btn'),
        backups: document.querySelectorAll('.preview-table tbody tr').length,
        titleCard: titleCard ? { present: true } : null
      };
    })()`)

    step('settings', settings)
    assert(
      settings.titleCard === null && !settings.cards.some((c) => c.includes('历史记录标题')),
      `the removed 历史记录标题 card is still rendered (cards: ${JSON.stringify(settings.cards)})`
    )
    assert(
      settings.channelRows.length > 0,
      `the settings page rendered no channel rows (saw ${JSON.stringify(settings.channelRows)})`
    )
    assert(
      Boolean(settings.currentProvider) && settings.currentProvider !== '未设置',
      `the current-route strip has no provider (${JSON.stringify(settings.currentProvider)})`
    )
    assert(
      settings.builtinToggle === null || /未配置的内置渠道/.test(settings.builtinToggle),
      `the built-in toggle is not labelled as expected (${JSON.stringify(settings.builtinToggle)})`
    )
    // The clickable copy of the channel's catalogue was removed: "current model"
    // has one control, and a channel's models are chosen in its own editor. That
    // control is the picker, whose list is the active channel's own catalogue —
    // checked by looking for both halves, since the field itself may be empty.
    assert(
      settings.modelChips.length === 0,
      `the removed 该渠道的模型 strip is still rendered (${JSON.stringify(settings.modelChips)})`
    )
    assert(
      Boolean(settings.modelInput !== null && settings.modelPicker),
      `设置 has no 当前模型 field (a text box plus a list toggle) (${JSON.stringify(settings)})`
    )

    /* ---------------- 6b. the channel editor ----------------
     * Add and edit share one form, which is where a channel's models are chosen
     * now. Nothing is saved here: the form is opened, inspected and cancelled, so
     * the run never rewrites the user's ocr configuration.
     */
    const editor = await wc.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const out = {};
      const rows = [...document.querySelectorAll('.channel-row')];
      out.channelRows = rows.length;
      out.buttons = rows[0]
        ? [...rows[0].querySelectorAll('.channel-actions button')].map(b => b.textContent.trim())
        : null;

      const edit = rows[0]?.querySelector('.channel-actions button:nth-child(2)');
      out.rowMeta = rows[0]?.querySelector('.channel-meta')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
      edit?.click();
      await sleep(500);
      // Scoped to the row on purpose: the create form is the same component and
      // stays in the document inside its closed details element.
      const form = rows[0]?.querySelector('.channel-edit') ?? null;
      out.formOpen = !!form;
      out.formFields = form
        ? [...form.querySelectorAll('input, select, .picker [role="combobox"]')]
            .map(el => el.getAttribute('role') === 'combobox'
              ? 'combobox'
              : (el.type || el.tagName.toLowerCase()))
        : null;
      out.keyHint = form?.querySelector('.field-hint')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
      out.currentModels = form
        ? [...form.querySelectorAll('.model-option')].map(o => o.textContent.trim())
        : null;

      const fetchBtn = form
        ? [...form.querySelectorAll('button')].find(b => b.textContent.includes('获取模型列表'))
        : null;
      out.fetchButton = fetchBtn ? fetchBtn.textContent.trim() : null;
      if (fetchBtn) {
        fetchBtn.click();
        await sleep(8000);
        out.gridModels = form.querySelectorAll('.model-option input').length;
        out.note = form.querySelector('.models-note')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
        out.checked = form.querySelectorAll('.model-option input:checked').length;
      }

      // The editor sits below the settings page's fold; scroll it into view so
      // the screenshot taken next actually shows the form. Guarded because a
      // missing form must fail the assertion below, not throw here first.
      form?.scrollIntoView({ block: 'center' });
      await sleep(700);
      out.scrolled = true;

      return out;
    })()`)

    // Photographed while the editor is open, before anything is cancelled.
    await shot(win, '07b-channel-editor')

    /* The rest of the stage: cancelling the editor, then the create form. */
    const editorRest = await wc.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const out = {};
      const rows = [...document.querySelectorAll('.channel-row')];

      [...(rows[0]?.querySelectorAll('.channel-edit button') ?? [])]
        .find(b => b.textContent.trim() === '取消')?.click();
      await sleep(400);
      out.formClosed = !rows[0]?.querySelector('.channel-edit');

      // The create form is the same component inside a folded section.
      const summary = [...document.querySelectorAll('details.advanced summary')]
        .find(s => s.textContent.includes('新增自定义渠道'));
      summary?.click();
      await sleep(400);
      const createForm = document.querySelector('details.advanced .channel-edit');
      out.createForm = createForm
        ? {
            hasNameField: !!createForm.querySelector('input[type="text"]'),
            // Named on purpose: a combobox without an accessible name is announced
            // as "combo box" and nothing else.
            hasProtocolPicker: !!createForm.querySelector('.picker [role="combobox"][aria-label="协议"]'),
            hasKeyField: !!createForm.querySelector('input[type="password"]'),
            fetchButton: !!([...createForm.querySelectorAll('button')]
              .find(b => b.textContent.includes('获取模型列表'))),
            submitDisabled: [...createForm.querySelectorAll('button')]
              .find(b => b.textContent.includes('创建渠道'))?.disabled ?? null
          }
        : null;
      out.createFormShot = true;

      // Cancel so the run writes nothing.
      [...(createForm?.querySelectorAll('button') ?? [])]
        .find(b => b.textContent.trim() === '取消')?.click();
      await sleep(300);
      out.createFormClosed = !document.querySelector('details.advanced[open]');
      return out;
    })()`)

    Object.assign(editor, editorRest)
    report.channelEditor = editor
    step('channel-editor', editor)

    assert(editor.formOpen === true, `the channel 编辑 button opened no form (${JSON.stringify(editor)})`)
    assert(
      editor.formFields?.includes('password') === true,
      `the channel editor has no API key field (${JSON.stringify(editor.formFields)})`
    )
    assert(
      /当前密钥/.test(editor.keyHint ?? ''),
      `the open editor does not show the stored (masked) key (${JSON.stringify(editor.keyHint)})`
    )
    assert(
      editor.formClosed === true,
      `cancelling the channel editor left the form open (${JSON.stringify(editor)})`
    )
    assert(
      editor.gridModels > 0 || Boolean(editor.note),
      `asking for the model list produced neither a picker nor an explanation (${JSON.stringify(editor)})`
    )
    // Pre-selection is only meaningful for a channel that already lists models.
    if (/未配置模型/.test(editor.rowMeta ?? '')) {
      log('the first channel lists no models; pre-selection of the catalogue was not exercised')
    } else {
      assert(
        editor.checked > 0,
        `the fetched catalogue did not pre-select the channel's models (${JSON.stringify(editor)})`
      )
    }
    assert(
      editor.createForm?.hasNameField === true &&
        editor.createForm?.hasProtocolPicker === true &&
        editor.createForm?.hasKeyField === true &&
        editor.createForm?.fetchButton === true &&
        editor.createForm?.submitDisabled === true,
      `the create-channel form is not the same editor (${JSON.stringify(editor.createForm)})`
    )
    assert(
      editor.createFormClosed === true,
      `cancelling the create form left it open (${JSON.stringify(editor)})`
    )
    await shot(win, '07-settings')

    /* ---------------- 7. a real review run (optional) ----------------
     * Set SMOKE_REPO to a git repo with a small uncommitted change to exercise
     * the whole run pipeline: spawn, stderr streaming, session-id extraction,
     * and the automatic jump to the results view. This one costs an LLM call.
     */

    const smokeRepo = process.env.SMOKE_REPO
    if (!smokeRepo) {
      log('SMOKE_REPO not set; skipping the real-run stage')
    } else {
      report.realRun = { repoDir: smokeRepo }

      // Pin the repo so it shows up in the rail, then refresh the tree.
      const added = await wc.executeJavaScript(
        `window.ocr.addRepo(${JSON.stringify(smokeRepo)}).then(r => r.ok ? 'ok' : r.error)`
      )
      log(`addRepo: ${added}`)

      await wc.executeJavaScript(`(() => {
        const btn = [...document.querySelectorAll('.sidebar-foot button')].find(b => b.title === '刷新列表');
        if (btn) btn.click();
        return true;
      })()`)
      await sleep(3000)

      const target = await wc.executeJavaScript(`(() => {
        const rows = [...document.querySelectorAll('.repo-row')];
        const row = rows.find(r => r.textContent.includes(${JSON.stringify(
          path.basename(smokeRepo)
        )}));
        if (!row) return { found: false, available: rows.map(r => r.textContent.trim()) };
        row.click();
        return { found: true, name: row.querySelector('.repo-name').textContent.trim() };
      })()`)
      step('real-run-repo-selected', target)

      if (!target.found) {
        report.realRun.error = 'temp repo did not appear in the rail'
      } else {
        await sleep(2500)
        await shot(win, '08-run-configured')

        const started = await wc.executeJavaScript(`(() => {
          const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '启动审查');
          if (!btn) return { clicked: false };
          if (btn.disabled) return { clicked: false, disabled: true };
          btn.click();
          return { clicked: true };
        })()`)
        step('real-run-started', started)

        if (process.env.SMOKE_CANCEL) {
          /* Cancellation: the risky part is `taskkill /T`, because a surviving
           * ocr child keeps spending the user's LLM quota with nothing on screen
           * to show for it. The caller checks for orphan processes afterwards. */
          await sleep(4000)

          const cancelClick = await wc.executeJavaScript(`(() => {
            const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '取消');
            if (!btn) return 'no cancel button';
            btn.click();
            return 'clicked';
          })()`)
          log(`cancel click: ${cancelClick}`)

          // Toasts are transient; poll rather than sample once at the end.
          const toasts = await collectToasts(wc, 10_000)

          const cancelled = await wc.executeJavaScript(`(() => {
            const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
            const startBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '启动审查');
            return {
              logVisible: !!document.querySelector('.log'),
              status: text('.card-head .inline.muted'),
              startEnabled: startBtn ? !startBtn.disabled : null,
              hasSummaryBar: !!document.querySelector('.summary-bar'),
              cancelButtonGone: ![...document.querySelectorAll('button')].some(b => b.textContent.trim() === '取消')
            };
          })()`)

          report.realRun.cancelled = { ...cancelled, toasts }
          step('cancel-outcome', { ...cancelled, toasts })
          await shot(win, '12-cancelled')

          assert(
            toasts.some((t) => t.includes('已取消')),
            `cancelling did not produce a 已取消 toast (saw ${JSON.stringify(toasts)})`
          )
          assert(
            (cancelled.status ?? '').includes('已取消'),
            `the run panel does not show a persistent 已取消 status (saw ${JSON.stringify(cancelled.status)})`
          )
          assert(cancelled.startEnabled !== false, 'start button stayed disabled after cancelling')
          assert(cancelled.cancelButtonGone, 'cancel button was still shown after the run ended')
          assert(!cancelled.hasSummaryBar, 'cancelling still opened a session result')
        } else {
          // Poll for the run to land on the results view (or fail loudly).
          let outcome = null
          for (let attempt = 0; attempt < 100; attempt += 1) {
            await sleep(3000)
            outcome = await wc.executeJavaScript(`(() => {
              const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
              return {
                hasSummaryBar: !!document.querySelector('.summary-bar'),
                head: text('.view-head h1'),
                metrics: [...document.querySelectorAll('.metric')].map(m => m.innerText.replace(/\\s+/g, ' ').trim()),
                findingCount: document.querySelectorAll('.finding').length,
                fileGroups: document.querySelectorAll('.file-group').length,
                empty: text('.empty'),
                toasts: [...document.querySelectorAll('.toast')].map(e => e.textContent.trim()),
                running: !!document.querySelector('.log'),
                progress: text('.card-head .inline.muted')
              };
            })()`)

            if (outcome.hasSummaryBar || outcome.toasts.length) break
          }

          await sleep(1500)
          report.realRun.outcome = outcome
          step('real-run-outcome', outcome)
          await shot(win, '09-run-results')

          assert(
            outcome.hasSummaryBar,
            `the run finished without opening a session (toasts: ${JSON.stringify(outcome.toasts)})`
          )

          // Identify the session the run just produced, so later stages can act
          // on it. Asking the CLI rather than scraping the DOM keeps this
          // independent of how the results view happens to be laid out.
          const newest = await wc.executeJavaScript(
            `window.ocr.listSessions(${JSON.stringify(smokeRepo)}, 0).then(r => {
               if (!r.ok || !r.data.length) return { error: r.ok ? 'no sessions' : r.error };
               const sorted = [...r.data].sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
               return { sessionId: sorted[0].session_id, startTime: sorted[0].start_time, total: r.data.length };
             })`
          )
          report.realRun.newest = newest
          if (newest.sessionId) report.realRun.sessionId = newest.sessionId
          else report.realRun.error = `could not identify the new session: ${JSON.stringify(newest)}`
        }
      }
    }

    /* ---------------- 8. titles, search and deletion ----------------
     * This stage **writes**: the naming backfill stores a generated title on
     * every untitled session in the repo (that is the behaviour under test), one
     * session is renamed, and one is moved to the trash. `SMOKE_REPO` alone only
     * promises "a repository to run a review in" — it is documented as a repo
     * with an uncommitted change, not necessarily a throwaway one — so the
     * mutating stage is a separate, explicit opt-in.
     */
    const mutate = process.env.SMOKE_MUTATE === '1'
    const sessionId = report.realRun?.sessionId ?? null
    // Every untitled session in the repo costs one model call on a serial queue,
    // so the budget has to be adjustable: on a slow gateway a too-small budget
    // reports an environment problem as an application defect.
    const titlePollAttempts = Number(process.env.SMOKE_TITLE_POLL || 90)
    if (!smokeRepo || !sessionId || process.env.SMOKE_CANCEL) {
      log('no fresh session from the real run; skipping the title/search/delete stage')
    } else if (!mutate) {
      log(
        'SMOKE_MUTATE is not set; skipping the title/search/delete stage ' +
          '(it renames sessions and deletes one — set SMOKE_MUTATE=1 only on a throwaway repo)'
      )
    } else {
      report.titles = { sessionId }

      /* 8a. Naming is automatic and runs in the background once the session list
       * is read, so poll for it rather than assuming it finished before the
       * results view appeared. Every session in the repo must end up named —
       * including any that already existed without a title (the setup script can
       * seed one by running `ocr review` directly), which is the backfill path
       * that no button is allowed to be needed for. */
      let autoTitle = null
      for (let attempt = 0; attempt < titlePollAttempts; attempt += 1) {
        autoTitle = await wc.executeJavaScript(
          `window.ocr.listSessions(${JSON.stringify(smokeRepo)}, 0).then(r => {
             if (!r.ok) return { error: r.error };
             const fresh = r.data.find(x => x.session_id === ${JSON.stringify(sessionId)}) ?? null;
             const others = r.data.filter(x => x.session_id !== ${JSON.stringify(sessionId)});
             return {
               total: r.data.length,
               untitledCount: r.data.filter(x => !x.title).length,
               untitledIds: r.data.filter(x => !x.title).map(x => x.session_id),
               freshTitle: fresh ? (fresh.title ?? null) : null,
               freshSource: fresh ? (fresh.titleSource ?? null) : null,
               others: others.map(x => ({ title: x.title ?? null, source: x.titleSource ?? null })),
               othersAllTitled: others.every(x => Boolean(x.title))
             };
           })`
        )
        if (autoTitle.error) break
        if (autoTitle.freshTitle && autoTitle.untitledCount === 0) break
        await sleep(2000)
      }

      step('title-auto', autoTitle)
      if (autoTitle.untitledCount > 0) {
        log(
          `naming did not converge within ${(titlePollAttempts * 2) / 1000}s ` +
            `(${autoTitle.untitledCount} of ${autoTitle.total} still unnamed) — ` +
            'each one costs a model call, so check the gateway too and raise SMOKE_TITLE_POLL if needed'
        )
      }
      assert(
        Boolean(autoTitle.freshTitle),
        `the run did not produce an auto-generated title (saw ${JSON.stringify(autoTitle)})`
      )
      assert(
        autoTitle.freshSource === 'ai',
        `the auto-generated title was not marked as model-written (saw ${JSON.stringify(autoTitle.freshSource)})`
      )
      assert(
        autoTitle.untitledCount === 0,
        `some sessions were left unnamed after ${(titlePollAttempts * 2) / 1000}s ` +
          `(${JSON.stringify(autoTitle.untitledIds)} of ${autoTitle.total}) — naming must not need a button` +
          ` (a slow or rate-limited gateway can look identical; raise SMOKE_TITLE_POLL)`
      )
      assert(
        autoTitle.othersAllTitled === true,
        `pre-existing sessions were not backfilled automatically (saw ${JSON.stringify(autoTitle.others)})`
      )
      if (autoTitle.others?.length) {
        assert(
          autoTitle.others.every((s) => s.source === 'ai'),
          `a backfilled title was not attributed to the model (saw ${JSON.stringify(autoTitle.others)})`
        )
      }

      /* 8b. The title has to reach the rail, which is the whole point of it. Also
       * asserts the absence of a "generate title" button: naming must be an
       * automatic behaviour, not something the user is expected to trigger. */
      const railTitle = await wc.executeJavaScript(`(async () => {
        const repoRow = [...document.querySelectorAll('.repo-row')]
          .find(r => r.textContent.includes(${JSON.stringify(path.basename(smokeRepo))}));
        // Optional chaining on purpose: a missing chevron used to throw inside
        // executeJavaScript, which the outer catch turned into a fatal run with
        // every later assertion's context lost.
        const chevron = repoRow?.querySelector('.chevron');
        if (chevron && !repoRow.querySelector('.chevron.open')) chevron.click();
        await new Promise(r => setTimeout(r, 2500));
        const row = document.querySelector('.session-row[data-session-id="${sessionId}"]');
        return {
          found: !!row,
          name: row?.querySelector('.session-name')?.textContent?.trim() ?? null,
          untitled: row?.querySelector('.session-name')?.classList.contains('untitled') ?? null,
          sub: row?.querySelector('.session-sub')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
          iconTitles: row ? [...row.querySelectorAll('.icon-btn')].map(b => b.title) : null,
          // Naming is automatic, so a row may only offer rename and delete.
          // Matched exactly on purpose: a loose /命名/ would also match 重命名.
          unexpectedButtons: [...document.querySelectorAll('.session-row .icon-btn')]
            .filter(b => !/^(重命名|删除该历史记录)$/.test(b.title))
            .map(b => b.title),
          sessionRowCount: document.querySelectorAll('.session-row').length
        };
      })()`)

      report.titles.rail = railTitle
      step('title-in-rail', railTitle)
      assert(railTitle.found, 'the new session is missing from the sidebar after expanding its repo')
      assert(
        railTitle.name === autoTitle.freshTitle,
        `the sidebar shows ${JSON.stringify(railTitle.name)} but the stored title is ${JSON.stringify(autoTitle.freshTitle)}`
      )
      assert(railTitle.untitled === false, 'a titled session was still styled as untitled')
      assert(
        JSON.stringify(railTitle.iconTitles) === JSON.stringify(['重命名', '删除该历史记录']),
        `a session row offers unexpected actions (${JSON.stringify(railTitle.iconTitles)}) — naming must be automatic`
      )
      assert(
        railTitle.unexpectedButtons.length === 0,
        `the rail exposes a manual action other than rename/delete: ${JSON.stringify(railTitle.unexpectedButtons)}`
      )
      await shot(win, '20-title-generated')

      /* 8c. Manual rename through the row's pencil button. */
      const renameInteraction = await wc.executeJavaScript(`(async () => {
        const row = document.querySelector('.session-row[data-session-id="${sessionId}"]');
        if (!row) return { error: 'row missing' };
        const pencil = [...row.querySelectorAll('.icon-btn')].find(b => b.title === '重命名');
        if (!pencil) return { error: 'rename button missing' };
        pencil.click();
        await new Promise(r => setTimeout(r, 400));
        const input = document.querySelector('.rename-input');
        if (!input) return { error: 'rename input did not appear' };
        input.value = ${JSON.stringify('手工命名的标题')};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return { typed: true };
      })()`)
      log(`rename interaction: ${JSON.stringify(renameInteraction)}`)

      // Renaming writes through IPC, then updates the rail.
      await sleep(2500)
      const afterRename = await titleSnapshot(wc, smokeRepo, sessionId)

      report.titles.renamed = afterRename
      step('title-renamed', afterRename)
      assert(
        afterRename.stored === '手工命名的标题',
        `the rename did not persist (stored ${JSON.stringify(afterRename.stored)})`
      )
      assert(
        afterRename.source === 'user',
        `the renamed title was not recorded as user-written (saw ${JSON.stringify(afterRename.source)})`
      )
      assert(
        afterRename.railName === '手工命名的标题',
        `the sidebar did not pick up the rename (saw ${JSON.stringify(afterRename.railName)})`
      )
      assert(afterRename.renameFieldOpen === false, 'the rename field stayed open after pressing Enter')
      await shot(win, '21-title-renamed')

      /* 8d. Regenerating must not overwrite a name the user chose. Nothing in the
       * UI can trigger this any more, but the rule lives in the main process so
       * it holds however the call arrives. */
      const refused = await wc.executeJavaScript(
        `window.ocr.generateTitle(${JSON.stringify(smokeRepo)}, ${JSON.stringify(sessionId)})
           .then(r => r.ok ? { applied: r.data.applied, title: r.data.title } : { error: r.error })`
      )
      step('title-regenerate-refused', refused)
      assert(
        refused.applied === false,
        `regenerating overwrote a manually renamed title (result ${JSON.stringify(refused)})`
      )
      assert(
        refused.title === '手工命名的标题',
        `the manual title changed after a regenerate (saw ${JSON.stringify(refused.title)})`
      )

      /* 8e. Searching by title has to surface the session it belongs to. */
      const search = await wc.executeJavaScript(`(async () => {
        const input = document.querySelector('.search input');
        if (!input) return { error: 'search box missing' };
        input.value = '手工命名';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 3000));
        const hits = [...document.querySelectorAll('.search-hit')];
        return {
          hits: hits.length,
          titles: hits.map(h => h.querySelector('.hit-title')?.textContent?.trim() ?? null),
          meta: hits[0]?.querySelector('.hit-meta')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
          ids: hits.map(h => h.dataset.sessionId)
        };
      })()`)

      report.titles.search = search
      step('title-search', search)
      assert(search.hits > 0, `searching by title found nothing (saw ${JSON.stringify(search)})`)
      assert(
        search.ids.includes(sessionId),
        `the search result list does not contain the matching session (saw ${JSON.stringify(search.ids)})`
      )
      await shot(win, '22-title-search')

      /* 8f. Emptying the rename field hands the session back to automatic naming —
       * there is no "regenerate" button, so this is how a stale name is replaced.
       * The transient untitled state is sampled right after the commit, before the
       * model can answer. */
      const cleared = await wc.executeJavaScript(`(async () => {
        const input = document.querySelector('.search input');
        // Checked like 8e does: without this a renamed selector rejected the
        // whole script and the outer catch turned it into a fatal run.
        if (!input) return { error: 'search box missing' };
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 1500));

        const row = document.querySelector('.session-row[data-session-id="${sessionId}"]');
        if (!row) return { error: 'row missing' };
        const pencil = [...row.querySelectorAll('.icon-btn')].find(b => b.title === '重命名');
        if (!pencil) return { error: 'rename button missing' };
        pencil.click();
        await new Promise(r => setTimeout(r, 400));
        const field = document.querySelector('.rename-input');
        if (!field) return { error: 'rename input did not appear' };
        field.value = '';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

        // Sampled in-page right after the commit, before the model can answer
        // (an IPC round trip here would already be too late to be evidence).
        await new Promise(r => setTimeout(r, 600));
        const name = document.querySelector('.session-row[data-session-id="${sessionId}"] .session-name');
        return {
          committed: true,
          transientUntitled: name?.classList.contains('untitled') ?? null,
          transientLabel: name?.textContent?.trim() ?? null
        };
      })()`)
      log(`clear-title interaction: ${JSON.stringify(cleared)}`)
      assert(!cleared.error, `clearing the title failed: ${JSON.stringify(cleared)}`)

      // Poll until the model has named it again, with no button pressed.
      let renamed = null
      const regenerateAttempts = Math.max(30, Math.ceil(titlePollAttempts / 3))
      for (let attempt = 0; attempt < regenerateAttempts; attempt += 1) {
        renamed = await titleSnapshot(wc, smokeRepo, sessionId)
        if (renamed?.stored && renamed.stored !== '手工命名的标题') break
        await sleep(2000)
      }

      report.titles.renamedAutomatically = { ...renamed, transient: cleared }
      step('title-auto-renamed', renamed)
      assert(
        Boolean(renamed?.stored) && renamed.stored !== '手工命名的标题',
        `emptying the title did not trigger automatic renaming within ` +
          `${(regenerateAttempts * 2) / 1000}s (saw ${JSON.stringify(renamed)})`
      )
      assert(
        renamed.source === 'ai',
        `the replacement title was not attributed to the model (saw ${JSON.stringify(renamed.source)})`
      )
      assert(
        renamed.railName === renamed.stored,
        `the rail did not pick up the automatically generated name (rail ${JSON.stringify(renamed.railName)} vs stored ${JSON.stringify(renamed.stored)})`
      )
      await shot(win, '23-title-auto-renamed')

      /* 8h. Deleting a history entry. The record must leave the list *and* the
       * CLI's own view of the repo, otherwise the row would come back on the
       * next refresh. */
      const before = await wc.executeJavaScript(
        `window.ocr.listSessions(${JSON.stringify(smokeRepo)}, 0).then(r => r.ok ? r.data.length : -1)`
      )

      const deleteClick = await wc.executeJavaScript(`(async () => {
        const row = document.querySelector('.session-row[data-session-id="${sessionId}"]');
        if (!row) return { error: 'row missing' };
        const bin = [...row.querySelectorAll('.icon-btn')].find(b => b.title === '删除该历史记录');
        if (!bin) return { error: 'delete button missing' };
        bin.click();
        await new Promise(r => setTimeout(r, 500));

        const modal = document.querySelector('.modal');
        if (!modal) return { error: 'confirmation dialog did not open' };
        const confirm = [...modal.querySelectorAll('.modal-actions button')].find(b => b.textContent.trim() === '删除');
        if (!confirm) return { error: 'confirm button missing' };
        const heading = modal.querySelector('h3')?.textContent?.trim() ?? null;
        const detail = modal.querySelector('.modal-detail')?.textContent?.trim() ?? null;
        confirm.click();
        return { heading, detail, confirmed: true };
      })()`)
      log(`delete interaction: ${JSON.stringify(deleteClick)}`)
      assert(!deleteClick.error, `deleting from the sidebar failed: ${JSON.stringify(deleteClick)}`)
      assert(
        deleteClick.heading === '删除这条审查历史？',
        `the delete confirmation was not shown (saw ${JSON.stringify(deleteClick.heading)})`
      )

      const toasts = await collectToasts(wc, 8000)
      await sleep(2500)

      const after = await wc.executeJavaScript(
        `window.ocr.listSessions(${JSON.stringify(smokeRepo)}, 0).then(r => ({
           count: r.ok ? r.data.length : -1,
           stillThere: r.ok ? r.data.some(x => x.session_id === ${JSON.stringify(sessionId)}) : null,
           rowGone: !document.querySelector('.session-row[data-session-id="${sessionId}"]'),
           // The dialog now stays open until the delete actually finishes, so it
           // must be gone by the time the toast has been seen.
           dialogGone: !document.querySelector('.modal')
         }))`
      )

      report.titles.deleted = { before, after, toasts }
      step('title-deleted', { before, after, toasts })
      assert(after.stillThere === false, 'the deleted session is still listed by the CLI')
      assert(
        before >= 0 && after.count === before - 1,
        `the session count did not drop by one (before ${before}, after ${after.count})`
      )
      assert(after.rowGone, 'the deleted session is still visible in the sidebar')
      assert(after.dialogGone, 'the confirmation dialog stayed open after the delete finished')
      assert(
        toasts.some((t) => t.includes('已删除')),
        `deleting produced no confirmation toast (saw ${JSON.stringify(toasts)})`
      )
      await shot(win, '24-title-deleted')
    }

    report.consoleErrors = consoleErrors
    finish(0)
  } catch (err) {
    report.fatal = `${err && err.stack ? err.stack : String(err)}`
    log(`FATAL ${report.fatal}`)
    finish(1)
  }
})

function finish(code) {
  // A broken invariant fails the run even when every stage produced output.
  const exit = report.violations.length ? 1 : code
  report.exitCode = exit
  // Real input is reported, never silently tolerated: if this is non-empty the
  // run was disturbed from outside and its failures may not be the app's.
  report.externalInput = externalInput
  report.externalInputCount = externalInput.length
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2))
  log(
    `done, exit=${exit}${report.violations.length ? ` (${report.violations.length} violations)` : ''}` +
      `, real OS input events: ${externalInput.length}`
  )
  app.exit(exit)
}
