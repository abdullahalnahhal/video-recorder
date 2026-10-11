/*
 * AudioWorklet processors for the sound mixer in js/app.js.
 *
 * Two processors live here:
 *  - "noise-gate": a self-referencing gate. Attenuates a channel's own
 *    signal whenever its level drops below a threshold, to cut hiss/hum
 *    between words.
 *  - "sidechain": ducks one channel using the level of a *different*
 *    channel as the trigger (e.g. duck background audio while the mic is
 *    active). Supports both proportional ("compression") and hard
 *    ("gating") reduction.
 *
 * Both are driven entirely by `port.postMessage` settings objects rather
 * than AudioParams, since the controls here (thresholds, times, mode) change
 * a few times a second at most from slider input — far below audio rate —
 * so there's nothing to gain from sample-accurate automation.
 */

const dbToLin = (db) => Math.pow(10, db / 20);
const linToDb = (lin) => 20 * Math.log10(Math.max(lin, 1e-8));

// One-pole smoothing coefficient for a given time constant (seconds).
const coefFor = (seconds, sr) => Math.exp(-1 / (sr * Math.max(seconds, 0.0001)));

class NoiseGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.thresholdDb = -100; // bypassed by default
    this.attack = 0.005;
    this.release = 0.15;
    this.env = [0, 0];
    this.gain = [1, 1];
    this.port.onmessage = (event) => Object.assign(this, event.data);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const channels = output.length;
    const n = output[0] ? output[0].length : 128;
    const thresholdLin = dbToLin(this.thresholdDb);
    const envCoef = coefFor(0.01, sampleRate);
    const attackCoef = coefFor(this.attack, sampleRate);
    const releaseCoef = coefFor(this.release, sampleRate);

    for (let ch = 0; ch < channels; ch++) {
      // Mono-up: if the input has fewer channels than the output wants, reuse channel 0.
      const inCh = input[ch] || input[0];
      const outCh = output[ch];
      if (!inCh) {
        outCh.fill(0);
        continue;
      }
      let env = this.env[ch] || 0;
      let gain = this.gain[ch] ?? 1;
      for (let i = 0; i < n; i++) {
        const rect = Math.abs(inCh[i]);
        env = envCoef * env + (1 - envCoef) * rect;
        const target = env >= thresholdLin ? 1 : 0;
        const coef = target > gain ? attackCoef : releaseCoef;
        gain = coef * gain + (1 - coef) * target;
        outCh[i] = inCh[i] * gain;
      }
      this.env[ch] = env;
      this.gain[ch] = gain;
    }
    return true;
  }
}

class SidechainProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.direction = 0; // 0: input0 triggers reduction on input1. 1: input1 triggers reduction on input0.
    this.mode = 0; // 0: proportional compression. 1: hard gate (duck fully once past threshold).
    this.thresholdDb = -30;
    this.ratio = 4;
    this.depthDb = 24; // max reduction, both modes
    this.attack = 0.015;
    this.release = 0.25;
    this.makeupDb = 0;
    this.env = 0;
    this.gainDb = 0;
    this.port.onmessage = (event) => Object.assign(this, event.data);
  }

  process(inputs, outputs) {
    const inA = inputs[0];
    const inB = inputs[1];
    const outA = outputs[0];
    const outB = outputs[1];
    const n = (outA[0] || outB[0] || []).length || 128;

    const copy = (src, dst) => {
      for (let ch = 0; ch < dst.length; ch++) {
        const inCh = src[ch] || src[0];
        if (inCh) dst[ch].set(inCh);
        else dst[ch].fill(0);
      }
    };

    if (!this.enabled) {
      copy(inA, outA);
      copy(inB, outB);
      return true;
    }

    const triggerIn = this.direction === 0 ? inA : inB;
    const triggerOut = this.direction === 0 ? outA : outB;
    const targetIn = this.direction === 0 ? inB : inA;
    const targetOut = this.direction === 0 ? outB : outA;
    copy(triggerIn, triggerOut); // the trigger channel itself always passes through untouched

    const trig0 = triggerIn[0];
    const envUpCoef = coefFor(0.005, sampleRate);
    const envDownCoef = coefFor(0.05, sampleRate);
    const attackCoef = coefFor(this.attack, sampleRate);
    const releaseCoef = coefFor(this.release, sampleRate);
    const makeupLin = dbToLin(this.makeupDb);

    for (let i = 0; i < n; i++) {
      const rect = trig0 ? Math.abs(trig0[i]) : 0;
      this.env = rect > this.env ? envUpCoef * this.env + (1 - envUpCoef) * rect : envDownCoef * this.env + (1 - envDownCoef) * rect;
      const envDb = linToDb(this.env);

      let targetDb;
      if (this.mode === 1) {
        targetDb = envDb > this.thresholdDb ? -this.depthDb : 0;
      } else {
        const over = Math.max(0, envDb - this.thresholdDb);
        targetDb = -Math.min(this.depthDb, over * (1 - 1 / this.ratio));
      }

      const coef = targetDb < this.gainDb ? attackCoef : releaseCoef;
      this.gainDb = coef * this.gainDb + (1 - coef) * targetDb;
      const g = dbToLin(this.gainDb) * makeupLin;

      for (let ch = 0; ch < targetOut.length; ch++) {
        const inCh = targetIn[ch] || targetIn[0];
        targetOut[ch][i] = inCh ? inCh[i] * g : 0;
      }
    }
    return true;
  }
}

registerProcessor('noise-gate', NoiseGateProcessor);
registerProcessor('sidechain', SidechainProcessor);
