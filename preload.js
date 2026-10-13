const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hub', {
  project: new URLSearchParams(location.search).get('project') || null,
  state: (project) => ipcRenderer.invoke('state', project),
  onState: (fn) => ipcRenderer.on('state', (_e, state) => fn(state)),
  onMenu: (fn) => ipcRenderer.on('menu', (_e, action) => fn(action)),
  fh: (args) => ipcRenderer.invoke('fh', args),
  host: (name) => ipcRenderer.invoke('host', name),
  open: (url) => ipcRenderer.send('open', url),
  reveal: (dir) => ipcRenderer.send('reveal', dir),
  rowMenu: (feature) => ipcRenderer.invoke('row-menu', feature),
  projectMenu: (current) => ipcRenderer.invoke('project-menu', current),
  openProject: (name) => ipcRenderer.send('open-project', name),
  addProject: () => ipcRenderer.invoke('add-project'),
  confirm: (message, detail) => ipcRenderer.invoke('confirm', message, detail),
  doc: {
    read: (kind, name) => ipcRenderer.invoke('doc:read', kind, name),
    write: (kind, name, text) => ipcRenderer.invoke('doc:write', kind, name, text),
  },
  brief: (name) => ipcRenderer.invoke('brief', name),
  term: {
    open: (opts) => ipcRenderer.invoke('term:open', opts),
    write: (id, data) => ipcRenderer.send('term:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
    close: (id) => ipcRenderer.send('term:close', id),
    onData: (fn) => ipcRenderer.on('term:data', (_e, id, chunk) => fn(id, chunk)),
    onExit: (fn) => ipcRenderer.on('term:exit', (_e, id) => fn(id)),
  },
})
