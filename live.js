/**
 * live.js — Direct browser WebSocket client for Gemini Live API (v1beta BidiGenerateContent)
 * Supports gemini-3.8-live and gemini-3.1-flash-live-preview for ultra-low-latency
 * real-time simultaneous speech translation with native input/output transcription
 * and 24kHz PCM audio caching.
 */

import { TARGET_LANGUAGES, TONE_PRESETS, formatGlossaryLine } from './gemini.js?v=3.2';
import { uint8ToBase64, base64ToUint8 } from './audio.js?v=3.2';

const LIVE_WS_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export function buildLiveSystemInstruction(targetLang = 'en', tone = 'natural', glossary = '') {
  const langInfo = TARGET_LANGUAGES[targetLang] || TARGET_LANGUAGES.en;
  const toneDesc = TONE_PRESETS[tone] || TONE_PRESETS.natural;
  const glossaryLine = formatGlossaryLine(glossary);

  return [
    `你是即時同步口譯員，只做雙向翻譯，絕不聊天、不回答問題、不加前言。`,
    `- 聽到非中文（英／日／瑞典等）：直接翻成自然繁體中文（台灣用語）。`,
    `- 聽到中文：直接翻成自然道地的${langInfo.label}（${langInfo.nativeName}），語氣：${toneDesc}。`,
    glossaryLine ? `- ${glossaryLine}` : '',
    `- 若只有雜音或無語音，保持靜默。`,
  ]
    .filter(Boolean)
    .join('\n');
}

export class GeminiLiveClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.setupDone = false;
    this.intentionalClose = false;
    this.model = 'gemini-3.8-live';
    this.resumptionHandle = '';

    // Current in-flight turn accumulators
    this.turnInputText = '';
    this.turnOutputText = '';
    this.turnAudioChunks = []; // Uint8Array[] of 24kHz 16-bit LE PCM
    this.turnSampleRate = 24000;
    this.lastActivityTs = 0;

    // Callbacks
    this.onStateChange = null; // (state: 'connecting'|'ready'|'closed'|'error', detail?: string)
    this.onPartialUpdate = null; // ({ inputText, outputText })
    this.onAudioChunk = null; // (uint8Bytes, sampleRate) — for optional real-time playback
    this.onTurnComplete = null; // ({ inputText, outputText, pcmChunks, sampleRate })
    this.onGoAway = null; // (timeLeft)
  }

  connect({
    apiKey,
    model = 'gemini-3.8-live',
    targetLang = 'en',
    tone = 'natural',
    glossary = '',
    voiceName = 'Kore',
    resume = false,
  }) {
    const handleToUse = resume ? this.resumptionHandle : '';
    this.disconnect(!resume);

    if (!apiKey || !apiKey.trim()) {
      return Promise.reject(new Error('尚未設定 Gemini API Key'));
    }

    this.intentionalClose = false;
    this.model = model || 'gemini-3.8-live';
    this._resetTurnState();

    const wsUrl = `${LIVE_WS_ENDPOINT}?key=${encodeURIComponent(apiKey.trim())}`;
    this._emitState('connecting');

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      const succeed = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const timeoutId = setTimeout(() => {
        if (!this.setupDone) {
          this.disconnect(true);
          fail(new Error('Live 串流連線逾時，請檢查網路或切換備用 Live 模型'));
        }
      }, 12000);

      let ws;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        clearTimeout(timeoutId);
        this._emitState('error', err.message);
        fail(err);
        return;
      }

      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        this.lastActivityTs = Date.now();
        const modelResource = this.model.startsWith('models/') ? this.model : `models/${this.model}`;

        // Verified v1beta BidiGenerateContentSetup payload for native-audio Live models:
        // - responseModalities: ["AUDIO"] (required by native-audio models)
        // - inputAudioTranscription & outputAudioTranscription for live text captions
        // - contextWindowCompression + sessionResumption for uninterrupted >10m sessions
        // - Omit thinkingConfig / proactiveAudio / enableAffectiveDialog for gemini-3.8-live compatibility
        const setupPayload = {
          setup: {
            model: modelResource,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: voiceName || 'Kore',
                  },
                },
              },
            },
            systemInstruction: {
              parts: [{ text: buildLiveSystemInstruction(targetLang, tone, glossary) }],
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            contextWindowCompression: {
              slidingWindow: {},
            },
            sessionResumption: handleToUse ? { handle: handleToUse } : {},
          },
        };

        try {
          ws.send(JSON.stringify(setupPayload));
        } catch (err) {
          clearTimeout(timeoutId);
          fail(err);
        }
      };

      ws.onmessage = async (event) => {
        try {
          const text =
            typeof event.data === 'string'
              ? event.data
              : event.data instanceof Blob
                ? await event.data.text()
                : new TextDecoder().decode(event.data);
          if (!text) return;
          const msg = JSON.parse(text);
          this._handleServerMessage(msg, () => {
            clearTimeout(timeoutId);
            succeed();
          });
        } catch (err) {
          console.error('Live message parse error:', err);
        }
      };

      ws.onerror = () => {
        clearTimeout(timeoutId);
        if (!this.setupDone) {
          this._emitState('error', '無法建立 Live WebSocket 連線');
          fail(new Error('無法建立 Live WebSocket 連線，請確認 API Key 與網路狀態'));
        }
      };

      ws.onclose = (event) => {
        clearTimeout(timeoutId);
        const wasSetup = this.setupDone;
        this.connected = false;
        this.setupDone = false;
        this.ws = null;

        if (!this.intentionalClose) {
          const reason = event.reason ? ` (${event.code}: ${event.reason})` : ` (code ${event.code})`;
          if (!wasSetup) {
            const errMsg =
              event.code === 1008
                ? `模型 ${this.model} 目前無權限或暫不可用${reason}，請在設定切換備用 Live 模型`
                : `Live 連線中斷${reason}`;
            this._emitState('error', errMsg);
            fail(new Error(errMsg));
          } else {
            this._emitState('closed', reason);
          }
        } else {
          this._emitState('closed');
        }
      };
    });
  }

  disconnect(clearResumption = true) {
    this.intentionalClose = true;
    this.connected = false;
    this.setupDone = false;
    if (clearResumption) {
      this.resumptionHandle = '';
    }
    this._resetTurnState();
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, 'Client disconnect');
        }
      } catch (_) {}
      this.ws = null;
    }
  }

  isReady() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN && this.setupDone);
  }

  /**
   * Stream raw 16kHz 16-bit little-endian mono PCM chunk.
   */
  sendAudioPcm16k(int16Array) {
    if (!this.isReady() || !int16Array || int16Array.length === 0) return;
    const bytes = new Uint8Array(int16Array.buffer, int16Array.byteOffset, int16Array.byteLength);
    const base64 = uint8ToBase64(bytes);
    try {
      this.ws.send(
        JSON.stringify({
          realtimeInput: {
            audio: {
              mimeType: 'audio/pcm;rate=16000',
              data: base64,
            },
          },
        })
      );
    } catch (_) {}
  }

  /**
   * Signal an audio pause so server flushes the current utterance immediately.
   */
  flushAudioStream() {
    if (!this.isReady()) return false;
    try {
      this.ws.send(
        JSON.stringify({
          realtimeInput: {
            audioStreamEnd: true,
          },
        })
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  sendRealtimeText(text) {
    if (!this.isReady() || !text) return false;
    this.lastActivityTs = Date.now();
    try {
      this.ws.send(
        JSON.stringify({
          realtimeInput: {
            text: String(text),
          },
        })
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  _resetTurnState() {
    this.turnInputText = '';
    this.turnOutputText = '';
    this.turnAudioChunks = [];
    this.turnSampleRate = 24000;
  }

  _emitState(state, detail = '') {
    if (this.onStateChange) {
      this.onStateChange(state, detail);
    }
  }

  _handleServerMessage(msg, onSetupComplete) {
    if (msg.setupComplete) {
      this.setupDone = true;
      this._emitState('ready');
      if (onSetupComplete) onSetupComplete();
      return;
    }

    if (msg.sessionResumptionUpdate && msg.sessionResumptionUpdate.newHandle) {
      this.resumptionHandle = msg.sessionResumptionUpdate.newHandle;
    }

    if (msg.goAway) {
      if (this.onGoAway) {
        this.onGoAway(msg.goAway.timeLeft || '');
      }
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    let updatedText = false;

    if (sc.inputTranscription && typeof sc.inputTranscription.text === 'string') {
      this.turnInputText += sc.inputTranscription.text;
      this.lastActivityTs = Date.now();
      updatedText = true;
    }

    if (sc.outputTranscription && typeof sc.outputTranscription.text === 'string') {
      this.turnOutputText += sc.outputTranscription.text;
      this.lastActivityTs = Date.now();
      updatedText = true;
    }

    // Process ALL parts in modelTurn (Gemini 3.8 Live may pack multiple parts per event)
    const parts = sc.modelTurn?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (!part) continue;
        if (part.inlineData && part.inlineData.data) {
          const mime = part.inlineData.mimeType || '';
          const rateMatch = /rate=(\d+)/i.exec(mime);
          if (rateMatch) this.turnSampleRate = parseInt(rateMatch[1], 10) || 24000;
          const bytes = base64ToUint8(part.inlineData.data);
          this.turnAudioChunks.push(bytes);
          this.lastActivityTs = Date.now();
          if (this.onAudioChunk) {
            this.onAudioChunk(bytes, this.turnSampleRate);
          }
        } else if (typeof part.text === 'string' && !part.thought && !sc.outputTranscription) {
          // Fallback if server emits direct text without outputTranscription
          this.turnOutputText += part.text;
          this.lastActivityTs = Date.now();
          updatedText = true;
        }
      }
    }

    if (updatedText && this.onPartialUpdate) {
      this.onPartialUpdate({
        inputText: this.turnInputText.trim(),
        outputText: this.turnOutputText.trim(),
      });
    }

    if (sc.interrupted) {
      // Finalize whatever we already received if substantial, otherwise clear partial
      if (this.turnOutputText.trim() && this.onTurnComplete) {
        this.onTurnComplete({
          inputText: this.turnInputText.trim(),
          outputText: this.turnOutputText.trim(),
          pcmChunks: this.turnAudioChunks.slice(),
          sampleRate: this.turnSampleRate,
          interrupted: true,
        });
      }
      this._resetTurnState();
      return;
    }

    if (sc.turnComplete) {
      const inputText = this.turnInputText.trim();
      const outputText = this.turnOutputText.trim();
      const pcmChunks = this.turnAudioChunks.slice();
      const sampleRate = this.turnSampleRate;
      this._resetTurnState();

      if ((inputText || outputText) && this.onTurnComplete) {
        this.onTurnComplete({
          inputText,
          outputText,
          pcmChunks,
          sampleRate,
          interrupted: false,
        });
      }
    }
  }
}
