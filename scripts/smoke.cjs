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
 * Usage:
 *   yarn build
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
 *
 * Artifacts land in smoke-out/ (log, JSON report, PNG screenshots).
 */

const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, dialog } = require('electron')

const OUT_DIR = path.join(__dirname, '..', 'smoke-out')
fs.mkdirSync(OUT_DIR, { recursive: true })

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

    log(`range mode: ${await clickMode('分支区间')}`)
    await sleep(3000)
    const rangeMode = await wc.executeJavaScript(`(() => {
      const selects = [...document.querySelectorAll('select')];
      return {
        selectCount: selects.length,
        values: selects.map(s => s.value),
        optionCounts: selects.map(s => s.options.length),
        sampleOptions: selects[0] ? [...selects[0].options].slice(0, 6).map(o => o.textContent.trim()) : []
      };
    })()`)
    step('range-mode', rangeMode)
    await shot(win, '10-range-mode')

    log(`commit mode: ${await clickMode('单提交')}`)
    await sleep(3000)
    const commitMode = await wc.executeJavaScript(`(() => {
      const select = document.querySelector('select');
      return {
        optionCount: select ? select.options.length : 0,
        sampleOptions: select ? [...select.options].slice(1, 6).map(o => o.textContent.trim()) : []
      };
    })()`)
    step('commit-mode', commitMode)
    await shot(win, '11-commit-mode')

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
      return {
        head: text('.view-head h1'),
        diagnostics: kv,
        warnings: [...document.querySelectorAll('.banner.warn')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()),
        cards: [...document.querySelectorAll('.card-head')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()),
        providerRows: [...document.querySelectorAll('.preview-table tbody tr')].slice(0, 6).map(r => r.innerText.replace(/\\s+/g, ' ').trim()),
        currentProvider: text('.pill'),
        modelInput: document.querySelector('input[list="model-options"]')?.value ?? null,
        backups: document.querySelectorAll('.preview-table tbody tr').length,
        titleCard: titleCard ? {
          autoTitleChecked: titleCard.querySelector('input[type=checkbox]')?.checked ?? null,
          providerOptions: titleCard.querySelectorAll('select option').length,
          modelPlaceholder: titleCard.querySelector('input[type=text]')?.placeholder ?? null,
          buttons: [...titleCard.querySelectorAll('button')].map(b => b.textContent.trim()),
          generationTriggers: [...titleCard.querySelectorAll('button')]
            .filter(b => /生成|补标题|开始/.test(b.textContent)).length
        } : null
      };
    })()`)

    step('settings', settings)
    assert(
      settings.cards.some((c) => c.includes('历史记录标题')),
      `the settings page is missing the title card (saw ${JSON.stringify(settings.cards)})`
    )
    assert(
      settings.titleCard?.autoTitleChecked === true,
      `auto-titling is off by default (saw ${JSON.stringify(settings.titleCard)})`
    )
    assert(
      settings.titleCard?.generationTriggers === 0,
      `the settings page still exposes a manual trigger for title generation (buttons: ${JSON.stringify(settings.titleCard?.buttons)})`
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
