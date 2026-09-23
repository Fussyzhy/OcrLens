/**
 * Isolated probe for the rail and channel main-process surfaces.
 *
 * Runs the real built app against a throwaway HOME/APPDATA/userData, so the
 * destructive and writing paths (repository delete moving session files into the
 * client trash, repository/session ordering, repository rename, channel save via
 * the ocr CLI) are exercised for real without touching the user's own history,
 * config or client state.
 *
 * This is deliberately separate from `smoke.cjs`: the smoke drives the UI and
 * must not delete anyone's repository, while these paths can only be checked
 * honestly by actually writing — so they write into a temporary tree and the probe
 * reports what landed where.
 *
 * Usage:
 *   yarn build
 *   node_modules\.bin\electron scripts\probe-rails.cjs
 *
 * Environment:
 *   PROBE_ISOLATE=1   make the window click-through and unfocused, so a stray
 *                     click on the desktop cannot disturb the run
 *
 * Artifacts land in smoke-out/probe-rails.json; the temporary tree is removed
 * again whatever the outcome.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { app, BrowserWindow } = require('electron')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rail-probe-'))
const home = path.join(root, 'home')
const userData = path.join(root, 'userdata')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(userData, { recursive: true })

// Must happen before the app's own modules ask for a path.
app.setPath('userData', userData)

const layoutPath = path.join(userData, 'sidebar-layout.json')

const repoA = path.join(root, 'repo-a')
const repoB = path.join(root, 'repo-b')
for (const dir of [repoA, repoB]) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' })
}

/**
 * The CLI's session storage key for a directory.
 *
 * `C:\Users\admin\x` becomes `C_Users-admin-x`: the drive's own separator turns
 * into the underscore, the separators after it into dashes. This matters — a key
 * built any other way is a directory `ocr` itself will not look in, so a fixture
 * using one would test a layout that cannot exist.
 */
const flatten = (dir) => dir.replace(/^([A-Za-z]):[\\/]/, '$1_').replace(/[\\/]/g, '-')

/**
 * Seed titles for the sessions about to be deleted, plus one for the repository
 * that stays. The delete must drop exactly the deleted repository's titles — in one
 * write, which is why `removeTitles` exists — and leave the other one alone.
 */
fs.writeFileSync(
  path.join(userData, 'session-titles.json'),
  JSON.stringify(
    Object.fromEntries(
      ['sess-a1', 'sess-a2', 'sess-a3', 'sess-a4', 'sess-b1'].map((id) => [
        id,
        { title: `标题 ${id}`, source: 'ai', updatedAt: '2026-01-01T00:00:00.000Z' }
      ])
    ),
    null,
    2
  )
)

const sessionsRoot = path.join(home, '.opencodereview', 'sessions')
const keyA = path.join(sessionsRoot, flatten(repoA))
const keyB = path.join(sessionsRoot, flatten(repoB))
fs.mkdirSync(keyA, { recursive: true })
fs.mkdirSync(keyB, { recursive: true })

/**
 * Seed a hand-edited layout file before the app ever reads one.
 *
 * The stored keys are deliberately messy — upper case and a trailing separator, as
 * someone editing JSON by hand would leave them — and the order is the reverse of
 * the activity order (`repo-b` was written last, so it is the newer one). If the
 * reader did not normalize what it loads, none of these keys would match and the
 * rail would silently fall back to the activity order instead.
 */
fs.writeFileSync(
  layoutPath,
  JSON.stringify(
    {
      repoOrder: [repoA.toUpperCase() + path.sep, repoB.toUpperCase() + path.sep],
      repoAliases: {},
      sessionOrder: {}
    },
    null,
    2
  )
)

const record = (cwd) => `${JSON.stringify({ type: 'session_start', cwd })}\n`
const recordRepoDir = (cwd) => `${JSON.stringify({ type: 'session_start', repo_dir: cwd })}\n`

// Written first so the newest-file scan in `listRepos` lands on a valid record:
// these two cannot be attributed to any repository and must be reported, not
// moved, when the repository is deleted.
fs.writeFileSync(path.join(keyA, 'bad name!.jsonl'), record(repoA))
fs.writeFileSync(path.join(keyA, 'unreadable.jsonl'), '{')
fs.writeFileSync(path.join(keyA, 'sess-a1.jsonl'), record(repoA))
fs.writeFileSync(path.join(keyA, 'sess-a2.jsonl'), record(repoA))
fs.writeFileSync(path.join(keyA, 'sess-a3.jsonl'), recordRepoDir(repoA))
fs.writeFileSync(path.join(keyA, 'sess-a4.jsonl'), record(repoA))
fs.writeFileSync(path.join(keyB, 'sess-b1.jsonl'), record(repoB))

// The app resolves `~` from the environment when it runs, so this is set before
// the app module is loaded.
process.env.USERPROFILE = home
process.env.HOME = home

require('../out/main/index.js')

const results = { root, checks: [], failures: [] }

function check(name, ok, detail) {
  results.checks.push({ name, ok, detail })
  if (!ok) results.failures.push(`${name}: ${JSON.stringify(detail)}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function finish(code) {
  results.exitCode = results.failures.length ? 1 : code
  const outDir = path.join(__dirname, '..', 'smoke-out')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'probe-rails.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
  app.exit(results.exitCode)
}

const configPath = path.join(home, '.opencodereview', 'config.json')
const settingsPath = path.join(userData, 'settings.json')

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return { error: err.message }
  }
}

app.whenReady().then(async () => {
  await sleep(500)
  const windows = BrowserWindow.getAllWindows()
  if (!windows.length) {
    results.fatal = 'no window'
    finish(1)
    return
  }

  const wc = windows[0].webContents
  if (process.env.PROBE_ISOLATE === '1') {
    // Same reasoning as the smoke: a click-through, unfocused window cannot be
    // disturbed from outside while the probe is driving the IPC surface.
    windows[0].setIgnoreMouseEvents(true)
    windows[0].blur()
  }
  if (wc.isLoading()) await new Promise((resolve) => wc.once('did-finish-load', resolve))
  // Environment probing spawns git; give it real time.
  await sleep(8000)

  const run = (script) => wc.executeJavaScript(script)

  try {
    /* 1. both repositories are discovered from the seeded session storage */
    const listed = await run(`window.ocr.listRepos().then(r => r.ok ? r.data.map(x => ({
      name: x.name, dir: x.dir, count: x.sessionCount
    })) : { error: r.error })`)
    results.listRepos = listed
    check(
      'both repositories discovered',
      Array.isArray(listed) && listed.length === 2 && listed.every((r) => r.dir),
      listed
    )
    // The seeded file asked for repo-a first; the activity order is the opposite
    // (repo-b's session file was written last), so this only holds if the messy
    // stored keys were normalized into matches.
    check(
      'a hand-edited order is normalized and applied',
      Array.isArray(listed) && JSON.stringify(listed.map((r) => r.name)) === JSON.stringify(['repo-a', 'repo-b']),
      listed.map((r) => r?.name)
    )

    /* 2. ordering: the stored order wins over the activity order */
    const ordered = await run(
      `window.ocr.reorderRepos(${JSON.stringify([repoB, repoA])}).then(r => r.ok ? r.data : { error: r.error })`
    )
    results.reorderRepos = ordered
    const afterOrder = await run(
      `window.ocr.listRepos().then(r => r.ok ? r.data.map(x => x.name) : null)`
    )
    check(
      'repo order persisted',
      JSON.stringify(afterOrder) === JSON.stringify(['repo-b', 'repo-a']),
      afterOrder
    )

    /* 3. rename: the rail label only, and it can be restored */
    const renamed = await run(
      `window.ocr.renameRepo(${JSON.stringify(repoA)}, '别名 A').then(r => r.ok ? r.data : { error: r.error })`
    )
    const afterRename = await run(
      `window.ocr.listRepos().then(r => r.ok ? r.data.map(x => x.name) : null)`
    )
    check(
      'repo rename stored',
      renamed === '别名 A' && afterRename.includes('别名 A'),
      { renamed, afterRename }
    )

    const restored = await run(
      `window.ocr.renameRepo(${JSON.stringify(repoA)}, null).then(r => r.ok ? r.data : { error: r.error })`
    )
    const afterRestore = await run(
      `window.ocr.listRepos().then(r => r.ok ? r.data.map(x => x.name) : null)`
    )
    check(
      'repo rename cleared',
      restored === null && afterRestore.includes('repo-a'),
      { restored, afterRestore }
    )

    /* 4. session order is stored per repository. The CLI cannot list these
     * synthetic files, so this checks the write; the arranged order is applied by
     * `applySessionOrder`, which the UI probe covers against real history. */
    const wanted = ['sess-a3', 'sess-a1', 'sess-a2']
    await run(
      `window.ocr.reorderSessions(${JSON.stringify(repoA)}, ${JSON.stringify(wanted)}).then(r => r.ok ? r.data : { error: r.error })`
    )
    const layoutAfterSessions = readJson(layoutPath)
    check(
      'session order persisted',
      JSON.stringify(layoutAfterSessions.sessionOrder?.[path.resolve(repoA).toLowerCase()]) ===
        JSON.stringify(wanted),
      layoutAfterSessions.sessionOrder
    )

    /* 5. a channel can be created, then edited, through one batched write */
    const created = await run(`window.ocr.saveProvider({
      name: 'probe-channel', custom: true, url: 'http://127.0.0.1:9/v1',
      protocol: 'openai', apiKey: 'sk-probe', models: ['m1', 'm2']
    }).then(r => r.ok ? r.data : { error: r.error })`)
    results.providerCreate = created
    const afterCreate = readJson(configPath)
    results.configAfterCreate = afterCreate.custom_providers ?? null
    check(
      'channel created through the CLI',
      created.ok === true &&
        afterCreate.custom_providers?.['probe-channel']?.url === 'http://127.0.0.1:9/v1' &&
        JSON.stringify(afterCreate.custom_providers?.['probe-channel']?.models) ===
          JSON.stringify(['m1', 'm2']) &&
        afterCreate.custom_providers?.['probe-channel']?.api_key === 'sk-probe',
      afterCreate.custom_providers
    )

    // Editing without a key must keep the stored one, and emptying the catalogue
    // must remove the key rather than store an empty name.
    const edited = await run(`window.ocr.saveProvider({
      name: 'probe-channel', custom: true, url: 'http://127.0.0.1:9/v2',
      protocol: 'openai-responses', models: []
    }).then(r => r.ok ? r.data : { error: r.error })`)
    results.providerEdit = edited
    const afterEdit = readJson(configPath)
    results.configAfterEdit = afterEdit.custom_providers ?? null
    const entry = afterEdit.custom_providers?.['probe-channel'] ?? {}
    check(
      'channel edited without losing the key',
      edited.ok === true &&
        entry.url === 'http://127.0.0.1:9/v2' &&
        entry.protocol === 'openai-responses' &&
        entry.api_key === 'sk-probe' &&
        entry.models === undefined,
      entry
    )
    check(
      'every key of the batch is reported',
      Array.isArray(created.keys) && created.keys.length === 4 && Array.isArray(edited.keys),
      { created: created.keys, edited: edited.keys }
    )

    /* 6. an unreachable gateway is reported, not swallowed */
    const probeError = await run(`window.ocr.fetchProviderModels({
      name: 'probe-channel', custom: true, url: 'http://127.0.0.1:9/v1', protocol: 'openai',
      apiKey: 'sk-probe'
    }).then(r => r.ok ? { ok: true, models: r.data.models.length } : { ok: false, error: r.error })`)
    results.modelProbe = probeError
    check(
      'an unreachable gateway produces an honest error',
      probeError.ok === false && typeof probeError.error === 'string' && probeError.error.length > 3,
      probeError
    )

    /* 6b. one name in both tables resolves the same way everywhere.
     *
     * The CLI refuses to build this state itself — it answers `custom provider name
     * "openai" conflicts with a preset provider` and quietly files a `providers.<new
     * name>` write under `custom_providers` — so a hand-edited config.json is the only
     * way in, which is exactly why the resolution rule has to live in one place. */
    const handEdited = readJson(configPath)
    handEdited.providers = {
      ...(handEdited.providers ?? {}),
      openai: { url: 'http://127.0.0.1:8/v9', protocol: 'openai', api_key: 'sk-builtin' }
    }
    handEdited.custom_providers = {
      ...(handEdited.custom_providers ?? {}),
      openai: { url: 'http://127.0.0.1:9/v9', protocol: 'openai', api_key: 'sk-custom' }
    }
    fs.writeFileSync(configPath, JSON.stringify(handEdited, null, 4))

    // Asked for as an *edit of the built-in table*, which is the case where a lookup
    // that preferred the requested table would talk to a different address than the
    // settings page displays.
    const priority = await run(`window.ocr.fetchProviderModels({
      name: 'openai', custom: false, url: '', protocol: '', apiKey: ''
    }).then(r => r.ok ? { ok: true } : { ok: false, error: r.error })`)
    results.tablePriority = priority
    check(
      'custom_providers wins when a name is in both tables',
      priority.ok === false && /127\.0\.0\.1:9/.test(priority.error ?? ''),
      priority
    )

    /* 7. deleting the repository trashes its whole history */
    const deleted = await run(
      `window.ocr.deleteRepo(${JSON.stringify(repoA)}).then(r => r.ok ? r.data : { error: r.error })`
    )
    results.deleteRepo = deleted
    check('delete trashed every session', deleted.trashed === 4, deleted)

    const titlesAfterDelete = readJson(path.join(userData, 'session-titles.json'))
    results.titlesAfterDelete = titlesAfterDelete
    check(
      'the deleted sessions lost their titles, the survivors kept theirs',
      ['sess-a1', 'sess-a2', 'sess-a3', 'sess-a4'].every((id) => !(id in titlesAfterDelete)) &&
        titlesAfterDelete['sess-b1']?.title === '标题 sess-b1',
      titlesAfterDelete
    )
    check(
      'unattributable files were reported, not moved',
      Array.isArray(deleted.skipped) && deleted.skipped.length === 2,
      deleted.skipped
    )

    const trashedFiles = fs.readdirSync(deleted.trashDir ?? userData)
    results.trashedFiles = trashedFiles
    check('trash holds the moved files', trashedFiles.length === 4, trashedFiles)

    const keyANames = fs.readdirSync(keyA).sort()
    check(
      'the unreadable files stay behind',
      JSON.stringify(keyANames) === JSON.stringify(['bad name!.jsonl', 'unreadable.jsonl']),
      keyANames
    )

    const afterDelete = await run(
      `window.ocr.listRepos().then(r => r.ok ? r.data.map(x => ({ name: x.name, dir: x.dir })) : null)`
    )
    results.afterDelete = afterDelete
    const lower = repoA.toLowerCase()
    check(
      'deleted repository is gone from the rail',
      Array.isArray(afterDelete) && !afterDelete.some((entry) => entry.dir.toLowerCase() === lower),
      afterDelete
    )
    check(
      'the surviving repository is still listed',
      Array.isArray(afterDelete) &&
        afterDelete.some((entry) => entry.dir.toLowerCase() === repoB.toLowerCase()),
      afterDelete
    )

    const layout = readJson(layoutPath)
    results.layout = layout
    const key = path.resolve(repoA).toLowerCase()
    check(
      'layout forgot the deleted repository',
      !layout.repoAliases?.[key] && !layout.sessionOrder?.[key] && !layout.repoOrder?.includes(key),
      layout
    )
    check(
      'layout kept the surviving repository',
      layout.repoOrder?.includes(path.resolve(repoB).toLowerCase()),
      layout.repoOrder
    )

    const settings = readJson(settingsPath)
    results.settings = settings
    check(
      'the deleted repository is ignored from now on',
      Array.isArray(settings.ignoredRepos) && settings.ignoredRepos.length === 1,
      settings
    )

    /* 8. saving a channel through its own form.
     *
     * The IPC-level checks above build plain objects by hand, so they cannot see
     * the one thing the form can get wrong: a payload assembled out of Vue refs.
     * A `ref`'s value is a reactive proxy and the structured clone behind IPC
     * refuses those ("An object could not be cloned."), which is a failure the user
     * meets as a toast and the config file never hears about. */
    const formFlow = await run(`(async () => {
      const out = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const clickIf = (el) => { if (el) el.click(); return Boolean(el); };

      clickIf([...document.querySelectorAll('.sidebar-foot button')]
        .find((b) => b.textContent.includes('⚙')));
      await sleep(4000);

      const row = [...document.querySelectorAll('.channel-row')]
        .find((r) => r.querySelector('.channel-name')?.textContent.includes('probe-channel'));
      out.rowFound = Boolean(row);
      const edit = row && [...row.querySelectorAll('.channel-actions button')]
        .find((b) => b.textContent.trim() === '编辑');
      out.editClicked = clickIf(edit);
      await sleep(600);

      const form = row?.querySelector('form.channel-edit');
      out.formFound = Boolean(form);
      const submit = form?.querySelector('button[type=submit]');
      out.submitLabel = submit?.textContent?.trim() ?? null;
      out.submitEnabled = submit ? !submit.disabled : null;

      // Tick one model through the form's own control, so the array it submits is
      // built by the component rather than handed to it ready-made.
      const manual = form?.querySelector('input[placeholder*="手动补充"]');
      out.manualFound = Boolean(manual);
      if (manual) {
        manual.value = 'm9-manual';
        manual.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(200);
        clickIf([...form.querySelectorAll('button')].find((b) => b.textContent.trim() === '添加'));
        await sleep(300);
        out.picked = [...form.querySelectorAll('.field-hint')]
          .map((h) => h.textContent.trim())
          .find((text) => text.startsWith('将写入')) ?? null;
      }

      clickIf(submit);
      await sleep(2000);
      out.toasts = [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim());
      // Guarded like every other use of row above: an unguarded read here would
      // throw inside this IIFE, reject the whole script, and turn a missing channel
      // row into an opaque fatal stack instead of the two readable checks below.
      out.editorClosed = row ? !row.querySelector('form.channel-edit') : null;
      return out;
    })()`)
    results.formFlow = formFlow

    const savedByForm = readJson(configPath).custom_providers?.['probe-channel'] ?? {}
    results.savedByForm = savedByForm
    check(
      'the channel form saves the model list it submitted',
      JSON.stringify(savedByForm.models) === JSON.stringify(['m9-manual']),
      savedByForm
    )
    check(
      'saving from the form reports success and closes the editor',
      formFlow.editorClosed === true &&
        formFlow.toasts?.some((text) => text.includes('已保存')) === true &&
        formFlow.toasts?.some((text) => text.includes('could not be cloned')) !== true,
      formFlow
    )

    finish(0)
  } catch (err) {
    results.fatal = err && err.stack ? err.stack : String(err)
    finish(1)
  }
})
