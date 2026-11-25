/**
 * audio.js — Mobile-first Web Audio PCM capture, Pre-roll VAD, WAV encoding,
 * and iOS Safari-safe Gemini 24kHz PCM TTS playback.
 */

const PLAN_A_SAMPLE_RATE = 12000;
const LIVE_PCM_SAMPLE_RATE = 16000;

/**
 * Downsample Float32 PCM buffer from inputRate to targetSampleRate and encode as 16-bit mono WAV.
 */
export function encodeWavMono(chunks, inputSampleRate, targetSampleRate = PLAN_A_SAMPLE_RATE) {
  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  if (totalLen === 0) return null;

  const merged = new Float32Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }

  let resampled;
  if (inputSampleRate === targetSampleRate) {
    resampled = merged;
  } else {
    const ratio = inputSampleRate / targetSampleRate;
    const outLength = Math.max(1, Math.round(merged.length / ratio));
    resampled = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const srcIdx = i * ratio;
      const idx0 = Math.floor(srcIdx);
      const idx1 = Math.min(idx0 + 1, merged.length - 1);
      const frac = srcIdx - idx0;
      resampled[i] = merged[idx0] * (1 - frac) + merged[idx1] * frac;
    }
  }

  const numSamples = resampled.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, numSamples * 2, true);

  let pos = 44;
  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, resampled[i]));
    view.setInt16(pos, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    pos += 2;
  }

  const bytes = new Uint8Array(buffer);
  return {
    bytes,
    base64: uint8ToBase64(bytes),
    mimeType: 'audio/wav',
    durationSec: numSamples / targetSampleRate,
  };
}

/**
 * Compatibility wrapper for 16kHz mono WAV encoding.
 */
export function encodeWav16kMono(chunks, inputSampleRate) {
  return encodeWavMono(chunks, inputSampleRate, LIVE_PCM_SAMPLE_RATE);
}

/**
 * Resample Float32 frame to 16-bit little-endian Int16 PCM at 16kHz for Gemini Live API.
 */
export function resampleFloat32ToInt16Pcm(frame, inputSampleRate, targetSampleRate = LIVE_PCM_SAMPLE_RATE) {
  if (!frame || frame.length === 0) return new Int16Array(0);
  const ratio = inputSampleRate / targetSampleRate;
  const outLength = inputSampleRate === targetSampleRate ? frame.length : Math.max(1, Math.round(frame.length / ratio));
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    let sample;
    if (inputSampleRate === targetSampleRate) {
      sample = frame[i];
    } else {
      const srcIdx = i * ratio;
      const idx0 = Math.floor(srcIdx);
      const idx1 = Math.min(idx0 + 1, frame.length - 1);
      const frac = srcIdx - idx0;
      sample = frame[idx0] * (1 - frac) + frame[idx1] * frac;
    }
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

export function uint8ToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

export function base64ToUint8(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Parse sample rate from Gemini TTS mimeType like "audio/L16;codec=pcm;rate=24000".
 */
export function parsePcmSampleRate(mimeType) {
  if (!mimeType) return 24000;
  const m = /rate=(\d+)/i.exec(mimeType);
  return m ? parseInt(m[1], 10) : 24000;
}

/**
 * Wrap raw 16-bit little-endian mono PCM bytes in a standard 44-byte RIFF/WAVE container.
 */
export function wrapPcm16ToWavBytes(pcmBytes, sampleRate = 24000) {
  const usableLen = pcmBytes.byteLength - (pcmBytes.byteLength % 2);
  const buffer = new ArrayBuffer(44 + usableLen);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + usableLen, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, usableLen, true);

  const out = new Uint8Array(buffer);
  out.set(pcmBytes.subarray(0, usableLen), 44);
  return out;
}

/**
 * Check whether raw 16-bit LE mono PCM bytes contain real audible speech (not empty/silence).
 */
export function hasAudiblePcm(pcmBytes, sampleRate = 24000, minDurationSec = 0.16, minPeak = 200) {
  if (!pcmBytes || pcmBytes.byteLength < 4) return false;
  const sampleCount = Math.floor(pcmBytes.byteLength / 2);
  if (sampleCount / sampleRate < minDurationSec) return false;
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, sampleCount * 2);
  let peak = 0;
  const step = Math.max(1, Math.floor(sampleCount / 4000));
  for (let i = 0; i < sampleCount; i += step) {
    const abs = Math.abs(view.getInt16(i * 2, true));
    if (abs > peak) {
      peak = abs;
      if (peak >= minPeak) return true;
    }
  }
  return peak >= minPeak;
}

/**
 * Shared AudioEngine with separate mic-capture AudioContext and dedicated playback
 * HTMLAudioElement + playback AudioContext (prevents Windows Bluetooth HFP/A2DP & iOS Safari mute bugs).
 */
export class AudioEngine {
  constructor() {
    // Mic capture context (isolated from speaker playback!)
    this.ctx = null;
    this.stream = null;
    this.sourceNode = null;
    this.captureNode = null;
    this.silentGain = null;

    // VAD & Live stream state
    this.listening = false;
    this.liveStreaming = false;
    this.manualCapturing = false;
    this.muted = false;
    this.muteUntil = 0;

    this.vadThreshold = 0.018;
    this.vadMode = 'dialogue'; // 'dialogue' (turn-based bidirectional) | 'broadcast' (2-3 sentence continuous news/lecture)
    this.silenceMs = 750;
    this.minBatchMs = 9000;
    this.interSentencePauseMs = 420;
    this.minSpeechMs = 400;
    this.maxChunkMs = 12000;
    this.preRollMs = 400;
    this.uploadSampleRate = PLAN_A_SAMPLE_RATE;

    this.preRollChunks = [];
    this.preRollSamples = 0;
    this.activeChunks = [];
    this.activeSamples = 0;
    this.isSpeaking = false;
    this.speechStartTs = 0;
    this.lastVoiceTs = 0;
    this._lastProgressTs = 0;

    this.manualChunks = [];
    this.manualSamples = 0;
    this.manualStartTs = 0;

    // Live PCM accumulation (~100ms = 1600 samples at 16kHz)
    this.livePcmPending = [];
    this.livePcmPendingSamples = 0;
    this.onLivePcmChunk = null; // (int16Array) => void

    // Callbacks
    this.onLevel = null; // (rms, activeState) => void
    this.onVadSegment = null; // (wavPayload) => void
    this.onVadStateChange = null; // (speaking: boolean) => void
    this.onCaptureProgress = null; // (durationSec: number) => void

    // Dedicated speaker playback state (decoupled from getUserMedia)
    this.playCtx = null;
    this.playerEl = null;
    this._workletLoadedCtx = null;
    this._htmlAudioUnlocked = false;
    this._playCtxUnlocked = false;
    this._activeObjectUrl = null;
    this._activeUtterance = null;
    this.currentSource = null;
    this.livePlaybackSources = [];
    this.livePlaybackCursor = 0;
    this.ttsCache = new Map(); // cacheKey -> { bytes: Uint8Array, mimeType: string }
    this.onPlaybackChange = null; // (playingId | null) => void
    this.playingId = null;
  }

  async ensureContext() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      throw new Error('此瀏覽器不支援 Web Audio API');
    }
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioCtx();
      this._workletLoadedCtx = null;
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    return this.ctx;
  }

  async ensurePlaybackContext() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      throw new Error('此瀏覽器不支援 Web Audio API');
    }
    if (!this.playCtx || this.playCtx.state === 'closed') {
      this.playCtx = new AudioCtx();
      this._playCtxUnlocked = false;
    }
    if (this.playCtx.state === 'suspended') {
      await this.playCtx.resume();
    }
    return this.playCtx;
  }

  /**
   * Call synchronously inside a user click/tap gesture before async TTS fetch
   * so iOS Safari & Chrome unlock both HTMLAudioElement and the dedicated playback AudioContext.
   */
  unlockPlayback() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        if (!this.playCtx || this.playCtx.state === 'closed') {
          this.playCtx = new AudioCtx();
          this._playCtxUnlocked = false;
        }
        if (this.playCtx.state === 'suspended') {
          this.playCtx.resume().catch(() => {});
        }
        if (!this._playCtxUnlocked) {
          // Standard 1-sample silent buffer unlocks Web Audio output on iOS Safari
          const silentBuf = this.playCtx.createBuffer(1, 1, 22050);
          const src = this.playCtx.createBufferSource();
          src.buffer = silentBuf;
          src.connect(this.playCtx.destination);
          src.start(0);
          this._playCtxUnlocked = true;
        }
      }
      if (typeof Audio !== 'undefined') {
        if (!this.playerEl) {
          const el = new Audio();
          el.playsInline = true;
          el.preload = 'auto';
          this.playerEl = el;
        }
        if (!this._htmlAudioUnlocked && !this.playingId) {
          // 1-sample silent WAV data URI unlocks HTMLAudioElement for post-await async playback on iOS Safari
          this._htmlAudioUnlocked = true;
          const el = this.playerEl;
          el.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
          const p = el.play();
          if (p && typeof p.then === 'function') {
            p.then(() => {
              if (!this.playingId) el.pause();
            }).catch(() => {
              this._htmlAudioUnlocked = false;
            });
          }
        }
      }
    } catch (_) {}
  }

  configureVad({
    threshold,
    silenceMs,
    mode,
    minBatchMs,
    interSentencePauseMs,
    maxChunkMs,
    uploadSampleRate,
  } = {}) {
    if (typeof threshold === 'number') this.vadThreshold = threshold;
    if (typeof silenceMs === 'number') this.silenceMs = silenceMs;
    if (mode === 'dialogue' || mode === 'broadcast') this.vadMode = mode;
    if (typeof minBatchMs === 'number') this.minBatchMs = minBatchMs;
    if (typeof interSentencePauseMs === 'number') this.interSentencePauseMs = interSentencePauseMs;
    if (typeof maxChunkMs === 'number') this.maxChunkMs = maxChunkMs;
    if (typeof uploadSampleRate === 'number' && uploadSampleRate >= 8000) {
      this.uploadSampleRate = uploadSampleRate;
    }
  }

  async ensureMicrophone() {
    await this.ensureContext();
    if (this.stream && this.captureNode) {
      const tracks = this.stream.getAudioTracks();
      if (tracks.length > 0 && tracks[0].readyState === 'live') {
        return;
      }
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('需要 HTTPS 安全連線才能使用手機麥克風');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    this.sourceNode = this.ctx.createMediaStreamSource(this.stream);
    this.silentGain = this.ctx.createGain();
    this.silentGain.gain.value = 0;

    let workletReady = false;
    if (this.ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        if (this._workletLoadedCtx !== this.ctx) {
          const workletCode = `
            class PcmCaptureProcessor extends AudioWorkletProcessor {
              process(inputs) {
                const input = inputs[0];
                if (input && input[0] && input[0].length > 0) {
                  this.port.postMessage(new Float32Array(input[0]));
                }
                return true;
              }
            }
            registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
          `;
          const blob = new Blob([workletCode], { type: 'application/javascript' });
          const url = URL.createObjectURL(blob);
          try {
            await this.ctx.audioWorklet.addModule(url);
            this._workletLoadedCtx = this.ctx;
          } finally {
            URL.revokeObjectURL(url);
          }
        }
        const node = new AudioWorkletNode(this.ctx, 'pcm-capture-processor');
        node.port.onmessage = (e) => this._handleAudioFrame(e.data);
        this.captureNode = node;
        workletReady = true;
      } catch (_) {
        workletReady = false;
      }
    }

    if (!workletReady) {
      const proc = this.ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        this._handleAudioFrame(new Float32Array(input));
      };
      this.captureNode = proc;
    }

    this.sourceNode.connect(this.captureNode);
    this.captureNode.connect(this.silentGain);
    this.silentGain.connect(this.ctx.destination);
  }

  releaseMicrophoneIfIdle() {
    if (this.listening || this.liveStreaming || this.manualCapturing) return;
    if (this.captureNode) {
      try { this.captureNode.disconnect(); } catch (_) {}
      this.captureNode = null;
    }
    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch (_) {}
      this.sourceNode = null;
    }
    if (this.silentGain) {
      try { this.silentGain.disconnect(); } catch (_) {}
      this.silentGain = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this._resetVadBuffers();
  }

  async startListening() {
    await this.ensureMicrophone();
    this._resetVadBuffers();
    this.liveStreaming = false;
    this.listening = true;
  }

  stopListening() {
    if (this.listening && this.isSpeaking && this.activeSamples > 0) {
      this._emitVadSegment(true);
    }
    this.listening = false;
    this._resetVadBuffers();
    this.releaseMicrophoneIfIdle();
  }

  async startLiveStream(onPcmChunk) {
    await this.ensureMicrophone();
    this._resetVadBuffers();
    this.listening = false;
    this.livePcmPending = [];
    this.livePcmPendingSamples = 0;
    this.onLivePcmChunk = onPcmChunk || null;
    this.liveStreaming = true;
  }

  stopLiveStream() {
    this.liveStreaming = false;
    this.livePcmPending = [];
    this.livePcmPendingSamples = 0;
    this.onLivePcmChunk = null;
    this.stopLivePlayback();
    this.releaseMicrophoneIfIdle();
  }

  flushListeningNow() {
    if (!this.listening) return false;
    if (this.activeSamples > 0) {
      return this._emitVadSegment(true);
    }
    return false;
  }

  async startManualCapture() {
    // Pause TTS if currently playing
    this.stopPlayback();
    await this.ensureMicrophone();
    // Flush any pending ambient VAD speech cleanly before manual recording
    if (this.listening && this.isSpeaking && this.activeSamples > 0) {
      this._emitVadSegment(true);
    }
    this._resetVadBuffers();
    this.manualChunks = [];
    this.manualSamples = 0;
    this.manualStartTs = performance.now();
    this.manualCapturing = true;
  }

  stopManualCapture() {
    if (!this.manualCapturing) return null;
    this.manualCapturing = false;
    const sampleRate = this.ctx ? this.ctx.sampleRate : 48000;
    const chunks = this.manualChunks;
    this.manualChunks = [];
    this.manualSamples = 0;

    // Brief cooldown before ambient VAD resumes
    this.muteUntil = performance.now() + 250;
    this.releaseMicrophoneIfIdle();

    if (chunks.length === 0) return null;
    const wav = encodeWavMono(chunks, sampleRate, this.uploadSampleRate || PLAN_A_SAMPLE_RATE);
    if (!wav || wav.durationSec < 0.25) return null;
    return wav;
  }

  cancelManualCapture() {
    this.manualCapturing = false;
    this.manualChunks = [];
    this.manualSamples = 0;
    this.releaseMicrophoneIfIdle();
  }

  _resetVadBuffers() {
    this.preRollChunks = [];
    this.preRollSamples = 0;
    this.activeChunks = [];
    this.activeSamples = 0;
    this._lastProgressTs = 0;
    if (this.isSpeaking) {
      this.isSpeaking = false;
      if (this.onVadStateChange) this.onVadStateChange(false);
    }
  }

  _handleAudioFrame(frame) {
    const now = performance.now();

    // Compute RMS energy
    let sumSq = 0;
    for (let i = 0; i < frame.length; i++) {
      sumSq += frame[i] * frame[i];
    }
    const rms = Math.sqrt(sumSq / frame.length);

    if (this.manualCapturing) {
      this.manualChunks.push(frame);
      this.manualSamples += frame.length;
      if (this.onLevel) this.onLevel(rms, 'manual');
      return;
    }

    // Live WebSocket streaming mode: bypass local VAD, stream 16kHz Int16 PCM directly every ~100ms
    if (this.liveStreaming) {
      if (this.muted || now < this.muteUntil) {
        if (this.onLevel) this.onLevel(0, 'muted');
        return;
      }
      if (this.onLevel) this.onLevel(rms, rms >= this.vadThreshold ? 'speaking' : 'idle');

      const sampleRate = this.ctx ? this.ctx.sampleRate : 48000;
      const pcm16 = resampleFloat32ToInt16Pcm(frame, sampleRate, LIVE_PCM_SAMPLE_RATE);
      if (pcm16.length > 0) {
        this.livePcmPending.push(pcm16);
        this.livePcmPendingSamples += pcm16.length;
        // ~100ms chunk (1600 samples @ 16kHz = 3200 bytes)
        if (this.livePcmPendingSamples >= 1600) {
          const merged = new Int16Array(this.livePcmPendingSamples);
          let off = 0;
          for (const part of this.livePcmPending) {
            merged.set(part, off);
            off += part.length;
          }
          this.livePcmPending = [];
          this.livePcmPendingSamples = 0;
          if (this.onLivePcmChunk) this.onLivePcmChunk(merged);
        }
      }
      return;
    }

    if (!this.listening) {
      return;
    }

    // Ignore mic input while AI TTS is speaking (echo guard)
    if (this.muted || now < this.muteUntil) {
      if (this.onLevel) this.onLevel(0, 'muted');
      return;
    }

    const sampleRate = this.ctx ? this.ctx.sampleRate : 48000;
    const maxPreRollSamples = Math.round((this.preRollMs / 1000) * sampleRate);

    if (!this.isSpeaking) {
      // Keep rolling pre-roll ring buffer
      this.preRollChunks.push(frame);
      this.preRollSamples += frame.length;
      while (this.preRollSamples > maxPreRollSamples && this.preRollChunks.length > 1) {
        const removed = this.preRollChunks.shift();
        this.preRollSamples -= removed.length;
      }

      if (rms >= this.vadThreshold) {
        this.isSpeaking = true;
        this.speechStartTs = now;
        this.lastVoiceTs = now;
        this._lastProgressTs = now;
        this.activeChunks = this.preRollChunks.slice();
        this.activeSamples = this.preRollSamples;
        this.preRollChunks = [];
        this.preRollSamples = 0;
        if (this.onVadStateChange) this.onVadStateChange(true);
      }

      if (this.onLevel) this.onLevel(rms, this.isSpeaking ? 'speaking' : 'idle');
      return;
    }

    // Currently capturing active speech
    this.activeChunks.push(frame);
    this.activeSamples += frame.length;

    if (rms >= this.vadThreshold * 0.72) {
      this.lastVoiceTs = now;
    }

    if (this.onLevel) this.onLevel(rms, 'speaking');

    const silenceElapsed = now - this.lastVoiceTs;
    const totalElapsed = now - this.speechStartTs;

    if (this.onCaptureProgress && now - this._lastProgressTs >= 500) {
      this._lastProgressTs = now;
      this.onCaptureProgress(Math.max(1, Math.round(totalElapsed / 1000)));
    }

    if (this.vadMode === 'broadcast') {
      // Continuous News / Lecture Mode (2–3 sentences per batch):
      // - Wait until minBatchMs (~9s std / ~4.5s Turbo) then cut cleanly on the next short sentence pause
      // - If speaker genuinely stops talking for silenceMs (~1.7s std / ~1.05s Turbo), flush immediately
      // - If speaker talks non-stop up to maxChunkMs (~17.5s std / ~9.5s Turbo), force seamless overlap cut
      const hitBatchBoundary = totalElapsed >= this.minBatchMs && silenceElapsed >= this.interSentencePauseMs;
      const hitFullStop = silenceElapsed >= this.silenceMs;
      const hitMaxCap = totalElapsed >= this.maxChunkMs;

      if (hitBatchBoundary || hitFullStop || hitMaxCap) {
        this._emitVadSegment(false, hitMaxCap);
      }
    } else {
      // Dialogue Mode (turn-based bidirectional conversation):
      // - Crisp cut on natural turn pause (silenceMs: ~750ms std / ~480ms Turbo)
      // - Or clean overlap cut if someone gives a long monologue (>maxChunkMs)
      const hitMaxCap = totalElapsed >= this.maxChunkMs;
      if (silenceElapsed >= this.silenceMs || hitMaxCap) {
        this._emitVadSegment(false, hitMaxCap);
      }
    }
  }

  _emitVadSegment(force, seamlessCarry = false) {
    const sampleRate = this.ctx ? this.ctx.sampleRate : 48000;
    const chunks = this.activeChunks;
    const speechDurationMs = (this.activeSamples / sampleRate) * 1000;

    // Preserve ~120ms tail into preRoll when cutting mid-speech (news anchor talking non-stop) so zero syllables drop
    let tailChunks = [];
    let tailSamples = 0;
    if (seamlessCarry && chunks.length > 0) {
      const targetTail = Math.round(0.12 * sampleRate);
      for (let i = chunks.length - 1; i >= 0 && tailSamples < targetTail; i--) {
        tailChunks.unshift(chunks[i]);
        tailSamples += chunks[i].length;
      }
    }

    this._resetVadBuffers();
    if (tailChunks.length > 0) {
      this.preRollChunks = tailChunks;
      this.preRollSamples = tailSamples;
    }

    const minMs = force ? 280 : this.minSpeechMs;
    if (chunks.length === 0 || speechDurationMs < minMs) {
      return false;
    }

    const wav = encodeWavMono(chunks, sampleRate, this.uploadSampleRate || PLAN_A_SAMPLE_RATE);
    if (wav && this.onVadSegment) {
      this.onVadSegment(wav);
      return true;
    }
    return false;
  }

  clearTtsCache() {
    this.ttsCache.clear();
  }

  _normalizeToPlayableBytes(bytes, mimeType) {
    if (!bytes || bytes.byteLength < 12) return null;
    const hasRiffHeader =
      bytes[0] === 0x52 && // R
      bytes[1] === 0x49 && // I
      bytes[2] === 0x46 && // F
      bytes[3] === 0x46;   // F
    if (hasRiffHeader) {
      return { bytes, mimeType: 'audio/wav' };
    }
    const isRawPcm = !mimeType || /audio\/L16|pcm/i.test(mimeType);
    if (isRawPcm) {
      const sampleRate = parsePcmSampleRate(mimeType);
      return {
        bytes: wrapPcm16ToWavBytes(bytes, sampleRate),
        mimeType: 'audio/wav',
      };
    }
    return { bytes, mimeType: mimeType || 'audio/wav' };
  }

  _putTtsCache(cacheKey, entry) {
    if (!cacheKey || !entry) return;
    this.ttsCache.set(cacheKey, entry);
    if (this.ttsCache.size > 40) {
      const oldestKey = this.ttsCache.keys().next().value;
      this.ttsCache.delete(oldestKey);
    }
  }

  cacheGeminiAudio(cacheKey, base64Data, mimeType) {
    if (!cacheKey || !base64Data) return false;
    const rawBytes = base64ToUint8(base64Data);
    const entry = this._normalizeToPlayableBytes(rawBytes, mimeType);
    if (!entry) return false;
    this._putTtsCache(cacheKey, entry);
    return true;
  }

  /**
   * Play Gemini TTS response (WAV with RIFF header or raw 24kHz 16-bit PCM).
   */
  async playGeminiAudio(cacheKey, base64Data, mimeType) {
    this.stopPlayback();

    let entry = cacheKey ? this.ttsCache.get(cacheKey) : null;
    if (!entry) {
      const rawBytes = base64ToUint8(base64Data);
      entry = this._normalizeToPlayableBytes(rawBytes, mimeType);
      if (!entry) {
        throw new Error('語音資料為空，無法播放');
      }
      if (cacheKey) this._putTtsCache(cacheKey, entry);
    }

    return this._playEntry(cacheKey, entry);
  }

  hasCachedAudio(cacheKey) {
    return Boolean(cacheKey && this.ttsCache.has(cacheKey));
  }

  async playCachedAudio(cacheKey) {
    const entry = this.ttsCache.get(cacheKey);
    if (!entry) return false;
    this.stopPlayback();
    await this._playEntry(cacheKey, entry);
    return true;
  }

  /**
   * Primary playback via dedicated HTMLAudioElement (immune to Windows Bluetooth HFP/getUserMedia
   * AudioContext sink bugs and iOS silent-switch WebAudio issues), with automatic fallback
   * to an isolated playback-only AudioContext if HTMLAudioElement is blocked.
   */
  async _playEntry(id, entry) {
    try {
      await this._playViaHtmlAudio(id, entry.bytes, entry.mimeType);
      return;
    } catch (htmlErr) {
      console.warn('HTMLAudioElement playback failed, trying playback AudioContext:', htmlErr);
    }
    await this._playViaPlayContext(id, entry.bytes);
  }

  _playViaHtmlAudio(id, bytes, mimeType = 'audio/wav') {
    return new Promise((resolve, reject) => {
      if (typeof Audio === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
        reject(new Error('HTMLAudioElement unavailable'));
        return;
      }

      if (!this.playerEl) {
        this.playerEl = new Audio();
        this.playerEl.playsInline = true;
      }
      const el = this.playerEl;

      if (this._activeObjectUrl) {
        try { URL.revokeObjectURL(this._activeObjectUrl); } catch (_) {}
        this._activeObjectUrl = null;
      }

      const blob = new Blob([bytes], { type: mimeType || 'audio/wav' });
      const url = URL.createObjectURL(blob);
      this._activeObjectUrl = url;

      let settled = false;
      const cleanup = () => {
        el.onended = null;
        el.onerror = null;
        if (this._activeObjectUrl === url) {
          try { URL.revokeObjectURL(url); } catch (_) {}
          this._activeObjectUrl = null;
        }
      };

      const finishOk = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.muted = false;
        this.muteUntil = performance.now() + 380;
        if (this.playingId === (id || '__playing__')) {
          this.playingId = null;
          if (this.onPlaybackChange) this.onPlaybackChange(null);
        }
        resolve();
      };

      const finishErr = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.muted = false;
        if (this.playingId === (id || '__playing__')) {
          this.playingId = null;
          if (this.onPlaybackChange) this.onPlaybackChange(null);
        }
        reject(err instanceof Error ? err : new Error('HTMLAudio 播放失敗'));
      };

      el.onended = finishOk;
      el.onerror = () => finishErr(new Error('HTMLAudio 解碼或播放失敗'));

      el.volume = 1.0;
      el.muted = false;
      el.src = url;
      el.load();

      this.muted = true;
      this.playingId = id || '__playing__';
      if (this.onPlaybackChange) this.onPlaybackChange(this.playingId);

      const playPromise = el.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(finishErr);
      }
    });
  }

  async _playViaPlayContext(id, wavBytes) {
    const ctx = await this.ensurePlaybackContext();
    const copy = wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength);
    const audioBuffer = await ctx.decodeAudioData(copy);

    return new Promise((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(ctx.destination);

      this.currentSource = src;
      this.muted = true;
      this.playingId = id || '__playing__';
      if (this.onPlaybackChange) this.onPlaybackChange(this.playingId);

      src.onended = () => {
        if (this.currentSource === src) {
          this.currentSource = null;
          this.muted = false;
          this.muteUntil = performance.now() + 380;
          this.playingId = null;
          if (this.onPlaybackChange) this.onPlaybackChange(null);
        }
        resolve();
      };

      src.start(0);
    });
  }

  _loadBrowserVoices() {
    return new Promise((resolve) => {
      const existing = window.speechSynthesis.getVoices();
      if (existing && existing.length > 0) {
        resolve(existing);
        return;
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        window.speechSynthesis.removeEventListener('voiceschanged', done);
        resolve(window.speechSynthesis.getVoices() || []);
      };
      window.speechSynthesis.addEventListener('voiceschanged', done);
      setTimeout(done, 450);
    });
  }

  /**
   * Free fallback TTS via Web Speech API (hardened against Chrome cancel()/resume()/GC quirks).
   */
  async speakBrowserFallback(id, text, langCode) {
    if (!('speechSynthesis' in window)) return;
    const wasSpeaking = window.speechSynthesis.speaking || window.speechSynthesis.pending;
    this.stopPlayback();

    const langMap = {
      zh: 'zh-TW',
      en: 'en-US',
      ja: 'ja-JP',
      sv: 'sv-SE',
    };
    const targetLang = langMap[langCode] || langCode || 'zh-TW';
    const voices = await this._loadBrowserVoices();

    if (wasSpeaking) {
      await new Promise((r) => setTimeout(r, 40));
    }

    return new Promise((resolve) => {
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = targetLang;
      utter.rate = 1.0;
      utter.volume = 1.0;

      const prefix = targetLang.toLowerCase().slice(0, 2);
      const exact = voices.find((v) => v.lang.toLowerCase() === targetLang.toLowerCase());
      const loose = voices.find((v) => v.lang.toLowerCase().startsWith(prefix));
      if (exact || loose) utter.voice = exact || loose;

      this._activeUtterance = utter;
      this.muted = true;
      this.playingId = id || '__speech__';
      if (this.onPlaybackChange) this.onPlaybackChange(this.playingId);

      let settled = false;
      const safetyTimer = setTimeout(() => finish(), 18000);

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(safetyTimer);
        if (this._activeUtterance === utter) this._activeUtterance = null;
        this.muted = false;
        this.muteUntil = performance.now() + 380;
        if (this.playingId === (id || '__speech__')) {
          this.playingId = null;
          if (this.onPlaybackChange) this.onPlaybackChange(null);
        }
        resolve();
      };

      utter.onend = finish;
      utter.onerror = finish;
      try {
        window.speechSynthesis.resume();
      } catch (_) {}
      window.speechSynthesis.speak(utter);
    });
  }

  /**
   * Stitch raw 16-bit LE PCM chunks from Gemini Live into a RIFF WAV entry and cache ONLY if audible.
   */
  cacheLivePcmChunks(cacheKey, uint8Chunks, sampleRate = 24000) {
    if (!cacheKey || !Array.isArray(uint8Chunks) || uint8Chunks.length === 0) return false;
    let totalBytes = 0;
    for (const c of uint8Chunks) totalBytes += c.byteLength;
    const usableBytes = totalBytes - (totalBytes % 2);
    if (usableBytes < 4) return false;

    const merged = new Uint8Array(usableBytes);
    let offset = 0;
    for (const c of uint8Chunks) {
      const copyLen = Math.min(c.byteLength, usableBytes - offset);
      if (copyLen > 0) {
        merged.set(c.subarray(0, copyLen), offset);
        offset += copyLen;
      }
    }

    // Guard against Gemini Live turns that return silence/near-empty audio alongside text
    if (!hasAudiblePcm(merged, sampleRate)) {
      return false;
    }

    const wavBytes = wrapPcm16ToWavBytes(merged, sampleRate);
    this._putTtsCache(cacheKey, { bytes: wavBytes, mimeType: 'audio/wav' });
    return true;
  }

  /**
   * Optional real-time gapless playback for Gemini Live 24kHz PCM chunks (uses isolated playCtx).
   */
  async enqueueLiveAudioChunk(uint8Bytes, sampleRate = 24000) {
    if (!uint8Bytes || uint8Bytes.byteLength < 2) return;
    const ctx = await this.ensurePlaybackContext();
    const sampleCount = Math.floor(uint8Bytes.byteLength / 2);
    const view = new DataView(uint8Bytes.buffer, uint8Bytes.byteOffset, uint8Bytes.byteLength);
    const audioBuffer = ctx.createBuffer(1, sampleCount, sampleRate);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      channel[i] = view.getInt16(i * 2, true) / 32768;
    }

    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now + 0.02, this.livePlaybackCursor);
    this.livePlaybackCursor = startAt + audioBuffer.duration;
    this.livePlaybackSources.push(src);
    this.muted = true;

    src.onended = () => {
      const idx = this.livePlaybackSources.indexOf(src);
      if (idx >= 0) this.livePlaybackSources.splice(idx, 1);
      if (this.livePlaybackSources.length === 0 && !this.currentSource) {
        this.muted = false;
        this.muteUntil = performance.now() + 360;
      }
    };

    src.start(startAt);
  }

  stopLivePlayback() {
    for (const src of this.livePlaybackSources) {
      try { src.stop(); } catch (_) {}
    }
    this.livePlaybackSources = [];
    this.livePlaybackCursor = 0;
  }

  stopPlayback() {
    this.stopLivePlayback();
    if (this.playerEl) {
      try {
        this.playerEl.onended = null;
        this.playerEl.onerror = null;
        this.playerEl.pause();
        this.playerEl.currentTime = 0;
      } catch (_) {}
    }
    if (this._activeObjectUrl) {
      try { URL.revokeObjectURL(this._activeObjectUrl); } catch (_) {}
      this._activeObjectUrl = null;
    }
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch (_) {}
      this.currentSource = null;
    }
    if ('speechSynthesis' in window && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) {
      try { window.speechSynthesis.cancel(); } catch (_) {}
    }
    this._activeUtterance = null;
    this.muted = false;
    if (this.playingId !== null) {
      this.playingId = null;
      if (this.onPlaybackChange) this.onPlaybackChange(null);
    }
  }
}
