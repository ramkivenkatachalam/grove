# Pitch video

`pitch.html` is the 72 s animation (scene timeline in its `setTime`), `render.js` renders it frame by frame
with Electron, `music.wav` is the original soundtrack. `real.png` (a screenshot of a real project window) is
deliberately not committed — capture your own with `FH_SCREENSHOT=…/real.png npx electron .` from the repo root.

    npx electron docs/video/render.js 30            # → docs/video/frames/*.png (about 6 minutes)
    ffmpeg -framerate 30 -i docs/video/frames/%05d.png -i docs/video/music.wav -map 0:v -map 1:a \
      -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest -movflags +faststart grove-pitch.mp4
