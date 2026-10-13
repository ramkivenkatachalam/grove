const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hub', {
  state: () => ipcRenderer.invoke('state'),
  onState: (fn) => ipcRenderer.on('state', (_e, state) => fn(state)),
  onMenu: (fn) => ipcRenderer.on('menu', (_e, action) => fn(action)),
  fh: (args) => ipcRenderer.invoke('fh', args),
  host: (name) => ipcRenderer.invoke('host', name),
  open: (url) => ipcRenderer.send('open', url),
  reveal: (dir) => ipcRenderer.send('reveal', dir),
  rowMenu: (feature) => ipcRenderer.invoke('row-menu', feature),
  confirm: (message, detail) => ipcRenderer.invoke('confirm', message, detail),
  term: {
    open: (opts) => ipcRenderer.invoke('term:open', opts),
    write: (id, data) => ipcRenderer.send('term:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
    close: (id) => ipcRenderer.send('term:close', id),
    onData: (fn) => ipcRenderer.on('term:data', (_e, id, chunk) => fn(id, chunk)),
    onExit: (fn) => ipcRenderer.on('term:exit', (_e, id) => fn(id)),
  },
})
