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
  const FACE_MODEL = 'models/face_landmarker.task';
  const BACKGROUNDS_DIR = 'img/backgrounds/';

  // Landmark indices from MediaPipe's standard 478-point face mesh, used to
  // anchor AR stickers and the beauty skin mask. These are the same indices
  // published in MediaPipe's own face mesh keypoint reference.
  const LM = { eyeOuterL: 33, eyeOuterR: 263, noseTip: 4, foreheadTop: 10, mouthL: 61, mouthR: 291, mouthTop: 13 };
  const FACE_OVAL = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
    400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
  ];

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
    lightingPanel: $('#lightingPanel'),
    lightAuto: $('#lightAuto'),
    lightBrightness: $('#lightBrightness'),
    arPanel: $('#arPanel'),
    arButtons: $$('#arGroup [data-ar]'),
    arNote: $('#arNote'),
    beautyPanel: $('#beautyPanel'),
    beautySmooth: $('#beautySmooth'),
    beautyGlow: $('#beautyGlow'),
    beautyNote: $('#beautyNote'),
    micEnabled: $('#micEnabled'),
    micSelect: $('#micSelect'),
    systemAudio: $('#systemAudio'),
    resolution: $('#resolution'),
    format: $('#format'),
    tabButtons: $$('#settingsTabs [role="tab"]'),
    tabPanels: $$('.tab-panel'),
    channelMic: $('#channelMic'),
    channelSystem: $('#channelSystem'),
    scEnabled: $('#scEnabled'),
    scTrigger: $('#scTrigger'),
    scMode: $('#scMode'),
    scThreshold: $('#scThreshold'),
    scThresholdVal: $('#scThresholdVal'),
    scRatioRow: $('#scRatioRow'),
    scRatio: $('#scRatio'),
    scRatioVal: $('#scRatioVal'),
    scDepthRow: $('#scDepthRow'),
    scDepth: $('#scDepth'),
    scDepthVal: $('#scDepthVal'),
    scAttack: $('#scAttack'),
    scAttackVal: $('#scAttackVal'),
    scRelease: $('#scRelease'),
    scReleaseVal: $('#scReleaseVal'),
    scMakeup: $('#scMakeup'),
    scMakeupVal: $('#scMakeupVal'),
    masterGain: $('#masterGain'),
    masterGainVal: $('#masterGainVal'),
    masterMeterFill: $('#masterMeterFill'),
    masterLimiter: $('#masterLimiter'),
    reverbReturn: $('#reverbReturn'),
    reverbReturnVal: $('#reverbReturnVal'),
    reverbSize: $('#reverbSize'),
    reverbSizeVal: $('#reverbSizeVal'),
    monitorEnabled: $('#monitorEnabled'),
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
    lightAuto: els.lightAuto.checked,
    lightBrightness: Number(els.lightBrightness.value),
    lightAutoValue: 1,
    ar: 'none',
    beautySmooth: Number(els.beautySmooth.value),
    beautyGlow: Number(els.beautyGlow.value),
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
    const brightness = state.lightAuto ? state.lightAutoValue : 1 + state.lightBrightness / 100;
    if (Math.abs(brightness - 1) > 0.01) parts.push(`brightness(${brightness.toFixed(2)})`);
    return parts.length ? parts.join(' ') : 'none';
  }

  // Cheap auto light correction: sample the average luminance of a tiny copy
  // of the frame and nudge a brightness multiplier towards a mid-grey target,
  // smoothed so it doesn't flicker frame to frame.
  const autoLightProbe = document.createElement('canvas');
  autoLightProbe.width = 8;
  autoLightProbe.height = 8;
  const autoLightCtx = autoLightProbe.getContext('2d', { willReadFrequently: true });

  function updateAutoLight() {
    if (!state.lightAuto) return;
    autoLightCtx.drawImage(camVideo, 0, 0, 8, 8);
    const { data } = autoLightCtx.getImageData(0, 0, 8, 8);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    const mean = Math.max(sum / (data.length / 4) / 255, 0.05);
    const desired = Math.min(1.6, Math.max(0.85, 0.46 / mean));
    state.lightAutoValue += (desired - state.lightAutoValue) * 0.15;
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
    let source = segmentation.hasLayer() ? segmentation.layer : faceFX.getFrame();
    const sw = camVideo.videoWidth;
    const sh = camVideo.videoHeight;
    const scale = Math.max(w / sw, h / sh);
    let cw = w / scale;
    let ch = h / scale;
    let cx = (sw - cw) / 2;
    let cy = (sh - ch) / 2;
    // Face landmarks are in raw video pixel space; keep the pre-blur crop
    // around so AR stickers can still be mapped into destination space even
    // when `source`/cx/cy/cw/ch below get swapped for the small blur canvas.
    const cropCx = cx;
    const cropCy = cy;
    const cropCw = cw;
    const cropCh = ch;
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
    let destX = x;
    let destY = y;
    if (state.mirror) {
      ctx.translate(x + w, y);
      ctx.scale(-1, 1);
      ctx.drawImage(source, cx, cy, cw, ch, 0, 0, w, h);
      destX = 0;
      destY = 0;
    } else {
      ctx.drawImage(source, cx, cy, cw, ch, x, y, w, h);
    }
    // Stickers draw crisp and in colour regardless of webcam filters/effects,
    // same as real AR filters — the filter only applies to the camera image.
    ctx.filter = 'none';
    if (state.ar !== 'none') drawArOverlay(destX, destY, w, h, cropCx, cropCy, cropCw, cropCh);
    ctx.restore();
  }

  // Maps AR stickers onto the already-transformed (mirrored/cropped) canvas
  // space drawCamera() just drew the webcam image into, using face landmarks
  // detected in raw video pixel space.
  function drawArOverlay(destX, destY, w, h, cropCx, cropCy, cropCw, cropCh) {
    const landmarks = faceFX.getLandmarks();
    if (!landmarks) return;
    const sw = camVideo.videoWidth;
    const sh = camVideo.videoHeight;
    const toLocal = (idx) => {
      const p = landmarks[idx];
      return {
        x: destX + ((p.x * sw - cropCx) / cropCw) * w,
        y: destY + ((p.y * sh - cropCy) / cropCh) * h,
      };
    };

    const eyeL = toLocal(LM.eyeOuterL);
    const eyeR = toLocal(LM.eyeOuterR);
    const eyeDist = Math.hypot(eyeR.x - eyeL.x, eyeR.y - eyeL.y);
    if (!eyeDist) return;
    const angle = Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x);
    const center = { x: (eyeL.x + eyeR.x) / 2, y: (eyeL.y + eyeR.y) / 2 };
    const mouthL = toLocal(LM.mouthL);
    const mouthR = toLocal(LM.mouthR);

    const anchors = {
      center,
      eyeDist,
      angle,
      nose: toLocal(LM.noseTip),
      forehead: toLocal(LM.foreheadTop),
      mouth: { x: (mouthL.x + mouthR.x) / 2, y: (mouthL.y + mouthR.y) / 2 },
      mouthTop: toLocal(LM.mouthTop),
    };

    const draw = AR_STICKERS[state.ar];
    if (draw) draw(anchors);
  }

  function drawSunglasses({ center, eyeDist, angle }) {
    const s = eyeDist;
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate(angle);
    const lensW = s * 0.62;
    const lensH = s * 0.46;
    const gap = s * 0.18;
    ctx.fillStyle = 'rgba(15, 15, 20, 0.92)';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = s * 0.04;
    [-1, 1].forEach((side) => {
      const lx = side * (gap / 2 + lensW / 2);
      roundedRectPath(lx - lensW / 2, -lensH / 2, lensW, lensH, lensH * 0.4);
      ctx.fill();
      ctx.stroke();
    });
    ctx.beginPath();
    ctx.moveTo(-gap / 2, 0);
    ctx.lineTo(gap / 2, 0);
    ctx.lineWidth = s * 0.05;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-(gap / 2 + lensW), 0);
    ctx.lineTo(-(gap / 2 + lensW + s * 0.3), -s * 0.05);
    ctx.moveTo(gap / 2 + lensW, 0);
    ctx.lineTo(gap / 2 + lensW + s * 0.3, -s * 0.05);
    ctx.stroke();
    ctx.restore();
  }

  function drawDogFilter({ eyeDist, angle, nose, forehead }) {
    const s = eyeDist;
    ctx.save();
    ctx.translate(forehead.x, forehead.y);
    ctx.rotate(angle);
    ctx.fillStyle = '#6b4a35';
    [-1, 1].forEach((side) => {
      ctx.save();
      ctx.translate(side * s * 0.9, -s * 0.15);
      ctx.rotate(side * 0.35);
      ctx.beginPath();
      ctx.ellipse(0, 0, s * 0.38, s * 0.62, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
    ctx.restore();

    ctx.save();
    ctx.translate(nose.x, nose.y);
    ctx.rotate(angle);
    ctx.fillStyle = '#231815';
    ctx.beginPath();
    ctx.ellipse(0, s * 0.08, s * 0.22, s * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.beginPath();
    ctx.ellipse(-s * 0.06, s * 0.02, s * 0.05, s * 0.03, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawMustache({ eyeDist, angle, mouthTop }) {
    const s = eyeDist;
    ctx.save();
    ctx.translate(mouthTop.x, mouthTop.y - s * 0.08);
    ctx.rotate(angle);
    ctx.fillStyle = '#2b1a12';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(s * 0.12, -s * 0.12, s * 0.3, -s * 0.05, s * 0.5, s * 0.06);
    ctx.bezierCurveTo(s * 0.34, s * 0.1, s * 0.16, s * 0.08, 0, s * 0.02);
    ctx.bezierCurveTo(-s * 0.16, s * 0.08, -s * 0.34, s * 0.1, -s * 0.5, s * 0.06);
    ctx.bezierCurveTo(-s * 0.3, -s * 0.05, -s * 0.12, -s * 0.12, 0, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawClownNose({ eyeDist, angle, nose }) {
    const s = eyeDist;
    ctx.save();
    ctx.translate(nose.x, nose.y);
    ctx.rotate(angle);
    const r = s * 0.22;
    const gradient = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
    gradient.addColorStop(0, '#ff8a8a');
    gradient.addColorStop(1, '#d81e1e');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawTopHat({ eyeDist, angle, forehead }) {
    const s = eyeDist;
    ctx.save();
    ctx.translate(forehead.x, forehead.y - s * 0.3);
    ctx.rotate(angle);
    ctx.fillStyle = '#17171a';
    ctx.beginPath();
    ctx.ellipse(0, s * 0.42, s * 0.75, s * 0.14, 0, 0, Math.PI * 2);
    ctx.fill();
    roundedRectPath(-s * 0.46, -s * 0.5, s * 0.92, s * 0.9, s * 0.08);
    ctx.fill();
    ctx.fillStyle = '#7a1f2b';
    ctx.fillRect(-s * 0.46, s * 0.18, s * 0.92, s * 0.12);
    ctx.restore();
  }

  const AR_STICKERS = {
    sunglasses: drawSunglasses,
    dog: drawDogFilter,
    mustache: drawMustache,
    clownNose: drawClownNose,
    tophat: drawTopHat,
  };

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

      // Cut the person out of the (beauty-processed) camera frame using the mask.
      const camFrame = faceFX.getFrame();
      personCtx.globalCompositeOperation = 'copy';
      if (supportsCanvasFilter) personCtx.filter = 'blur(2px)';
      personCtx.drawImage(mask, 0, 0, w, h);
      personCtx.filter = 'none';
      personCtx.globalCompositeOperation = 'source-in';
      personCtx.drawImage(camFrame, 0, 0, w, h);
      personCtx.globalCompositeOperation = 'source-over';

      // Background, then the person on top.
      if (state.background.id === 'blur') {
        const radius = w / 60;
        const filter = supportsCanvasFilter ? `blur(${(radius / BLUR_DOWNSCALE).toFixed(1)}px)` : 'none';
        layerCtx.drawImage(blurBackground(camFrame, 0, 0, w, h, w, h, filter, radius), 0, 0, w, h);
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

  /* ------------------------------------------------------------------------
   * Face effects: AR stickers (via face landmarks) and beauty touch-up
   * (skin smoothing + soft glow), using MediaPipe Face Landmarker.
   *
   * `getFrame()` is the single point the rest of the app reads the "camera
   * image to show" from — drawCamera() and segmentation.compose() both use
   * it instead of camVideo directly, so beauty touch-up applies no matter
   * which source (plain webcam, or segmented-onto-a-background) is active.
   * --------------------------------------------------------------------- */

  const faceFX = (() => {
    const frame = document.createElement('canvas');
    const frameCtx = frame.getContext('2d');
    const faceMask = document.createElement('canvas');
    const faceMaskCtx = faceMask.getContext('2d');
    const skin = document.createElement('canvas');
    const skinCtx = skin.getContext('2d');
    const blurSkin = createSmallBlur();
    const blurGlow = createSmallBlur();
    let landmarker = null;
    let loading = null;
    let landmarks = null;
    let lastTimestamp = 0;
    let failures = 0;

    function load() {
      if (landmarker) return Promise.resolve(landmarker);
      if (!loading) {
        loading = (async () => {
          const url = (path) => new URL(path, document.baseURI).href;
          const vision = await import(/* webpackIgnore: true */ url(MEDIAPIPE_BUNDLE));
          const fileset = await vision.FilesetResolver.forVisionTasks(url(MEDIAPIPE_WASM));
          const create = (delegate) => vision.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: url(FACE_MODEL), delegate },
            runningMode: 'VIDEO',
            numFaces: 1,
          });
          try {
            landmarker = await create('GPU');
          } catch (err) {
            console.warn('GPU face tracking unavailable, falling back to CPU.', err);
            landmarker = await create('CPU');
          }
          return landmarker;
        })();
        loading.catch(() => {
          loading = null;
        });
      }
      return loading;
    }

    // Smooth skin and the AR stickers need tracked landmarks; soft glow is a
    // plain full-frame effect and works without ever loading the face model.
    const needsTracking = () => state.ar !== 'none' || state.beautySmooth > 0;
    const isActive = () => needsTracking() || state.beautyGlow > 0;

    function detect() {
      let timestamp = performance.now();
      if (timestamp <= lastTimestamp) timestamp = lastTimestamp + 1;
      lastTimestamp = timestamp;
      const result = landmarker.detectForVideo(camVideo, timestamp);
      landmarks = (result.faceLandmarks && result.faceLandmarks[0]) || null;
    }

    function tracePath(context, indices, w, h) {
      context.beginPath();
      indices.forEach((idx, i) => {
        const p = landmarks[idx];
        const x = p.x * w;
        const y = p.y * h;
        if (i === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.closePath();
    }

    function applySmooth(w, h) {
      const amount = Math.min(1, state.beautySmooth / 100);
      if (amount <= 0 || !landmarks) return;
      if (faceMask.width !== w || faceMask.height !== h) {
        faceMask.width = skin.width = w;
        faceMask.height = skin.height = h;
      }
      faceMaskCtx.clearRect(0, 0, w, h);
      faceMaskCtx.fillStyle = '#fff';
      tracePath(faceMaskCtx, FACE_OVAL, w, h);
      faceMaskCtx.fill();

      const radius = w / 40;
      const filter = supportsCanvasFilter ? `blur(${(radius / BLUR_DOWNSCALE).toFixed(1)}px)` : 'none';
      const blurred = blurSkin(frame, 0, 0, w, h, w, h, filter, radius);

      // Same mask-feathering trick used for the segmentation cutout: copy the
      // mask through a blur so its edge fades, then clip the blurred skin to it.
      skinCtx.globalCompositeOperation = 'copy';
      if (supportsCanvasFilter) skinCtx.filter = 'blur(4px)';
      skinCtx.drawImage(faceMask, 0, 0, w, h);
      skinCtx.filter = 'none';
      skinCtx.globalCompositeOperation = 'source-in';
      skinCtx.drawImage(blurred, 0, 0, blurred.width, blurred.height, 0, 0, w, h);
      skinCtx.globalCompositeOperation = 'source-over';

      frameCtx.globalAlpha = amount;
      frameCtx.drawImage(skin, 0, 0, w, h);
      frameCtx.globalAlpha = 1;
    }

    function applyGlow(w, h) {
      const amount = Math.min(1, state.beautyGlow / 100);
      if (amount <= 0) return;
      const radius = w / 30;
      const filter = supportsCanvasFilter ? `blur(${(radius / BLUR_DOWNSCALE).toFixed(1)}px) brightness(1.3)` : 'none';
      const glow = blurGlow(frame, 0, 0, w, h, w, h, filter, radius);
      frameCtx.save();
      frameCtx.globalCompositeOperation = 'screen';
      frameCtx.globalAlpha = amount * 0.7;
      frameCtx.drawImage(glow, 0, 0, glow.width, glow.height, 0, 0, w, h);
      frameCtx.restore();
    }

    return {
      isTrackingReady: () => Boolean(landmarker),
      needsTracking,
      hasFace: () => Boolean(landmarks),
      load,
      getLandmarks: () => landmarks,
      update() {
        if (!isActive()) {
          landmarks = null;
          return;
        }
        try {
          if (needsTracking() && landmarker) detect();
          else landmarks = null;

          const w = camVideo.videoWidth;
          const h = camVideo.videoHeight;
          if (frame.width !== w || frame.height !== h) {
            frame.width = w;
            frame.height = h;
          }
          frameCtx.filter = 'none';
          frameCtx.globalCompositeOperation = 'source-over';
          frameCtx.drawImage(camVideo, 0, 0, w, h);
          applySmooth(w, h);
          applyGlow(w, h);
          failures = 0;
        } catch (err) {
          console.error(err);
          if (++failures > 10) {
            failures = 0;
            state.ar = 'none';
            state.beautySmooth = 0;
            state.beautyGlow = 0;
            syncFaceFxUI();
            toast('Face effects stopped working and were turned off.', true);
          }
        }
      },
      // The "camera image to show": the beauty-processed frame once any face
      // effect is active, otherwise the raw camera feed.
      getFrame: () => (isActive() && frame.width > 0 ? frame : camVideo),
    };
  })();

  function updateCameraLayer() {
    updateAutoLight();
    faceFX.update();
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
      mixer.syncSources();
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
    mixer.syncSources();
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
    mixer.syncSources();
  }

  // Brings the mixer online and feeds it the current mic/system audio, so
  // the channel strips and meters are already live once you open the Audio
  // tab — not only once a recording starts. Safe to call repeatedly.
  let audioPreviewStarted = false;
  async function activateAudioPreview() {
    mixer.resume();
    if (!audioPreviewStarted) {
      audioPreviewStarted = true;
      await mixer.init();
      if (els.micEnabled.checked) await ensureMic();
    }
    mixer.syncSources();
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
   * Sound mixer: dynamics, noise control, spatial effects, routing, sidechain
   *
   * The graph is built once, with a fixed topology, and never rewired after
   * that — every control (mute, bypass, mix amount...) is a parameter change
   * on an always-connected node rather than a connect()/disconnect() call.
   * That avoids the clicks and race conditions that come from rebuilding a
   * live audio graph, and it means turning an effect off is just steering its
   * parameters back to "no effect" rather than a structural change:
   *
   *   mic ──► trim ─► highpass ─► gate ─► compressor ─► makeup ─┐
   *                                                             │ (sidechain, shared, 2-in/2-out)
   *   system ─► trim ─► highpass ─► gate ─► compressor ─► makeup ┘
   *                             │
   *            ┌────────────────┴──────────────┐
   *       postSidechain(mic)              postSidechain(system)
   *            │  ├─ dry ─────────────┐         │  ├─ dry ─────────────┐
   *            │  └─ delay/echo ──────┤         │  └─ delay/echo ──────┤
   *            └─────────────────► out ◄────────┘                     │
   *                                │  └─ reverbSend ─► reverbBus ─► reverbReturn ─┐
   *                                └──────────────── routeGain ──────────────────┤
   *                                                                              ▼
   *                                                                          masterBus ─► limiter ─┬─► recording destination
   *                                                                                                 └─► monitor gain ─► speakers
   * --------------------------------------------------------------------- */

  const WORKLET_URL = 'js/worklets/audio-fx-processors.js';
  const dbToLin = (db) => Math.pow(10, db / 20);

  // A convolution reverb impulse, generated on the fly (no audio file needed):
  // exponentially-decaying noise. `sizePct` (0-100) controls both the tail
  // length and how fast it decays, from a small room to a long hall.
  function createReverbImpulse(audioCtx, sizePct) {
    const duration = 0.5 + (sizePct / 100) * 3;
    const decay = 3 - (sizePct / 100) * 2;
    const rate = audioCtx.sampleRate;
    const length = Math.max(1, Math.floor(rate * duration));
    const buffer = audioCtx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
    }
    return buffer;
  }

  const CHANNEL_DEFAULTS = {
    trimDb: 0,
    muted: false,
    included: true,
    highpass: false,
    gateEnabled: false,
    gateThreshold: -45,
    gateRelease: 150,
    compEnabled: false,
    compThreshold: -24,
    compRatio: 3,
    compAttack: 10,
    compRelease: 150,
    compMakeup: 0,
    spatialType: 'none',
    spatialTime: 250,
    spatialFeedback: 25,
    spatialMix: 25,
    reverbSend: 0,
  };

  const mixer = (() => {
    let audioCtx = null;
    let readyPromise = null;
    let destination = null;
    let gateAvailable = false;
    let sidechainAvailable = false;
    let sidechainNode = null;
    let master, limiter, monitorGain, reverbBus, reverbReturn, masterMeter;
    const channels = {}; // key -> node refs, built lazily once the context exists
    const channelSettings = { mic: { ...CHANNEL_DEFAULTS }, system: { ...CHANNEL_DEFAULTS } };
    const sidechainSettings = {
      enabled: false, trigger: 'mic', mode: 'comp',
      threshold: -30, ratio: 4, depth: 24, attack: 15, release: 250, makeup: 0,
    };
    const masterSettings = { gainDb: 0, limiter: true, reverbSize: 40, reverbReturn: 60, monitor: false };
    const meterBuf = new Float32Array(512);
    const CHANNEL_INDEX = { mic: 0, system: 1 };

    function readLevel(analyser) {
      if (!analyser) return 0;
      analyser.getFloatTimeDomainData(meterBuf);
      let sum = 0;
      for (let i = 0; i < meterBuf.length; i++) sum += meterBuf[i] * meterBuf[i];
      return Math.min(1, Math.sqrt(sum / meterBuf.length) * 4);
    }

    function makeChannel(key) {
      const trim = audioCtx.createGain();
      const highpass = audioCtx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 20; // ~inaudible cutoff = effectively bypassed

      let gate;
      if (gateAvailable) {
        gate = new AudioWorkletNode(audioCtx, 'noise-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      } else {
        gate = audioCtx.createGain(); // transparent fallback when AudioWorklet isn't available
      }

      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value = 0;
      comp.ratio.value = 1;
      comp.knee.value = 0;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      const makeup = audioCtx.createGain();

      const postSidechain = audioCtx.createGain();
      if (sidechainAvailable) {
        const idx = CHANNEL_INDEX[key];
        makeup.connect(sidechainNode, 0, idx);
        sidechainNode.connect(postSidechain, idx, 0);
      } else {
        makeup.connect(postSidechain);
      }

      const dry = audioCtx.createGain();
      const delay = audioCtx.createDelay(2.5);
      const feedback = audioCtx.createGain();
      feedback.gain.value = 0;
      const delayTone = audioCtx.createBiquadFilter();
      delayTone.type = 'lowpass';
      delayTone.frequency.value = 3500;
      const wet = audioCtx.createGain();
      wet.gain.value = 0;
      const out = audioCtx.createGain();
      const reverbSend = audioCtx.createGain();
      reverbSend.gain.value = 0;
      const routeGain = audioCtx.createGain();
      const meter = audioCtx.createAnalyser();
      meter.fftSize = 512;

      trim.connect(highpass);
      highpass.connect(gate);
      gate.connect(comp);
      comp.connect(makeup);

      postSidechain.connect(dry);
      postSidechain.connect(delay);
      delay.connect(feedback);
      feedback.connect(delayTone);
      delayTone.connect(delay); // feedback loop = repeating echoes
      delay.connect(wet);
      dry.connect(out);
      wet.connect(out);

      out.connect(routeGain);
      routeGain.connect(master);
      routeGain.connect(reverbSend);
      reverbSend.connect(reverbBus);
      routeGain.connect(meter);

      return { trim, highpass, gate, comp, makeup, dry, delay, feedback, wet, reverbSend, routeGain, meter, source: null, sourceStream: null };
    }

    function applyChannel(key) {
      const c = channels[key];
      if (!c) return;
      const s = channelSettings[key];
      const now = audioCtx.currentTime;
      const ramp = (param, value) => param.setTargetAtTime(value, now, 0.02);

      ramp(c.trim.gain, s.muted ? 0 : dbToLin(s.trimDb));
      ramp(c.highpass.frequency, s.highpass ? 150 : 20);

      if (gateAvailable) {
        c.gate.port.postMessage({
          thresholdDb: s.gateEnabled ? s.gateThreshold : -100,
          attack: 0.005,
          release: s.gateRelease / 1000,
        });
      }

      ramp(c.comp.threshold, s.compEnabled ? s.compThreshold : 0);
      ramp(c.comp.ratio, s.compEnabled ? s.compRatio : 1);
      ramp(c.comp.attack, Math.max(0.001, s.compAttack / 1000));
      ramp(c.comp.release, Math.max(0.01, s.compRelease / 1000));
      ramp(c.makeup.gain, dbToLin(s.compEnabled ? s.compMakeup : 0));

      const active = s.spatialType !== 'none';
      ramp(c.delay.delayTime, Math.max(0.001, s.spatialTime / 1000));
      ramp(c.feedback.gain, active ? (s.spatialFeedback / 100) * 0.9 : 0);
      ramp(c.wet.gain, active ? s.spatialMix / 100 : 0);
      ramp(c.reverbSend.gain, s.reverbSend / 100);
      ramp(c.routeGain.gain, s.included ? 1 : 0);
    }

    function applySidechain() {
      if (!sidechainAvailable) return;
      const s = sidechainSettings;
      sidechainNode.port.postMessage({
        enabled: s.enabled,
        direction: s.trigger === 'mic' ? 0 : 1,
        mode: s.mode === 'gate' ? 1 : 0,
        thresholdDb: s.threshold,
        ratio: s.ratio,
        depthDb: s.depth,
        attack: s.attack / 1000,
        release: s.release / 1000,
        makeupDb: s.makeup,
      });
    }

    let lastReverbSize = null;

    function applyMaster() {
      if (!audioCtx) return;
      const s = masterSettings;
      const now = audioCtx.currentTime;
      master.gain.setTargetAtTime(dbToLin(s.gainDb), now, 0.02);
      limiter.threshold.setTargetAtTime(s.limiter ? -3 : 0, now, 0.02);
      limiter.ratio.setTargetAtTime(s.limiter ? 20 : 1, now, 0.02);
      reverbReturn.gain.setTargetAtTime(s.reverbReturn / 100, now, 0.02);
      monitorGain.gain.setTargetAtTime(s.monitor ? 1 : 0, now, 0.02);
      // Only rebuild the impulse response when the size actually changed — this
      // swaps the convolver's buffer, which would otherwise click/reset its
      // tail on every unrelated master control (e.g. dragging the level).
      if (s.reverbSize !== lastReverbSize) {
        lastReverbSize = s.reverbSize;
        reverbBus.buffer = createReverbImpulse(audioCtx, s.reverbSize);
      }
    }

    async function init() {
      if (readyPromise) return readyPromise;
      readyPromise = (async () => {
        audioCtx = new AudioContext();
        destination = audioCtx.createMediaStreamDestination();
        master = audioCtx.createGain();
        limiter = audioCtx.createDynamicsCompressor();
        limiter.knee.value = 6;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.2;
        monitorGain = audioCtx.createGain();
        monitorGain.gain.value = 0;
        reverbBus = audioCtx.createConvolver();
        reverbBus.normalize = true;
        reverbReturn = audioCtx.createGain();
        masterMeter = audioCtx.createAnalyser();
        masterMeter.fftSize = 512;

        master.connect(limiter);
        limiter.connect(destination);
        limiter.connect(monitorGain);
        limiter.connect(masterMeter);
        monitorGain.connect(audioCtx.destination);
        reverbBus.connect(reverbReturn);
        reverbReturn.connect(master);

        try {
          await audioCtx.audioWorklet.addModule(new URL(WORKLET_URL, document.baseURI).href);
          gateAvailable = true;
          sidechainAvailable = true;
          sidechainNode = new AudioWorkletNode(audioCtx, 'sidechain', {
            numberOfInputs: 2, numberOfOutputs: 2, outputChannelCount: [2, 2],
          });
        } catch (err) {
          console.warn('Audio worklets unavailable; noise gate and sidechain are disabled.', err);
        }

        channels.mic = makeChannel('mic');
        channels.system = makeChannel('system');
        applyChannel('mic');
        applyChannel('system');
        applySidechain();
        applyMaster();
      })();
      return readyPromise;
    }

    function connectSource(key, stream) {
      const c = channels[key];
      if (!c || c.sourceStream === stream) return;
      c.sourceStream = stream || null;
      if (c.source) {
        c.source.disconnect();
        c.source = null;
      }
      if (stream && stream.getAudioTracks().length) {
        c.source = audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
        c.source.connect(c.trim);
      }
    }

    function syncSources() {
      if (!audioCtx) return;
      connectSource('mic', els.micEnabled.checked ? state.mic : null);
      const screenHasAudio = state.screen && state.screen.getAudioTracks().length > 0;
      connectSource('system', els.systemAudio.checked && needsScreen() && screenHasAudio ? state.screen : null);
    }

    return {
      init,
      syncSources,
      isReady: () => Boolean(audioCtx),
      resume: () => audioCtx && audioCtx.state === 'suspended' && audioCtx.resume(),
      getDestinationStream: () => destination.stream,
      updateChannel(key, patch) {
        Object.assign(channelSettings[key], patch);
        applyChannel(key);
      },
      updateSidechain(patch) {
        Object.assign(sidechainSettings, patch);
        applySidechain();
      },
      updateMaster(patch) {
        Object.assign(masterSettings, patch);
        applyMaster();
      },
      getChannelLevel: (key) => readLevel(channels[key] && channels[key].meter),
      getMasterLevel: () => readLevel(masterMeter),
    };
  })();

  /* ------------------------------------------------------------------------
   * Audio mixer UI — a channel strip template (used for both Microphone and
   * System audio), plus the Sidechain and Master panels.
   * --------------------------------------------------------------------- */

  const fmtDb = (v) => `${v > 0 ? '+' : ''}${v} dB`;
  const fmtMs = (v) => `${v} ms`;
  const fmtPct = (v) => `${v}%`;
  const fmtRatio = (v) => `${v}:1`;

  function wireRange(input, label, fmt, onChange) {
    const update = () => {
      const v = Number(input.value);
      if (label) label.textContent = fmt(v);
      onChange(v);
    };
    input.addEventListener('input', update);
    update();
  }

  function wireToggle(input, onChange) {
    input.addEventListener('change', () => onChange(input.checked));
    onChange(input.checked);
  }

  function wireSelect(input, onChange) {
    input.addEventListener('change', () => onChange(input.value));
    onChange(input.value);
  }

  // One field per CHANNEL_DEFAULTS key (minus "muted", which the mute chip
  // button handles directly). Reused for both the Microphone and System
  // audio channel strips — see channelStripTemplate().
  const CHANNEL_FIELDS = [
    ['trimDb', 'range', fmtDb],
    ['compEnabled', 'toggle'],
    ['compThreshold', 'range', fmtDb],
    ['compRatio', 'range', fmtRatio],
    ['compAttack', 'range', fmtMs],
    ['compRelease', 'range', fmtMs],
    ['compMakeup', 'range', fmtDb],
    ['highpass', 'toggle'],
    ['gateEnabled', 'toggle'],
    ['gateThreshold', 'range', fmtDb],
    ['gateRelease', 'range', fmtMs],
    ['spatialType', 'select'],
    ['spatialTime', 'range', fmtMs],
    ['spatialFeedback', 'range', fmtPct],
    ['spatialMix', 'range', fmtPct],
    ['reverbSend', 'range', fmtPct],
    ['included', 'toggle'],
  ];

  function channelStripTemplate(title) {
    return `
      <header class="channel-head">
        <strong>${title}</strong>
        <span class="meter" aria-hidden="true"><span class="meter-fill" data-ctl="meter"></span></span>
        <button type="button" class="chip" data-ctl="muted" aria-pressed="false">Mute</button>
      </header>
      <div class="row"><label>Trim</label><input type="range" data-ctl="trimDb" min="-24" max="24" value="0" step="1"><span class="val" data-ctl="trimDbVal"></span></div>

      <details open>
        <summary>Dynamics processing</summary>
        <label class="toggle"><input type="checkbox" data-ctl="compEnabled"><span>Compressor</span></label>
        <div class="row"><label>Threshold</label><input type="range" data-ctl="compThreshold" min="-60" max="0" value="-24"><span class="val" data-ctl="compThresholdVal"></span></div>
        <div class="row"><label>Ratio</label><input type="range" data-ctl="compRatio" min="1" max="20" value="3" step="0.5"><span class="val" data-ctl="compRatioVal"></span></div>
        <div class="row"><label>Attack</label><input type="range" data-ctl="compAttack" min="0" max="100" value="10"><span class="val" data-ctl="compAttackVal"></span></div>
        <div class="row"><label>Release</label><input type="range" data-ctl="compRelease" min="10" max="1000" value="150"><span class="val" data-ctl="compReleaseVal"></span></div>
        <div class="row"><label>Makeup</label><input type="range" data-ctl="compMakeup" min="0" max="24" value="0"><span class="val" data-ctl="compMakeupVal"></span></div>
      </details>

      <details>
        <summary>Noise control</summary>
        <label class="toggle"><input type="checkbox" data-ctl="highpass"><span>Remove low rumble</span></label>
        <label class="toggle"><input type="checkbox" data-ctl="gateEnabled"><span>Noise gate</span></label>
        <div class="row"><label>Threshold</label><input type="range" data-ctl="gateThreshold" min="-80" max="-10" value="-45"><span class="val" data-ctl="gateThresholdVal"></span></div>
        <div class="row"><label>Release</label><input type="range" data-ctl="gateRelease" min="20" max="1000" value="150"><span class="val" data-ctl="gateReleaseVal"></span></div>
      </details>

      <details>
        <summary>Spatial effects</summary>
        <div class="row"><label>Insert</label>
          <select data-ctl="spatialType">
            <option value="none">None</option>
            <option value="delay">Delay</option>
            <option value="echo">Echo</option>
          </select>
        </div>
        <div class="row"><label>Time</label><input type="range" data-ctl="spatialTime" min="20" max="1000" value="250"><span class="val" data-ctl="spatialTimeVal"></span></div>
        <div class="row"><label>Feedback</label><input type="range" data-ctl="spatialFeedback" min="0" max="90" value="25"><span class="val" data-ctl="spatialFeedbackVal"></span></div>
        <div class="row"><label>Mix</label><input type="range" data-ctl="spatialMix" min="0" max="100" value="25"><span class="val" data-ctl="spatialMixVal"></span></div>
        <div class="row"><label>Reverb send</label><input type="range" data-ctl="reverbSend" min="0" max="100" value="0"><span class="val" data-ctl="reverbSendVal"></span></div>
      </details>

      <details>
        <summary>Routing</summary>
        <label class="toggle"><input type="checkbox" data-ctl="included" checked><span>Include in the mix</span></label>
      </details>
    `;
  }

  // Delay and Echo are the same effect under the hood (a feedback delay);
  // picking one just loads sensible starting numbers, still adjustable after.
  function applySpatialPreset(container, type) {
    const preset = type === 'echo'
      ? { spatialTime: 450, spatialFeedback: 45, spatialMix: 35 }
      : { spatialTime: 250, spatialFeedback: 15, spatialMix: 20 };
    Object.entries(preset).forEach(([prop, value]) => {
      const input = container.querySelector(`[data-ctl="${prop}"]`);
      input.value = value;
      input.dispatchEvent(new Event('input'));
    });
  }

  function wireChannelStrip(key, container, title) {
    container.innerHTML = channelStripTemplate(title);
    const mute = container.querySelector('[data-ctl="muted"]');
    mute.addEventListener('click', () => {
      const on = mute.getAttribute('aria-pressed') !== 'true';
      mute.setAttribute('aria-pressed', String(on));
      mixer.updateChannel(key, { muted: on });
    });
    CHANNEL_FIELDS.forEach(([prop, kind, fmt]) => {
      const input = container.querySelector(`[data-ctl="${prop}"]`);
      if (kind === 'range') {
        wireRange(input, container.querySelector(`[data-ctl="${prop}Val"]`), fmt, (v) => mixer.updateChannel(key, { [prop]: v }));
      } else if (kind === 'toggle') {
        wireToggle(input, (on) => mixer.updateChannel(key, { [prop]: on }));
      } else {
        wireSelect(input, (v) => {
          mixer.updateChannel(key, { [prop]: v });
          if (prop === 'spatialType' && v !== 'none') applySpatialPreset(container, v);
        });
      }
    });
  }

  function wireSidechainPanel() {
    wireToggle(els.scEnabled, (on) => mixer.updateSidechain({ enabled: on }));
    wireSelect(els.scTrigger, (v) => mixer.updateSidechain({ trigger: v }));
    wireSelect(els.scMode, (v) => {
      mixer.updateSidechain({ mode: v });
      els.scRatioRow.hidden = v === 'gate';
      els.scDepthRow.hidden = v !== 'gate';
    });
    wireRange(els.scThreshold, els.scThresholdVal, fmtDb, (v) => mixer.updateSidechain({ threshold: v }));
    wireRange(els.scRatio, els.scRatioVal, fmtRatio, (v) => mixer.updateSidechain({ ratio: v }));
    wireRange(els.scDepth, els.scDepthVal, fmtDb, (v) => mixer.updateSidechain({ depth: v }));
    wireRange(els.scAttack, els.scAttackVal, fmtMs, (v) => mixer.updateSidechain({ attack: v }));
    wireRange(els.scRelease, els.scReleaseVal, fmtMs, (v) => mixer.updateSidechain({ release: v }));
    wireRange(els.scMakeup, els.scMakeupVal, fmtDb, (v) => mixer.updateSidechain({ makeup: v }));
  }

  function wireMasterPanel() {
    wireRange(els.masterGain, els.masterGainVal, fmtDb, (v) => mixer.updateMaster({ gainDb: v }));
    wireToggle(els.masterLimiter, (on) => mixer.updateMaster({ limiter: on }));
    wireRange(els.reverbReturn, els.reverbReturnVal, fmtPct, (v) => mixer.updateMaster({ reverbReturn: v }));
    wireRange(els.reverbSize, els.reverbSizeVal, fmtPct, (v) => mixer.updateMaster({ reverbSize: v }));
    wireToggle(els.monitorEnabled, (on) => mixer.updateMaster({ monitor: on }));
  }

  function setMeterFill(container, level) {
    const fill = container && container.querySelector('[data-ctl="meter"]');
    if (fill) fill.style.width = `${level * 100}%`;
  }

  function startMeterLoop() {
    setInterval(() => {
      if (!mixer.isReady()) return;
      setMeterFill(els.channelMic, mixer.getChannelLevel('mic'));
      setMeterFill(els.channelSystem, mixer.getChannelLevel('system'));
      els.masterMeterFill.style.width = `${mixer.getMasterLevel() * 100}%`;
    }, 100);
  }

  function wireTabs() {
    els.tabButtons.forEach((button) => {
      button.addEventListener('click', () => {
        els.tabButtons.forEach((b) => b.setAttribute('aria-selected', String(b === button)));
        els.tabPanels.forEach((panel) => {
          panel.hidden = panel.dataset.tabPanel !== button.dataset.tab;
        });
        if (button.dataset.tab === 'audio') activateAudioPreview();
      });
    });
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

    await activateAudioPreview();

    const format = selectedFormat();
    const pixels = els.canvas.width * els.canvas.height;
    const canvasStream = els.canvas.captureStream(FPS);
    const stream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...mixer.getDestinationStream().getAudioTracks(),
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
    mixer.syncSources();
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
    els.lightingPanel.setAttribute('aria-disabled', String(!needsCamera()));
    els.arPanel.setAttribute('aria-disabled', String(!needsCamera()));
    els.beautyPanel.setAttribute('aria-disabled', String(!needsCamera()));

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

  /* Face effects (AR stickers + beauty touch-up) */

  let faceFxLoadState = 'idle'; // idle | loading | ready | error
  let faceFxError = '';
  let faceFxLoadPromise = null;

  // Lazily loads the face landmark model the first time an AR sticker or
  // skin smoothing is requested. Soft glow doesn't need it at all.
  function ensureFaceFX() {
    if (faceFxLoadState === 'ready') return Promise.resolve(true);
    if (faceFxLoadState === 'loading') return faceFxLoadPromise;
    faceFxLoadState = 'loading';
    updateFaceNotes();
    faceFxLoadPromise = faceFX.load().then(
      () => {
        faceFxLoadState = 'ready';
        updateFaceNotes();
        return true;
      },
      (err) => {
        console.error(err);
        faceFxLoadState = 'error';
        faceFxError = `Face tracking is unavailable: ${err.message}`;
        state.ar = 'none';
        state.beautySmooth = 0;
        els.beautySmooth.value = 0;
        syncFaceFxUI();
        return false;
      },
    );
    return faceFxLoadPromise;
  }

  function syncFaceFxUI() {
    els.arButtons.forEach((button) => {
      button.setAttribute('aria-checked', String(button.dataset.ar === state.ar));
    });
    updateFaceNotes();
  }

  async function selectAr(id) {
    if (id !== 'none' && !(await ensureFaceFX())) return;
    state.ar = id;
    syncFaceFxUI();
  }

  function faceStatusMessage() {
    if (faceFxLoadState === 'error') return faceFxError;
    if (faceFxLoadState === 'loading') return 'Loading face tracking…';
    if (faceFX.needsTracking() && faceFX.isTrackingReady() && !faceFX.hasFace()) {
      return 'No face detected — move into the camera view.';
    }
    return '';
  }

  function updateFaceNotes() {
    const message = faceStatusMessage();
    els.arNote.textContent = message;
    els.beautyNote.textContent = message;
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

    els.lightAuto.addEventListener('change', () => {
      state.lightAuto = els.lightAuto.checked;
      els.lightBrightness.disabled = state.lightAuto;
    });
    els.lightBrightness.addEventListener('input', () => {
      state.lightBrightness = Number(els.lightBrightness.value);
    });

    els.arButtons.forEach((button) => {
      button.addEventListener('click', () => selectAr(button.dataset.ar));
    });
    els.beautySmooth.addEventListener('input', async () => {
      const value = Number(els.beautySmooth.value);
      if (value > 0 && !(await ensureFaceFX())) return;
      state.beautySmooth = value;
    });
    els.beautyGlow.addEventListener('input', () => {
      state.beautyGlow = Number(els.beautyGlow.value);
    });

    els.micEnabled.addEventListener('change', async () => {
      if (els.micEnabled.checked) await activateAudioPreview();
      else stopMic();
      mixer.syncSources();
    });
    els.micSelect.addEventListener('change', async () => {
      if (!state.mic) return;
      stopMic();
      if (els.micEnabled.checked) await ensureMic();
      mixer.syncSources();
    });
    els.systemAudio.addEventListener('change', () => mixer.syncSources());

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
    setInterval(updateFaceNotes, 300);
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
    wireChannelStrip('mic', els.channelMic, 'Microphone');
    wireChannelStrip('system', els.channelSystem, 'System / screen audio');
    wireSidechainPanel();
    wireMasterPanel();
    wireTabs();
    startMeterLoop();
    updateUI();
    ensureCamera().then(updateUI);
  }

  init();
})();
