// Grove: the Electron main process. One window per project. State comes from ~/.grove
// (written by `grove` and the Claude Code mod); actions go through `grove`; every terminal is a tmux session
// attached through ptybridge.py, so closing a window or quitting never stops an agent or a server.
const { app, BrowserWindow, ipcMain, shell, Menu, dialog, Notification } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn, execFile } = require('child_process')

const HOME = os.homedir()
const HUB = process.env.GROVE_HUB || path.join(HOME, '.grove')
const BIN = process.env.GROVE_BIN || path.join(HUB, 'bin/grove')
// another hub (a try-out or a test) keeps its own window state, not the installed app's
if (process.env.GROVE_HUB) app.setPath('userData', path.join(HUB, 'app'))
// a Finder-launched app has a bare PATH: tmux, gh, git and claude live in these
process.env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local/bin'), process.env.PATH]
  .filter(Boolean).join(':')

const windows = new Map() // project -> BrowserWindow
const terms = new Map() // terminal id -> { child, sender }
let quitting = false

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

const CLAUDE = { band: '#3a2822', name: '#d77757', accent: '#e8957a', waiting: '#ffc2a6', working: '#b8bccb', ready: '#8fdcb4' }

function palette() {
  const theme = readJSON(path.join(HUB, 'theme.json'), {})
  const pal = { ...CLAUDE, ...((theme.palettes || {})[theme.palette || 'claude'] || {}) }
  const rgb = [1, 3, 5].map((i) => parseInt(pal.band.slice(i, i + 2), 16))
  pal.off = '#' + rgb.map((c) => Math.round(c * 0.86 + 255 * 0.14).toString(16).padStart(2, '0')).join('')
  return pal
}

// ---- projects ----
// one folder per project (project.json) holding one folder per feature (feature.json, status.json, worktree/)
const PROJECTS = path.join(HUB, 'projects')

function folders(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch {
    return []
  }
}

function projects() {
  return folders(PROJECTS)
    .filter((name) => fs.existsSync(path.join(PROJECTS, name, 'project.json')))
    .map((name) => {
      const repo = (readJSON(path.join(PROJECTS, name, 'project.json'), {}).repo || '').replace(/^~/, HOME)
      return { name, repo }
    })
}

function defaultProject() {
  const names = projects().map((p) => p.name)
  const chosen = readJSON(path.join(HUB, 'config.json'), {}).defaultProject
  return names.includes(chosen) ? chosen : names[0] || null
}

// whether the Claude session that wrote a status still runs, without starting a process (the app polls):
// its pid (the mod writes it) must be alive, and nothing written before the last boot counts. A status
// without a pid (a session on a mod from before pids) is trusted until the next reboot. As session_live in cli/grove.
function sessionLive(status) {
  if ((status.updatedAt || 0) < Date.now() - os.uptime() * 1000) return false
  if (!Number.isInteger(status.pid) || status.pid <= 1) return true
  try {
    process.kill(status.pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// offline once no live Claude session is left to update the status (a reboot, a crash, a killed tmux
// server); the last question or permission prompt no longer stands, the recap does
function shownStatus(dir) {
  const status = readJSON(path.join(dir, 'status.json'), { state: 'offline' })
  if ((status.state || 'offline') === 'offline' || sessionLive(status)) return status
  const details = { ...status.details, note: '', nextStep: `grove fix ${path.basename(dir)}` }
  return { ...status, state: 'offline', message: 'no Claude session running', details }
}

// the captions and file names only; the images come one by one (proof:image) when the Summary shows them
function proofOf(dir) {
  const rows = readJSON(path.join(dir, 'proof', 'proof.json'), [])
  return Array.isArray(rows) ? rows.filter((r) => r && /^[\w.-]+$/.test(r.file || '') && fs.existsSync(path.join(dir, 'proof', r.file))) : []
}

function allFeatures() {
  // each project's PRs, by branch (branch names are only unique within one repo)
  const prs = Object.fromEntries(folders(PROJECTS).map((p) => [p, readJSON(path.join(PROJECTS, p, 'prs.json'), {}).byBranch || {}]))
  const dirs = folders(PROJECTS).flatMap((p) => folders(path.join(PROJECTS, p)).map((name) => path.join(PROJECTS, p, name)))
  return dirs
    .map((dir) => [dir, readJSON(path.join(dir, 'feature.json'), null)])
    .filter(([, f]) => f)
    .map(([dir, f]) => ({
      ...f,
      project: f.project || path.basename(path.dirname(dir)),
      title: f.title || f.name,
      status: shownStatus(dir),
      recap: readJSON(path.join(dir, 'recap.json'), null), // grove recap: summary, why, tasks, diagram…
      proof: proofOf(dir), // grove proof: screenshots that show it working
      stats: readJSON(path.join(dir, 'stats.json'), null), // grove statusline: model, context, cost…
      pr: (prs[path.basename(path.dirname(dir))] || {})[f.branch] || null,
    }))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.name.localeCompare(b.name))
}

function loadState(project) {
  const everything = allFeatures()
  const others = {}
  for (const f of everything) {
    if (f.project !== project && f.status.state === 'waiting') others[f.project] = (others[f.project] || 0) + 1
  }
  return {
    project,
    projects: projects(),
    repo: (projects().find((p) => p.name === project) || {}).repo || '',
    features: everything.filter((f) => f.project === project),
    waitingElsewhere: others,
    palette: palette(),
    focus: readJSON(path.join(HUB, 'focus.json'), null),
  }
}

function sendState() {
  for (const [project, w] of windows) {
    if (!w.isDestroyed()) w.webContents.send('state', loadState(project))
  }
  const waiting = allFeatures().filter((f) => f.status.state === 'waiting').length
  app.dock?.setBadge(waiting ? String(waiting) : '')
  buildMenu()
}

let pending = null
function watchHub() {
  try {
    fs.watch(HUB, { recursive: true }, (_event, file) => {
      // worktrees live under the hub too: only Grove's own state files count
      if (file && (/(^|\/)worktree(\/|$)/.test(file) || !/\.json$/.test(file))) return
      clearTimeout(pending)
      pending = setTimeout(sendState, 150)
    })
  } catch {}
  setInterval(sendState, 4000) // a backstop for missed events
}

function grove(args) {
  return new Promise((resolve) => {
    execFile(BIN, args, { env: process.env, timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

// ---- windows: which projects are open survives a restart ----
const OPEN_FILE = () => path.join(app.getPath('userData'), 'open-projects.json')

function rememberOpen() {
  if (quitting) return
  try {
    fs.writeFileSync(OPEN_FILE(), JSON.stringify([...windows.keys()]))
  } catch {}
}

function closeTerminalsOf(contents) {
  for (const [id, t] of terms) {
    if (t.sender === contents) {
      t.child.stdin.end()
      terms.delete(id)
    }
  }
}

// review=true opens the project on its "bring in your work" sheet
function openProject(project, { review = false } = {}) {
  const existing = windows.get(project)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    if (review) existing.webContents.send('menu', 'import')
    return existing
  }
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 900,
    minHeight: 560,
    title: project ? `${project} — Grove` : 'Grove',
    backgroundColor: '#161616',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  })
  windows.set(project, win)
  rememberOpen()
  win.loadFile(path.join(__dirname, 'renderer/index.html'), { query: { project: project || '', review: review ? '1' : '' } })
  win.on('page-title-updated', (e) => e.preventDefault()) // keep "<project> — Grove"
  const contents = win.webContents
  // a reload starts a new page: detach its old terminals (their tmux sessions keep running)
  contents.on('did-start-navigation', (_e, _url, _inPlace, isMainFrame) => isMainFrame && closeTerminalsOf(contents))
  win.on('closed', () => {
    closeTerminalsOf(contents)
    windows.delete(project)
    rememberOpen()
  })
  if (process.env.GROVE_SCREENSHOT && windows.size === 1) {
    // GROVE_SCREENSHOT_JS runs once in the page first (e.g. to open panels), for visual checks
    if (process.env.GROVE_SCREENSHOT_JS) contents.once('did-finish-load', () => contents.executeJavaScript(process.env.GROVE_SCREENSHOT_JS))
    contents.once('did-finish-load', () => setTimeout(async () => {
      fs.writeFileSync(process.env.GROVE_SCREENSHOT, (await contents.capturePage()).toPNG())
      app.quit()
    }, Number(process.env.GROVE_SCREENSHOT_DELAY || 6000)))
  }
  return win
}

// a repo becomes a project (or, if it already is one, opens), then shows what is already in flight on it
async function addProject(parent) {
  const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
    title: 'Add a project to Grove', message: 'Choose a git repository (its main checkout or any of its worktrees)',
    properties: ['openDirectory'], buttonLabel: 'Add Project',
  })
  if (canceled || !filePaths[0]) return null
  const result = await grove(['import', filePaths[0], '--json'])
  let found = null
  try { found = JSON.parse(result.stdout) } catch {}
  if (result.code || !found) {
    dialog.showMessageBox(parent, { type: 'warning', message: 'Could not add the project', detail: (result.stderr || result.stdout).trim() })
    return null
  }
  sendState()
  const blank = windows.get(null) // the "add a project to begin" window has done its job
  openProject(found.project, { review: true })
  if (blank && !blank.isDestroyed()) blank.close()
  return found.project
}

async function scanProject(project) {
  if (!projects().some((p) => p.name === project)) return { error: `no project ${project}` }
  const result = await grove(['import', '--project', project, '--json'])
  try {
    return JSON.parse(result.stdout)
  } catch {
    return { error: (result.stderr || result.stdout).trim() || 'could not look for work outside Grove' }
  }
}

// ---- terminals (each belongs to the window that opened it) ----
ipcMain.handle('term:open', (e, { id, session, cols, rows }) => {
  if (terms.has(id)) return true
  const child = spawn('python3', [path.join(__dirname, 'ptybridge.py'), String(cols), String(rows), '--',
    'tmux', 'attach-session', '-t', '=' + session], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: process.env })
  const sender = e.sender
  terms.set(id, { child, sender })
  const send = (channel, ...args) => !sender.isDestroyed() && sender.send(channel, ...args)
  child.stdout.on('data', (chunk) => send('term:data', id, chunk))
  child.stderr.on('data', (chunk) => send('term:data', id, chunk))
  child.on('exit', () => {
    terms.delete(id)
    send('term:exit', id)
  })
  return true
})
ipcMain.on('term:write', (_e, id, data) => terms.get(id)?.child.stdin.write(data))
ipcMain.on('term:resize', (_e, id, cols, rows) => terms.get(id)?.child.stdio[3].write(JSON.stringify({ cols, rows }) + '\n'))
ipcMain.on('term:close', (_e, id) => {
  terms.get(id)?.child.stdin.end()
  terms.delete(id)
})

// ---- state and actions ----
const windowOf = (e) => BrowserWindow.fromWebContents(e.sender)
ipcMain.handle('state', (_e, project) => loadState(project))
ipcMain.handle('grove', async (_e, args) => {
  const result = await grove(args)
  sendState()
  return result
})
// a screenshot for a feature's agent (grove shot): the window steps aside while you drag a region, or
// a pasted image's bytes come along; the saved file's path comes back for the renderer to type in
// only a file grove shot just saved counts: an older grove without `shot` prints its help and exits 0
function shotResult(result) {
  const out = result.stdout.trim()
  if (!result.code && path.isAbsolute(out) && !out.includes('\n') && fs.existsSync(out)) return { path: out }
  if (!result.code) return { error: `${BIN} has no shot command: update Grove, or run this build with GROVE_BIN=<checkout>/cli/grove` }
  return { error: (result.stderr || result.stdout).trim() || 'screenshot cancelled' }
}
ipcMain.handle('shot', async (e, name, mode, bytes, type) => {
  if (mode === 'image') {
    const ext = { 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[type] || '.png'
    const tmp = path.join(os.tmpdir(), `grove-paste-${process.pid}-${Date.now()}${ext}`)
    fs.writeFileSync(tmp, Buffer.from(bytes))
    const result = await grove(['shot', name, tmp, '--print'])
    fs.rmSync(tmp, { force: true })
    return shotResult(result)
  }
  const win = windowOf(e)
  const hide = win?.isVisible()
  if (hide) win.hide()
  const result = await grove(['shot', name, '--print', ...(mode === 'window' ? ['--window'] : [])])
  if (hide && !win.isDestroyed()) {
    win.show()
    win.focus()
  }
  return shotResult(result)
})
ipcMain.handle('host', async (_e, name) => {
  const result = await grove(['host', name])
  try {
    return JSON.parse(result.stdout)
  } catch {
    return { error: (result.stderr || result.stdout).trim() }
  }
})
// a feature's own folder in the hub (projects/<project>/<name>), found by name: names are unique
function featureDir(name) {
  if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) return null
  const project = folders(PROJECTS).find((p) => fs.existsSync(path.join(PROJECTS, p, name, 'feature.json')))
  return project ? path.join(PROJECTS, project, name) : null
}

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const proofFile = (name, file) => {
  const dir = featureDir(name)
  return dir && /^[\w.-]+$/.test(file) && IMAGE_TYPES[path.extname(file).toLowerCase()] ? path.join(dir, 'proof', file) : null
}
ipcMain.handle('proof:image', (_e, name, file) => {
  const p = proofFile(name, file)
  try {
    return p ? `data:${IMAGE_TYPES[path.extname(p).toLowerCase()]};base64,${fs.readFileSync(p).toString('base64')}` : null
  } catch {
    return null
  }
})
ipcMain.on('proof:open', (_e, name, file) => {
  const p = proofFile(name, file)
  if (p && fs.existsSync(p)) shell.openPath(p)
})
// a feature's notes and retro: markdown in its hub folder, kept out of the worktree (and so out of git)
const DOCS = { notes: 'notes.md', retro: 'retro.md' }
const docFile = (kind, name) => {
  const dir = DOCS[kind] && featureDir(name)
  return dir ? path.join(dir, DOCS[kind]) : null
}
ipcMain.handle('doc:read', (_e, kind, name) => {
  const file = docFile(kind, name)
  try {
    return file ? fs.readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
})
ipcMain.handle('doc:write', (_e, kind, name, text) => {
  const file = docFile(kind, name)
  if (!file) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file + '.tmp', text)
  fs.renameSync(file + '.tmp', file)
  return true
})
// the task a feature was started with (grove new -p / a ticket), before or after Claude was handed it
ipcMain.handle('brief', (_e, name) => {
  const dir = featureDir(name)
  for (const file of dir ? ['brief.md', 'brief.sent.md'] : []) {
    try {
      return fs.readFileSync(path.join(dir, file), 'utf8')
    } catch {}
  }
  return ''
})
// a project can pick the browser and Chrome profile its links open in, in your own project.json:
// "browser": {"app": "Google Chrome", "profile": "Work"}. The profile is a folder name ("Profile 2") or
// the name Chrome shows ("Work"), looked up in the browser's Local State. Unset: the default browser.
const PROFILE_ROOTS = {
  'Google Chrome': 'Google/Chrome',
  'Google Chrome Beta': 'Google/Chrome Beta',
  'Google Chrome Canary': 'Google/Chrome Canary',
  Chromium: 'Chromium',
  'Brave Browser': 'BraveSoftware/Brave-Browser',
  'Microsoft Edge': 'Microsoft Edge',
}
function profileDir(appName, profile) {
  const root = PROFILE_ROOTS[appName]
  if (!root || fs.existsSync(path.join(HOME, 'Library/Application Support', root, profile))) return profile
  const info = readJSON(path.join(HOME, 'Library/Application Support', root, 'Local State'), {})?.profile?.info_cache || {}
  return Object.keys(info).find((dir) => info[dir]?.name === profile) || profile
}
function browserOf(project) {
  const b = project && readJSON(path.join(PROJECTS, project, 'project.json'), {}).browser
  if (!b || typeof b !== 'object') return null
  const appName = typeof b.app === 'string' && b.app.trim() ? b.app.trim() : 'Google Chrome'
  const profile = typeof b.profile === 'string' && b.profile.trim() ? b.profile.trim() : null
  return { app: appName, dir: profile && profileDir(appName, profile) }
}
function openLink(url, project) {
  const b = browserOf(project)
  if (!b) return shell.openExternal(url)
  // with a profile, the URL goes to the browser itself so it lands in that profile's window
  const args = b.dir ? ['-na', b.app, '--args', `--profile-directory=${b.dir}`, url] : ['-a', b.app, url]
  execFile('open', args, (err) => {
    if (err) shell.openExternal(url) // the browser named isn't installed: the default one still opens it
  })
}
ipcMain.on('open', (e, url) => {
  if (!/^https?:\/\//.test(url)) return
  const win = windowOf(e)
  const project = [...windows].find(([, w]) => w === win)?.[0]
  openLink(url, project)
})
ipcMain.on('open-project', (_e, name) => openProject(name))
ipcMain.handle('import:scan', (_e, project) => scanProject(project))
// the project's own config file, in the default editor
ipcMain.on('open-config', (_e, project) => {
  if (projects().some((p) => p.name === project)) shell.openPath(path.join(PROJECTS, project, 'project.json'))
})
ipcMain.handle('add-project', (e) => addProject(windowOf(e)))
ipcMain.handle('project-menu', (e, current) => new Promise((resolve) => {
  const items = [
    ...projects().map((p) => ({
      label: p.name, type: 'checkbox', checked: p.name === current,
      click: () => { openProject(p.name); resolve(p.name) },
    })),
    { type: 'separator' },
    { label: 'Add Project…', click: () => { addProject(windowOf(e)); resolve(null) } },
  ]
  Menu.buildFromTemplate(items).popup({ window: windowOf(e), callback: () => resolve(null) })
}))
ipcMain.handle('row-menu', (e, feature) => new Promise((resolve) => {
  const items = [
    { label: 'Rename…', click: () => resolve('rename') },
    { label: 'Restart services', click: () => resolve('restart') },
    { label: 'Fix (start what stopped)', click: () => resolve('fix') },
    { type: 'separator' },
    ...Object.entries(feature.links || {}).map(([svc, url]) => ({ label: `Open ${svc}  ${url}`, click: () => resolve('open:' + url) })),
    ...(feature.prUrl ? [{ label: 'Open pull request', click: () => resolve('open-pr') }] : []),
    { label: 'Reveal worktree in Finder', click: () => resolve('reveal') },
    { type: 'separator' },
    { label: 'Close feature', click: () => resolve('done') },
  ]
  Menu.buildFromTemplate(items).popup({ window: windowOf(e), callback: () => resolve(null) })
}))
// right-click on text in the Summary tab: hand the selection to this feature's agent, or edit it
ipcMain.handle('selection-menu', (e, { picked, editable }) => new Promise((resolve) => {
  const items = [
    { label: 'Send to agent', accelerator: 'Cmd+Enter', enabled: picked, click: () => resolve('send') },
    { label: 'New feature from selection…', accelerator: 'Shift+Cmd+Enter', enabled: picked, click: () => resolve('new') },
    { type: 'separator' },
    ...(editable ? [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' }] : [{ role: 'copy', enabled: picked }]),
  ]
  Menu.buildFromTemplate(items).popup({ window: windowOf(e), callback: () => resolve(null) })
}))
ipcMain.on('reveal', (_e, dir) => shell.showItemInFolder(dir))
ipcMain.handle('confirm', async (e, message, detail, ok = 'OK') => {
  const { response } = await dialog.showMessageBox(windowOf(e), { type: 'question', buttons: [ok, 'Cancel'], defaultId: 1, cancelId: 1, message, detail })
  return response === 0
})
// a choice of several buttons, the last one cancels: resolves to the index picked
ipcMain.handle('ask', async (e, message, detail, buttons) => {
  const last = buttons.length - 1
  const { response } = await dialog.showMessageBox(windowOf(e), { type: 'warning', buttons, defaultId: last, cancelId: last, message, detail })
  return response
})

// ---- updates: `grove update` pulls this app's checkout and rebuilds the app; here we only look and offer ----
const UPDATE_EVERY = 6 * 60 * 60 * 1000
let update = null // the last `grove update --check --json`, plus { running } while an update runs
let notifiedFor = ''
let autoUpdate = null // `auto` from the last check; null until known, or when the CLI is too old to report it

function updateItem() {
  if (update?.running) return { label: 'Updating Grove…', enabled: false }
  if (update?.available) {
    const what = update.behind ? `${update.behind} new commit${update.behind === 1 ? '' : 's'}` : 'rebuild the app'
    return { label: `Update Grove (${what})…`, click: () => confirmUpdate() }
  }
  if (update?.blocked) return { label: `Can't Update: ${update.blocked}`, enabled: false }
  return { label: 'Check for Updates…', click: () => checkUpdate({ manual: true }) }
}

// The CLI owns the setting (autoUpdate in config.json); the menu only shows it and asks the CLI to change it.
function autoUpdateItem() {
  if (autoUpdate === null) return []
  return [{ label: 'Update Automatically', type: 'checkbox', checked: autoUpdate, click: () => setAutoUpdate(!autoUpdate) }]
}

async function setAutoUpdate(on) {
  const r = await grove(['update', '--auto', on ? 'on' : 'off'])
  if (r.code) dialog.showMessageBox({ type: 'warning', message: 'Could not change Update Automatically', detail: (r.stderr || r.stdout).trim() })
  else autoUpdate = on
  lastMenuKey = '' // the click already flipped the tick; redraw it from what the CLI holds
  buildMenu()
}

async function checkUpdate({ manual = false } = {}) {
  if (update?.running) return
  const r = await grove(['update', '--check', '--json'])
  let s = null
  try { s = JSON.parse(r.stdout) } catch { /* an older CLI, or git missing */ }
  update = s
  if (typeof s?.auto === 'boolean') autoUpdate = s.auto
  buildMenu()
  if (!s) {
    if (manual) dialog.showMessageBox({ type: 'warning', message: 'Could not check for updates', detail: (r.stderr || r.stdout).trim() })
    return
  }
  if (manual && !s.available) {
    const detail = s.blocked || s.fetchError || `${s.repo} is on ${s.upstream}, and the app matches it.`
    dialog.showMessageBox({ type: 'info', message: s.blocked ? "Grove can't update" : 'Grove is up to date', detail })
    return
  }
  if (!s.available) return
  if (manual) return confirmUpdate()
  // auto-update waits until Grove is in the background, so nobody loses the window mid-keystroke
  if (s.auto && !BrowserWindow.getFocusedWindow()) return runUpdate()
  const key = `${s.head}:${s.behind}:${s.appStale}`
  if (notifiedFor !== key && Notification.isSupported()) {
    notifiedFor = key
    const n = new Notification({ title: 'Grove update available', body: `${updateItem().label.replace(/…$/, '')}. Click to install.` })
    n.on('click', () => confirmUpdate())
    n.show()
  }
}

async function confirmUpdate() {
  const s = update
  if (!s?.available) return
  const steps = [s.behind && `pulls ${s.behind} commit${s.behind === 1 ? '' : 's'} into ${s.repo}`,
    'rebuilds the app if its files changed, then reopens it'].filter(Boolean)
  const { response } = await dialog.showMessageBox({
    type: 'question', buttons: ['Update', 'Later'], defaultId: 0, cancelId: 1, message: 'Update Grove?',
    detail: `It ${steps.join(' and ')}. Agents and services keep running in tmux. Running Claude sessions pick up mod changes when restarted.

To update on its own while Grove is in the background: Grove → Update Automatically`,
  })
  if (response === 0) runUpdate()
}

// The update outlives this process: rebuilding the app quits it, and `grove update --relaunch` reopens it.
function runUpdate() {
  const log = path.join(HUB, 'update.log')
  const out = fs.openSync(log, 'w')
  update = { ...update, running: true }
  buildMenu()
  const child = spawn(BIN, ['update', '--relaunch'], { detached: true, stdio: ['ignore', out, out], env: process.env })
  fs.closeSync(out)
  child.unref()
  child.on('exit', (code) => {
    update = null
    if (code) dialog.showMessageBox({ type: 'warning', message: 'Grove could not update', detail: `${fs.readFileSync(log, 'utf8').trim().split('\n').slice(-6).join('\n')}\n\nFull log: ${log}` })
    checkUpdate()
  })
}

// ---- menus ----
let lastMenuKey = ''
function buildMenu() {
  const list = projects()
  const key = JSON.stringify([list.map((p) => p.name), updateItem().label, autoUpdate])
  if (key === lastMenuKey) return
  lastMenuKey = key
  const send = (action) => () => BrowserWindow.getFocusedWindow()?.webContents.send('menu', action)
  const openItems = list.map((p, i) => ({
    label: p.name, accelerator: i < 9 ? `CmdOrCtrl+Shift+${i + 1}` : undefined, click: () => openProject(p.name),
  }))
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        updateItem(),
        ...autoUpdateItem(),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Project',
      submenu: [
        { label: 'Open Project', submenu: openItems.length ? openItems : [{ label: 'No projects yet', enabled: false }] },
        { label: 'Add Project…', accelerator: 'CmdOrCtrl+Shift+O', click: () => addProject(BrowserWindow.getFocusedWindow()) },
        { label: 'Bring In Existing Work…', accelerator: 'CmdOrCtrl+Shift+I', click: send('import') },
      ],
    },
    {
      label: 'Feature',
      submenu: [
        { label: 'New Feature…', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: 'Rename…', accelerator: 'CmdOrCtrl+E', click: send('rename') },
        { label: 'Find Feature', accelerator: 'CmdOrCtrl+K', click: send('find') },
        { type: 'separator' },
        { label: 'Restart Services', accelerator: 'CmdOrCtrl+Shift+R', click: send('restart') },
        { label: 'Fix Feature', accelerator: 'CmdOrCtrl+Shift+F', click: send('fix') },
        { type: 'separator' },
        { label: 'Screenshot to Agent…', accelerator: 'CmdOrCtrl+Shift+S', click: send('shot') },
        { label: 'Window Screenshot to Agent…', accelerator: 'CmdOrCtrl+Alt+Shift+S', click: send('shot:window') },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle a Panel: ⌘⌥ + its key', enabled: false },
        { label: 'Zoom Panel', accelerator: 'CmdOrCtrl+Shift+Enter', click: send('zoom') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: send('keys') }],
    },
  ]))
  app.dock?.setMenu(Menu.buildFromTemplate([
    ...list.map((p) => ({ label: p.name, click: () => openProject(p.name) })),
    { type: 'separator' },
    { label: 'Add Project…', click: () => addProject(null) },
  ]))
}

function openRemembered() {
  const known = new Set(projects().map((p) => p.name))
  const remembered = readJSON(OPEN_FILE(), []).filter((name) => known.has(name))
  const start = process.env.GROVE_PROJECT ? [process.env.GROVE_PROJECT] : remembered.length ? remembered : [defaultProject()]
  // GROVE_REVIEW=1 opens as if the project had just been added (scripts/try-onboarding.sh app --added)
  for (const name of start) openProject(name, { review: process.env.GROVE_REVIEW === '1' })
}

// About Grove says which build is running, so you can tell whether an update took, and where it reads from when that is unusual.
// A packaged app reads version.json (stamped by `npm run dist`); a run from source asks git directly.
function setAbout() {
  let info = null
  if (app.isPackaged) info = readJSON(path.join(__dirname, 'version.json'), null)
  else {
    try {
      info = require('./scripts/stamp-version').buildInfo()
    } catch {}
  }
  const when = info?.builtAt && new Date(info.builtAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
  const build = !info ? 'unknown build' : !app.isPackaged ? 'dev, from source' : `built ${when}`
  app.setAboutPanelOptions({
    applicationName: 'Grove',
    applicationVersion: `${app.getVersion()}${info ? ` · ${info.short}` : ''}${info?.pr ? ` (#${info.pr})` : ''}`,
    version: info?.dirty ? `${build} · dirty` : build,
    // only what differs from a normal install; the commit and PR are already in the version line
    credits: [
      info?.branch && info.branch !== 'main' && `Branch: ${info.branch}`,
      !app.isPackaged && `App: ${app.getAppPath()}`,
      process.env.GROVE_HUB && `Hub: ${HUB}`,
      process.env.GROVE_BIN && `CLI: ${BIN}`,
    ].filter(Boolean).join('\n'),
  })
}

app.whenReady().then(async () => {
  setAbout()
  await grove(['ui', 'app']) // new features get hosted sessions for this app
  buildMenu()
  openRemembered()
  watchHub()
  // an installed app checks; a dev run (`electron .`) only when asked, so screenshots stay offline
  if (app.isPackaged || process.env.GROVE_UPDATE_CHECK) {
    setTimeout(checkUpdate, 15 * 1000)
    setInterval(checkUpdate, UPDATE_EVERY)
  }
  app.on('activate', () => {
    if (windows.size === 0) openRemembered()
  })
})
app.on('before-quit', () => { quitting = true })
app.on('window-all-closed', () => app.quit())
