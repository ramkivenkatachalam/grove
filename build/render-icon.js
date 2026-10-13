// Renders build/icon.svg to build/icon-1024.png with Electron (no image tools needed).
//   npx electron build/render-icon.js
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8')
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true,
    webPreferences: { offscreen: true } })
  win.setBackgroundColor('#00000000')
  win.webContents.setZoomFactor(1)
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 400))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  const png = image.resize({ width: 1024, height: 1024 }).toPNG()
  fs.writeFileSync(path.join(__dirname, 'icon-1024.png'), png)
  app.quit()
})
