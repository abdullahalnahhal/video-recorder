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
| **Sound mixer** | A full channel strip for the mic and for system/screen audio: dynamics (compressor), noise control (gate + rumble filter), spatial effects (reverb, delay, echo), routing (mute / include-in-mix), and a sidechain (compression or gating) between the two — see [Sound mixer](#sound-mixer) below |
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

## Sound mixer

Switch the side panel from **Video** to **Sound** for a small mixing console. It's live as soon as you open the tab (even before you hit Record), so you can dial everything in while watching the level meters, and keep adjusting it mid-recording.

Each of **Microphone** and **System / screen audio** gets its own channel strip:

| Section | Controls | What it's for |
|---|---|---|
| **Dynamics processing** | Compressor: threshold, ratio, attack, release, makeup gain | Evens out a voice that swings between quiet and loud |
| **Noise control** | Rumble filter (high-pass) + noise gate (threshold, release) | Cuts low hum and hiss/background noise between words |
| **Spatial effects** | Insert: None / Delay / Echo, with time, feedback and mix; separate **reverb send** to a shared reverb bus (room size + return level, in the *Reverb bus* panel) | Adds space or repeats to a channel |
| **Routing** | *Include in the mix* | Pulls a channel in or out of the recorded/monitored signal entirely |

Plus two shared panels:

- **Advanced control — Sidechain.** Pick a *trigger* channel (mic or system audio) and a mode:
  - **Sidechain compression** — proportionally turns the other channel down while the trigger is active (classic "duck the music while I talk").
  - **Sidechain gating** — hard-cuts the other channel instead of a gradual reduction.

  Threshold, ratio/depth, attack, release and makeup gain all apply to how the *other* channel reacts to the trigger.
- **Master.** Overall level, a limiter (keeps the mix from clipping), and a **Monitor through speakers** toggle — leave this off unless you're on headphones, since otherwise the mic will pick the speakers back up.

All of it is built on the Web Audio API: a native `DynamicsCompressorNode` for the compressors and limiter, a `ConvolverNode` with a procedurally generated impulse response for the reverb (no audio file needed), `DelayNode` feedback loops for delay/echo, and two small custom `AudioWorkletProcessor`s (in `js/worklets/audio-fx-processors.js`) for the noise gate and the sidechain engine — Web Audio has no built-in node for either.

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
      mic ─► trim ─► highpass ─► gate ─► compressor ─┐           │
                                                      ├─ sidechain ─► dry/delay ─► reverb send ─┐
   system ─► trim ─► highpass ─► gate ─► compressor ─┘  (shared)                                ├─► master ─► limiter ──┘ (audio track)
                                                                            reverb bus ───────────┘
```

- **Compositing:** every frame is drawn onto one `<canvas>` (`canvas.captureStream()`), which is why the source can change mid-recording.
- **Render clock:** a Web Worker timer drives frames, so recording keeps running when the tab is in the background (`requestAnimationFrame` would pause). It waits for each frame to finish, so slow machines drop frames instead of freezing.
- **Virtual background:** [MediaPipe Image Segmenter](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter) (selfie model), with the GPU used when available. The library (`js/vendor/mediapipe/`) and model (`models/`) are bundled, so it works offline.
- **Effects:** Canvas 2D filters (`blur`, `grayscale`, `contrast`). Blur is computed at quarter resolution and scaled up, which is much cheaper and looks the same.
- **Sound mixer:** a fixed Web Audio graph built once per channel (see [Sound mixer](#sound-mixer)); every control is a parameter change on an always-connected node, never a rewire, so turning an effect on or off mid-recording can't click or glitch.
- **Saving:** the [File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access) (`showSaveFilePicker`), opened directly from the *Stop* click, with a normal download as the fallback.

---

## Project structure

```
├── index.html                  # Page markup
├── css/style.css               # Styles (custom styles in "Author's custom styles")
├── js/
│   ├── app.js                  # The whole application
│   ├── vendor/mediapipe/       # MediaPipe Tasks Vision 1.1.0 (JS + WebAssembly)
│   └── worklets/               # AudioWorklet DSP: noise gate + sidechain processor
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
| Noise gate/compressor/sidechain controls don't seem to do anything | Your browser doesn't support `AudioWorklet` (needs a secure context, same as recording — see above). The mixer falls back to passing audio through unprocessed for those two effects; dynamics, filters, delay/echo and reverb still work. |
| I hear my own voice echoing back / howling feedback | You turned on **Monitor through speakers** without headphones. Turn it off, or switch to headphones. |
| The mix sounds thin or the music disappears completely | The sidechain is probably set to **gating** with a low threshold — try **compression** mode, or reduce its depth/raise its threshold. |

---

## Recommendations

### For using it

- **Use Chrome or Edge.** You get the "Save as" window, MP4 output and GPU-accelerated backgrounds.
- **Choose MP4.** It plays everywhere (Windows, macOS, iPhone, WhatsApp, YouTube). Browser-made WebM files often have no duration, so seeking breaks in some players.
- **Turn off "Mirror webcam" for screen recordings** where you hold up text or documents. Mirroring is nice for the preview but is also saved into the video.
- **Good light in front of you** makes virtual backgrounds noticeably cleaner.
- **Share "Entire screen" rather than this tab.** Recording the recorder itself creates an infinite mirror; the app already hides its own tab from the picker in Chrome.
- **Deploy over HTTPS.** Camera, screen sharing and the "Save as" window all need it.
- **Start with the sidechain in compression mode, not gating.** Gating is more aggressive (a hard on/off) and is easy to set too deep by accident, which can make background audio disappear entirely. Compression gives you a gentler, more predictable duck.
- **A small amount of compression + a light noise gate is usually enough** for a typical voiceover mic. Save reverb/delay/echo for intentional effect, not as a default — they're easy to overdo.

### For future development

1. **Save while recording (long recordings).** Recorded data is kept in memory until you stop, so very long sessions (1h+ at 1080p) use a lot of RAM. Choosing the file at *Start* and streaming chunks to it with `createWritable()` would remove that limit and protect against crashes.
2. **Drag the webcam overlay** freely instead of picking one of four corners.
3. **Upload your own background** from the computer (and remember it with IndexedDB).
4. **Countdown (3-2-1) and keyboard shortcuts** (e.g. `Space` = pause, `Ctrl+Shift+R` = start/stop).
5. **Mixer presets** ("Podcast voice", "Music ducking", "Clean dialogue") that set every channel-strip control in one click, instead of tuning each slider by hand.
6. **A compressor gain-reduction meter** (how many dB it's currently pulling down), which is the normal way to judge if a compressor/sidechain setting is too aggressive — our level meters only show output, not reduction.
7. **Automatic background list.** Replace `backgrounds.json` with a small server script (or a build step) that lists `img/backgrounds/`.
8. **Fix WebM duration** with a library such as `fix-webm-duration`, so WebM files are seekable.
9. **Trim before saving.** Cut the start/end in the preview dialog.
10. **Annotations.** Draw/highlight on screen and show clicks while recording.
11. **PWA / offline install.** The project already has a web manifest; add a service worker for an installable app.
12. **Automated tests.** Puppeteer/Playwright with Chrome's `--use-fake-device-for-media-stream` flag can test the whole flow headlessly (this is how the mixer above was verified — ffprobe/ffmpeg on the recorded output confirms the audio track and its level).
13. **Translations** (e.g. Arabic with RTL layout).

---

## Third-party licenses

- [HTML5 Boilerplate](https://html5boilerplate.com/): MIT (see `LICENSE.txt`)
- [MediaPipe](https://github.com/google-ai-edge/mediapipe) Tasks Vision & selfie segmentation model: Apache License 2.0
- Background images in `img/backgrounds/` were generated for this project and are free to use.
