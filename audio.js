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
 * Shared unlocked AudioContext manager (essential for iOS Safari PWA audio playback).
 */
export class AudioEngine {
  constructor() {
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
    this.silenceMs = 850;
    this.minSpeechMs = 420;
    this.maxChunkMs = 14000;
    this.preRollMs = 420;

    this.preRollChunks = [];
    this.preRollSamples = 0;
    this.activeChunks = [];
    this.activeSamples = 0;
    this.isSpeaking = false;
    this.speechStartTs = 0;
    this.lastVoiceTs = 0;

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

    // Playback state
    this.currentSource = null;
    this.livePlaybackSources = [];
    this.livePlaybackCursor = 0;
    this.ttsCache = new Map();
    this.onPlaybackChange = null; // (playingId | null) => void
    this.playingId = null;
  }

  async ensureContext() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      throw new Error('此瀏覽器不支援 Web Audio API');
    }
    if (!this.ctx) {
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    return this.ctx;
  }

  configureVad({ threshold, silenceMs }) {
    if (typeof threshold === 'number') this.vadThreshold = threshold;
    if (typeof silenceMs === 'number') this.silenceMs = silenceMs;
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
        } finally {
          URL.revokeObjectURL(url);
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
    const wav = encodeWavMono(chunks, sampleRate, PLAN_A_SAMPLE_RATE);
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

    if (silenceElapsed >= this.silenceMs || totalElapsed >= this.maxChunkMs) {
      this._emitVadSegment(false);
    }
  }

  _emitVadSegment(force) {
    const sampleRate = this.ctx ? this.ctx.sampleRate : 48000;
    const chunks = this.activeChunks;
    const speechDurationMs = (this.activeSamples / sampleRate) * 1000;

    this._resetVadBuffers();

    const minMs = force ? 280 : this.minSpeechMs;
    if (chunks.length === 0 || speechDurationMs < minMs) {
      return false;
    }

    const wav = encodeWavMono(chunks, sampleRate, PLAN_A_SAMPLE_RATE);
    if (wav && this.onVadSegment) {
      this.onVadSegment(wav);
      return true;
    }
    return false;
  }

  clearTtsCache() {
    this.ttsCache.clear();
  }

  /**
   * Play Gemini TTS response (WAV with RIFF header or raw 24kHz 16-bit PCM).
   */
  async playGeminiAudio(cacheKey, base64Data, mimeType) {
    const ctx = await this.ensureContext();
    this.stopPlayback();

    let audioBuffer = cacheKey ? this.ttsCache.get(cacheKey) : null;

    if (!audioBuffer) {
      const bytes = base64ToUint8(base64Data);
      const hasRiffHeader =
        bytes.length >= 12 &&
        bytes[0] === 0x52 && // R
        bytes[1] === 0x49 && // I
        bytes[2] === 0x46 && // F
        bytes[3] === 0x46;   // F
      const isRawPcm = !hasRiffHeader && (!mimeType || /audio\/L16|pcm/i.test(mimeType));

      if (isRawPcm) {
        const sampleRate = parsePcmSampleRate(mimeType);
        const sampleCount = Math.floor(bytes.byteLength / 2);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        audioBuffer = ctx.createBuffer(1, sampleCount, sampleRate);
        const channel = audioBuffer.getChannelData(0);
        for (let i = 0; i < sampleCount; i++) {
          channel[i] = view.getInt16(i * 2, true) / 32768;
        }
      } else {
        const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        audioBuffer = await ctx.decodeAudioData(copy);
      }

      if (cacheKey) {
        this.ttsCache.set(cacheKey, audioBuffer);
        if (this.ttsCache.size > 40) {
          const oldestKey = this.ttsCache.keys().next().value;
          this.ttsCache.delete(oldestKey);
        }
      }
    }

    return this._playBuffer(cacheKey, audioBuffer);
  }

  hasCachedAudio(cacheKey) {
    return Boolean(cacheKey && this.ttsCache.has(cacheKey));
  }

  async playCachedAudio(cacheKey) {
    const buf = this.ttsCache.get(cacheKey);
    if (!buf) return false;
    await this.ensureContext();
    this.stopPlayback();
    await this._playBuffer(cacheKey, buf);
    return true;
  }

  _playBuffer(id, audioBuffer) {
    return new Promise((resolve) => {
      const src = this.ctx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(this.ctx.destination);

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
   * Free fallback TTS via Web Speech API.
   */
  async speakBrowserFallback(id, text, langCode) {
    if (!('speechSynthesis' in window)) return;
    this.stopPlayback();

    const langMap = {
      zh: 'zh-TW',
      en: 'en-US',
      ja: 'ja-JP',
      sv: 'sv-SE',
    };
    const targetLang = langMap[langCode] || langCode || 'zh-TW';
    const voices = await this._loadBrowserVoices();

    return new Promise((resolve) => {
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = targetLang;
      utter.rate = 1.0;

      const prefix = targetLang.toLowerCase().slice(0, 2);
      const exact = voices.find((v) => v.lang.toLowerCase() === targetLang.toLowerCase());
      const loose = voices.find((v) => v.lang.toLowerCase().startsWith(prefix));
      if (exact || loose) utter.voice = exact || loose;

      this.muted = true;
      this.playingId = id || '__speech__';
      if (this.onPlaybackChange) this.onPlaybackChange(this.playingId);

      const finish = () => {
        this.muted = false;
        this.muteUntil = performance.now() + 380;
        this.playingId = null;
        if (this.onPlaybackChange) this.onPlaybackChange(null);
        resolve();
      };

      utter.onend = finish;
      utter.onerror = finish;
      window.speechSynthesis.speak(utter);
    });
  }

  /**
   * Stitch raw 16-bit LE PCM chunks (e.g. from Gemini Live 24kHz audio) into a single AudioBuffer.
   */
  async pcmChunksToAudioBuffer(uint8Chunks, sampleRate = 24000) {
    if (!Array.isArray(uint8Chunks) || uint8Chunks.length === 0) return null;
    let totalBytes = 0;
    for (const c of uint8Chunks) totalBytes += c.byteLength;
    const sampleCount = Math.floor(totalBytes / 2);
    if (sampleCount <= 0) return null;

    const ctx = await this.ensureContext();
    const merged = new Uint8Array(sampleCount * 2);
    let offset = 0;
    for (const c of uint8Chunks) {
      const copyLen = Math.min(c.byteLength, merged.byteLength - offset);
      if (copyLen > 0) {
        merged.set(c.subarray(0, copyLen), offset);
        offset += copyLen;
      }
    }

    const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
    const audioBuffer = ctx.createBuffer(1, sampleCount, sampleRate);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      channel[i] = view.getInt16(i * 2, true) / 32768;
    }
    return audioBuffer;
  }

  cacheAudioBuffer(cacheKey, audioBuffer) {
    if (!cacheKey || !audioBuffer) return;
    this.ttsCache.set(cacheKey, audioBuffer);
    if (this.ttsCache.size > 40) {
      const oldestKey = this.ttsCache.keys().next().value;
      this.ttsCache.delete(oldestKey);
    }
  }

  /**
   * Optional real-time gapless playback for Gemini Live 24kHz PCM chunks (echo-guarded).
   */
  async enqueueLiveAudioChunk(uint8Bytes, sampleRate = 24000) {
    if (!uint8Bytes || uint8Bytes.byteLength < 2) return;
    const ctx = await this.ensureContext();
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
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch (_) {}
      this.currentSource = null;
    }
    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch (_) {}
    }
    this.muted = false;
    if (this.playingId !== null) {
      this.playingId = null;
      if (this.onPlaybackChange) this.onPlaybackChange(null);
    }
  }
}
