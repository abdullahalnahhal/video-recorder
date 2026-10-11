# Video Recorder

A browser-based recorder for your **webcam**, your **entire screen**, or **both at once**: the screen as the main video with your webcam in a corner. It also has webcam effects and virtual backgrounds.

Everything runs in the browser. Nothing is uploaded, and the video is saved straight to a folder you choose.

---

## Features

| | |
|---|---|
| **Sources** | Webcam · Screen · Screen + Webcam (picture-in-picture) |
| **Switch while recording** | Change source, effects or background mid-recording without breaking the file |
| **Webcam overlay** | Choose the corner, size (12–40 % of the width) and shape (rounded rectangle or circle) |
| **Webcam effects** | Blur (adjustable), Black & white, High contrast. They can be combined |
| **Virtual background** | None, background blur, or any image from `img/backgrounds/` (AI person segmentation, runs locally) |
| **Audio** | Microphone and screen/tab audio, mixed into one track. Both can be toggled while recording |
| **Recording** | Start, pause/resume, stop. Live timer. 1080p or 720p. MP4 (H.264) or WebM (VP9/VP8) |
| **Saving** | On stop, a **"Save as" window** opens so you can choose where to save the video |
| **Safety net** | If you cancel the save window, a dialog shows a preview with *Save as…* / *Discard*, so the recording isn't lost |
| **Devices** | Pick the camera and microphone |
| **Background-safe** | Keeps recording smoothly while you work in other windows or tabs |

---

## Download

**Option A: Git**

```bash
git clone https://github.com/abdullahalnahhal/video-recorder.git
cd video-recorder
```

**Option B: ZIP**

Download <https://github.com/abdullahalnahhal/video-recorder/archive/refs/heads/main.zip> and extract it.

---

## Installation & running

The app is plain HTML/CSS/JavaScript with **no build step required**. It only needs to be served by a web server.

> ⚠️ Browsers only allow camera and screen access on **`localhost`** or **`https://`**.
> Opening `index.html` directly (`file://…`) or through a LAN IP over `http://` will not work.

Pick **one** of these:

### 1. Any static server (quickest)

```bash
# Python (pre-installed on most Linux/macOS)
python3 -m http.server 8000
# → open http://localhost:8000

# or Node.js
npx serve .
```

### 2. Webpack dev server (auto-reload while editing)

Requires Node.js 18+.

```bash
npm install
npm start          # opens http://localhost:8080
```

### 3. Apache / nginx

Copy the folder into your web root (e.g. `/var/www/html/video-recorder`) and open
`http://localhost/video-recorder/`.

For a server reachable from other machines, it **must** use HTTPS (e.g. with Let's Encrypt).

### Production build (optional)

```bash
npm install
npm run build      # minified site in dist/
```

Upload the contents of `dist/` to any static host: GitHub Pages, Netlify, Vercel, or your own server.

---

## How to use

1. Open the page and **allow camera access**. Your webcam appears in the preview.
2. Choose a **Source**:
   - **Webcam**: camera only.
   - **Screen**: the browser asks what to share. Choose **Entire screen**.
   - **Screen + Webcam**: your screen with the webcam in a corner. Adjust it under **Webcam overlay**.
3. Optional: turn on **Webcam effects** or pick a **Webcam background**. The first background takes a few seconds to load the AI model.
4. Click **Start recording** and allow the microphone if asked.
5. Click **Stop & save**, then choose where to save the video in the "Save as" window.

> 💡 To record tab or system sound, tick **"Share tab audio"** / **"Share system audio"** in the browser's screen-share window.

---

## Adding your own backgrounds

1. Put the image (JPG/PNG/WebP, ideally 1920×1080) in `img/backgrounds/`.
2. Add it to `img/backgrounds/backgrounds.json`:

```json
[
  { "name": "Mountains", "file": "mountains.jpg" },
  { "name": "My office", "file": "my-office.jpg" }
]
```

3. Reload the page. It appears in the **Webcam background** grid.

---

## Browser support

| Browser | Recording | "Save as" window | MP4 output | Backgrounds & effects |
|---|---|---|---|---|
| **Chrome / Edge** (desktop) | ✅ | ✅ | ✅ | ✅ |
| **Opera / Brave** (desktop) | ✅ | ✅ | ✅ | ✅ |
| **Firefox** | ✅ | ❌ normal download\* | ❌ WebM only | ✅ |
| **Safari** (macOS) | ✅ | ❌ normal download\* | ✅ | ⚠️ effects need a recent Safari |
| Mobile browsers | ⚠️ webcam only | ❌ | varies | varies |

\* The file downloads like any other download. Whether you're asked for a location depends on the browser's download settings (Firefox: *Settings → Downloads → "Always ask you where to save files"*).

**Recommended:** the latest Chrome or Edge.

---

## How it works

```
 Webcam ──► [segmentation + background] ──► [effects] ──┐
                                                         ├──► <canvas> ──► MediaRecorder ──► Blob ──► "Save as"
 Screen ─────────────────────────────────────────────────┘        ▲
                                                                  │
 Mic + screen audio ──► Web Audio mixer ──────────────────────────┘ (audio track)
```

- **Compositing:** every frame is drawn onto one `<canvas>` (`canvas.captureStream()`), which is why the source can change mid-recording.
- **Render clock:** a Web Worker timer drives frames, so recording keeps running when the tab is in the background (`requestAnimationFrame` would pause). It waits for each frame to finish, so slow machines drop frames instead of freezing.
- **Virtual background:** [MediaPipe Image Segmenter](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter) (selfie model), with the GPU used when available. The library (`js/vendor/mediapipe/`) and model (`models/`) are bundled, so it works offline.
- **Effects:** Canvas 2D filters (`blur`, `grayscale`, `contrast`). Blur is computed at quarter resolution and scaled up, which is much cheaper and looks the same.
- **Saving:** the [File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access) (`showSaveFilePicker`), opened directly from the *Stop* click, with a normal download as the fallback.

---

## Project structure

```
├── index.html                  # Page markup
├── css/style.css               # Styles (custom styles in "Author's custom styles")
├── js/
│   ├── app.js                  # The whole application
│   └── vendor/mediapipe/       # MediaPipe Tasks Vision 1.1.0 (JS + WebAssembly)
├── models/
│   └── selfie_segmenter.tflite # Person segmentation model
├── img/backgrounds/            # Background images + backgrounds.json
├── webpack.*.js                # Optional dev server / production build
└── package.json
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Allow camera access" never goes away | Click the camera icon in the address bar → *Allow* → reload. Close other apps using the camera (Zoom, Teams…). |
| Nothing works, buttons disabled | You're not on `localhost`/`https://`. See [Installation](#installation--running). |
| Text on my screen is reversed | That's the webcam mirror. Untick **Mirror webcam** (it also mirrors the saved video). |
| No sound from the screen | Tick *Share tab/system audio* in the browser's share window, and keep **Screen / tab audio** on. |
| Background edges look rough | Improve lighting and use a plain wall behind you. Make sure hardware acceleration is on (`chrome://settings/system`). |
| Video is choppy | Choose 720p, turn off the background/blur, and close heavy tabs. |
| No "Save as" window | Your browser doesn't support it (Firefox/Safari). The video downloads normally instead. |
| WebM file has no duration / can't seek | Use **MP4**, or play it in VLC. |

---

## Recommendations

### For using it

- **Use Chrome or Edge.** You get the "Save as" window, MP4 output and GPU-accelerated backgrounds.
- **Choose MP4.** It plays everywhere (Windows, macOS, iPhone, WhatsApp, YouTube). Browser-made WebM files often have no duration, so seeking breaks in some players.
- **Turn off "Mirror webcam" for screen recordings** where you hold up text or documents. Mirroring is nice for the preview but is also saved into the video.
- **Good light in front of you** makes virtual backgrounds noticeably cleaner.
- **Share "Entire screen" rather than this tab.** Recording the recorder itself creates an infinite mirror; the app already hides its own tab from the picker in Chrome.
- **Deploy over HTTPS.** Camera, screen sharing and the "Save as" window all need it.

### For future development

1. **Save while recording (long recordings).** Recorded data is kept in memory until you stop, so very long sessions (1h+ at 1080p) use a lot of RAM. Choosing the file at *Start* and streaming chunks to it with `createWritable()` would remove that limit and protect against crashes.
2. **Drag the webcam overlay** freely instead of picking one of four corners.
3. **Upload your own background** from the computer (and remember it with IndexedDB).
4. **Countdown (3-2-1) and keyboard shortcuts** (e.g. `Space` = pause, `Ctrl+Shift+R` = start/stop).
5. **Microphone level meter**, so you can see the mic works before recording.
6. **Automatic background list.** Replace `backgrounds.json` with a small server script (or a build step) that lists `img/backgrounds/`.
7. **Fix WebM duration** with a library such as `fix-webm-duration`, so WebM files are seekable.
8. **Trim before saving.** Cut the start/end in the preview dialog.
9. **Annotations.** Draw/highlight on screen and show clicks while recording.
10. **PWA / offline install.** The project already has a web manifest; add a service worker for an installable app.
11. **Automated tests.** Puppeteer/Playwright with Chrome's `--use-fake-device-for-media-stream` flag can test the whole flow headlessly.
12. **Translations** (e.g. Arabic with RTL layout).

---

## Third-party licenses

- [HTML5 Boilerplate](https://html5boilerplate.com/): MIT (see `LICENSE.txt`)
- [MediaPipe](https://github.com/google-ai-edge/mediapipe) Tasks Vision & selfie segmentation model: Apache License 2.0
- Background images in `img/backgrounds/` were generated for this project and are free to use.
