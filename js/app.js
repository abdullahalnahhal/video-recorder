/*
 * Video Recorder
 *
 * Everything (webcam, screen, or screen with a webcam overlay) is drawn onto a
 * single <canvas>, and the canvas stream is what gets recorded. That's what makes
 * it possible to switch sources, effects and backgrounds in the middle of a
 * recording without breaking the file.
 */
(() => {
  'use strict';

  const FPS = 30;
  const MEDIAPIPE_BUNDLE = 'js/vendor/mediapipe/vision_bundle.js';
  const MEDIAPIPE_WASM = 'js/vendor/mediapipe/wasm';
  const SEGMENTER_MODEL = 'models/selfie_segmenter.tflite';
  const BACKGROUNDS_DIR = 'img/backgrounds/';

  // The first supported candidate of each group is used.
  const FORMAT_GROUPS = [
    {
      label: 'MP4 (H.264)', ext: 'mp4', type: 'video/mp4',
      candidates: ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4'],
    },
    { label: 'WebM (VP9)', ext: 'webm', type: 'video/webm', candidates: ['video/webm;codecs=vp9,opus'] },
    { label: 'WebM (VP8)', ext: 'webm', type: 'video/webm', candidates: ['video/webm;codecs=vp8,opus', 'video/webm'] },
  ];

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const els = {
    canvas: $('#output'),
    overlay: $('#stageOverlay'),
    overlaySpinner: $('#stageSpinner'),
    overlayMessage: $('#stageMessage'),
    overlayAction: $('#stageAction'),
    btnStart: $('#btnStart'),
    btnPause: $('#btnPause'),
    btnStop: $('#btnStop'),
    recStatus: $('#recStatus'),
    recStatusText: $('#recStatusText'),
    recTimer: $('#recTimer'),
    modeButtons: $$('#modeGroup [data-mode]'),
    cameraSelect: $('#cameraSelect'),
    btnChangeScreen: $('#btnChangeScreen'),
    pipPanel: $('#pipPanel'),
    cornerButtons: $$('#cornerGroup [data-corner]'),
    pipSize: $('#pipSize'),
    pipShape: $('#pipShape'),
    effectsPanel: $('#effectsPanel'),
    effectButtons: $$('#effectGroup [data-effect]'),
    blurRow: $('#blurRow'),
    blurAmount: $('#blurAmount'),
    mirror: $('#mirror'),
    bgPanel: $('#bgPanel'),
    bgGrid: $('#bgGrid'),
    bgNote: $('#bgNote'),
    micEnabled: $('#micEnabled'),
    micSelect: $('#micSelect'),
    systemAudio: $('#systemAudio'),
    resolution: $('#resolution'),
    format: $('#format'),
    dialog: $('#resultDialog'),
    resultVideo: $('#resultVideo'),
    resultInfo: $('#resultInfo'),
    resultMsg: $('#resultMsg'),
    btnSaveAs: $('#btnSaveAs'),
    btnDiscard: $('#btnDiscard'),
    toast: $('#toast'),
  };

  const ctx = els.canvas.getContext('2d', { alpha: false });
  const supportsCanvasFilter = 'filter' in ctx;

  const state = {
    mode: 'webcam',
    cam: null,
    screen: null,
    mic: null,
    camError: null,
    busy: '',
    effects: new Set(),
    blurAmount: Number(els.blurAmount.value),
    mirror: els.mirror.checked,
    background: { id: 'none', image: null },
    pip: { corner: 'br', size: Number(els.pipSize.value) / 100, shape: els.pipShape.value },
    formats: [],
    recording: null,
    stopping: false,
    result: null,
  };

  const camVideo = createHiddenVideo();
  const screenVideo = createHiddenVideo();

  function createHiddenVideo() {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    return video;
  }

  const needsCamera = (mode = state.mode) => mode !== 'screen';
  const needsScreen = (mode = state.mode) => mode !== 'webcam';
  const isReady = (video, stream) => Boolean(stream) && video.readyState >= 2 && video.videoWidth > 0;

  /* ------------------------------------------------------------------------
   * Rendering
   * --------------------------------------------------------------------- */

  function render() {
    const W = els.canvas.width;
    const H = els.canvas.height;

    ctx.fillStyle = '#0b0c0f';
    ctx.fillRect(0, 0, W, H);

    const camReady = isReady(camVideo, state.cam);
    const screenReady = isReady(screenVideo, state.screen);

    if (camReady && needsCamera()) {
      updateCameraLayer();
    }

    if (state.mode === 'webcam') {
      if (camReady) drawCamera(0, 0, W, H);
      return;
    }

    if (screenReady) drawContain(screenVideo, 0, 0, W, H);
    if (state.mode === 'both' && camReady) drawPip(W, H);
  }

  function drawContain(source, x, y, w, h) {
    const sw = source.videoWidth;
    const sh = source.videoHeight;
    const scale = Math.min(w / sw, h / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    ctx.drawImage(source, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  const blurRadius = (width) => state.blurAmount * width / 1280;

  function cameraFilter(width) {
    const parts = [];
    if (state.effects.has('blur')) parts.push(`blur(${blurRadius(width).toFixed(1)}px)`);
    if (state.effects.has('grayscale')) parts.push('grayscale(1)');
    if (state.effects.has('contrast')) parts.push('contrast(1.8)');
    return parts.length ? parts.join(' ') : 'none';
  }

  // Blurring a full-size frame is expensive, so blur a small copy and scale it
  // up; once blurred, the lower resolution isn't visible.
  const BLUR_DOWNSCALE = 4;

  // Returns a function that draws `source` (crop sx,sy,sw,sh) shrunk onto its
  // own small canvas with `filter` applied, for a w×h destination.
  function createSmallBlur() {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    return (source, sx, sy, sw, sh, w, h, filter, radius) => {
      const bw = Math.max(1, Math.round(w / BLUR_DOWNSCALE));
      const bh = Math.max(1, Math.round(h / BLUR_DOWNSCALE));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      // A blur fades out at the edges, so draw slightly larger than the canvas.
      const pad = Math.ceil(radius / BLUR_DOWNSCALE * 3);
      context.clearRect(0, 0, bw, bh);
      context.filter = filter;
      context.drawImage(source, sx, sy, sw, sh, -pad, -pad, bw + pad * 2, bh + pad * 2);
      context.filter = 'none';
      return canvas;
    };
  }

  const blurCamera = createSmallBlur();

  // Draws the (processed) webcam into the given rectangle, cropped to fill it.
  function drawCamera(x, y, w, h) {
    let source = segmentation.hasLayer() ? segmentation.layer : camVideo;
    const sw = camVideo.videoWidth;
    const sh = camVideo.videoHeight;
    const scale = Math.max(w / sw, h / sh);
    let cw = w / scale;
    let ch = h / scale;
    let cx = (sw - cw) / 2;
    let cy = (sh - ch) / 2;
    let filter = supportsCanvasFilter ? cameraFilter(w) : 'none';

    if (supportsCanvasFilter && state.effects.has('blur')) {
      source = blurCamera(source, cx, cy, cw, ch, w, h, cameraFilter(w / BLUR_DOWNSCALE), blurRadius(w));
      [cx, cy, cw, ch] = [0, 0, source.width, source.height];
      filter = 'none';
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.filter = filter;
    if (state.mirror) {
      ctx.translate(x + w, y);
      ctx.scale(-1, 1);
      ctx.drawImage(source, cx, cy, cw, ch, 0, 0, w, h);
    } else {
      ctx.drawImage(source, cx, cy, cw, ch, x, y, w, h);
    }
    ctx.restore();
  }

  function drawPip(W, H) {
    const { corner, size, shape } = state.pip;
    const margin = Math.round(W * 0.02);
    const w = Math.round(W * size);
    const h = shape === 'circle' ? w : Math.round(w * camVideo.videoHeight / camVideo.videoWidth);
    const x = corner[1] === 'l' ? margin : W - w - margin;
    const y = corner[0] === 't' ? margin : H - h - margin;
    const radius = shape === 'circle' ? w / 2 : Math.round(w * 0.06);

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = W * 0.012;
    ctx.fillStyle = '#000';
    roundedRectPath(x, y, w, h, radius);
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundedRectPath(x, y, w, h, radius);
    ctx.clip();
    drawCamera(x, y, w, h);
    ctx.restore();

    ctx.save();
    roundedRectPath(x, y, w, h, radius);
    ctx.lineWidth = Math.max(2, W * 0.0025);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.stroke();
    ctx.restore();
  }

  function roundedRectPath(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Draws an image to fill w×h, optionally flipped horizontally.
  function drawCover(target, image, w, h, flip) {
    const iw = image.naturalWidth || image.width;
    const ih = image.naturalHeight || image.height;
    const scale = Math.max(w / iw, h / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    target.save();
    if (flip) {
      target.translate(w, 0);
      target.scale(-1, 1);
    }
    target.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
    target.restore();
  }

  /* ------------------------------------------------------------------------
   * Background replacement (MediaPipe selfie segmentation)
   * --------------------------------------------------------------------- */

  const segmentation = (() => {
    const layer = document.createElement('canvas');
    const layerCtx = layer.getContext('2d');
    const person = document.createElement('canvas');
    const personCtx = person.getContext('2d');
    const mask = document.createElement('canvas');
    const maskCtx = mask.getContext('2d');
    let maskImage = null;
    let maskPixels = null;
    let hasMask = false;
    let segmenter = null;
    let loading = null;
    let lastTimestamp = 0;
    let failures = 0;
    const blurBackground = createSmallBlur();

    function load() {
      if (segmenter) return Promise.resolve(segmenter);
      if (!loading) {
        loading = (async () => {
          const url = (path) => new URL(path, document.baseURI).href;
          const vision = await import(/* webpackIgnore: true */ url(MEDIAPIPE_BUNDLE));
          const fileset = await vision.FilesetResolver.forVisionTasks(url(MEDIAPIPE_WASM));
          const create = (delegate) => vision.ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: url(SEGMENTER_MODEL), delegate },
            runningMode: 'VIDEO',
            outputConfidenceMasks: true,
            outputCategoryMask: false,
          });
          try {
            segmenter = await create('GPU');
          } catch (err) {
            console.warn('GPU segmentation unavailable, falling back to CPU.', err);
            segmenter = await create('CPU');
          }
          return segmenter;
        })();
        loading.catch(() => {
          loading = null;
        });
      }
      return loading;
    }

    function writeMask(data, width, height, invert) {
      if (mask.width !== width || mask.height !== height || !maskImage) {
        mask.width = width;
        mask.height = height;
        maskImage = maskCtx.createImageData(width, height);
        maskPixels = new Uint32Array(maskImage.data.buffer);
      }
      for (let i = 0; i < data.length; i++) {
        const confidence = invert ? 1 - data[i] : data[i];
        // Tighten the soft edge a little to reduce the halo around the person.
        const alpha = Math.min(1, Math.max(0, (confidence - 0.25) * 2));
        maskPixels[i] = ((alpha * 255) << 24) | 0xffffff;
      }
      maskCtx.putImageData(maskImage, 0, 0);
      hasMask = true;
    }

    function segment() {
      let timestamp = performance.now();
      if (timestamp <= lastTimestamp) timestamp = lastTimestamp + 1;
      lastTimestamp = timestamp;
      segmenter.segmentForVideo(camVideo, timestamp, (result) => {
        const masks = result.confidenceMasks;
        if (!masks || !masks.length) return;
        // Single-channel models give the person confidence; multi-class models put background first.
        writeMask(masks[0].getAsFloat32Array(), masks[0].width, masks[0].height, masks.length > 1);
      });
    }

    function compose() {
      const w = camVideo.videoWidth;
      const h = camVideo.videoHeight;
      if (layer.width !== w || layer.height !== h) {
        layer.width = person.width = w;
        layer.height = person.height = h;
      }

      // Cut the person out of the camera frame using the mask.
      personCtx.globalCompositeOperation = 'copy';
      if (supportsCanvasFilter) personCtx.filter = 'blur(2px)';
      personCtx.drawImage(mask, 0, 0, w, h);
      personCtx.filter = 'none';
      personCtx.globalCompositeOperation = 'source-in';
      personCtx.drawImage(camVideo, 0, 0, w, h);
      personCtx.globalCompositeOperation = 'source-over';

      // Background, then the person on top.
      if (state.background.id === 'blur') {
        const radius = w / 60;
        const filter = supportsCanvasFilter ? `blur(${(radius / BLUR_DOWNSCALE).toFixed(1)}px)` : 'none';
        layerCtx.drawImage(blurBackground(camVideo, 0, 0, w, h, w, h, filter, radius), 0, 0, w, h);
      } else {
        // The whole layer is mirrored later, so pre-flip the image to keep it the right way round.
        drawCover(layerCtx, state.background.image, w, h, state.mirror);
      }
      layerCtx.drawImage(person, 0, 0);
    }

    return {
      layer,
      load,
      isActive: () => state.background.id !== 'none' && Boolean(segmenter),
      hasLayer() {
        return this.isActive() && hasMask;
      },
      update() {
        if (!this.isActive()) return;
        try {
          segment();
          if (hasMask) compose();
          failures = 0;
        } catch (err) {
          console.error(err);
          if (++failures > 10) {
            failures = 0;
            selectBackground('none');
            toast('Background replacement stopped working and was turned off.', true);
          }
        }
      },
    };
  })();

  function updateCameraLayer() {
    segmentation.update();
  }

  /* ------------------------------------------------------------------------
   * Render clock. A worker timer keeps ticking when the tab is in the
   * background (e.g. while you record another window); requestAnimationFrame
   * would pause and freeze the recording.
   *
   * The worker waits for each frame to finish ('done') before sending the next
   * tick, so a slow machine drops frames instead of queueing up ticks forever.
   * --------------------------------------------------------------------- */

  const CLOCK_WORKER = `
    let busy = false;
    let due = false;
    const tick = () => { due = false; busy = true; postMessage(0); };
    onmessage = (e) => {
      if (e.data === 'done') {
        busy = false;
        if (due) tick();
      } else {
        setInterval(() => { due = true; if (!busy) tick(); }, e.data);
      }
    };
  `;

  function startRenderClock() {
    try {
      const worker = new Worker(URL.createObjectURL(new Blob([CLOCK_WORKER], { type: 'text/javascript' })));
      worker.onmessage = () => {
        try {
          render();
        } finally {
          worker.postMessage('done');
        }
      };
      worker.postMessage(1000 / FPS);
    } catch (err) {
      console.warn('Worker timer unavailable, using setInterval.', err);
      setInterval(render, 1000 / FPS);
    }
  }

  /* ------------------------------------------------------------------------
   * Sources
   * --------------------------------------------------------------------- */

  async function ensureCamera() {
    if (state.cam) return true;
    const deviceId = els.cameraSelect.value;
    setBusy('Starting camera…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: FPS },
        },
        audio: false,
      });
      state.cam = stream;
      state.camError = null;
      camVideo.srcObject = stream;
      await camVideo.play().catch(() => {});
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        if (state.cam !== stream) return;
        stopCamera();
        toast('The camera was disconnected.', true);
      });
      refreshDevices();
      return true;
    } catch (err) {
      state.camError = err;
      toast(describeMediaError(err, 'camera'), true);
      return false;
    } finally {
      setBusy('');
    }
  }

  function stopCamera() {
    if (state.cam) state.cam.getTracks().forEach((track) => track.stop());
    state.cam = null;
    camVideo.srcObject = null;
    updateOverlay();
  }

  async function ensureScreen() {
    if (state.screen) return true;
    setBusy('Choose the screen you want to record…');
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor', frameRate: { ideal: FPS } },
        audio: els.systemAudio.checked,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: 'include',
      });
      state.screen = stream;
      screenVideo.srcObject = stream;
      await screenVideo.play().catch(() => {});
      stream.getVideoTracks()[0].addEventListener('ended', () => onScreenEnded(stream));
      syncAudio();
      return true;
    } catch (err) {
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
        toast(describeMediaError(err, 'screen'), true);
      }
      return false;
    } finally {
      setBusy('');
    }
  }

  function stopScreen() {
    if (state.screen) state.screen.getTracks().forEach((track) => track.stop());
    state.screen = null;
    screenVideo.srcObject = null;
    syncAudio();
  }

  // Fired when sharing is stopped from the browser's own "Stop sharing" bar.
  function onScreenEnded(stream) {
    if (state.screen !== stream) return;
    stopScreen();
    if (state.mode === 'both' && state.cam) {
      setMode('webcam');
      toast('Screen sharing ended — switched to webcam only.');
    } else if (state.mode === 'screen' && state.recording) {
      toast('Screen sharing ended — the recording was stopped.');
      stopRecording();
    }
    updateOverlay();
  }

  async function changeScreen() {
    const previous = state.screen;
    const wasRecording = pauseForSetup();
    state.screen = null;
    const ok = await ensureScreen();
    if (ok) {
      if (previous) previous.getTracks().forEach((track) => track.stop());
    } else {
      state.screen = previous;
      screenVideo.srcObject = previous;
    }
    resumeAfterSetup(wasRecording);
    updateUI();
  }

  async function ensureMic() {
    if (state.mic) return true;
    const deviceId = els.micSelect.value;
    try {
      state.mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      refreshDevices();
      return true;
    } catch (err) {
      toast(describeMediaError(err, 'microphone') + ' Recording without microphone.', true);
      return false;
    }
  }

  function stopMic() {
    if (state.mic) state.mic.getTracks().forEach((track) => track.stop());
    state.mic = null;
    syncAudio();
  }

  // Requests whatever the current mode needs. Screen first: getDisplayMedia
  // must run while the click that triggered it still counts as a user gesture.
  async function ensureSourcesForMode() {
    const wantScreen = needsScreen() && !state.screen;
    const wantCamera = needsCamera() && !state.cam;
    if (!wantScreen && !wantCamera) return true;

    const wasRecording = pauseForSetup();
    let ok = true;
    if (wantScreen) ok = (await ensureScreen()) && ok;
    if (wantCamera) ok = (await ensureCamera()) && ok;
    resumeAfterSetup(wasRecording);
    updateUI();
    return ok;
  }

  // Free the camera when it isn't shown, so its light turns off.
  function releaseUnusedSources() {
    if (!state.recording && !needsCamera()) stopCamera();
  }

  function describeMediaError(err, device) {
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return `Permission to use the ${device} was denied.`;
      case 'NotFoundError':
      case 'OverconstrainedError':
        return `No ${device} was found.`;
      case 'NotReadableError':
        return `The ${device} is being used by another application.`;
      default:
        return `Could not start the ${device}${err && err.message ? `: ${err.message}` : '.'}`;
    }
  }

  async function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const fill = (select, kind, activeStream, fallbackLabel) => {
      const list = devices.filter((device) => device.kind === kind && device.deviceId);
      const track = activeStream && activeStream.getTracks()[0];
      const activeId = track && track.getSettings ? track.getSettings().deviceId : '';
      const selected = activeId || select.value;
      select.replaceChildren(new Option('Default', ''));
      list.forEach((device, i) => {
        select.add(new Option(device.label || `${fallbackLabel} ${i + 1}`, device.deviceId));
      });
      select.value = list.some((device) => device.deviceId === selected) ? selected : '';
    };
    fill(els.cameraSelect, 'videoinput', state.cam, 'Camera');
    fill(els.micSelect, 'audioinput', state.mic, 'Microphone');
  }

  /* ------------------------------------------------------------------------
   * Audio mixing (microphone + screen/tab audio into one track)
   * --------------------------------------------------------------------- */

  const audio = { ctx: null, dest: null, nodes: {} };

  function setupAudio() {
    if (!audio.ctx) {
      audio.ctx = new AudioContext();
      audio.dest = audio.ctx.createMediaStreamDestination();
    }
    if (audio.ctx.state === 'suspended') audio.ctx.resume();
  }

  function syncAudio() {
    if (!audio.ctx) return;
    const recording = Boolean(state.recording);
    const mic = recording && els.micEnabled.checked ? state.mic : null;
    const screenHasAudio = state.screen && state.screen.getAudioTracks().length > 0;
    const screen = recording && els.systemAudio.checked && needsScreen() && screenHasAudio ? state.screen : null;
    connectAudio('mic', mic);
    connectAudio('screen', screen);
  }

  function connectAudio(key, stream) {
    const current = audio.nodes[key];
    if (current && current.stream === stream) return;
    if (current) {
      current.node.disconnect();
      delete audio.nodes[key];
    }
    if (stream) {
      const node = audio.ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      node.connect(audio.dest);
      audio.nodes[key] = { stream, node };
    }
  }

  /* ------------------------------------------------------------------------
   * Recording
   * --------------------------------------------------------------------- */

  function selectedFormat() {
    return state.formats[Number(els.format.value)] || state.formats[0];
  }

  async function startRecording() {
    if (state.recording || state.stopping) return;
    if (!state.formats.length) {
      toast('This browser cannot record video. Please use a recent Chrome, Edge or Firefox.', true);
      return;
    }

    els.btnStart.disabled = true;
    const ready = await ensureSourcesForMode();
    if (!ready) {
      updateUI();
      toast(needsScreen() ? 'Share a screen to start recording.' : 'The camera is needed to start recording.', true);
      return;
    }

    setupAudio();
    if (els.micEnabled.checked) await ensureMic();

    const format = selectedFormat();
    const pixels = els.canvas.width * els.canvas.height;
    const canvasStream = els.canvas.captureStream(FPS);
    const stream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...audio.dest.stream.getAudioTracks(),
    ]);

    let recorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: format.mime,
        videoBitsPerSecond: pixels >= 1920 * 1080 ? 8_000_000 : 5_000_000,
        audioBitsPerSecond: 128_000,
      });
    } catch (err) {
      canvasStream.getTracks().forEach((track) => track.stop());
      toast(`Could not start recording: ${err.message}`, true);
      updateUI();
      return;
    }

    const rec = { recorder, format, canvasStream, chunks: [], startedAt: performance.now(), pausedMs: 0, pausedAt: 0 };
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size) rec.chunks.push(event.data);
    });
    recorder.addEventListener('error', (event) => {
      console.error(event.error || event);
      toast('Recording error — saving what was recorded so far.', true);
      stopRecording();
    });
    recorder.start(1000);
    state.recording = rec;
    syncAudio();
    updateUI();
  }

  function togglePause() {
    const rec = state.recording;
    if (!rec) return;
    if (rec.recorder.state === 'recording') {
      rec.recorder.pause();
      rec.pausedAt = performance.now();
    } else if (rec.recorder.state === 'paused') {
      rec.recorder.resume();
      rec.pausedMs += performance.now() - rec.pausedAt;
      rec.pausedAt = 0;
    }
    updateUI();
  }

  // Pauses an active recording while a source picker or permission prompt is open.
  function pauseForSetup() {
    const rec = state.recording;
    if (rec && rec.recorder.state === 'recording') {
      togglePause();
      return true;
    }
    return false;
  }

  function resumeAfterSetup(wasRecording) {
    const rec = state.recording;
    if (wasRecording && rec && rec.recorder.state === 'paused') togglePause();
  }

  function elapsedMs(rec) {
    const now = performance.now();
    const paused = rec.pausedMs + (rec.pausedAt ? now - rec.pausedAt : 0);
    return now - rec.startedAt - paused;
  }

  async function stopRecording() {
    const rec = state.recording;
    if (!rec || state.stopping) return;
    state.stopping = true;
    state.recording = null;

    const duration = elapsedMs(rec);
    const stopped = new Promise((resolve) => rec.recorder.addEventListener('stop', resolve, { once: true }));
    if (rec.recorder.state !== 'inactive') rec.recorder.stop();

    // Open the "Save as" window right away, while the Stop click still counts
    // as a user gesture (the browser refuses to open it later without one).
    const name = suggestedFileName(rec.format);
    const picked = requestSaveHandle(rec.format, name);

    updateUI();
    const [, choice] = await Promise.all([stopped, picked]);
    rec.canvasStream.getTracks().forEach((track) => track.stop());
    stopMic();
    releaseUnusedSources();

    const blob = new Blob(rec.chunks, { type: rec.format.type });
    state.result = { blob, name, format: rec.format, duration, url: URL.createObjectURL(blob) };
    state.stopping = false;
    updateUI();

    if (choice.handle) {
      try {
        await writeToHandle(choice.handle, blob);
        finishSaved(choice.handle.name);
      } catch (err) {
        showResult(`Could not save the file: ${err.message}`, 'error');
      }
    } else if (choice.unsupported) {
      downloadResult();
      showResult('The download has started. Your browser saves it to your Downloads folder, or asks where to save it, depending on its settings.', 'success');
      els.btnSaveAs.textContent = 'Download again';
    } else if (choice.error && choice.error.name === 'AbortError') {
      showResult('You haven’t saved this recording yet.');
    } else {
      showResult('Choose where to save your recording.');
    }
  }

  function suggestedFileName(format) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    return `recording-${stamp}.${format.ext}`;
  }

  // Must be called synchronously from a click handler.
  function requestSaveHandle(format, name) {
    if (typeof window.showSaveFilePicker !== 'function') return Promise.resolve({ unsupported: true });
    try {
      return window.showSaveFilePicker({
        suggestedName: name,
        startIn: 'videos',
        types: [{ description: `${format.ext.toUpperCase()} video`, accept: { [format.type]: [`.${format.ext}`] } }],
      }).then((handle) => ({ handle }), (error) => ({ error }));
    } catch (error) {
      return Promise.resolve({ error });
    }
  }

  async function writeToHandle(handle, blob) {
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (err) {
      await writable.abort().catch(() => {});
      throw err;
    }
  }

  function downloadResult() {
    const { url, name } = state.result;
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
  }

  async function saveResultAs() {
    const result = state.result;
    if (!result) return;
    const choice = requestSaveHandle(result.format, result.name);
    const { handle, error, unsupported } = await choice;
    if (unsupported) {
      downloadResult();
      setResultMessage('The download has started.', 'success');
      return;
    }
    if (error) {
      if (error.name !== 'AbortError') setResultMessage(`Could not open the save window: ${error.message}`, 'error');
      return;
    }
    try {
      setResultMessage('Saving…');
      await writeToHandle(handle, result.blob);
      finishSaved(handle.name);
    } catch (err) {
      setResultMessage(`Could not save the file: ${err.message}`, 'error');
    }
  }

  function finishSaved(fileName) {
    clearResult();
    toast(`Saved “${fileName}”.`);
  }

  function discardResult() {
    if (!state.result) return;
    if (!window.confirm('Discard this recording? It hasn’t been saved.')) return;
    clearResult();
  }

  function clearResult() {
    if (els.dialog.open) els.dialog.close();
    els.resultVideo.removeAttribute('src');
    els.resultVideo.load();
    if (state.result) URL.revokeObjectURL(state.result.url);
    state.result = null;
  }

  function showResult(message, kind) {
    const { blob, duration, format, url } = state.result;
    els.resultVideo.src = url;
    els.resultInfo.textContent = `${formatTime(duration)} · ${(blob.size / (1024 * 1024)).toFixed(1)} MB · ${format.label}`;
    els.btnSaveAs.textContent = typeof window.showSaveFilePicker === 'function' ? 'Save as…' : 'Download';
    setResultMessage(message, kind);
    if (!els.dialog.open) els.dialog.showModal();
  }

  function setResultMessage(message, kind) {
    els.resultMsg.textContent = message || '';
    els.resultMsg.className = `result-msg${kind ? ` ${kind}` : ''}`;
  }

  /* ------------------------------------------------------------------------
   * UI
   * --------------------------------------------------------------------- */

  async function setMode(mode) {
    state.mode = mode;
    updateUI();
    await ensureSourcesForMode();
    releaseUnusedSources();
    syncAudio();
    updateUI();
  }

  function setBusy(message) {
    state.busy = message;
    updateOverlay();
  }

  function updateOverlay() {
    let message = '';
    let action = '';

    if (state.busy) {
      message = state.busy;
    } else if (needsScreen() && !state.screen && needsCamera() && !state.cam) {
      message = 'Share your screen and turn on your camera to get started.';
      action = 'Share screen & camera';
    } else if (needsScreen() && !state.screen) {
      message = 'Choose the screen you want to record.';
      action = 'Share screen';
    } else if (needsCamera() && !state.cam) {
      message = state.camError ? describeMediaError(state.camError, 'camera') : 'Allow camera access to see your webcam.';
      action = 'Turn on camera';
    }

    els.overlay.hidden = !message;
    els.overlayMessage.textContent = message;
    els.overlaySpinner.hidden = !state.busy;
    els.overlayAction.hidden = !action;
    els.overlayAction.textContent = action;
  }

  function updateUI() {
    const rec = state.recording;
    const recState = rec ? rec.recorder.state : 'inactive';

    els.modeButtons.forEach((button) => {
      button.setAttribute('aria-checked', String(button.dataset.mode === state.mode));
    });
    els.pipPanel.hidden = state.mode !== 'both';
    els.btnChangeScreen.hidden = !needsScreen() || !state.screen;
    els.effectsPanel.setAttribute('aria-disabled', String(!needsCamera()));
    els.bgPanel.setAttribute('aria-disabled', String(!needsCamera()));

    els.btnStart.disabled = Boolean(rec) || state.stopping;
    els.btnPause.disabled = !rec;
    els.btnPause.textContent = recState === 'paused' ? 'Resume' : 'Pause';
    els.btnStop.disabled = !rec;
    els.resolution.disabled = Boolean(rec);
    els.format.disabled = Boolean(rec);

    let status = 'idle';
    let text = 'Ready';
    if (state.stopping) {
      text = 'Finishing…';
    } else if (recState === 'recording') {
      status = 'recording';
      text = 'Recording';
    } else if (recState === 'paused') {
      status = 'paused';
      text = 'Paused';
    }
    els.recStatus.dataset.state = status;
    els.recStatusText.textContent = text;
    updateTimer();
    updateOverlay();
  }

  function updateTimer() {
    if (state.recording) els.recTimer.textContent = formatTime(elapsedMs(state.recording));
  }

  function formatTime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return h ? `${h}:${mmss}` : mmss;
  }

  let toastTimer = 0;
  function toast(message, isError = false) {
    els.toast.textContent = message;
    els.toast.classList.toggle('error', isError);
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 5000);
  }

  /* Backgrounds */

  const backgroundImages = new Map();

  async function loadBackgroundList() {
    try {
      const response = await fetch(`${BACKGROUNDS_DIR}backgrounds.json`, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const list = await response.json();
      list.forEach((item) => {
        const src = BACKGROUNDS_DIR + item.file;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'bg-item';
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', 'false');
        button.dataset.bg = src;
        button.title = item.name;
        button.style.backgroundImage = `url("${encodeURI(src)}")`;
        const label = document.createElement('span');
        label.className = 'bg-label';
        label.textContent = item.name;
        button.append(label);
        els.bgGrid.append(button);
      });
    } catch (err) {
      console.error(err);
      els.bgNote.textContent = 'Could not load the background images list.';
    }
  }

  function loadImage(src) {
    if (!backgroundImages.has(src)) {
      const promise = new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`Could not load ${src}`));
        image.src = src;
      });
      promise.catch(() => backgroundImages.delete(src));
      backgroundImages.set(src, promise);
    }
    return backgroundImages.get(src);
  }

  let backgroundRequest = 0;
  async function selectBackground(id) {
    const request = ++backgroundRequest;
    const markSelected = (selectedId) => {
      els.bgGrid.querySelectorAll('[data-bg]').forEach((button) => {
        button.setAttribute('aria-checked', String(button.dataset.bg === selectedId));
      });
    };
    markSelected(id);

    if (id === 'none') {
      state.background = { id: 'none', image: null };
      els.bgNote.textContent = '';
      return;
    }

    els.bgNote.textContent = 'Loading background…';
    try {
      const [image] = await Promise.all([id === 'blur' ? null : loadImage(id), segmentation.load()]);
      if (request !== backgroundRequest) return;
      state.background = { id, image };
      els.bgNote.textContent = '';
    } catch (err) {
      console.error(err);
      if (request !== backgroundRequest) return;
      state.background = { id: 'none', image: null };
      markSelected('none');
      els.bgNote.textContent = `Background replacement is unavailable: ${err.message}`;
    }
  }

  /* Event wiring */

  function bindEvents() {
    els.modeButtons.forEach((button) => {
      button.addEventListener('click', () => setMode(button.dataset.mode));
    });
    els.overlayAction.addEventListener('click', () => ensureSourcesForMode());
    els.btnChangeScreen.addEventListener('click', changeScreen);

    els.cameraSelect.addEventListener('change', async () => {
      if (!state.cam) return;
      const wasRecording = pauseForSetup();
      stopCamera();
      await ensureCamera();
      resumeAfterSetup(wasRecording);
    });

    els.cornerButtons.forEach((button) => {
      button.addEventListener('click', () => {
        state.pip.corner = button.dataset.corner;
        els.cornerButtons.forEach((b) => b.setAttribute('aria-checked', String(b === button)));
      });
    });
    els.pipSize.addEventListener('input', () => {
      state.pip.size = Number(els.pipSize.value) / 100;
    });
    els.pipShape.addEventListener('change', () => {
      state.pip.shape = els.pipShape.value;
    });

    els.effectButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const effect = button.dataset.effect;
        const on = !state.effects.has(effect);
        if (on) state.effects.add(effect);
        else state.effects.delete(effect);
        button.setAttribute('aria-pressed', String(on));
        els.blurRow.hidden = !state.effects.has('blur');
      });
    });
    els.blurAmount.addEventListener('input', () => {
      state.blurAmount = Number(els.blurAmount.value);
    });
    els.mirror.addEventListener('change', () => {
      state.mirror = els.mirror.checked;
    });

    els.bgGrid.addEventListener('click', (event) => {
      const button = event.target.closest('[data-bg]');
      if (button) selectBackground(button.dataset.bg);
    });

    els.micEnabled.addEventListener('change', async () => {
      if (state.recording && els.micEnabled.checked) await ensureMic();
      syncAudio();
    });
    els.micSelect.addEventListener('change', async () => {
      if (!state.mic) return;
      stopMic();
      if (state.recording && els.micEnabled.checked) await ensureMic();
      syncAudio();
    });
    els.systemAudio.addEventListener('change', syncAudio);

    els.resolution.addEventListener('change', () => {
      const [w, h] = els.resolution.value.split('x').map(Number);
      els.canvas.width = w;
      els.canvas.height = h;
    });

    els.btnStart.addEventListener('click', startRecording);
    els.btnPause.addEventListener('click', togglePause);
    els.btnStop.addEventListener('click', stopRecording);

    els.btnSaveAs.addEventListener('click', saveResultAs);
    els.btnDiscard.addEventListener('click', discardResult);
    // Don't let Escape throw away an unsaved recording.
    els.dialog.addEventListener('cancel', (event) => event.preventDefault());

    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
    }

    window.addEventListener('beforeunload', (event) => {
      if (state.recording || state.result) {
        event.preventDefault();
        event.returnValue = '';
      }
    });

    setInterval(updateTimer, 250);
  }

  function initFormats() {
    if (typeof MediaRecorder === 'undefined') return;
    state.formats = FORMAT_GROUPS
      .map((group) => ({ ...group, mime: group.candidates.find((mime) => MediaRecorder.isTypeSupported(mime)) }))
      .filter((format) => format.mime);
    state.formats.forEach((format, i) => els.format.add(new Option(format.label, String(i))));
  }

  function init() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !els.canvas.captureStream) {
      els.overlay.hidden = false;
      els.overlayMessage.textContent = window.isSecureContext
        ? 'This browser does not support recording. Please use a recent Chrome, Edge or Firefox.'
        : 'Recording only works over HTTPS or on localhost. Please open this page from a secure address.';
      document.querySelectorAll('button, select, input').forEach((el) => {
        el.disabled = true;
      });
      return;
    }
    if (!navigator.mediaDevices.getDisplayMedia) {
      els.modeButtons.filter((b) => b.dataset.mode !== 'webcam').forEach((b) => {
        b.disabled = true;
        b.title = 'Screen recording is not supported in this browser.';
      });
    }
    if (!supportsCanvasFilter) {
      els.bgNote.textContent = 'Blur and colour effects are not supported in this browser.';
    }

    initFormats();
    bindEvents();
    loadBackgroundList();
    refreshDevices();
    startRenderClock();
    updateUI();
    ensureCamera().then(updateUI);
  }

  init();
})();
