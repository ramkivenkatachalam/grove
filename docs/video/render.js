// Renders pitch.html frame by frame: `electron render.js [fps] [t1,t2,…]` (stills when times are given)
const { app, BrowserWindow } = require('electron'); const fs = require('fs'); const path = require('path')
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const fps = Number(process.argv[2] || 30), stills = process.argv[3] ? process.argv[3].split(',').map(Number) : null
  const dur = 72, dir = path.join(__dirname, stills ? 'stills' : 'frames'); fs.mkdirSync(dir, { recursive: true })
  const win = new BrowserWindow({ width: 1920, height: 1080, show: false, useContentSize: true, webPreferences: { offscreen: true } })
  await win.loadFile(path.join(__dirname, 'pitch.html')); await new Promise(r => setTimeout(r, 2000))
  const times = stills || Array.from({ length: dur * fps }, (_, i) => i / fps)
  // warm up: decode every image and settle the compositor before the first saved frame
  for (const t of [3, 21, 31, 40, 52, 69, 0]) {
    await win.webContents.executeJavaScript(`setTime(${t}); new Promise(r => setTimeout(r, 150))`)
    await win.webContents.capturePage({ x: 0, y: 0, width: 1920, height: 1080 })
  }
  // settle each frame: two animation frames and a beat, then capture twice (the second is current)
  for (let i = 0; i < times.length; i++) {
    await win.webContents.executeJavaScript(`setTime(${times[i]}); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 40))))`)
    await win.webContents.capturePage({ x: 0, y: 0, width: 1920, height: 1080 })
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1920, height: 1080 })
    fs.writeFileSync(path.join(dir, stills ? `t${times[i]}.png` : `${String(i).padStart(5, '0')}.png`), img.toPNG())
  }
  app.quit()
})
