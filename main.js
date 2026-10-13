// Grove: the Electron main process. One window per project. State comes from ~/.grove
// (written by `fh` and the Claude Code mod); actions go through `fh`; every terminal is a tmux session
// attached through ptybridge.py, so closing a window or quitting never stops an agent or a server.
const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn, execFile } = require('child_process')

const HOME = os.homedir()
const HUB = process.env.GROVE_HUB || path.join(HOME, '.grove')
const FH = process.env.GROVE_BIN || path.join(HUB, 'bin/fh')
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
function projects() {
  let names = []
  try {
    names = fs.readdirSync(path.join(HUB, 'projects')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort()
  } catch {}
  return names.map((name) => {
    const repo = (readJSON(path.join(HUB, 'projects', name + '.json'), {}).repo || '').replace(/^~/, HOME)
    return { name, repo }
  })
}

function defaultProject() {
  const names = projects().map((p) => p.name)
  const chosen = readJSON(path.join(HUB, 'config.json'), {}).defaultProject
  return names.includes(chosen) ? chosen : names[0] || null
}

function allFeatures() {
  let files = []
  try {
    files = fs.readdirSync(path.join(HUB, 'features')).filter((f) => f.endsWith('.json'))
  } catch {}
  const prs = (readJSON(path.join(HUB, 'prs.json'), {}).byBranch) || {}
  const fallback = defaultProject()
  return files
    .map((file) => readJSON(path.join(HUB, 'features', file), null))
    .filter(Boolean)
    .map((f) => ({
      ...f,
      project: f.project || fallback,
      title: f.title || f.name,
      status: readJSON(path.join(HUB, 'status', f.name + '.json'), { state: 'offline' }),
      pr: prs[f.branch] || null,
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
    fs.watch(HUB, { recursive: true }, () => {
      clearTimeout(pending)
      pending = setTimeout(sendState, 150)
    })
  } catch {}
  setInterval(sendState, 4000) // a backstop for missed events
}

function fh(args) {
  return new Promise((resolve) => {
    execFile(FH, args, { env: process.env, timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
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

function openProject(project) {
  const existing = windows.get(project)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
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
  win.loadFile(path.join(__dirname, 'renderer/index.html'), { query: { project: project || '' } })
  win.on('page-title-updated', (e) => e.preventDefault()) // keep "<project> — Grove"
  const contents = win.webContents
  // a reload starts a new page: detach its old terminals (their tmux sessions keep running)
  contents.on('did-start-navigation', (_e, _url, _inPlace, isMainFrame) => isMainFrame && closeTerminalsOf(contents))
  win.on('closed', () => {
    closeTerminalsOf(contents)
    windows.delete(project)
    rememberOpen()
  })
  if (process.env.FH_SCREENSHOT && windows.size === 1) {
    // FH_SCREENSHOT_JS runs once in the page first (e.g. to open panels), for visual checks
    if (process.env.FH_SCREENSHOT_JS) contents.once('did-finish-load', () => contents.executeJavaScript(process.env.FH_SCREENSHOT_JS))
    contents.once('did-finish-load', () => setTimeout(async () => {
      fs.writeFileSync(process.env.FH_SCREENSHOT, (await contents.capturePage()).toPNG())
      app.quit()
    }, Number(process.env.FH_SCREENSHOT_DELAY || 6000)))
  }
  return win
}

async function addProject(parent) {
  const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
    title: 'Add a project to Grove', message: 'Choose the main checkout of a git repository',
    properties: ['openDirectory'], buttonLabel: 'Add Project',
  })
  if (canceled || !filePaths[0]) return null
  const result = await fh(['project', 'add', filePaths[0]])
  if (result.code) {
    dialog.showMessageBox(parent, { type: 'warning', message: 'Could not add the project', detail: (result.stderr || result.stdout).trim() })
    return null
  }
  const name = (result.stdout.match(/^project (\S+):/) || [])[1]
  sendState()
  if (name) openProject(name)
  return name
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
ipcMain.handle('fh', async (_e, args) => {
  const result = await fh(args)
  sendState()
  return result
})
ipcMain.handle('host', async (_e, name) => {
  const result = await fh(['host', name])
  try {
    return JSON.parse(result.stdout)
  } catch {
    return { error: (result.stderr || result.stdout).trim() }
  }
})
ipcMain.on('open', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url)
})
ipcMain.on('open-project', (_e, name) => openProject(name))
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
    { type: 'separator' },
    ...Object.entries(feature.links || {}).map(([svc, url]) => ({ label: `Open ${svc}  ${url}`, click: () => resolve('open:' + url) })),
    ...(feature.prUrl ? [{ label: 'Open pull request', click: () => resolve('open-pr') }] : []),
    { label: 'Reveal worktree in Finder', click: () => resolve('reveal') },
    { type: 'separator' },
    { label: 'Close feature…', click: () => resolve('done') },
  ]
  Menu.buildFromTemplate(items).popup({ window: windowOf(e), callback: () => resolve(null) })
}))
ipcMain.on('reveal', (_e, dir) => shell.showItemInFolder(dir))
ipcMain.handle('confirm', async (e, message, detail) => {
  const { response } = await dialog.showMessageBox(windowOf(e), { type: 'question', buttons: ['Close feature', 'Cancel'], defaultId: 1, cancelId: 1, message, detail })
  return response === 0
})

// ---- menus ----
let lastMenuKey = ''
function buildMenu() {
  const list = projects()
  const key = JSON.stringify(list.map((p) => p.name))
  if (key === lastMenuKey) return
  lastMenuKey = key
  const send = (action) => () => BrowserWindow.getFocusedWindow()?.webContents.send('menu', action)
  const openItems = list.map((p, i) => ({
    label: p.name, accelerator: i < 9 ? `CmdOrCtrl+Shift+${i + 1}` : undefined, click: () => openProject(p.name),
  }))
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'Project',
      submenu: [
        { label: 'Open Project', submenu: openItems.length ? openItems : [{ label: 'No projects yet', enabled: false }] },
        { label: 'Add Project…', accelerator: 'CmdOrCtrl+Shift+O', click: () => addProject(BrowserWindow.getFocusedWindow()) },
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
  for (const name of start) openProject(name)
}

app.whenReady().then(async () => {
  await fh(['ui', 'app']) // new features get hosted sessions for this app
  buildMenu()
  openRemembered()
  watchHub()
  app.on('activate', () => {
    if (windows.size === 0) openRemembered()
  })
})
app.on('before-quit', () => { quitting = true })
app.on('window-all-closed', () => app.quit())
