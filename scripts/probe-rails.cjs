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
 *   yarn compile
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

    /* 8a. seed the channel the picker checks need, before the settings page is
     * opened further down — its config is read once, on mount. A catalogue of five
     * with `p3` in use is the shape of the bug: a datalist offered only what was
     * already in the box. */
    const pickerSeed = await run(`window.ocr.saveProvider({
      name: 'picker-channel', custom: true, url: 'http://127.0.0.1:9/v1',
      protocol: 'openai', apiKey: 'sk-picker', models: ['p1', 'p2', 'p3', 'p4', 'p5']
    }).then(r => r.ok ? r.data : { error: r.error })`)
    await run(`window.ocr.setConfig('provider', 'picker-channel').then(r => r.ok ? r.data.ok : r.error)`)
    await run(`window.ocr.setConfig('model', 'p3').then(r => r.ok ? r.data.ok : r.error)`)
    results.pickerSeed = {
      saved: pickerSeed.ok === true,
      entry: readJson(configPath).custom_providers?.['picker-channel'] ?? null
    }
    check(
      'the picker channel is seeded with five models and one in use',
      results.pickerSeed.entry?.model === 'p3' &&
        JSON.stringify(results.pickerSeed.entry?.models) ===
          JSON.stringify(['p1', 'p2', 'p3', 'p4', 'p5']),
      results.pickerSeed
    )

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

    /* Page-side helpers, interpolated into the scripts below.
     *
     * `executeJavaScript` evaluates each call in its own scope, so sharing a helper
     * means sharing its source rather than defining it twice and letting the two
     * copies drift — which is how the navigation to 设置 and the reading of the
     * hint line were duplicated three times before. */
    const PAGE_HELPERS = `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const gearButton = () => [...document.querySelectorAll('.sidebar-foot button')]
        .find((b) => b.textContent.includes('⚙'));
      /* Back to the home view and into 设置, so the settings page mounts against
       * the configuration as it now stands. */
      async function openSettings() {
        document.querySelector('.brand').click();
        await sleep(400);
        gearButton().click();
        await sleep(3000);
      }
      /* The 当前模型 control, found by the name on its own combobox: the page also
       * holds a protocol dropdown, inside the (unopened) create form. */
      const pickerField = () => [...document.querySelectorAll('.picker')]
        .find((p) => p.querySelector('input[aria-label="当前模型"]')) ?? null;
      const pickerHint = () => pickerField()?.parentElement?.querySelector('.hint-row')
        ?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
    `

    /* 9. the 当前模型 picker.
     *
     * What it replaced was `<input list>` + `<datalist>`, and a datalist filters
     * its own entries by what is already in the field — with `p3` in the box, a
     * catalogue of five offered exactly `p3`, which is why the list looked out of
     * step with the channel's editor. So the model in use is deliberately one of
     * several, and the list is required to hold all of them.
     *
     * It is now the same control the page's plain dropdowns use (SelectMenu.vue,
     * both on composables/useAnchoredMenu.ts), so this section also covers the
     * keyboard path those two share — typing, the arrows, Enter — and the pieces
     * of ARIA that make the control describable at all.
     *
     * The field also lives inside a card with `overflow: hidden`, so "the menu is
     * painted on top of it" is a real check rather than a formality: an absolutely
     * positioned list would have been cut off at the card's edge.
     */
    const picker = await run(`(async () => {
      ${PAGE_HELPERS}
      const out = {};
      await openSettings();

      const field = pickerField();
      out.fieldFound = Boolean(field);
      const input = field?.querySelector('input');
      const toggle = field?.querySelector('.picker-toggle');
      out.value = input?.value ?? null;
      out.hint = pickerHint();
      // Unnamed, a combobox is announced as an edit field and nothing else; the
      // placeholder is gone the moment there is a value in the box.
      out.accessibleName = input?.getAttribute('aria-label') ?? null;
      // The list is not filtered by what is typed, so it must not claim to be
      // autocomplete either.
      out.advertisedAutocomplete = input?.getAttribute('aria-autocomplete') ?? null;

      toggle?.click();
      await sleep(300);
      const menu = document.querySelector('.picker-menu');
      const items = [...(menu?.querySelectorAll('.picker-item') ?? [])];
      out.menuFound = Boolean(menu);
      out.expanded = input?.getAttribute('aria-expanded') ?? null;
      // Only the combobox may report the expanded state; a second copy on the
      // chevron button announces it twice.
      out.expandedSources = field ? field.querySelectorAll('[aria-expanded]').length : 0;
      out.items = items.map((i) => i.querySelector('.picker-label').textContent.trim());
      out.ticked = items.filter((i) => i.classList.contains('current'))
        .map((i) => i.querySelector('.picker-label').textContent.trim());
      out.ariaSelected = items.map((i) => i.getAttribute('aria-selected'));
      out.activeDescendant = input?.getAttribute('aria-activedescendant') ?? null;
      out.activeDescendantExists = Boolean(
        out.activeDescendant && document.getElementById(out.activeDescendant)
      );

      // Whatever is painted at the list's own centre has to be the list.
      const box = menu?.getBoundingClientRect();
      const hit = box && document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(box.height / 2, 12));
      out.paintedOnTop = Boolean(hit && menu.contains(hit));
      out.insideWindow = box ? box.top >= -1 && box.bottom <= window.innerHeight + 1 : null;

      // Why a fixed-position box can still land outside the window: a transformed
      // or filtered ancestor turns fixed into absolute. Kept as evidence, since the
      // failure it explains is otherwise invisible from the DOM alone.
      const rect = (el) => el ? { t: Math.round(el.getBoundingClientRect().top), b: Math.round(el.getBoundingClientRect().bottom), l: Math.round(el.getBoundingClientRect().left), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null;
      const chain = [];
      for (let el = field; el; el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (cs.transform !== 'none' || cs.filter !== 'none' || cs.backdropFilter !== 'none' || cs.perspective !== 'none' || cs.willChange !== 'auto') {
          chain.push({ el: String(el.className || el.tagName), transform: cs.transform, filter: cs.filter, backdrop: cs.backdropFilter, willChange: cs.willChange });
        }
      }
      const menuCss = menu ? getComputedStyle(menu) : null;
      out.boxes = {
        field: rect(field), menu: rect(menu), innerHeight: window.innerHeight,
        menuCss: menuCss ? { position: menuCss.position, top: menuCss.top, bottom: menuCss.bottom, left: menuCss.left, maxHeight: menuCss.maxHeight } : null,
        containerChain: chain
      };

      /* Typing, with the list open: the highlight has to follow the text.
       *
       * The list is deliberately not filtered by the box, so a highlight left on
       * the previously selected model would make Enter replace a name the user
       * has just typed with an unrelated one. */
      const type = async (text) => {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(150);
      };
      const activeLabel = () => document.querySelector('.picker-menu .picker-item.active')
        ?.querySelector('.picker-label')?.textContent.trim() ?? null;

      await type('p9-typed');
      out.typedRows = [...document.querySelectorAll('.picker-menu .picker-item')]
        .map((i) => i.querySelector('.picker-label').textContent.trim());
      out.typedHighlight = activeLabel();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(250);
      out.afterTypedEnter = input.value;
      out.closedAfterTypedEnter = !document.querySelector('.picker-menu');

      /* The arrows, then Enter: an explicit choice still wins. */
      await type('p1');
      // The first arrow opens the list (on a text box the arrows are needed to
      // walk the text until then), the second one moves the highlight.
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await sleep(200);
      out.openedByArrow = Boolean(document.querySelector('.picker-menu'));
      out.highlightAtOpen = activeLabel();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await sleep(150);
      out.arrowHighlight = activeLabel();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(250);
      out.afterArrowEnter = input.value;

      toggle?.click();
      await sleep(250);
      out.reopened = Boolean(document.querySelector('.picker-menu'));
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(200);
      out.closedByEscape = !document.querySelector('.picker-menu');

      toggle?.click();
      await sleep(200);
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await sleep(200);
      out.closedByOutside = !document.querySelector('.picker-menu');

      // The list is re-queried here on purpose: the nodes captured when it first
      // opened were replaced by every open and close since.
      toggle?.click();
      await sleep(250);
      const fresh = [...document.querySelectorAll('.picker-menu .picker-item')];
      fresh[fresh.length - 1]?.click();
      await sleep(300);
      out.afterPick = input?.value ?? null;
      out.closedAfterPick = !document.querySelector('.picker-menu');
      out.expandedAfterPick = input?.getAttribute('aria-expanded') ?? null;

      // 应用 is what actually stores it: on the channel, not only on screen.
      [...document.querySelectorAll('.current-route button')]
        .find((b) => b.textContent.trim() === '应用')?.click();
      await sleep(1800);
      out.toasts = [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim());
      return out;
    })()`)
    results.picker = picker

    check('the model picker is on the settings page', picker.fieldFound === true, picker)
    check(
      'it starts on the model in use',
      picker.value === 'p3' && JSON.stringify(picker.ticked) === JSON.stringify(['p3']),
      { value: picker.value, ticked: picker.ticked }
    )
    check(
      'the list holds the whole catalogue, not just the current model',
      JSON.stringify(picker.items) === JSON.stringify(['p1', 'p2', 'p3', 'p4', 'p5']),
      picker.items
    )
    check(
      'the list marks exactly the model in use',
      JSON.stringify(picker.ariaSelected) === JSON.stringify(['false', 'false', 'true', 'false', 'false']),
      picker.ariaSelected
    )
    check(
      'the control is named, and announces only one expanded state',
      picker.accessibleName === '当前模型' &&
        picker.expandedSources === 1 &&
        picker.expanded === 'true' &&
        picker.advertisedAutocomplete === null,
      {
        accessibleName: picker.accessibleName,
        expandedSources: picker.expandedSources,
        expanded: picker.expanded,
        advertisedAutocomplete: picker.advertisedAutocomplete
      }
    )
    check(
      'the highlight is pointed at by aria-activedescendant',
      picker.activeDescendantExists === true && picker.activeDescendant.endsWith('-option-2'),
      { activeDescendant: picker.activeDescendant }
    )
    check(
      'the list is painted on top of the clipping card, inside the window',
      picker.paintedOnTop === true && picker.insideWindow === true,
      { paintedOnTop: picker.paintedOnTop, insideWindow: picker.insideWindow }
    )
    check(
      'typing a name outside the catalogue and pressing Enter keeps it',
      picker.typedHighlight === 'p9-typed' &&
        picker.afterTypedEnter === 'p9-typed' &&
        picker.closedAfterTypedEnter === true,
      {
        typedRows: picker.typedRows,
        typedHighlight: picker.typedHighlight,
        afterTypedEnter: picker.afterTypedEnter
      }
    )
    check(
      'the arrow keys move the highlight and Enter takes it',
      picker.openedByArrow === true &&
        picker.highlightAtOpen === 'p1' &&
        picker.arrowHighlight === 'p2' &&
        picker.afterArrowEnter === 'p2',
      {
        openedByArrow: picker.openedByArrow,
        highlightAtOpen: picker.highlightAtOpen,
        arrowHighlight: picker.arrowHighlight,
        afterArrowEnter: picker.afterArrowEnter
      }
    )
    check(
      'picking a model fills the field and closes the list',
      picker.afterPick === 'p5' &&
        picker.closedAfterPick === true &&
        picker.expandedAfterPick === 'false',
      {
        afterPick: picker.afterPick,
        closedAfterPick: picker.closedAfterPick,
        expandedAfterPick: picker.expandedAfterPick
      }
    )
    check(
      'Escape and a click outside both close it',
      picker.reopened === true && picker.closedByEscape === true && picker.closedByOutside === true,
      picker
    )

    const afterApply = readJson(configPath).custom_providers?.['picker-channel'] ?? {}
    results.pickerAfterApply = afterApply
    check(
      '应用 stores the picked model on the active channel',
      afterApply.model === 'p5' &&
        picker.toasts?.some((text) => text.includes('已设置模型 p5')) === true,
      { model: afterApply.model, toasts: picker.toasts }
    )
    check(
      'the hint counts the catalogue it offers',
      typeof picker.hint === 'string' && picker.hint.includes('可选 5 个模型'),
      picker.hint
    )

    /* 9a. two pictures of the control, for a human to look at: the open list, and
     * what it says when the channel has no catalogue. The rest of this probe can
     * only assert the mechanics — whether it looks like the rest of the page is not
     * something a DOM query can answer. */
    const shot = async (name) => {
      try {
        const box = await run(`(async () => {
          ${PAGE_HELPERS}
          const field = pickerField();
          field?.scrollIntoView({ block: 'center' });
          await sleep(500);
          if (!document.querySelector('.picker-menu')) field?.querySelector('.picker-toggle')?.click();
          await sleep(500);
          const menu = document.querySelector('.picker-menu');
          const rects = [field, menu].filter(Boolean).map((el) => el.getBoundingClientRect());
          if (!rects.length) return null;
          const left = Math.min(...rects.map((r) => r.left));
          const top = Math.min(...rects.map((r) => r.top));
          const right = Math.max(...rects.map((r) => r.right));
          const bottom = Math.max(...rects.map((r) => r.bottom));
          const pad = 24;
          return {
            x: Math.max(0, Math.round(left - pad)),
            y: Math.max(0, Math.round(top - pad)),
            width: Math.round(right - left + pad * 2),
            height: Math.round(bottom - top + pad * 2)
          };
        })()`)
        // The probe's window is blurred and click-through, so Chromium paints it
        // rarely: without this the capture comes back as the frame from before the
        // menu was opened.
        wc.invalidate()
        await sleep(500)
        const image = await wc.capturePage(box ?? undefined)
        fs.mkdirSync(path.join(__dirname, '..', 'smoke-out'), { recursive: true })
        fs.writeFileSync(path.join(__dirname, '..', 'smoke-out', name), image.toPNG())
      } catch (err) {
        // A picture is a convenience, not a rail: a window that has already gone
        // away must not turn into a fatal result for the whole probe.
        console.log(`shot ${name}: FAILED — ${err?.message ?? err}`)
      }
    }
    await shot('picker-open.png')

    /* 9b. a channel with no catalogue at all: the list says so and points at the
     * editor, rather than opening as an empty box. */
    await run(`window.ocr.saveProvider({
      name: 'empty-channel', custom: true, url: 'http://127.0.0.1:9/v1', protocol: 'openai', models: []
    }).then(r => r.ok ? r.data.ok : r.error)`)
    await run(`window.ocr.setConfig('provider', 'empty-channel').then(r => r.ok ? r.data.ok : r.error)`)

    const emptyPicker = await run(`(async () => {
      ${PAGE_HELPERS}
      const out = {};
      await openSettings();

      const field = pickerField();
      out.hint = pickerHint();
      const link = field?.parentElement?.querySelector('.hint-row .link-btn') ?? null;
      out.linkFound = Boolean(link);
      field?.querySelector('.picker-toggle')?.click();
      await sleep(300);
      out.items = [...document.querySelectorAll('.picker-menu .picker-item')].length;
      out.note = document.querySelector('.picker-empty')?.textContent
        ?.replace(/\\s+/g, ' ').trim() ?? null;

      /* Scoped to the channel's own row: the create form below is the same
       * component and sits in the document the whole time, so an unscoped
       * form.channel-edit query passes whether or not the link did anything. */
      const rowOf = () => [...document.querySelectorAll('.channel-row')].find((r) =>
        r.querySelector('.channel-name')?.textContent?.includes('empty-channel')) ?? null;
      out.rowFound = Boolean(rowOf());
      link?.click();
      await sleep(600);
      out.editorOpened = Boolean(rowOf()?.querySelector('form.channel-edit'));
      out.editorChannel = rowOf()?.querySelector('form.channel-edit .mono')?.textContent?.trim() ?? null;
      // The link promises to take the user somewhere; clicking it again must not
      // undo that by toggling the editor shut.
      link?.click();
      await sleep(600);
      out.editorStillOpen = Boolean(rowOf()?.querySelector('form.channel-edit'));
      return out;
    })()`)
    results.emptyPicker = emptyPicker

    check(
      'a channel without a catalogue says so instead of opening an empty list',
      emptyPicker.items === 0 &&
        typeof emptyPicker.note === 'string' &&
        emptyPicker.note.includes('还没有模型目录') &&
        typeof emptyPicker.hint === 'string' &&
        emptyPicker.hint.includes('还没有模型目录'),
      emptyPicker
    )
    check(
      'and the hint opens that channel for editing',
      emptyPicker.linkFound === true &&
        emptyPicker.rowFound === true &&
        emptyPicker.editorOpened === true &&
        emptyPicker.editorChannel === 'empty-channel',
      emptyPicker
    )
    check(
      'clicking the link again leaves the editor open',
      emptyPicker.editorStillOpen === true,
      { editorOpened: emptyPicker.editorOpened, editorStillOpen: emptyPicker.editorStillOpen }
    )
    await shot('picker-empty.png')

    /* 10. the window's close button, and the tray.
     *
     * Close hides the window instead of ending the process — a review runs for
     * minutes inside `ocr` and the window is only a view of it — and quitting is
     * the tray menu's own exit. None of that needs the tray object itself to be
     * observable: the decision shows up on the window's `close` event, where this
     * listener runs *after* the app's and can read `defaultPrevented`, and the
     * quitting flag is set from `before-quit`, which every real quit path goes
     * through (`app.quit()` — what the menu item calls — included).
     *
     * Last section on purpose: it leaves the window hidden.
     */
    const trayWin = BrowserWindow.getAllWindows()[0]
    const closeDecisions = []
    trayWin.on('close', (event) => {
      closeDecisions.push(event.defaultPrevented)
      // Final say, whichever way the app decided: the probe needs the window to
      // survive this to keep reporting.
      event.preventDefault()
    })

    trayWin.close()
    await sleep(400)
    const hidOnClose = {
      vetoed: closeDecisions[0] === true,
      hidden: !trayWin.isVisible(),
      stillThere: !trayWin.isDestroyed()
    }
    trayWin.show()
    await sleep(300)
    hidOnClose.shownAgain = trayWin.isVisible()

    // The quitting path: set the flag the way a real quit does, then close again.
    // A veto here would leave the process running with no window to show.
    app.emit('before-quit')
    trayWin.close()
    await sleep(300)
    const quitPath = { vetoed: closeDecisions[1] === true }

    // The tray icon is loaded from the built bundle's own directory, so a build
    // that stopped copying `resources` next to it gets a tray with no picture.
    const trayIcon = path.join(__dirname, '..', 'resources', 'icon.png')
    const iconThere = fs.existsSync(trayIcon)

    results.tray = { ...hidOnClose, quitVetoed: quitPath.vetoed, iconThere, closeDecisions }

    check(
      'the close button hides the window instead of ending the app',
      hidOnClose.vetoed === true &&
        hidOnClose.hidden === true &&
        hidOnClose.stillThere === true &&
        hidOnClose.shownAgain === true,
      hidOnClose
    )
    check('the window can be brought back from the tray', hidOnClose.shownAgain === true, hidOnClose)
    check(
      'quitting is no longer vetoed by the close handler',
      quitPath.vetoed === false,
      { closeDecisions, quitVetoed: quitPath.vetoed }
    )
    check('the tray has an icon to show', iconThere === true, { trayIcon })

    finish(0)
  } catch (err) {
    results.fatal = err && err.stack ? err.stack : String(err)
    finish(1)
  }
})
