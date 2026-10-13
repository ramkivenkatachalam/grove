// Feature Hub: the Electron main process. State comes from ~/.claude/feature-hub (written by `fh`
// and the feature-hub Claude Code mod); actions go through `fh`; every terminal is a tmux session
// attached through ptybridge.py, so quitting the app never stops an agent or a server.
const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn, execFile } = require('child_process')

const HOME = os.homedir()
const HUB = process.env.GROVE_HUB || path.join(HOME, '.claude/feature-hub')
const FH = process.env.GROVE_BIN || path.join(HUB, 'bin/fh')
// a Finder-launched app has a bare PATH: tmux, gh, git and claude live in these
process.env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local/bin'), process.env.PATH]
  .filter(Boolean).join(':')

let win = null
const terms = new Map() // id -> child process

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


function loadState() {
  let names = []
  try {
    names = fs.readdirSync(path.join(HUB, 'features')).filter((f) => f.endsWith('.json'))
  } catch {}
  const prs = (readJSON(path.join(HUB, 'prs.json'), {}).byBranch) || {}
  const features = names
    .map((file) => readJSON(path.join(HUB, 'features', file), null))
    .filter(Boolean)
    .map((f) => ({
      ...f,
      title: f.title || f.name,
      status: readJSON(path.join(HUB, 'status', f.name + '.json'), { state: 'offline' }),
      pr: prs[f.branch] || null,
    }))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.name.localeCompare(b.name))
  return { features, palette: palette(), focus: readJSON(path.join(HUB, 'focus.json'), null) }
}

function sendState() {
  if (!win || win.isDestroyed()) return
  const state = loadState()
  win.webContents.send('state', state)
  const waiting = state.features.filter((f) => f.status.state === 'waiting').length
  app.dock?.setBadge(waiting ? String(waiting) : '')
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

// ---- terminals ----
ipcMain.handle('term:open', (_e, { id, session, cols, rows }) => {
  if (terms.has(id)) return true
  const child = spawn('python3', [path.join(__dirname, 'ptybridge.py'), String(cols), String(rows), '--',
    'tmux', 'attach-session', '-t', '=' + session], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: process.env })
  terms.set(id, child)
  child.stdout.on('data', (chunk) => win?.webContents.send('term:data', id, chunk))
  child.stderr.on('data', (chunk) => win?.webContents.send('term:data', id, chunk))
  child.on('exit', () => {
    terms.delete(id)
    win?.webContents.send('term:exit', id)
  })
  return true
})
ipcMain.on('term:write', (_e, id, data) => terms.get(id)?.stdin.write(data))
ipcMain.on('term:resize', (_e, id, cols, rows) => terms.get(id)?.stdio[3].write(JSON.stringify({ cols, rows }) + '\n'))
ipcMain.on('term:close', (_e, id) => {
  terms.get(id)?.stdin.end()
  terms.delete(id)
})

// ---- state and actions ----
ipcMain.handle('state', () => loadState())
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
ipcMain.handle('row-menu', (_e, feature) => new Promise((resolve) => {
  const items = [
    { label: 'Rename…', click: () => resolve('rename') },
    { label: 'Restart servers', click: () => resolve('restart') },
    { type: 'separator' },
    ...Object.entries(feature.links || {}).map(([svc, url]) => ({ label: `Open ${svc}  ${url}`, click: () => resolve('open:' + url) })),
    ...(feature.prUrl ? [{ label: 'Open pull request', click: () => resolve('open-pr') }] : []),
    { label: 'Reveal worktree in Finder', click: () => resolve('reveal') },
    { type: 'separator' },
    { label: 'Close feature…', click: () => resolve('done') },
  ]
  Menu.buildFromTemplate(items).popup({ window: win, callback: () => resolve(null) })
}))
ipcMain.on('reveal', (_e, dir) => shell.showItemInFolder(dir))
ipcMain.handle('confirm', async (_e, message, detail) => {
  const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: ['Close feature', 'Cancel'], defaultId: 1, cancelId: 1, message, detail })
  return response === 0
})

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 900,
    minHeight: 560,
    title: 'Grove',
    backgroundColor: '#161616',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  })
  win.loadFile(path.join(__dirname, 'renderer/index.html'))
  // a reload starts a new page: detach its old terminals (their tmux sessions keep running)
  win.webContents.on('did-start-navigation', (_e, _url, _inPlace, isMainFrame) => {
    if (!isMainFrame) return
    for (const child of terms.values()) child.stdin.end()
    terms.clear()
  })
  win.on('closed', () => {
    for (const child of terms.values()) child.stdin.end()
    terms.clear()
    win = null
  })
  if (process.env.FH_SCREENSHOT) {
    // FH_SCREENSHOT_JS runs once in the page first (e.g. to open panels), for visual checks
    if (process.env.FH_SCREENSHOT_JS) {
      win.webContents.once('did-finish-load', () => win.webContents.executeJavaScript(process.env.FH_SCREENSHOT_JS))
    }
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const image = await win.webContents.capturePage()
      fs.writeFileSync(process.env.FH_SCREENSHOT, image.toPNG())
      app.quit()
    }, Number(process.env.FH_SCREENSHOT_DELAY || 6000)))
  }
}

function buildMenu() {
  const send = (action) => () => win?.webContents.send('menu', action)
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'Feature',
      submenu: [
        { label: 'New Feature…', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: 'Rename…', accelerator: 'CmdOrCtrl+E', click: send('rename') },
        { label: 'Find Feature', accelerator: 'CmdOrCtrl+K', click: send('find') },
        { type: 'separator' },
        { label: 'Restart Servers', accelerator: 'CmdOrCtrl+Shift+R', click: send('restart') },
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
}

app.whenReady().then(async () => {
  await fh(['ui', 'app']) // new features get hosted sessions for this app
  buildMenu()
  createWindow()
  watchHub()
  app.on('activate', () => {
    if (!win) createWindow()
  })
})
app.on('window-all-closed', () => app.quit())
