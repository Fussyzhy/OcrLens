/**
 * Sidebar structure probe.
 *
 * A smoke run once reported a session opening into a different repository's
 * results view, and the rail showing fifteen session rows although only two
 * chevrons had been clicked. This dumps the actual DOM structure — which repo
 * block owns which rows — instead of inferring it from screenshots, because "a
 * row appeared somewhere" is exactly what a screenshot makes ambiguous.
 *
 * Kept because it is the quickest way to check a suspicion about the rail:
 * it expands exactly one repo, clicks exactly one row, and prints the resulting
 * structure for each step. See the last entry of「验证情况」in README.md.
 *
 * Usage:
 *   yarn compile
 *   node_modules\.bin\electron scripts\probe-sidebar.cjs
 *   # results in smoke-out/probe.log
 *
 * PROBE_REPO=<substring> picks the repository to expand; without it the first
 * row is used. The repo name used to be hardcoded, which made the script work on
 * exactly one machine.
 */

const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

/** Substring of the repo name to probe; empty means "the first row". */
const REPO_MATCH = process.env.PROBE_REPO ?? ''

const OUT = path.join(__dirname, '..', 'smoke-out')
fs.mkdirSync(OUT, { recursive: true })
const LOG = path.join(OUT, 'probe.log')
fs.writeFileSync(LOG, '')

function log(message) {
  fs.appendFileSync(LOG, message + '\n')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

require('../out/main/index.js')

app.whenReady().then(async () => {
  try {
    await sleep(9000)
    const win = BrowserWindow.getAllWindows()[0]
    const wc = win.webContents

    const repos = await wc.executeJavaScript(
      `window.ocr.listRepos().then(r => r.ok
         ? r.data.map(x => ({ name: x.name, dir: x.dir, key: x.key, count: x.sessionCount }))
         : { error: r.error })`
    )
    log('REPOS_FROM_IPC ' + JSON.stringify(repos, null, 2))

    const dump = async (label) => {
      const data = await wc.executeJavaScript(`(() => {
        const blocks = [...document.querySelectorAll('.repo')];
        const allRows = [...document.querySelectorAll('.session-row')];
        return {
          repoBlockCount: blocks.length,
          repoBlockNames: blocks.map(b => b.querySelector('.repo-name')?.textContent?.trim() ?? null),
          structure: blocks.map(b => {
            const row = b.querySelector('.repo-row');
            const box = b.querySelector('.sessions');
            const rows = box ? [...box.querySelectorAll('.session-row')] : [];
            return {
              name: row?.querySelector('.repo-name')?.textContent?.trim() ?? null,
              chevronOpen: row?.querySelector('.chevron')?.classList.contains('open') ?? null,
              active: row?.classList.contains('active') ?? null,
              hasSessionsBox: !!box,
              rowsInside: rows.length,
              idsInside: rows.map(r => (r.dataset.sessionId || '').slice(0, 8)),
              labels: rows.map(r => r.querySelector('.session-name')?.textContent?.trim() ?? null)
            };
          }),
          totalSessionRows: allRows.length,
          rowsNotInsideARepoBlock: allRows.filter(r => !r.closest('.repo')).length,
          activeSessionIds: [...document.querySelectorAll('.session-row.active')].map(r => (r.dataset.sessionId || '').slice(0, 8)),
          activeRepoBlocks: blocks.filter(b => b.querySelector('.repo-row.active')).map(b => b.querySelector('.repo-name')?.textContent?.trim() ?? null),
          searchHits: document.querySelectorAll('.search-hit').length,
          searchValue: document.querySelector('.search input')?.value ?? null,
          viewHead: document.querySelector('.view-head h1')?.textContent?.trim() ?? null,
          sidebarText: document.querySelector('.tree')?.innerText?.replace(/\\n+/g, ' | ').slice(0, 700) ?? null
        };
      })()`)
      log(`\n===== ${label} =====\n` + JSON.stringify(data, null, 2))
      return data
    }

    await dump('INITIAL')

    const expanded = await wc.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('.repo-row')];
      const match = ${JSON.stringify(REPO_MATCH)};
      const row = (match ? rows.find(r => r.textContent.includes(match)) : rows[0]) ?? null;
      if (!row) return { error: match ? 'no row matching ' + match : 'no repo rows at all', available: rows.map(r => r.textContent.trim()) };
      const chevron = row.querySelector('.chevron');
      if (!chevron) return { error: 'row has no chevron' };
      if (chevron.classList.contains('open')) return { alreadyOpen: true, name: row.textContent.trim() };
      chevron.click();
      return { clicked: true, name: row.textContent.trim() };
    })()`)
    log('\nEXPAND_REPO ' + JSON.stringify(expanded))

    await sleep(7000)
    await dump('AFTER_EXPANDING_ONLY_ONE_REPO')

    const clickedRow = await wc.executeJavaScript(`(() => {
      const blocks = [...document.querySelectorAll('.repo')];
      const match = ${JSON.stringify(REPO_MATCH)};
      const block = (match
        ? blocks.find(b => b.querySelector('.repo-name')?.textContent?.includes(match))
        : blocks[0]) ?? null;
      if (!block) return { error: match ? 'no block matching ' + match : 'no repo blocks at all' };
      const rows = [...block.querySelectorAll('.session-row')];
      if (!rows.length) return { error: 'no session rows inside the selected repo' };
      const target = rows[0];
      const info = {
        id: (target.dataset.sessionId || '').slice(0, 8),
        label: target.querySelector('.session-name')?.textContent?.trim() ?? null,
        rowTitle: target.getAttribute('title')
      };
      target.click();
      return info;
    })()`)
    log('\nCLICKED_ROW ' + JSON.stringify(clickedRow, null, 2))

    await sleep(10000)
    await dump('AFTER_CLICKING_ONE_REPO_ROW')

    log('\nDONE')
    app.exit(0)
  } catch (err) {
    log('FATAL ' + (err && err.stack ? err.stack : String(err)))
    app.exit(1)
  }
})
