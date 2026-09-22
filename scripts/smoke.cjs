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
 *   npm run build
 *   node_modules\.bin\electron scripts\smoke.cjs
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

function step(name, data) {
  report.steps.push({ name, ...data })
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
      return {
        head: text('.view-head h1'),
        diagnostics: kv,
        warnings: [...document.querySelectorAll('.banner.warn')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()),
        cards: [...document.querySelectorAll('.card-head')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()),
        providerRows: [...document.querySelectorAll('.preview-table tbody tr')].slice(0, 6).map(r => r.innerText.replace(/\\s+/g, ' ').trim()),
        currentProvider: text('.pill'),
        modelInput: document.querySelector('input[list="model-options"]')?.value ?? null,
        backups: document.querySelectorAll('.preview-table tbody tr').length
      };
    })()`)

    step('settings', settings)
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
        }
      }
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
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2))
  log(`done, exit=${exit}${report.violations.length ? ` (${report.violations.length} violations)` : ''}`)
  app.exit(exit)
}
