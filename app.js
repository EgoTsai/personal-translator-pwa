/**
 * app.js — Main UI controller for 隨身口譯官 PWA
 */

import { AudioEngine } from './audio.js?v=3.2';
import {
  TARGET_LANGUAGES,
  ICEBREAKER_BANNERS,
  interpretDialogueAudio,
  interpretBroadcastAudio,
  polishBroadcastText,
  translateOutboundChinese,
  translateImageWithGemini,
  synthesizeGeminiSpeech,
  testApiKey,
} from './gemini.js?v=3.2';
import { GeminiLiveClient } from './live.js?v=3.2';

const STORAGE_KEYS = {
  settings: 'pt_settings_v1',
  messages: 'pt_messages_v1',
  speakers: 'pt_speakers_v1',
  broadcast: 'pt_broadcast_v1',
  phraseCache: 'pt_phrase_cache_v1',
};

const DEFAULT_SETTINGS = {
  settingsVersion: 3,
  apiKey: '',
  model: 'gemini-3.5-flash-lite',
  liveModel: 'gemini-3.8-live',
  ttsModel: 'gemini-3.8-flash-lite-tts',
  voiceName: 'Kore',
  tone: 'natural',
  glossary: '',
  silenceMs: 750,
  vadThreshold: 0.018,
  showOriginal: true,
  draftCaption: true,
  liveAutoSpeak: false,
  useLiveInDialogue: false,
  turboMode: false,
  broadcastFontSize: 'md',
  targetLang: 'en',
  autoTts: false,
  theme: 'light',
};

const LANG_BADGE_MAP = {
  en: '英',
  ja: '日',
  sv: '瑞典',
  zh: '中文',
  ko: '韓',
  fr: '法',
  de: '德',
  es: '西',
};

const TONE_META = {
  natural: { short: '日常', toast: '語氣：日常自然' },
  polite: { short: '禮貌', toast: '語氣：禮貌敬語（日文用丁寧語）' },
  casual: { short: '口語', toast: '語氣：輕鬆口語（朋友聊天）' },
};
const TONE_ORDER = ['natural', 'polite', 'casual'];

const BC_FONT_ORDER = ['sm', 'md', 'lg'];
const BC_FONT_LABEL = { sm: '字級 小', md: '字級 中', lg: '字級 大' };

// State + seamless settings migration across versions
const storedSettings = loadJson(STORAGE_KEYS.settings, null);
let settings = { ...DEFAULT_SETTINGS, ...(storedSettings || {}) };
if (storedSettings && Number(storedSettings.settingsVersion || 0) < 3) {
  const legacySilenceMap = { 650: 600, 850: 750, 1300: 1100, 1800: 1600 };
  const curSil = Number(storedSettings.silenceMs);
  if (legacySilenceMap[curSil]) {
    settings.silenceMs = legacySilenceMap[curSil];
  }
  settings.settingsVersion = 3;
  try {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  } catch (_) {}
}

let messages = loadJson(STORAGE_KEYS.messages, []);
let speakerMemory = loadJson(STORAGE_KEYS.speakers, {}); // { A: { voiceHint, customName } }
let broadcastParagraphs = loadJson(STORAGE_KEYS.broadcast, []); // [{ id, time, segments: [{ id, text, revised, settled, needsPolish }] }]

// Scenario & view state:
// - activeMode: null | 'dialogue' | 'broadcast' (whether mic is actively listening)
// - viewMode: 'dialogue' | 'broadcast' (stays in full-screen Chinese reader even when broadcast is paused!)
let activeMode = null;
let viewMode = 'dialogue';
let isLiveActive = false; // Optional Gemini Live WebSocket (only inside 'dialogue' when enabled in Settings)
let liveConnected = false;
let liveConnecting = false;
let liveStartTs = 0;
let liveTimerHandle = null;
let liveIdleHandle = null;
let liveInboundCount = 0;
let sessionEpoch = 0; // Monotonic guard against rapid toggle race conditions
let feedEpoch = 0; // Monotonic guard so cleared chats don't receive stale in-flight cards
let bcEpoch = 0; // Monotonic guard so cleared broadcast canvas ignores stale jobs/polish
let bcStreamText = '';
let bcPolishBusy = false;
let bcHintTimer = null;
let bcDemoTimer = null;
let isManualRecording = false;
let manualTimerHandle = null;
let manualStartTime = 0;
let isOnline = typeof navigator !== 'undefined' && 'onLine' in navigator ? navigator.onLine : true;

// Turbo ≤ 2x hard quota rate guardrail (sliding 60s window: max 12 dialogue / 14 broadcast auto-segments/min)
function getTurboMinuteLimit(mode) {
  return mode === 'broadcast' ? 14 : 12;
}
const turboAutoEmitTimestamps = [];
let turboThrottled = false;
let turboCooldownTimer = null;

/**
 * Pure scenario × Turbo parameter profile balancing Quota (strictly ≤ 2x) vs Speed/Efficiency.
 * Broadcast outputs Chinese-only (~50% fewer output tokens & 2x faster TTFT) + single-pass retroactive smoothing!
 */
export function getAudioProfile(mode, turbo, baseSilenceMs = 750, throttled = false) {
  const effectiveTurbo = Boolean(turbo && !throttled);
  const safeBaseSilence = Number(baseSilenceMs) || 750;

  if (mode === 'broadcast') {
    return effectiveTurbo
      ? {
          mode: 'broadcast',
          minBatchMs: 3200,
          interSentencePauseMs: 260,
          silenceMs: 900,
          maxChunkMs: 7500,
          uploadSampleRate: 10000,
          maxConcurrency: 2,
          contextLimit: 2,
        }
      : {
          mode: 'broadcast',
          minBatchMs: 5500,
          interSentencePauseMs: 360,
          silenceMs: 1400,
          maxChunkMs: 12500,
          uploadSampleRate: 12000,
          maxConcurrency: 1,
          contextLimit: 3,
        };
  }

  // Scenario 1: 'dialogue' (bidirectional automatic conversation)
  return effectiveTurbo
    ? {
        mode: 'dialogue',
        minBatchMs: 0,
        interSentencePauseMs: 300,
        silenceMs: Math.min(480, Math.max(400, Math.round(safeBaseSilence * 0.64))),
        maxChunkMs: 7500,
        uploadSampleRate: 10000,
        maxConcurrency: 2,
        contextLimit: 2,
      }
    : {
        mode: 'dialogue',
        minBatchMs: 0,
        interSentencePauseMs: 400,
        silenceMs: safeBaseSilence,
        maxChunkMs: 12000,
        uploadSampleRate: 12000,
        maxConcurrency: 1,
        contextLimit: 4,
      };
}

// TTS concurrency guard (prevents rapid 🔊 clicks from playing out of order)
let speakRequestSeq = 0;
let activeSpeakAbort = null;

// Ordered parallel pipeline for VAD segments (concurrency 1 in Standard, concurrency 2 in Turbo; FIFO commit order)
const vadPendingJobs = [];
const vadCommitQueue = [];
let vadInFlight = 0;
let vadJobSeq = 0;
let pendingCount = 0;
let broadcastPendingCount = 0;
let activeShowcardMsg = null;
let wakeLockSentinel = null;

// Free browser live draft caption (SpeechRecognition — used ONLY in Dialogue / Manual mode, suppressed in Broadcast!)
let draftRecognition = null;
let draftRecognitionActive = false;
let draftRecognitionDisabled = false;
let currentDraftText = '';

// Active live streaming preview data (rendered in-place without rebuilding feed)
let activeStreamState = null;

const audio = new AudioEngine();
const liveClient = new GeminiLiveClient();

// Subtle mobile haptic feedback (safe no-op on unsupported devices)
function haptic(pattern = 12) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch (_) {}
}

// Keep screen awake while listening, recording, or displaying face-to-face Showcard
async function syncWakeLock() {
  if (!('wakeLock' in navigator)) return;
  const shouldLock = Boolean(activeMode) || isManualRecording || Boolean(activeShowcardMsg);
  if (shouldLock && !wakeLockSentinel && document.visibilityState === 'visible') {
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => {
        wakeLockSentinel = null;
      });
    } catch (_) {
      wakeLockSentinel = null;
    }
  } else if (!shouldLock && wakeLockSentinel) {
    try {
      await wakeLockSentinel.release();
    } catch (_) {}
    wakeLockSentinel = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    syncWakeLock();
    syncViewportMetrics();
    setTimeout(syncViewportMetrics, 120);
  }
});

// DOM references
const $ = (id) => document.getElementById(id);

const els = {
  appShell: $('appShell'),
  topHeader: $('topHeader'),
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  turboBtn: $('turboBtn'),
  toneQuickBtn: $('toneQuickBtn'),
  themeBtn: $('themeBtn'),
  exportBtn: $('exportBtn'),
  clearBtn: $('clearBtn'),
  settingsBtn: $('settingsBtn'),
  langBar: $('langBar'),
  dialogueSwitch: $('dialogueSwitch'),
  dialogueSub: $('dialogueSub'),
  broadcastSwitch: $('broadcastSwitch'),
  broadcastSub: $('broadcastSub'),
  listenStripCollapse: $('listenStripCollapse'),
  listenStrip: $('listenStrip'),
  liveTimerPill: $('liveTimerPill'),
  waveBars: $('waveBars'),
  vadStatus: $('vadStatus'),
  flushBtn: $('flushBtn'),
  setupBanner: $('setupBanner'),
  bannerSetupBtn: $('bannerSetupBtn'),
  bannerDemoBtn: $('bannerDemoBtn'),
  transcriptFeed: $('transcriptFeed'),
  emptyState: $('emptyState'),
  emptyDemoBtn: $('emptyDemoBtn'),

  broadcastView: $('broadcastView'),
  broadcastHint: $('broadcastHint'),
  bcFontBtn: $('bcFontBtn'),
  bcPolishBtn: $('bcPolishBtn'),
  bcCopyBtn: $('bcCopyBtn'),
  bcClearBtn: $('bcClearBtn'),
  broadcastCanvas: $('broadcastCanvas'),
  broadcastEmpty: $('broadcastEmpty'),
  bcDemoBtn: $('bcDemoBtn'),
  broadcastPausedBar: $('broadcastPausedBar'),
  bcResumeBtn: $('bcResumeBtn'),
  bcBackToChatBtn: $('bcBackToChatBtn'),

  quickTextRow: $('quickTextRow'),
  quickChineseInput: $('quickChineseInput'),
  quickSendBtn: $('quickSendBtn'),
  keyboardToggleBtn: $('keyboardToggleBtn'),
  speakChineseBtn: $('speakChineseBtn'),
  speakBtnLabel: $('speakBtnLabel'),
  cameraBtn: $('cameraBtn'),
  cameraInput: $('cameraInput'),
  cancelRecBtn: $('cancelRecBtn'),

  settingsSheet: $('settingsSheet'),
  closeSettingsBtn: $('closeSettingsBtn'),
  apiKeyInput: $('apiKeyInput'),
  toggleKeyVisibility: $('toggleKeyVisibility'),
  testKeyBtn: $('testKeyBtn'),
  testResult: $('testResult'),
  modelSelect: $('modelSelect'),
  useLiveInDialogueCheck: $('useLiveInDialogueCheck'),
  liveModelSelect: $('liveModelSelect'),
  ttsModelSelect: $('ttsModelSelect'),
  voiceSelect: $('voiceSelect'),
  testVoiceBtn: $('testVoiceBtn'),
  toneSelect: $('toneSelect'),
  glossaryInput: $('glossaryInput'),
  silenceSelect: $('silenceSelect'),
  vadThresholdSelect: $('vadThresholdSelect'),
  draftCaptionCheck: $('draftCaptionCheck'),
  liveAutoSpeakCheck: $('liveAutoSpeakCheck'),
  showOriginalCheck: $('showOriginalCheck'),
  saveSettingsBtn: $('saveSettingsBtn'),

  showcardOverlay: $('showcardOverlay'),
  flipShowcardBtn: $('flipShowcardBtn'),
  closeShowcardBtn: $('closeShowcardBtn'),
  showcardContent: $('showcardContent'),
  showcardBanner: $('showcardBanner'),
  showcardMain: $('showcardMain'),
  showcardReading: $('showcardReading'),
  showcardSub: $('showcardSub'),
  speakShowcardBtn: $('speakShowcardBtn'),

  toast: $('toast'),
};

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function saveState() {
  // Always persist settings (API Key!) first in an isolated try/catch so storage quota on photos never loses settings
  try {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
    localStorage.setItem(STORAGE_KEYS.speakers, JSON.stringify(speakerMemory));
    localStorage.setItem(STORAGE_KEYS.broadcast, JSON.stringify(broadcastParagraphs.slice(-60)));
  } catch (_) {}

  // Keep at most 120 messages and strip thumbnails from older photo cards to stay safely under storage quota
  const recent = messages.slice(-120);
  const buildPruned = (maxThumbs, limit) => {
    const slice = recent.slice(-limit);
    let keptThumbs = 0;
    const out = [];
    for (let i = slice.length - 1; i >= 0; i--) {
      const m = slice[i];
      if (m.type === 'photo' && m.thumbUrl) {
        keptThumbs += 1;
        out.unshift(keptThumbs <= maxThumbs ? m : { ...m, thumbUrl: '' });
      } else {
        out.unshift(m);
      }
    }
    return out;
  };

  try {
    localStorage.setItem(STORAGE_KEYS.messages, JSON.stringify(buildPruned(6, 120)));
  } catch (_) {
    try {
      localStorage.setItem(STORAGE_KEYS.messages, JSON.stringify(buildPruned(0, 60)));
    } catch (_) {}
  }
}

// Zero-risk exact-match LRU Phrase Cache (max 200 entries, typed text input only, auto-learned solely from verified Gemini outputs)
const PHRASE_CACHE_MAX = 200;
const phraseCacheMap = new Map();
{
  const savedEntries = loadJson(STORAGE_KEYS.phraseCache, []);
  if (Array.isArray(savedEntries)) {
    for (const entry of savedEntries.slice(-PHRASE_CACHE_MAX)) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && typeof entry[1] === 'object') {
        phraseCacheMap.set(entry[0], entry[1]);
      }
    }
  }
}

function buildPhraseCacheKey(text, targetLang, tone, glossary = '') {
  const normText = String(text || '').trim().replace(/\s+/g, ' ');
  if (!normText || normText.length > 160) return '';
  const normGlossary = String(glossary || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return `${targetLang || 'en'}|${tone || 'natural'}|${normGlossary}|${normText}`;
}

function persistPhraseCache() {
  try {
    localStorage.setItem(STORAGE_KEYS.phraseCache, JSON.stringify(Array.from(phraseCacheMap.entries())));
  } catch (_) {}
}

export function lookupPhraseCache(text, targetLang, tone, glossary = '') {
  const key = buildPhraseCacheKey(text, targetLang, tone, glossary);
  if (!key || !phraseCacheMap.has(key)) return null;
  const hit = phraseCacheMap.get(key);
  // Refresh LRU recency
  phraseCacheMap.delete(key);
  phraseCacheMap.set(key, hit);
  return { ...hit };
}

export function storePhraseCache(text, targetLang, tone, glossary, result) {
  if (!result || !result.translated) return false;
  const key = buildPhraseCacheKey(text, targetLang, tone, glossary);
  if (!key) return false;
  const record = {
    sourceLang: result.sourceLang,
    targetLang: result.targetLang,
    isSourceChinese: Boolean(result.isSourceChinese),
    sourceText: result.sourceText || String(text || '').trim(),
    zh: result.zh,
    translated: result.translated,
    reading: result.reading || '',
  };
  if (phraseCacheMap.has(key)) {
    phraseCacheMap.delete(key);
  }
  phraseCacheMap.set(key, record);
  while (phraseCacheMap.size > PHRASE_CACHE_MAX) {
    const oldestKey = phraseCacheMap.keys().next().value;
    phraseCacheMap.delete(oldestKey);
  }
  persistPhraseCache();
  return true;
}

function isOpusAudioFormatError(err) {
  const msg = String(err?.message || '');
  return /\(400\)/.test(msg) && /audio|mime|ogg|opus|unsupported|invalid argument|unable to process/i.test(msg);
}

/**
 * Transparently retry with WAV if Gemini API ever rejects an `audio/ogg` Opus payload (HTTP 400).
 */
async function callWithOpusFallback(wav, invokeWithAudio) {
  try {
    return await invokeWithAudio(wav);
  } catch (err) {
    if (wav && wav.mimeType === 'audio/ogg' && typeof wav.fallbackWav === 'function' && isOpusAudioFormatError(err)) {
      console.warn('audio/ogg rejected by API, switching cleanly to WAV fallback:', err?.message || err);
      audio.disableOpusCompression();
      const fallback = wav.fallbackWav();
      if (fallback) {
        return await invokeWithAudio(fallback);
      }
    }
    throw err;
  }
}

let toastTimer = null;
function showToast(msg, duration = 2600, action = null) {
  els.toast.textContent = '';
  const textSpan = document.createElement('span');
  textSpan.textContent = msg;
  els.toast.appendChild(textSpan);

  if (action && action.label && typeof action.onClick === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-undo-btn';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      clearTimeout(toastTimer);
      els.toast.classList.remove('show', 'has-action');
      action.onClick();
    });
    els.toast.appendChild(btn);
    els.toast.classList.add('has-action');
  } else {
    els.toast.classList.remove('has-action');
  }

  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show', 'has-action');
  }, duration);
}

function nowTimeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function makeId() {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// Theme & Appearance
function applyBroadcastFont() {
  const size = BC_FONT_ORDER.includes(settings.broadcastFontSize) ? settings.broadcastFontSize : 'md';
  if (els.broadcastCanvas) {
    els.broadcastCanvas.classList.remove('bc-font-sm', 'bc-font-md', 'bc-font-lg');
    els.broadcastCanvas.classList.add(`bc-font-${size}`);
  }
  if (els.bcFontBtn) {
    els.bcFontBtn.textContent = BC_FONT_LABEL[size] || '字級 中';
  }
}

function applyTheme() {
  if (settings.theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  if (settings.showOriginal) {
    els.transcriptFeed.classList.remove('hide-originals');
  } else {
    els.transcriptFeed.classList.add('hide-originals');
  }
  applyBroadcastFont();
}

function syncClearButtonsState() {
  const isBcView = viewMode === 'broadcast';
  const hasDialogue = messages.length > 0 || Boolean(activeStreamState) || Boolean(currentDraftText);
  const hasBroadcast = broadcastParagraphs.length > 0 || Boolean(bcStreamText);

  if (els.clearBtn) {
    const isEmpty = isBcView ? !hasBroadcast : !hasDialogue;
    els.clearBtn.classList.toggle('empty', isEmpty);
    const title = isBcView ? '一鍵清除聆聽譯文，從頭開始' : '一鍵清除對話內容，從頭開始';
    els.clearBtn.title = title;
    els.clearBtn.setAttribute('aria-label', title);
  }
  if (els.bcClearBtn) {
    els.bcClearBtn.classList.toggle('empty', !hasBroadcast);
  }
}

function syncViewportMetrics() {
  if (typeof window === 'undefined') return;
  if ((window.scrollY || 0) !== 0 || (window.scrollX || 0) !== 0) {
    if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
  }
  if (document.documentElement && document.documentElement.scrollTop) {
    document.documentElement.scrollTop = 0;
  }
  if (document.body && document.body.scrollTop) {
    document.body.scrollTop = 0;
  }
  const vv = window.visualViewport;
  const innerH = Number(window.innerHeight) || 0;
  const vvH = vv && Number(vv.height) > 0 ? Number(vv.height) : innerH;
  const targetH = innerH > 0 && vvH > 0 ? Math.min(vvH, innerH) : vvH || innerH;
  const topOffset = vv && Number(vv.offsetTop) > 0 ? Math.round(vv.offsetTop) : 0;
  const rootStyle = document.documentElement && document.documentElement.style;
  if (rootStyle && typeof rootStyle.setProperty === 'function') {
    if (targetH > 200) {
      rootStyle.setProperty('--app-height', `${Math.round(targetH)}px`);
    }
    rootStyle.setProperty('--app-top', `${topOffset}px`);
  }
}

function syncHeaderScrollElevation() {
  if (!els.topHeader) return;
  const activeScroller = viewMode === 'broadcast' ? els.broadcastCanvas : els.transcriptFeed;
  const scrolled = Boolean(activeScroller && Number(activeScroller.scrollTop) > 6);
  els.topHeader.classList.toggle('scrolled', scrolled);
}

function syncViewModeUI() {
  const isBcView = viewMode === 'broadcast';
  if (els.appShell) {
    els.appShell.classList.toggle('broadcast-immersive', isBcView);
  }
  if (els.transcriptFeed && typeof els.transcriptFeed.setAttribute === 'function') {
    els.transcriptFeed.setAttribute('aria-hidden', String(isBcView));
  }
  if (els.broadcastView && typeof els.broadcastView.setAttribute === 'function') {
    els.broadcastView.setAttribute('aria-hidden', String(!isBcView));
  }
  if (els.broadcastPausedBar) {
    els.broadcastPausedBar.classList.toggle('visible', isBcView && activeMode !== 'broadcast');
  }
  syncClearButtonsState();
  syncHeaderScrollElevation();
  syncViewportMetrics();
}

function updateHeaderStatus() {
  els.statusDot.className = 'status-dot';
  if (!isOnline) {
    els.statusDot.classList.add('offline');
    els.statusText.textContent = '離線中・等待網路恢復';
    return;
  }
  if (audio.playingId) {
    els.statusDot.classList.add('speaking');
    els.statusText.textContent = 'AI 真人朗讀中⋯';
    return;
  }
  if (isManualRecording) {
    els.statusDot.classList.add('listening');
    els.statusText.textContent = '正在收錄語音⋯';
    return;
  }
  if (activeMode === 'dialogue' && isLiveActive) {
    if (liveConnecting) {
      els.statusDot.classList.add('processing');
      els.statusText.textContent = '⚡ Live 串流連線中⋯';
    } else if (liveConnected) {
      els.statusDot.classList.add('live-ws');
      els.statusText.textContent = '⚡ Live 雙向對話・螢幕恆亮';
    } else {
      els.statusDot.classList.add('processing');
      els.statusText.textContent = '⚡ Live 準備中⋯';
    }
    return;
  }
  if (bcPolishBusy) {
    els.statusDot.classList.add('processing');
    els.statusText.textContent = '✨ 正在回頭潤飾中文語意⋯';
    return;
  }
  const totalPending = pendingCount + broadcastPendingCount;
  if (totalPending > 0) {
    els.statusDot.classList.add('processing');
    if (settings.turboMode && !turboThrottled) {
      els.statusText.textContent =
        totalPending > 1 ? `⚡ Turbo 並行快翻 (${totalPending})⋯` : '⚡ Turbo 極速翻譯中⋯';
    } else {
      els.statusText.textContent = `Gemini 串流翻譯中 (${totalPending})⋯`;
    }
    return;
  }
  if (activeMode === 'dialogue') {
    els.statusDot.classList.add('dialogue');
    els.statusText.textContent = settings.turboMode
      ? turboThrottled
        ? '💬 對話中・2x額度保護'
        : '⚡ 對話極速中・螢幕恆亮'
      : '💬 自動對話中・螢幕恆亮';
    return;
  }
  if (activeMode === 'broadcast') {
    els.statusDot.classList.add('listening');
    els.statusText.textContent = settings.turboMode
      ? turboThrottled
        ? '📻 純中文連翻・2x保護'
        : '⚡ 純中文極速連翻・螢幕恆亮'
      : '📻 純中文連翻中・螢幕恆亮';
    return;
  }
  els.statusDot.classList.add('ready');
  if (!settings.apiKey) {
    els.statusText.textContent = '尚未設定 API Key';
  } else if (viewMode === 'broadcast') {
    els.statusText.textContent = '聆聽翻譯已暫停・純中文閱讀';
  } else {
    els.statusText.textContent = settings.turboMode ? '待命中・⚡ Turbo (≤2x)' : '待命中・標準省額度';
  }
}

function updateSwitchUI() {
  const langInfo = TARGET_LANGUAGES[settings.targetLang] || TARGET_LANGUAGES.en;
  const shortTarget = LANG_BADGE_MAP[langInfo.code] || langInfo.label;

  // Top-right Turbo Button (strictly ≤ 2x quota budget)
  if (els.turboBtn) {
    const isOn = Boolean(settings.turboMode);
    els.turboBtn.classList.toggle('on', isOn);
    els.turboBtn.classList.toggle('throttled', isOn && turboThrottled);
    els.turboBtn.setAttribute('aria-checked', String(isOn));
    els.turboBtn.textContent = isOn && turboThrottled ? '⚡ 2x限速' : '⚡ Turbo';
  }

  // Scenario 1: 對話 (Bidirectional Auto-Listening)
  const isDialogueOn = activeMode === 'dialogue';
  if (els.dialogueSwitch) {
    els.dialogueSwitch.classList.toggle('dialogue-on', isDialogueOn && !isLiveActive);
    els.dialogueSwitch.classList.toggle('live-on', isDialogueOn && isLiveActive);
    els.dialogueSwitch.setAttribute('aria-checked', String(isDialogueOn));
  }
  if (els.dialogueSub) {
    if (isDialogueOn && isLiveActive) {
      els.dialogueSub.textContent = liveConnecting ? 'Live 連線中⋯' : 'Live 雙向串流中';
    } else if (isDialogueOn) {
      els.dialogueSub.textContent =
        settings.turboMode && !turboThrottled
          ? `⚡ 並行極速（中↔${shortTarget}）`
          : `中 ↔ ${shortTarget} 雙向聆聽中`;
    } else if (settings.useLiveInDialogue) {
      els.dialogueSub.textContent = `中 ↔ ${shortTarget}（Live）`;
    } else {
      els.dialogueSub.textContent = `中 ↔ ${shortTarget} 自動互譯`;
    }
  }

  // Scenario 2: 聆聽翻譯 (Full-Screen Pure Chinese + Retroactive Semantic Refinement)
  const isBroadcastOn = activeMode === 'broadcast';
  if (els.broadcastSwitch) {
    els.broadcastSwitch.classList.toggle('broadcast-on', isBroadcastOn);
    els.broadcastSwitch.setAttribute('aria-checked', String(isBroadcastOn));
  }
  if (els.broadcastSub) {
    if (isBroadcastOn) {
      els.broadcastSub.textContent =
        settings.turboMode && !turboThrottled ? '⚡ 純中文極速・自動潤飾' : '純中文連翻中・自動潤飾';
    } else {
      els.broadcastSub.textContent = settings.turboMode ? '⚡ 1句快翻・自動潤飾' : '純中文連翻・自動潤飾';
    }
  }

  // Live Meter / Listening Strip (smooth CSS-Grid reveal/collapse)
  const isListeningStripVisible = Boolean(activeMode);
  els.listenStrip.classList.toggle('visible', isListeningStripVisible);
  if (els.listenStripCollapse) {
    els.listenStripCollapse.classList.toggle('visible', isListeningStripVisible);
  }
  els.listenStrip.classList.toggle('dialogue-mode', isDialogueOn && !isLiveActive);
  els.listenStrip.classList.toggle('broadcast-mode', isBroadcastOn);
  els.listenStrip.classList.toggle('live-mode', isDialogueOn && isLiveActive);
  if (els.liveTimerPill) {
    els.liveTimerPill.classList.toggle('hidden', !(isDialogueOn && isLiveActive && liveConnected));
  }
  if (els.flushBtn) {
    els.flushBtn.textContent = isLiveActive
      ? '送出此句'
      : isBroadcastOn
        ? '立即翻'
        : '立即送出';
  }

  // Tone Quick Chip
  if (els.toneQuickBtn) {
    const meta = TONE_META[settings.tone] || TONE_META.natural;
    els.toneQuickBtn.textContent = meta.short;
    els.toneQuickBtn.classList.toggle('polite', settings.tone === 'polite');
  }

  // Target language pills (Apple spring sliding indicator) & outbound button label
  let activeLangIdx = 0;
  els.langBar.querySelectorAll('.lang-pill').forEach((btn, idx) => {
    const isActive = btn.dataset.lang === settings.targetLang;
    if (isActive) activeLangIdx = idx;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });
  els.langBar.dataset.activeIndex = String(activeLangIdx);

  els.quickChineseInput.placeholder = `輸入中文或外語，自動互譯（中文 ↔ ${langInfo.label}）⋯`;
  if (!isManualRecording) {
    els.speakBtnLabel.textContent = `按住或點擊說話（中 ↔ ${shortTarget}）`;
  }

  // Setup banner
  els.setupBanner.classList.toggle('hidden', Boolean(settings.apiKey));
  syncViewModeUI();
  updateHeaderStatus();
}

function speakerColorClass(speakerCode, isOutbound) {
  if (isOutbound || speakerCode === '我') return 'sp-me';
  if (speakerCode === '譯') return 'sp-a';
  const ch = String(speakerCode || 'A').toUpperCase().charCodeAt(0) - 65;
  const classes = ['sp-a', 'sp-b', 'sp-c', 'sp-d'];
  return classes[((ch % classes.length) + classes.length) % classes.length];
}

function displaySpeakerName(speakerCode, isOutbound) {
  if (isOutbound) return '我';
  const mem = speakerMemory[speakerCode];
  if (mem && mem.customName) return mem.customName;
  return speakerCode;
}

// Smart stick-to-bottom scrolling: never yanks the screen down if the user scrolled up to read history
function isNearFeedBottom() {
  const feed = els.transcriptFeed;
  if (!feed || typeof feed.scrollHeight !== 'number' || typeof feed.clientHeight !== 'number') return true;
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 140;
}

let scrollRafPending = false;
function scrollFeedToBottom(force = false) {
  if (!force && !isNearFeedBottom()) return;
  if (scrollRafPending) return;
  scrollRafPending = true;
  requestAnimationFrame(() => {
    scrollRafPending = false;
    els.transcriptFeed.scrollTop = els.transcriptFeed.scrollHeight;
  });
}

function buildDraftCaptionElement(text) {
  const el = document.createElement('div');
  el.id = 'liveDraftCard';
  el.className = 'draft-caption-card';
  const badge = document.createElement('span');
  badge.className = 'draft-caption-badge';
  badge.textContent = '即時聽寫';
  const span = document.createElement('span');
  span.className = 'draft-caption-text';
  span.textContent = text;
  el.append(badge, span);
  return el;
}

function upsertDraftCaptionDom(text) {
  currentDraftText = (text || '').trim();
  const feed = els.transcriptFeed;
  const existing = document.getElementById('liveDraftCard');

  if (!currentDraftText) {
    if (existing) existing.remove();
    if (messages.length === 0 && !activeStreamState && pendingCount === 0 && els.emptyState && els.emptyState.parentNode !== feed) {
      feed.appendChild(els.emptyState);
    }
    return;
  }

  const shouldScroll = isNearFeedBottom();
  if (els.emptyState && els.emptyState.parentNode === feed) {
    els.emptyState.remove();
  }

  if (existing) {
    const span = existing.querySelector('.draft-caption-text');
    if (span) span.textContent = currentDraftText;
  } else {
    const anchor = document.getElementById('liveStreamingCard') || document.getElementById('pendingPill');
    const node = buildDraftCaptionElement(currentDraftText);
    if (anchor && anchor.parentNode === feed) {
      feed.insertBefore(node, anchor);
    } else {
      feed.appendChild(node);
    }
  }
  if (shouldScroll) scrollFeedToBottom(true);
}

function buildStreamingCardElement(data) {
  const isOut = data.direction === 'outbound';
  const spClass = data.isLive ? 'sp-c' : speakerColorClass(data.speaker || 'A', isOut);
  const card = document.createElement('article');
  card.id = 'liveStreamingCard';
  card.dataset.streamKey = `${data.isLive ? 'L' : 'S'}_${isOut ? 'out' : 'in'}_${data.speaker || 'A'}`;
  card.className = `utterance-card streaming ${isOut ? 'outbound' : `card-${spClass}`}${data.isLive ? ' live-stream-card' : ''}`;

  const top = document.createElement('div');
  top.className = 'utterance-top';
  const spGroup = document.createElement('div');
  spGroup.className = 'speaker-group';

  const badge = document.createElement('span');
  badge.className = `speaker-badge ${spClass}`;
  badge.textContent = data.isLive ? '⚡ LIVE' : isOut ? '我:' : (data.speaker === '譯' ? '譯' : `${displaySpeakerName(data.speaker || 'A', false)}:`);

  const tag = document.createElement('span');
  tag.className = 'lang-tag';
  tag.textContent = data.isLive ? '即時串流翻譯中⋯' : '串流輸出中⋯';

  spGroup.append(badge, tag);
  top.appendChild(spGroup);
  card.appendChild(top);

  const mainEl = document.createElement('div');
  mainEl.className = 'utterance-main';
  const textNode = document.createElement('span');
  textNode.className = 'stream-main-text';
  textNode.textContent = data.mainText || '';
  const cursor = document.createElement('span');
  cursor.className = 'stream-cursor';
  mainEl.append(textNode, cursor);
  card.appendChild(mainEl);

  const readEl = document.createElement('div');
  readEl.className = 'utterance-reading';
  readEl.textContent = data.reading || '';
  readEl.style.display = data.reading ? '' : 'none';
  card.appendChild(readEl);

  const subEl = document.createElement('div');
  subEl.className = 'utterance-sub';
  subEl.textContent = data.subText || '';
  subEl.style.display = data.subText ? '' : 'none';
  card.appendChild(subEl);

  return card;
}

function upsertStreamingCardDom(data) {
  activeStreamState = data;
  const feed = els.transcriptFeed;
  if (!data || (!data.mainText && !data.subText)) {
    clearStreamingCardDom();
    return;
  }

  const shouldScroll = isNearFeedBottom();
  if (els.emptyState && els.emptyState.parentNode === feed) {
    els.emptyState.remove();
  }

  // Hide generic spinner pill once actual streaming tokens are visible
  const pendingPill = document.getElementById('pendingPill');
  if (pendingPill) pendingPill.remove();

  const isOut = data.direction === 'outbound';
  const nextKey = `${data.isLive ? 'L' : 'S'}_${isOut ? 'out' : 'in'}_${data.speaker || 'A'}`;
  const existing = document.getElementById('liveStreamingCard');

  // Update text nodes IN-PLACE when card identity matches (zero DOM churn, smooth cursor!)
  if (existing && existing.dataset.streamKey === nextKey) {
    const mainTextEl = existing.querySelector('.stream-main-text');
    if (mainTextEl) mainTextEl.textContent = data.mainText || '';

    const readEl = existing.querySelector('.utterance-reading');
    if (readEl) {
      readEl.textContent = data.reading || '';
      readEl.style.display = data.reading ? '' : 'none';
    }

    const subEl = existing.querySelector('.utterance-sub');
    if (subEl) {
      subEl.textContent = data.subText || '';
      subEl.style.display = data.subText ? '' : 'none';
    }
  } else {
    const nextCard = buildStreamingCardElement(data);
    if (existing) {
      existing.replaceWith(nextCard);
    } else {
      feed.appendChild(nextCard);
    }
  }

  if (shouldScroll) scrollFeedToBottom(true);
}

function clearStreamingCardDom() {
  activeStreamState = null;
  const existing = document.getElementById('liveStreamingCard');
  if (existing) existing.remove();
}

function syncPendingPillDom() {
  const feed = els.transcriptFeed;
  const existing = document.getElementById('pendingPill');
  const shouldShow = pendingCount > 0 && !(activeStreamState && (activeStreamState.mainText || activeStreamState.subText));

  if (shouldShow) {
    const shouldScroll = isNearFeedBottom();
    if (!existing) {
      const pill = document.createElement('div');
      pill.id = 'pendingPill';
      pill.className = 'pending-pill';
      pill.innerHTML = `<span class="spinner"></span><span>Gemini 極速翻譯中⋯</span>`;
      feed.appendChild(pill);
    }
    if (shouldScroll) scrollFeedToBottom(true);
  } else if (existing) {
    existing.remove();
  }
}

/**
 * Incrementally append a single finalized message card without rebuilding the entire feed DOM.
 */
function appendMessageCard(msg, forceScroll = false) {
  const feed = els.transcriptFeed;
  const shouldScroll = forceScroll || isNearFeedBottom();

  if (els.emptyState && els.emptyState.parentNode === feed) {
    els.emptyState.remove();
  }

  const card = createMessageCard(msg);
  card.classList.add('bubble-enter');
  const anchor =
    document.getElementById('liveDraftCard') ||
    document.getElementById('liveStreamingCard') ||
    document.getElementById('pendingPill');

  if (anchor && anchor.parentNode === feed) {
    feed.insertBefore(card, anchor);
  } else {
    feed.appendChild(card);
  }

  // Keep DOM node count bounded in long conversations
  while (messages.length > 150) {
    messages.shift();
    const firstCard = feed.querySelector('.utterance-card:not(.streaming)');
    if (firstCard) firstCard.remove();
  }

  if (shouldScroll) scrollFeedToBottom(true);
  syncClearButtonsState();
}

function renderFeed(forceScroll = true) {
  const feed = els.transcriptFeed;
  feed.innerHTML = '';

  if (messages.length === 0 && !activeStreamState && !currentDraftText) {
    feed.appendChild(els.emptyState);
  } else {
    const frag = document.createDocumentFragment();
    for (const msg of messages) {
      frag.appendChild(createMessageCard(msg));
    }
    feed.appendChild(frag);
  }

  if (currentDraftText) {
    feed.appendChild(buildDraftCaptionElement(currentDraftText));
  }

  if (activeStreamState && (activeStreamState.mainText || activeStreamState.subText)) {
    feed.appendChild(buildStreamingCardElement(activeStreamState));
  } else if (pendingCount > 0) {
    const pill = document.createElement('div');
    pill.id = 'pendingPill';
    pill.className = 'pending-pill';
    pill.innerHTML = `<span class="spinner"></span><span>Gemini 極速翻譯中⋯</span>`;
    feed.appendChild(pill);
  }

  scrollFeedToBottom(forceScroll);
  syncClearButtonsState();
}

const FLAG_SVG_MAP = {
  en: `<svg class="flag-svg sm" viewBox="0 0 24 16" aria-hidden="true"><rect width="24" height="16" rx="2" fill="#B22234"/><path d="M0 2.5h24M0 5h24M0 7.5h24M0 10h24M0 12.5h24M0 15h24" stroke="#FFF" stroke-width="1.25"/><rect width="10.5" height="8.5" rx="1" fill="#3C3B6E"/><circle cx="2.3" cy="2.1" r=".6" fill="#FFF"/><circle cx="5.2" cy="2.1" r=".6" fill="#FFF"/><circle cx="8.1" cy="2.1" r=".6" fill="#FFF"/><circle cx="3.8" cy="4.2" r=".6" fill="#FFF"/><circle cx="6.7" cy="4.2" r=".6" fill="#FFF"/><circle cx="2.3" cy="6.3" r=".6" fill="#FFF"/><circle cx="5.2" cy="6.3" r=".6" fill="#FFF"/><circle cx="8.1" cy="6.3" r=".6" fill="#FFF"/></svg>`,
  ja: `<svg class="flag-svg sm" viewBox="0 0 24 16" aria-hidden="true"><rect width="24" height="16" rx="2" fill="#FFFFFF"/><circle cx="12" cy="8" r="4.6" fill="#BC002D"/></svg>`,
  sv: `<svg class="flag-svg sm" viewBox="0 0 24 16" aria-hidden="true"><rect width="24" height="16" rx="2" fill="#006AA7"/><rect x="7" width="3.2" height="16" fill="#FECC00"/><rect y="6.4" width="24" height="3.2" fill="#FECC00"/></svg>`,
};

/**
 * XSS-safe DOM helper: renders a trusted static flag SVG (if known) plus plain textContent spans.
 * Never interpolates dynamic or model-generated strings into innerHTML.
 */
function renderFlagLabel(container, { prefix = '', flagCode = '', text = '' }) {
  container.textContent = '';
  if (prefix) {
    container.appendChild(document.createTextNode(prefix));
  }
  const svgMarkup = Object.prototype.hasOwnProperty.call(FLAG_SVG_MAP, flagCode) ? FLAG_SVG_MAP[flagCode] : '';
  if (svgMarkup) {
    const slot = document.createElement('span');
    slot.className = 'flag-slot';
    slot.innerHTML = svgMarkup;
    container.appendChild(slot);
  }
  const labelSpan = document.createElement('span');
  labelSpan.textContent = text;
  container.appendChild(labelSpan);
}

const SPEAKER_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path class="sp-wave-1" d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path class="sp-wave-2" d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;

let loadingSpeakId = null;
let openSpeakerPickerMsgId = null;

function syncPlaybackButtons() {
  const activeId = audio.playingId;
  els.transcriptFeed.querySelectorAll('.inline-speak-btn').forEach((btn) => {
    const cid = btn.dataset.cacheId;
    const isPlaying = Boolean(activeId && cid === activeId);
    const isLoading = Boolean(!isPlaying && loadingSpeakId && cid === loadingSpeakId);
    btn.classList.toggle('playing', isPlaying);
    btn.classList.toggle('loading', isLoading);
    btn.title = isPlaying ? '播放中（點擊停止）' : isLoading ? '生成語音中⋯' : '朗讀這一句';
    btn.setAttribute('aria-label', btn.title);
  });
}

function createMessageCard(msg) {
  const isPhoto = msg.type === 'photo';
  const isOutbound = !isPhoto && msg.direction === 'outbound';
  const spName = displaySpeakerName(msg.speaker, isOutbound);
  const spClass = isPhoto ? 'sp-a' : speakerColorClass(msg.speaker, isOutbound);

  const card = document.createElement('article');
  const cardColorClass = isPhoto ? 'photo-card' : isOutbound ? 'outbound' : `card-${spClass}`;
  card.className = `utterance-card ${cardColorClass}`;
  card.dataset.id = msg.id;

  const makeInlineSpeakBtn = (cacheId, textToSpeak, langCode, subtle = false) => {
    const playing = audio.playingId === cacheId;
    const loading = !playing && loadingSpeakId === cacheId;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.cacheId = cacheId;
    btn.className = `inline-speak-btn${subtle ? ' subtle' : ''}${playing ? ' playing' : ''}${loading ? ' loading' : ''}`;
    btn.title = playing ? '播放中（點擊停止）' : '朗讀這一句';
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = SPEAKER_ICON_SVG;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (audio.playingId === cacheId || loadingSpeakId === cacheId) {
        cancelActiveSpeak();
      } else {
        speakMessage(cacheId, textToSpeak, langCode);
      }
    });
    return btn;
  };

  // Top metadata row
  const top = document.createElement('div');
  top.className = 'utterance-top';

  const spGroup = document.createElement('div');
  spGroup.className = 'speaker-group';

  const spBtn = document.createElement('button');
  spBtn.type = 'button';
  spBtn.className = `speaker-badge ${spClass}`;
  if (isPhoto) {
    spBtn.textContent = '📷 拍照';
    spBtn.title = '拍照翻譯結果';
  } else {
    spBtn.textContent = msg.speaker === '譯' ? '譯' : `${spName}:`;
    spBtn.title = isOutbound || msg.speaker === '譯' ? '自動互譯' : '點擊切換說話者顏色（A/B/C/D）或改名';
    if (!isOutbound && msg.speaker !== '譯') {
      spBtn.addEventListener('click', () => {
        openSpeakerPickerMsgId = openSpeakerPickerMsgId === msg.id ? null : msg.id;
        renderFeed();
      });
    }
  }

  const langTag = document.createElement('span');
  langTag.className = 'lang-tag';
  if (isPhoto) {
    if (msg.isSourceChinese) {
      const targetInfo = TARGET_LANGUAGES[msg.targetLang] || TARGET_LANGUAGES.en;
      renderFlagLabel(langTag, { prefix: '中 → ', flagCode: targetInfo.code, text: targetInfo.label });
    } else {
      const shortLang = LANG_BADGE_MAP[msg.lang] || String(msg.lang || '外語').toUpperCase();
      renderFlagLabel(langTag, { flagCode: msg.lang, text: `${shortLang} → 中文` });
    }
  } else if (isOutbound) {
    const targetInfo = TARGET_LANGUAGES[msg.targetLang] || TARGET_LANGUAGES.en;
    renderFlagLabel(langTag, { prefix: '中 → ', flagCode: targetInfo.code, text: targetInfo.label });
  } else if (!msg.isChinese) {
    const shortLang = LANG_BADGE_MAP[msg.lang] || String(msg.lang || '外語').toUpperCase();
    renderFlagLabel(langTag, { flagCode: msg.lang, text: `${shortLang} → 中文` });
  } else {
    langTag.textContent = '中文';
  }

  const timeTag = document.createElement('span');
  timeTag.className = 'time-tag';
  timeTag.textContent = msg.time || '';

  spGroup.append(spBtn, langTag, timeTag);

  // Determine main text & copyable payload
  const mainText = isPhoto ? (msg.summary || msg.title || '') : (isOutbound ? msg.translated : msg.zh);
  const copyText = isPhoto
    ? [msg.title, msg.summary, ...(msg.items || []).map((it) => `${it.translated}${it.original ? ` (${it.original})` : ''}${it.note ? ` — ${it.note}` : ''}`)].filter(Boolean).join('\n')
    : mainText;

  const actions = document.createElement('div');
  actions.className = 'utterance-actions';

  if (!isPhoto) {
    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'mini-btn';
    expandBtn.title = '放大給對方看';
    expandBtn.setAttribute('aria-label', '放大給對方看');
    expandBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
    expandBtn.addEventListener('click', () => openShowcard(msg));
    actions.appendChild(expandBtn);
  }

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'mini-btn';
  copyBtn.title = '複製文字';
  copyBtn.setAttribute('aria-label', '複製文字');
  copyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      showToast('已複製到剪貼簿');
    } catch (_) {
      showToast('複製失敗');
    }
  });

  actions.appendChild(copyBtn);
  top.append(spGroup, actions);
  card.appendChild(top);

  // Photo card layout (menu / sign / document breakdown)
  if (isPhoto) {
    const hero = document.createElement('div');
    hero.className = 'photo-hero';
    if (msg.thumbUrl) {
      const img = document.createElement('img');
      img.className = 'photo-thumb';
      img.src = msg.thumbUrl;
      img.alt = msg.title || '拍照翻譯縮圖';
      hero.appendChild(img);
    }
    const sumBox = document.createElement('div');
    sumBox.className = 'photo-summary-box';
    if (msg.title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'photo-title';
      titleEl.textContent = msg.title;
      sumBox.appendChild(titleEl);
    }
    if (msg.summary) {
      const sumEl = document.createElement('div');
      sumEl.className = 'utterance-main';
      sumEl.style.fontSize = '15px';
      sumEl.textContent = msg.summary;
      sumBox.appendChild(sumEl);
    }
    hero.appendChild(sumBox);
    card.appendChild(hero);

    if (Array.isArray(msg.items) && msg.items.length > 0) {
      const listEl = document.createElement('div');
      listEl.className = 'photo-items';
      msg.items.forEach((it, idx) => {
        const row = document.createElement('div');
        row.className = 'photo-item';

        const zhRow = document.createElement('div');
        zhRow.className = 'photo-item-zh';
        zhRow.textContent = it.translated;
        // If photo was Chinese -> Foreign, put speak icon right after the translated foreign item
        if (msg.isSourceChinese && it.translated) {
          zhRow.appendChild(makeInlineSpeakBtn(`${msg.id}_it_${idx}`, it.translated, msg.targetLang, true));
        }
        row.appendChild(zhRow);

        if (it.original && it.original !== it.translated) {
          const origRow = document.createElement('div');
          origRow.className = 'photo-item-orig';
          origRow.appendChild(document.createTextNode(it.original));
          // Let user tap to pronounce foreign menu item directly to the waiter!
          if (!msg.isSourceChinese) {
            origRow.appendChild(makeInlineSpeakBtn(`${msg.id}_it_${idx}`, it.original, msg.lang || settings.targetLang, true));
          }
          row.appendChild(origRow);
        }

        if (it.note) {
          const noteRow = document.createElement('div');
          noteRow.className = 'photo-item-note';
          noteRow.textContent = `※ ${it.note}`;
          row.appendChild(noteRow);
        }

        listEl.appendChild(row);
      });
      card.appendChild(listEl);
    }

    return card;
  }

  // Standard conversation card
  if (!isOutbound && openSpeakerPickerMsgId === msg.id) {
    const picker = document.createElement('div');
    picker.className = 'speaker-picker';
    ['A', 'B', 'C', 'D'].forEach((code) => {
      const b = document.createElement('button');
      b.type = 'button';
      const cls = speakerColorClass(code, false);
      b.className = `speaker-pick-btn speaker-badge ${cls}${msg.speaker === code ? ' active' : ''}`;
      b.textContent = displaySpeakerName(code, false);
      b.addEventListener('click', () => {
        msg.speaker = code;
        openSpeakerPickerMsgId = null;
        saveState();
        renderFeed();
      });
      picker.appendChild(b);
    });
    const ren = document.createElement('button');
    ren.type = 'button';
    ren.className = 'speaker-pick-rename';
    ren.textContent = '改名';
    ren.addEventListener('click', () => {
      openSpeakerPickerMsgId = null;
      renameSpeaker(msg.speaker);
    });
    picker.appendChild(ren);
    card.appendChild(picker);
  }

  const speakText = isOutbound ? msg.translated : msg.zh;
  const speakLang = isOutbound ? msg.targetLang : 'zh';

  // Main text (tap text itself to open Face-to-Face Showcard) + inline speak icon
  const mainEl = document.createElement('div');
  mainEl.className = 'utterance-main';
  const mainSpan = document.createElement('span');
  mainSpan.className = 'utterance-main-text';
  mainSpan.textContent = mainText;
  mainSpan.title = '點擊放大給對方看';
  mainSpan.addEventListener('click', () => openShowcard(msg));
  mainEl.append(mainSpan, makeInlineSpeakBtn(msg.id, speakText, speakLang, false));
  card.appendChild(mainEl);

  if (isOutbound && msg.reading) {
    const readEl = document.createElement('div');
    readEl.className = 'utterance-reading';
    readEl.textContent = msg.reading;
    card.appendChild(readEl);
  }

  if (isOutbound && msg.zh) {
    const subEl = document.createElement('div');
    subEl.className = 'utterance-sub';
    subEl.textContent = `原話：${msg.zh}`;
    card.appendChild(subEl);
  } else if (!isOutbound && !msg.isChinese && msg.original && msg.original !== msg.zh) {
    const subEl = document.createElement('div');
    subEl.className = 'utterance-sub foreign-orig';
    subEl.append(
      document.createTextNode(msg.original),
      makeInlineSpeakBtn(`${msg.id}_orig`, msg.original, msg.lang, true)
    );
    card.appendChild(subEl);
  }

  return card;
}

function renameSpeaker(speakerCode) {
  const current = speakerMemory[speakerCode]?.customName || speakerCode;
  const next = window.prompt(`將說話者「${speakerCode}」重新命名為（留空恢復原代號）：`, current);
  if (next === null) return;
  const trimmed = next.trim();
  if (!speakerMemory[speakerCode]) {
    speakerMemory[speakerCode] = { voiceHint: '', customName: '' };
  }
  speakerMemory[speakerCode].customName = trimmed && trimmed !== speakerCode ? trimmed : '';
  saveState();
  renderFeed();
}

function cancelActiveSpeak() {
  speakRequestSeq += 1;
  if (activeSpeakAbort) {
    try { activeSpeakAbort.abort(); } catch (_) {}
    activeSpeakAbort = null;
  }
  loadingSpeakId = null;
  audio.stopPlayback();
  syncPlaybackButtons();
  updateHeaderStatus();
}

// TTS Playback (race-safe, zero-flicker in-place button state, iOS Safari unlocked)
async function speakMessage(msgOrId, text, langCode) {
  const cacheId = typeof msgOrId === 'string' ? msgOrId : msgOrId?.id;
  if (!text) return;

  // Unlock dedicated speaker playback synchronously inside the user tap gesture
  audio.unlockPlayback();

  const reqSeq = ++speakRequestSeq;
  if (activeSpeakAbort) {
    try { activeSpeakAbort.abort(); } catch (_) {}
    activeSpeakAbort = null;
  }

  try {
    if (audio.hasCachedAudio(cacheId)) {
      loadingSpeakId = null;
      syncPlaybackButtons();
      await audio.playCachedAudio(cacheId);
      return;
    }

    const useGeminiTts = settings.ttsModel !== 'browser' && Boolean(settings.apiKey);
    if (useGeminiTts) {
      const abortCtrl = new AbortController();
      activeSpeakAbort = abortCtrl;
      loadingSpeakId = cacheId;
      syncPlaybackButtons();
      updateHeaderStatus();

      const { base64, mimeType } = await synthesizeGeminiSpeech({
        apiKey: settings.apiKey,
        ttsModel: settings.ttsModel,
        voiceName: settings.voiceName,
        text,
        langCode,
        signal: abortCtrl.signal,
      });

      if (activeSpeakAbort === abortCtrl) activeSpeakAbort = null;

      // If another speaker click superseded this request, still cache the fetched audio silently!
      if (reqSeq !== speakRequestSeq) {
        if (cacheId) audio.cacheGeminiAudio(cacheId, base64, mimeType);
        return;
      }

      loadingSpeakId = null;
      syncPlaybackButtons();
      await audio.playGeminiAudio(cacheId, base64, mimeType);
    } else {
      loadingSpeakId = null;
      syncPlaybackButtons();
      if (settings.ttsModel !== 'browser' && !settings.apiKey) {
        showToast('未設定 API Key，暫用手機內建語音示範');
      }
      await audio.speakBrowserFallback(cacheId, text, langCode);
    }
  } catch (err) {
    if (err?.name === 'AbortError' || reqSeq !== speakRequestSeq) {
      return;
    }
    loadingSpeakId = null;
    syncPlaybackButtons();
    updateHeaderStatus();
    console.error('TTS error:', err);
    showToast(`AI 語音失敗，改用瀏覽器語音：${err.message}`, 3200);
    await audio.speakBrowserFallback(cacheId, text, langCode);
  }
}

// Free Browser SpeechRecognition Live Draft Preview (Plan A — zero API cost, graceful fallback)
const DRAFT_LOCALE_MAP = {
  en: 'en-US',
  ja: 'ja-JP',
  sv: 'sv-SE',
  zh: 'zh-TW',
};

function startDraftRecognition(langCode = 'zh') {
  if (!settings.draftCaption || draftRecognitionDisabled || isLiveActive || (activeMode === 'broadcast' && !isManualRecording)) {
    return;
  }
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) return;

  stopDraftRecognition(false);
  try {
    const rec = new SpeechRec();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = DRAFT_LOCALE_MAP[langCode] || 'zh-TW';

    rec.onresult = (event) => {
      if (!draftRecognitionActive) return;
      let combined = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i]?.[0]?.transcript || '';
        combined += transcript;
      }
      if (combined.trim()) {
        upsertDraftCaptionDom(combined.trim());
      }
    };

    rec.onerror = (event) => {
      // On iOS Safari or devices that disallow concurrent WebAudio + SpeechRecognition,
      // silently disable draft preview without ever affecting WebAudio recording.
      const code = event?.error || '';
      if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') {
        draftRecognitionDisabled = true;
      }
      draftRecognitionActive = false;
    };

    rec.onend = () => {
      if (
        draftRecognitionActive &&
        !draftRecognitionDisabled &&
        (activeMode === 'dialogue' || isManualRecording) &&
        !isLiveActive
      ) {
        try {
          rec.start();
        } catch (_) {
          draftRecognitionActive = false;
        }
      }
    };

    draftRecognition = rec;
    draftRecognitionActive = true;
    rec.start();
  } catch (_) {
    draftRecognitionActive = false;
  }
}

function stopDraftRecognition(clearText = true) {
  draftRecognitionActive = false;
  if (draftRecognition) {
    try {
      draftRecognition.onresult = null;
      draftRecognition.onerror = null;
      draftRecognition.onend = null;
      draftRecognition.stop();
    } catch (_) {}
    draftRecognition = null;
  }
  if (clearText) {
    upsertDraftCaptionDom('');
  }
}

// Language heuristic helpers for Gemini Live turns (ratio-based so English with a quoted Han place name stays English)
export function isLikelyChineseText(text) {
  if (!text) return false;
  const kanaCount = (text.match(/[\u3040-\u30ff]/g) || []).length;
  if (kanaCount > 0) return false; // Japanese Kana -> Japanese, not Chinese
  const hanCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  if (hanCount === 0) return false;
  const latinCount = (text.match(/[A-Za-zÅÄÖåäöÉé]/g) || []).length;
  // Each Han char carries ~2-3x Latin char information density
  return hanCount * 2 >= latinCount;
}

function detectRoughForeignLang(text, fallback = 'en') {
  if (!text) return fallback;
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[åäöÅÄÖ]/.test(text)) return 'sv';
  if (isLikelyChineseText(text)) return 'zh';
  return fallback || 'en';
}

function formatTimerMMSS(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function stopLiveTimers() {
  if (liveTimerHandle) {
    clearInterval(liveTimerHandle);
    liveTimerHandle = null;
  }
  if (liveIdleHandle) {
    clearInterval(liveIdleHandle);
    liveIdleHandle = null;
  }
}

function startLiveTimers() {
  stopLiveTimers();
  liveStartTs = Date.now();
  if (els.liveTimerPill) {
    els.liveTimerPill.textContent = '⚡ LIVE 00:00';
  }
  liveTimerHandle = setInterval(() => {
    if (liveConnected && els.liveTimerPill) {
      els.liveTimerPill.textContent = `⚡ LIVE ${formatTimerMMSS(Date.now() - liveStartTs)}`;
    }
  }, 1000);

  // Guardrail: auto-disconnect after 5 minutes of total silence so credits are never burned accidentally
  liveIdleHandle = setInterval(() => {
    if (!liveConnected || !liveClient.lastActivityTs) return;
    if (Date.now() - liveClient.lastActivityTs >= 5 * 60 * 1000) {
      sessionEpoch += 1;
      stopLiveSession(true);
      activeMode = null;
      isLiveActive = false;
      syncWakeLock();
      updateSwitchUI();
      showToast('Live 串流已靜音 5 分鐘，自動斷線以節省額度', 4200);
    }
  }, 15000);
}

// Wire Gemini Live Client callbacks once
liveClient.onStateChange = (state, detail) => {
  if (state === 'connecting') {
    liveConnecting = true;
    liveConnected = false;
    updateSwitchUI();
  } else if (state === 'ready') {
    liveConnecting = false;
    liveConnected = true;
    startLiveTimers();
    els.vadStatus.textContent = '⚡ Live 雙向對話已連線・直接開口即可即時口譯';
    updateSwitchUI();
  } else if (state === 'closed') {
    const wasActive = liveConnected;
    liveConnecting = false;
    liveConnected = false;
    stopLiveTimers();
    clearStreamingCardDom();
    if (wasActive && activeMode === 'dialogue' && isLiveActive) {
      audio.stopLiveStream();
      activeMode = null;
      isLiveActive = false;
      syncWakeLock();
      showToast(`Live 連線已關閉${detail || ''}`, 3200);
    }
    updateSwitchUI();
  } else if (state === 'error') {
    liveConnecting = false;
    liveConnected = false;
    stopLiveTimers();
    clearStreamingCardDom();
    audio.stopLiveStream();
    if (detail) showToast(detail, 4200);
    updateSwitchUI();
  }
};

liveClient.onPartialUpdate = ({ inputText, outputText }) => {
  if (!inputText && !outputText) return;
  const mainIsOut = outputText ? !isLikelyChineseText(outputText) : isLikelyChineseText(inputText);
  upsertStreamingCardDom({
    isLive: true,
    direction: mainIsOut ? 'outbound' : 'inbound',
    speaker: mainIsOut ? '我' : 'A',
    mainText: outputText || inputText,
    subText: outputText && inputText && outputText !== inputText ? (mainIsOut ? `原話：${inputText}` : inputText) : '',
  });
};

liveClient.onAudioChunk = (bytes, sampleRate) => {
  if (settings.liveAutoSpeak) {
    audio.enqueueLiveAudioChunk(bytes, sampleRate).catch(() => {});
  }
};

liveClient.onTurnComplete = async ({ inputText, outputText, pcmChunks, sampleRate }) => {
  clearStreamingCardDom();
  const cleanOut = (outputText || '').trim();
  const cleanIn = (inputText || '').trim();
  if (!cleanOut && !cleanIn) return;

  const outIsZh = isLikelyChineseText(cleanOut);
  let msg;
  if (outIsZh || !cleanOut) {
    // Foreign -> Chinese (inbound left card)
    const speakers = ['A', 'B'];
    const spCode = speakers[liveInboundCount % speakers.length];
    liveInboundCount += 1;
    const detectedLang = detectRoughForeignLang(cleanIn, settings.targetLang);
    msg = {
      id: makeId(),
      direction: 'inbound',
      speaker: spCode,
      lang: detectedLang,
      isChinese: detectedLang === 'zh',
      original: cleanIn || cleanOut,
      zh: cleanOut || cleanIn,
      time: nowTimeStr(),
    };
  } else {
    // Chinese -> Foreign (outbound right card)
    msg = {
      id: makeId(),
      direction: 'outbound',
      speaker: '我',
      lang: 'zh',
      targetLang: settings.targetLang,
      isChinese: true,
      zh: cleanIn,
      translated: cleanOut,
      reading: '',
      time: nowTimeStr(),
    };
  }

  // Cache returned 24kHz PCM directly under msg.id ONLY if genuinely audible (0ms replay & 0 extra TTS cost)
  if (Array.isArray(pcmChunks) && pcmChunks.length > 0) {
    try {
      audio.cacheLivePcmChunks(msg.id, pcmChunks, sampleRate || 24000);
    } catch (_) {}
  }

  messages.push(msg);
  saveState();
  appendMessageCard(msg);
  updateHeaderStatus();
};

liveClient.onGoAway = () => {
  if (activeMode === 'dialogue' && isLiveActive) {
    showToast('Live 連線即將到期，無縫續連中⋯', 2400);
    const epoch = ++sessionEpoch;
    startLiveSession({ resume: true, epoch }).catch(() => {});
  }
};

async function startLiveSession({ resume = false, epoch = sessionEpoch } = {}) {
  stopDraftRecognition(true);
  audio.stopListening();
  liveConnecting = true;
  updateSwitchUI();

  try {
    await audio.ensureMicrophone();
    if (epoch !== sessionEpoch) return;
    await liveClient.connect({
      apiKey: settings.apiKey,
      model: settings.liveModel || 'gemini-3.8-live',
      targetLang: settings.targetLang,
      tone: settings.tone,
      glossary: settings.glossary || '',
      voiceName: settings.voiceName,
      resume,
    });
    if (epoch !== sessionEpoch) {
      liveClient.disconnect(true);
      return;
    }
    await audio.startLiveStream((pcm16) => {
      liveClient.sendAudioPcm16k(pcm16);
    });
  } catch (err) {
    if (epoch === sessionEpoch) {
      liveConnecting = false;
      liveConnected = false;
      audio.stopLiveStream();
      liveClient.disconnect(true);
    }
    throw err;
  }
}

function stopLiveSession(releaseMic = true) {
  stopLiveTimers();
  liveConnecting = false;
  liveConnected = false;
  clearStreamingCardDom();
  liveClient.disconnect(true);
  if (releaseMic) {
    audio.stopLiveStream();
  } else {
    audio.liveStreaming = false;
    audio.onLivePcmChunk = null;
    audio.stopLivePlayback();
  }
}

// ============================================================================
// Full-Screen Continuous Chinese Broadcast Canvas & Retroactive Semantic Polish
// ============================================================================
function isNearBroadcastBottom() {
  const el = els.broadcastCanvas;
  if (!el || typeof el.scrollHeight !== 'number' || typeof el.clientHeight !== 'number') return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 140;
}

let bcScrollRaf = false;
function scrollBroadcastToBottom(force = false) {
  if (!force && !isNearBroadcastBottom()) return;
  if (bcScrollRaf) return;
  bcScrollRaf = true;
  requestAnimationFrame(() => {
    bcScrollRaf = false;
    if (els.broadcastCanvas) {
      els.broadcastCanvas.scrollTop = els.broadcastCanvas.scrollHeight;
    }
  });
}

function flashBroadcastHint(text, duration = 2800) {
  if (!els.broadcastHint) return;
  els.broadcastHint.textContent = text;
  els.broadcastHint.classList.add('revised-notice');
  clearTimeout(bcHintTimer);
  bcHintTimer = setTimeout(() => {
    if (!els.broadcastHint) return;
    els.broadcastHint.classList.remove('revised-notice');
    els.broadcastHint.textContent = '純繁體中文・自動回頭潤飾語意';
  }, duration);
}

function getBroadcastTailSegment() {
  if (!Array.isArray(broadcastParagraphs) || broadcastParagraphs.length === 0) return null;
  const para = broadcastParagraphs[broadcastParagraphs.length - 1];
  if (!para || !Array.isArray(para.segments) || para.segments.length === 0) return null;
  return { para, seg: para.segments[para.segments.length - 1] };
}

function findBroadcastSegmentById(segId) {
  if (!segId) return null;
  for (let i = broadcastParagraphs.length - 1; i >= 0; i--) {
    const para = broadcastParagraphs[i];
    if (!para || !Array.isArray(para.segments)) continue;
    for (let j = para.segments.length - 1; j >= 0; j--) {
      if (para.segments[j].id === segId) {
        return { para, seg: para.segments[j], paraIdx: i, segIdx: j };
      }
    }
  }
  return null;
}

function getBroadcastPriorContext(excludeSegId = null, maxChars = 240) {
  const chunks = [];
  let total = 0;
  for (let i = broadcastParagraphs.length - 1; i >= 0 && total < maxChars; i--) {
    const para = broadcastParagraphs[i];
    if (!para || !Array.isArray(para.segments)) continue;
    for (let j = para.segments.length - 1; j >= 0 && total < maxChars; j--) {
      const s = para.segments[j];
      if (excludeSegId && s.id === excludeSegId) continue;
      if (!s.text) continue;
      chunks.unshift(s.text);
      total += s.text.length;
    }
  }
  const joined = chunks.join('');
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

function getBroadcastFullText() {
  return broadcastParagraphs
    .map((p) => (p.segments || []).map((s) => s.text).join(''))
    .filter((line) => line.trim())
    .join('\n\n');
}

function createBroadcastSegSpan(seg, isLiveTail = false) {
  const span = document.createElement('span');
  span.className = `bc-seg${isLiveTail && !seg.settled ? ' live-tail' : ''}`;
  span.dataset.sid = seg.id;
  span.textContent = seg.text;
  return span;
}

function createBroadcastParaElement(para, isLastPara = false) {
  const p = document.createElement('p');
  p.className = 'bc-para';
  p.dataset.pid = para.id;
  const segs = para.segments || [];
  segs.forEach((seg, idx) => {
    const isTail = isLastPara && idx === segs.length - 1;
    p.appendChild(createBroadcastSegSpan(seg, isTail));
  });
  return p;
}

function renderBroadcastCanvas(forceScroll = true) {
  const canvas = els.broadcastCanvas;
  if (!canvas) return;
  canvas.innerHTML = '';

  if (broadcastParagraphs.length === 0 && !bcStreamText && broadcastPendingCount === 0) {
    if (els.broadcastEmpty) canvas.appendChild(els.broadcastEmpty);
    syncClearButtonsState();
    return;
  }

  const frag = document.createDocumentFragment();
  broadcastParagraphs.forEach((para, idx) => {
    frag.appendChild(createBroadcastParaElement(para, idx === broadcastParagraphs.length - 1));
  });
  canvas.appendChild(frag);

  if (bcStreamText) {
    upsertBroadcastStreamSpan(bcStreamText);
  } else if (broadcastPendingCount > 0) {
    syncBroadcastPendingInline();
  }

  scrollBroadcastToBottom(forceScroll);
  syncClearButtonsState();
}

function getOrCreateActiveBroadcastParaEl() {
  const canvas = els.broadcastCanvas;
  if (!canvas) return null;
  if (els.broadcastEmpty && els.broadcastEmpty.parentNode === canvas) {
    els.broadcastEmpty.remove();
  }
  const paras = canvas.querySelectorAll('.bc-para');
  if (paras.length > 0) {
    return paras[paras.length - 1];
  }
  const temp = document.createElement('p');
  temp.id = 'bcTempStreamPara';
  temp.className = 'bc-para';
  canvas.appendChild(temp);
  return temp;
}

function upsertBroadcastStreamSpan(text) {
  bcStreamText = String(text || '');
  const canvas = els.broadcastCanvas;
  if (!canvas) return;
  if (!bcStreamText) {
    clearBroadcastStreamSpan();
    return;
  }

  const shouldScroll = isNearBroadcastBottom();
  const pendingEl = document.getElementById('bcPendingInline');
  if (pendingEl) pendingEl.remove();

  let span = document.getElementById('bcStreamingSpan');
  if (!span) {
    const paraEl = getOrCreateActiveBroadcastParaEl();
    if (!paraEl) return;
    span = document.createElement('span');
    span.id = 'bcStreamingSpan';
    span.className = 'bc-seg bc-streaming';
    const txt = document.createElement('span');
    txt.className = 'bc-stream-text';
    const cursor = document.createElement('span');
    cursor.className = 'stream-cursor';
    span.append(txt, cursor);
    paraEl.appendChild(span);
  }
  const txtNode = span.querySelector('.bc-stream-text');
  if (txtNode) txtNode.textContent = bcStreamText;

  if (shouldScroll) scrollBroadcastToBottom(true);
}

function clearBroadcastStreamSpan() {
  bcStreamText = '';
  const span = document.getElementById('bcStreamingSpan');
  if (span) span.remove();
  const temp = document.getElementById('bcTempStreamPara');
  if (temp && temp.children.length === 0) temp.remove();
}

function syncBroadcastPendingInline() {
  const canvas = els.broadcastCanvas;
  if (!canvas) return;
  const existing = document.getElementById('bcPendingInline');
  const shouldShow = broadcastPendingCount > 0 && !bcStreamText;

  if (shouldShow) {
    const shouldScroll = isNearBroadcastBottom();
    if (!existing) {
      const paraEl = getOrCreateActiveBroadcastParaEl();
      if (!paraEl) return;
      const badge = document.createElement('span');
      badge.id = 'bcPendingInline';
      badge.className = 'bc-pending-inline';
      badge.innerHTML = `<span class="spinner"></span><span>翻譯中⋯</span>`;
      paraEl.appendChild(badge);
    }
    if (shouldScroll) scrollBroadcastToBottom(true);
  } else if (existing) {
    existing.remove();
    const temp = document.getElementById('bcTempStreamPara');
    if (temp && temp.children.length === 0) temp.remove();
    if (broadcastParagraphs.length === 0 && !bcStreamText && els.broadcastEmpty && els.broadcastEmpty.parentNode !== canvas) {
      canvas.appendChild(els.broadcastEmpty);
    }
  }
}

function updateBroadcastSpanInPlace(segId, nextText, triggerGlow = false) {
  const canvas = els.broadcastCanvas;
  if (!canvas) return;
  const spans = canvas.querySelectorAll('.bc-seg');
  let target = null;
  for (const s of spans) {
    if (s.dataset && s.dataset.sid === segId) {
      target = s;
      break;
    }
  }
  if (!target) {
    renderBroadcastCanvas(false);
    return;
  }
  target.textContent = nextText;
  target.classList.remove('live-tail');
  if (triggerGlow) {
    target.classList.remove('revised-flash');
    void target.offsetWidth; // restart CSS shimmer cleanly
    target.classList.add('revised-flash');
  }
}

function settleAllLiveTailSpansDom() {
  if (!els.broadcastCanvas) return;
  els.broadcastCanvas.querySelectorAll('.bc-seg.live-tail').forEach((el) => {
    el.classList.remove('live-tail');
  });
}

/**
 * Commit a Chinese-only Broadcast result with surgical in-place retroactive refinement (revised_prev)
 * and continuous inline paragraph flow (zero bubbles, zero English).
 */
export function applyBroadcastCommit(job, result) {
  const shouldScroll = isNearBroadcastBottom();
  clearBroadcastStreamSpan();
  const pendingInline = document.getElementById('bcPendingInline');
  if (pendingInline) pendingInline.remove();

  let changed = false;
  let revisedApplied = false;

  // 1. Apply single-pass retroactive semantic refinement to the previous tail segment (zero extra API call!)
  if (job.prevTailSegId) {
    const found = findBroadcastSegmentById(job.prevTailSegId);
    if (found) {
      found.seg.settled = true;
      found.seg.needsPolish = false;
      if (result.revisedPrev && result.revisedPrev !== found.seg.text) {
        found.seg.text = result.revisedPrev;
        found.seg.revised = true;
        updateBroadcastSpanInPlace(found.seg.id, found.seg.text, true);
        flashBroadcastHint('✨ 已依後續語境回頭潤飾前句語意');
        changed = true;
        revisedApplied = true;
      } else {
        updateBroadcastSpanInPlace(found.seg.id, found.seg.text, false);
      }
    }
  }
  if (!revisedApplied && els.broadcastHint && els.broadcastHint.textContent.includes('正在依新語境')) {
    clearTimeout(bcHintTimer);
    els.broadcastHint.classList.remove('revised-notice');
    els.broadcastHint.textContent = '純繁體中文・自動回頭潤飾語意';
  }

  // 2. Append newly translated Traditional Chinese continuously inline (or start a clean paragraph on topic shift)
  if (result.currentZh) {
    const canvas = els.broadcastCanvas;
    if (canvas && els.broadcastEmpty && els.broadcastEmpty.parentNode === canvas) {
      els.broadcastEmpty.remove();
    }

    const lastPara = broadcastParagraphs[broadcastParagraphs.length - 1] || null;
    const lastParaLen = lastPara
      ? lastPara.segments.reduce((acc, s) => acc + (s.text ? s.text.length : 0), 0)
      : 0;
    const shouldStartNewPara = !lastPara || result.newParagraph || lastParaLen >= 220;

    // Mark previous live tails as settled
    if (lastPara) {
      for (const s of lastPara.segments) s.settled = true;
    }
    settleAllLiveTailSpansDom();

    const newSeg = {
      id: makeId(),
      text: result.currentZh,
      revised: false,
      settled: false,
      needsPolish: !job.hadPrevTail,
    };

    if (shouldStartNewPara) {
      const para = {
        id: makeId(),
        time: nowTimeStr(),
        segments: [newSeg],
      };
      broadcastParagraphs.push(para);
      if (canvas) {
        const temp = document.getElementById('bcTempStreamPara');
        if (temp) temp.remove();
        canvas.appendChild(createBroadcastParaElement(para, true));
      }
      while (broadcastParagraphs.length > 60) {
        broadcastParagraphs.shift();
        const firstP = canvas ? canvas.querySelector('.bc-para') : null;
        if (firstP) firstP.remove();
      }
    } else {
      lastPara.segments.push(newSeg);
      if (canvas) {
        const paras = canvas.querySelectorAll('.bc-para');
        const lastParaEl = paras.length > 0 ? paras[paras.length - 1] : null;
        if (lastParaEl && lastParaEl.dataset?.pid === lastPara.id) {
          lastParaEl.appendChild(createBroadcastSegSpan(newSeg, true));
        } else {
          renderBroadcastCanvas(false);
        }
      }
    }
    changed = true;
  }

  if (changed) {
    saveState();
  }
  if (shouldScroll) scrollBroadcastToBottom(true);
  syncClearButtonsState();
}

/**
 * Lightweight text-only retroactive polisher (~0.1x cost of an audio call).
 * Auto-triggered when Turbo parallel chunks finish out of sync, or manually via the "✨ 潤飾" button.
 */
async function polishBroadcastTail(manualTrigger = false) {
  if (bcPolishBusy || !settings.apiKey || !isOnline) {
    if (manualTrigger && !settings.apiKey) {
      showToast('請先填入 Gemini API Key');
      openSettings();
    }
    return;
  }
  if (broadcastParagraphs.length === 0) {
    if (manualTrigger) showToast('目前沒有可潤飾的中文內容');
    return;
  }

  const para = broadcastParagraphs[broadcastParagraphs.length - 1];
  if (!para || !Array.isArray(para.segments) || para.segments.length === 0) return;

  // Polish up to the last 3 segments (or whole current paragraph if manual)
  const takeCount = manualTrigger ? para.segments.length : Math.min(3, para.segments.length);
  const startIdx = para.segments.length - takeCount;
  const targetSegs = para.segments.slice(startIdx);
  const targetIds = targetSegs.map((s) => s.id);
  const draftText = targetSegs.map((s) => s.text).join('').trim();
  if (draftText.length < 10) {
    if (manualTrigger) showToast('目前字數較短，已足夠通順');
    return;
  }

  const myEpoch = bcEpoch;
  bcPolishBusy = true;
  if (els.bcPolishBtn) els.bcPolishBtn.classList.add('busy');
  updateHeaderStatus();

  try {
    const priorContext = getBroadcastPriorContext(targetIds[0], 220);
    const polished = await polishBroadcastText({
      apiKey: settings.apiKey,
      model: settings.model,
      glossary: settings.glossary || '',
      priorContext,
      draftText,
    });

    if (myEpoch !== bcEpoch) return;

    if (polished && polished !== draftText) {
      // Ensure target segments still exist contiguously in `para`
      const firstIdx = para.segments.findIndex((s) => s.id === targetIds[0]);
      if (firstIdx >= 0) {
        const mergedSeg = {
          id: makeId(),
          text: polished,
          revised: true,
          settled: true,
          needsPolish: false,
        };
        para.segments.splice(firstIdx, targetIds.length, mergedSeg);
        saveState();
        renderBroadcastCanvas(false);
        updateBroadcastSpanInPlace(mergedSeg.id, mergedSeg.text, true);
        flashBroadcastHint('✨ 已回頭完成整段語意潤飾');
        if (manualTrigger) showToast('✨ 已潤飾目前段落語意');
      }
    } else {
      for (const s of targetSegs) {
        s.needsPolish = false;
        s.settled = true;
      }
      saveState();
      if (manualTrigger) showToast('目前段落已經非常流暢自然');
    }
  } catch (err) {
    console.warn('Broadcast polish skipped:', err);
    if (manualTrigger) showToast(`潤飾失敗：${err.message}`, 3200);
  } finally {
    bcPolishBusy = false;
    if (els.bcPolishBtn) els.bcPolishBtn.classList.remove('busy');
    updateHeaderStatus();
  }
}

function runBroadcastDemo() {
  clearTimeout(bcDemoTimer);
  viewMode = 'broadcast';
  bcEpoch += 1;
  const seg1Id = makeId();
  broadcastParagraphs = [
    {
      id: makeId(),
      time: nowTimeStr(),
      segments: [
        {
          id: makeId(),
          text: '歡迎收看今日國際財經快訊。全球市場本週高度關注歐美央行的利率動向與最新通膨報告。',
          revised: false,
          settled: true,
          needsPolish: false,
        },
      ],
    },
    {
      id: makeId(),
      time: nowTimeStr(),
      segments: [
        {
          id: seg1Id,
          text: '歐洲央行今天宣布，儘管歐元區經濟成長低迷，他們可能暫時不會⋯',
          revised: false,
          settled: false,
          needsPolish: false,
        },
      ],
    },
  ];
  saveState();
  syncViewModeUI();
  renderBroadcastCanvas(true);
  flashBroadcastHint('📻 正在收聽下一句，待語境完整後將自動回頭潤飾⋯', 1800);

  // Demonstrate live retroactive self-correction + seamless inline continuation 1.3s later!
  bcDemoTimer = setTimeout(() => {
    applyBroadcastCommit(
      { prevTailSegId: seg1Id, hadPrevTail: true },
      {
        revisedPrev: '歐洲央行今天宣布，儘管歐元區經濟成長低迷，仍決定連續第三次會議維持利率不變，',
        currentZh: '並強調服務業通膨仍具黏性，短期內將審慎觀察後續經濟數據再決定降息時程。',
        newParagraph: false,
      }
    );
    showToast('✨ 已示範：純中文連續顯示＋自動回頭修改前句語意！', 3400);
  }, 1300);
}

// Turbo ≤ 2x quota guardrail helpers
function pruneTurboWindow(now = Date.now()) {
  const cutoff = now - 60000;
  while (turboAutoEmitTimestamps.length > 0 && turboAutoEmitTimestamps[0] < cutoff) {
    turboAutoEmitTimestamps.shift();
  }
  const limit = getTurboMinuteLimit(activeMode || 'dialogue');
  const shouldThrottle = Boolean(settings.turboMode && turboAutoEmitTimestamps.length >= limit);
  if (turboThrottled && !shouldThrottle) {
    turboThrottled = false;
    applyActiveAudioProfile();
    if (activeMode && !isLiveActive && !audio.isSpeaking) {
      els.vadStatus.textContent = getIdleVadHint();
    }
    updateSwitchUI();
    pumpVadPipeline();
  }
  return shouldThrottle;
}

function recordTurboAutoEmit(mode) {
  if (!settings.turboMode) return;
  const now = Date.now();
  pruneTurboWindow(now);
  turboAutoEmitTimestamps.push(now);

  const limit = getTurboMinuteLimit(mode || activeMode || 'dialogue');
  if (turboAutoEmitTimestamps.length >= limit) {
    const wasThrottled = turboThrottled;
    turboThrottled = true;
    applyActiveAudioProfile();
    updateSwitchUI();
    if (!wasThrottled) {
      showToast('⚡ Turbo 已達每分鐘 2x 額度上限，自動降速保護中', 3400);
    }
    clearTimeout(turboCooldownTimer);
    const waitMs = Math.max(1200, turboAutoEmitTimestamps[0] + 60000 - now + 250);
    turboCooldownTimer = setTimeout(() => {
      pruneTurboWindow();
    }, waitMs);
  }
}

function applyActiveAudioProfile() {
  const profile = getAudioProfile(
    activeMode || 'dialogue',
    settings.turboMode,
    settings.silenceMs,
    turboThrottled
  );
  audio.configureVad({
    threshold: Number(settings.vadThreshold),
    mode: profile.mode,
    silenceMs: profile.silenceMs,
    minBatchMs: profile.minBatchMs,
    interSentencePauseMs: profile.interSentencePauseMs,
    maxChunkMs: profile.maxChunkMs,
    uploadSampleRate: profile.uploadSampleRate,
  });
  return profile;
}

function getIdleVadHint() {
  const langInfo = TARGET_LANGUAGES[settings.targetLang] || TARGET_LANGUAGES.en;
  const shortTarget = LANG_BADGE_MAP[langInfo.code] || langInfo.label;
  if (activeMode === 'broadcast') {
    if (settings.turboMode && !turboThrottled) {
      return '⚡ Turbo 純中文極速連翻中⋯自動回頭潤飾（≤2x）';
    }
    if (settings.turboMode && turboThrottled) {
      return '📻 純中文連翻中（2x 額度保護中・自動潤飾）';
    }
    return '📻 純中文連續聆聽中⋯自動回頭潤飾前句語意';
  }
  if (settings.turboMode && !turboThrottled) {
    return `⚡ Turbo 雙向對話（中↔${shortTarget}）⋯停頓即並行快翻`;
  }
  if (settings.turboMode && turboThrottled) {
    return `💬 雙向對話（2x 額度保護中・中↔${shortTarget}）`;
  }
  return `💬 自動雙向對話中⋯外語翻中文、中文翻${langInfo.label}`;
}

// Top-right Turbo toggle: accelerates both scenarios strictly within a 2x quota ceiling
function toggleTurboMode() {
  settings.turboMode = !settings.turboMode;
  haptic(12);
  if (!settings.turboMode) {
    turboThrottled = false;
    clearTimeout(turboCooldownTimer);
  } else {
    pruneTurboWindow();
  }
  applyActiveAudioProfile();
  saveState();
  if (activeMode && !isLiveActive && !audio.isSpeaking) {
    els.vadStatus.textContent = getIdleVadHint();
  }
  updateSwitchUI();
  pumpVadPipeline();

  if (settings.turboMode) {
    if (activeMode === 'dialogue' && isLiveActive) {
      showToast('⚡ Turbo 已開啟（已記憶；目前為 Live 進階串流）', 2600);
    } else if (activeMode === 'broadcast') {
      showToast('⚡ Turbo 開啟：1 句極速純中文＋自動回頭潤飾（額度 ≤ 2x）', 3000);
    } else {
      showToast('⚡ Turbo 開啟：極速斷句＋雙路並行快翻（額度上限 ≤ 2x）', 3000);
    }
  } else {
    showToast('已關閉 Turbo，切回標準省額度模式（1x）', 2400);
  }
}

// Dual Scenario Switcher:
// - 'dialogue' (自動雙向對話，標準對話氣泡視圖)
// - 'broadcast' (全畫面純中文連續聆聽＋自動回頭潤飾，無英文干擾)
async function toggleScenario(targetMode) {
  audio.unlockPlayback();
  const epoch = ++sessionEpoch;

  // Tapping the already-active scenario pauses listening
  if (activeMode === targetMode) {
    const prevMode = activeMode;
    if (isLiveActive) {
      stopLiveSession(true);
    } else {
      stopDraftRecognition(true);
      audio.stopListening();
    }
    activeMode = null;
    isLiveActive = false;
    haptic(10);
    syncWakeLock();
    updateSwitchUI();

    if (prevMode === 'broadcast') {
      // Keep full-screen Chinese reading view open so user can read/copy, and polish any unpolished Turbo tail!
      const lastPara = broadcastParagraphs[broadcastParagraphs.length - 1];
      if (lastPara && lastPara.segments.some((s) => s.needsPolish)) {
        polishBroadcastTail(false);
      }
      showToast('已暫停聆聽翻譯（可繼續閱讀或複製全文）');
    } else {
      showToast('已關閉「對話」模式');
    }
    return;
  }

  if (!settings.apiKey) {
    // Allow switching into Broadcast canvas preview if they tapped Broadcast without API key? Better: prompt key as before
    if (targetMode === 'broadcast') {
      viewMode = 'broadcast';
      renderBroadcastCanvas(true);
      updateSwitchUI();
    }
    showToast('請先填入 Gemini API Key 才能啟動自動翻譯');
    openSettings();
    return;
  }
  if (!isOnline) {
    showToast('目前處於離線狀態，請確認網路連線');
    return;
  }

  const switchingBetweenVadModes = Boolean(activeMode && !isLiveActive);
  const switchingFromLive = Boolean(activeMode && isLiveActive);

  // Flush any already-spoken buffer under the previous scenario before switching modes
  if (switchingBetweenVadModes) {
    audio.flushListeningNow();
  } else if (switchingFromLive) {
    stopLiveSession(false);
  }

  viewMode = targetMode;

  const wantsLive = targetMode === 'dialogue' && Boolean(settings.useLiveInDialogue);

  if (wantsLive) {
    activeMode = 'dialogue';
    isLiveActive = true;
    haptic(15);
    syncWakeLock();
    updateSwitchUI();
    showToast('⚡ 正在連線 Gemini Live 雙向對話⋯', 2200);
    try {
      await startLiveSession({ resume: false, epoch });
      if (epoch !== sessionEpoch) return;
      showToast('⚡ Live 雙向對話已就緒（點 🔊 可 0 秒重播）');
      return;
    } catch (err) {
      if (epoch !== sessionEpoch) return;
      console.error('Live dialogue error, falling back to SSE dialogue:', err);
      isLiveActive = false;
      showToast('Live 連線失敗，已自動切回標準對話模式', 3200);
    }
  }

  // Standard / Turbo SSE streaming engine (optimal Quota × Efficiency balance)
  try {
    activeMode = targetMode;
    isLiveActive = false;
    haptic(15);
    if (targetMode === 'broadcast') {
      // Suppress browser SpeechRecognition in Broadcast so ZERO raw English drafts appear on screen!
      stopDraftRecognition(true);
      renderBroadcastCanvas(false);
    }
    // 0ms optimistic transition: slide toggle, crossfade view, and glide bars immediately without waiting on mic stream init
    els.vadStatus.textContent = audio.listening ? getIdleVadHint() : '正在啟動麥克風⋯';
    updateSwitchUI();
    applyActiveAudioProfile();

    if (!audio.listening) {
      await audio.startListening();
      if (epoch !== sessionEpoch) return;
    }

    if (targetMode === 'broadcast') {
      renderBroadcastCanvas(true);
    } else {
      startDraftRecognition(settings.targetLang);
    }

    syncWakeLock();
    els.vadStatus.textContent = getIdleVadHint();
    updateSwitchUI();

    const langInfo = TARGET_LANGUAGES[settings.targetLang] || TARGET_LANGUAGES.en;
    if (targetMode === 'broadcast') {
      showToast(
        settings.turboMode
          ? '⚡ 純中文全畫面聆聽（Turbo）：極速連翻＋自動回頭潤飾'
          : '📻 純中文全畫面聆聽已開啟：連續翻譯並自動回頭潤飾語意',
        2800
      );
    } else {
      showToast(
        settings.turboMode
          ? `⚡ 對話模式（Turbo）：中 ↔ ${langInfo.label} 並行自動互譯`
          : `💬 對話模式已開啟：外語→中文、中文→${langInfo.label}`,
        2800
      );
    }
  } catch (err) {
    if (epoch !== sessionEpoch) return;
    console.error('Scenario start error:', err);
    activeMode = null;
    isLiveActive = false;
    audio.stopListening();
    syncWakeLock();
    updateSwitchUI();
    showToast(`無法啟動麥克風：${err.message}`, 3800);
  }
}

// Ordered Parallel VAD Pipeline (concurrency = 1 Standard, concurrency = 2 Turbo; strict FIFO commit order)
function enqueueVadSegment(wav) {
  upsertDraftCaptionDom('');
  const modeAtCapture = activeMode || 'dialogue';
  recordTurboAutoEmit(modeAtCapture);
  const profile = getAudioProfile(modeAtCapture, settings.turboMode, settings.silenceMs, turboThrottled);

  const job = {
    seq: ++vadJobSeq,
    wav,
    mode: modeAtCapture,
    targetLang: settings.targetLang,
    tone: settings.tone,
    contextLimit: profile.contextLimit,
    feedEpoch,
    bcEpoch,
    prevTailSegId: null,
    hadPrevTail: false,
    done: false,
    utterances: null,
    broadcastResult: null,
    error: null,
    latestStream: null,
  };

  vadPendingJobs.push(job);
  vadCommitQueue.push(job);
  if (modeAtCapture === 'broadcast') {
    broadcastPendingCount += 1;
    syncBroadcastPendingInline();
  } else {
    pendingCount += 1;
    syncPendingPillDom();
  }
  updateHeaderStatus();
  pumpVadPipeline();
}

function pumpVadPipeline() {
  const maxConc = settings.turboMode && !turboThrottled ? 2 : 1;
  while (vadInFlight < maxConc && vadPendingJobs.length > 0) {
    const job = vadPendingJobs.shift();
    const isStale = job.mode === 'broadcast' ? job.bcEpoch !== bcEpoch : job.feedEpoch !== feedEpoch;
    if (isStale) {
      job.done = true;
      drainVadCommits();
      continue;
    }
    vadInFlight += 1;
    runVadJob(job);
  }
}

async function runVadJob(job) {
  try {
    if (job.mode === 'broadcast') {
      // Check if an earlier broadcast job is still in flight (Turbo parallel overlap)
      const hasEarlierBcInFlight = vadCommitQueue.some(
        (other) => other.seq < job.seq && other.mode === 'broadcast' && !other.done
      );
      const tail = !hasEarlierBcInFlight ? getBroadcastTailSegment() : null;
      job.prevTailSegId = tail ? tail.seg.id : null;
      job.hadPrevTail = !hasEarlierBcInFlight;

      const priorContext = getBroadcastPriorContext(
        job.prevTailSegId,
        settings.turboMode ? 180 : 260
      );

      job.broadcastResult = await callWithOpusFallback(job.wav, (audioPayload) =>
        interpretBroadcastAudio({
          apiKey: settings.apiKey,
          model: settings.model,
          wavBase64: audioPayload.base64,
          mimeType: audioPayload.mimeType,
          preferredLang: job.targetLang,
          glossary: settings.glossary || '',
          prevTailText: tail ? tail.seg.text : '',
          priorContext,
          onStream: ({ currentZh, revising }) => {
            job.latestStream = { currentZh, revising };
            if (vadCommitQueue[0] === job && job.bcEpoch === bcEpoch) {
              if (currentZh) {
                upsertBroadcastStreamSpan(currentZh);
              }
              if (revising && els.broadcastHint) {
                els.broadcastHint.textContent = '✨ 正在依新語境回頭潤飾前句⋯';
                els.broadcastHint.classList.add('revised-notice');
              }
            }
          },
        })
      );
    } else {
      const onStream = (chunk) => {
        job.latestStream = chunk;
        // Only paint live streaming card for the oldest uncommitted job so parallel Turbo jobs never flicker!
        if (vadCommitQueue[0] === job && job.feedEpoch === feedEpoch) {
          upsertDraftCaptionDom('');
          upsertStreamingCardDom(chunk);
        }
      };

      job.utterances = await callWithOpusFallback(job.wav, (audioPayload) =>
        interpretDialogueAudio({
          apiKey: settings.apiKey,
          model: settings.model,
          wavBase64: audioPayload.base64,
          mimeType: audioPayload.mimeType,
          targetLang: job.targetLang,
          tone: job.tone,
          glossary: settings.glossary || '',
          speakerMemory,
          recentContext: messages.slice(-job.contextLimit),
          contextLimit: job.contextLimit,
          onStream,
        })
      );
    }
  } catch (err) {
    job.error = err;
  } finally {
    job.done = true;
    vadInFlight = Math.max(0, vadInFlight - 1);
    drainVadCommits();
    pumpVadPipeline();
  }
}

function drainVadCommits() {
  let addedDialogue = false;
  let committedUnpolishedTurboBc = false;

  while (vadCommitQueue.length > 0 && vadCommitQueue[0].done) {
    const job = vadCommitQueue.shift();

    if (job.mode === 'broadcast') {
      if (broadcastPendingCount > 0) broadcastPendingCount -= 1;
      if (job.bcEpoch !== bcEpoch) continue;

      clearBroadcastStreamSpan();
      if (job.error) {
        console.error('Broadcast interpret error:', job.error);
        showToast(job.error.message || '聆聽翻譯失敗，請稍後再試', 3800);
        continue;
      }
      if (job.broadcastResult) {
        applyBroadcastCommit(job, job.broadcastResult);
        if (!job.hadPrevTail) {
          committedUnpolishedTurboBc = true;
        }
      }
      continue;
    }

    // Dialogue job commit
    if (pendingCount > 0) pendingCount -= 1;
    if (job.feedEpoch !== feedEpoch) continue;

    clearStreamingCardDom();

    if (job.error) {
      console.error('VAD interpret error:', job.error);
      showToast(job.error.message || '翻譯失敗，請稍後再試', 3800);
      continue;
    }

    const utterances = Array.isArray(job.utterances) ? job.utterances : [];
    for (const u of utterances) {
      let msg;
      if (u.direction === 'outbound') {
        msg = {
          id: makeId(),
          direction: 'outbound',
          speaker: '我',
          lang: 'zh',
          targetLang: u.targetLang || job.targetLang,
          isChinese: true,
          zh: u.zh || u.original,
          translated: u.translated || u.zh,
          reading: u.reading || '',
          time: nowTimeStr(),
        };
      } else {
        if (!speakerMemory[u.speaker]) {
          speakerMemory[u.speaker] = { voiceHint: u.voiceHint || '', customName: '' };
        } else if (u.voiceHint) {
          speakerMemory[u.speaker].voiceHint = u.voiceHint;
        }
        msg = {
          id: makeId(),
          direction: 'inbound',
          speaker: u.speaker || 'A',
          lang: u.sourceLang || u.lang || job.targetLang,
          isChinese: Boolean(u.isChinese),
          original: u.original,
          zh: u.zh,
          time: nowTimeStr(),
        };
      }

      messages.push(msg);
      appendMessageCard(msg);
      addedDialogue = true;
    }
  }

  if (addedDialogue) {
    saveState();
  }

  // Hand off live streaming preview smoothly if a second parallel Turbo job already has partial output
  const nextHead = vadCommitQueue[0];
  if (nextHead && nextHead.latestStream) {
    if (nextHead.mode === 'broadcast' && nextHead.bcEpoch === bcEpoch && nextHead.latestStream.currentZh) {
      upsertBroadcastStreamSpan(nextHead.latestStream.currentZh);
    } else if (nextHead.mode === 'dialogue' && nextHead.feedEpoch === feedEpoch) {
      upsertStreamingCardDom(nextHead.latestStream);
    }
  }

  // If a Turbo parallel broadcast burst just settled, automatically run one tiny text-only polish (~0.1x cost)
  const hasMoreBroadcastPending = vadCommitQueue.some((j) => j.mode === 'broadcast');
  if (committedUnpolishedTurboBc && !hasMoreBroadcastPending) {
    const lastPara = broadcastParagraphs[broadcastParagraphs.length - 1];
    if (lastPara && lastPara.segments.length >= 2 && lastPara.segments.some((s) => s.needsPolish)) {
      polishBroadcastTail(false);
    }
  }

  syncPendingPillDom();
  syncBroadcastPendingInline();
  updateHeaderStatus();
}

// Dual-Gesture Speak Button: Press-and-Hold (Walkie-Talkie) OR Tap-to-Toggle
let speakPressActive = false;
let speakPressDownTs = 0;
let speakWasRecOnDown = false;
let speakStarting = false;
let speakPendingStop = false;
let speakHoldMode = false;

async function beginManualRecording() {
  if (!settings.apiKey) {
    showToast('請先填入 Gemini API Key');
    openSettings();
    return false;
  }
  speakStarting = true;
  try {
    await audio.startManualCapture();
    speakStarting = false;
    isManualRecording = true;
    manualStartTime = Date.now();
    startDraftRecognition('zh');
    haptic(15);
    syncWakeLock();
    els.speakChineseBtn.classList.add('recording');
    els.cancelRecBtn.classList.add('visible');
    if (els.cameraBtn) els.cameraBtn.classList.add('hidden');
    updateManualTimer();
    manualTimerHandle = setInterval(updateManualTimer, 250);
    updateHeaderStatus();

    if (speakPendingStop) {
      speakPendingStop = false;
      await finishManualRecording();
    }
    return true;
  } catch (err) {
    speakStarting = false;
    speakPendingStop = false;
    console.error(err);
    showToast(`無法啟動麥克風：${err.message}`, 3500);
    return false;
  }
}

async function finishManualRecording() {
  if (!isManualRecording) return;
  clearInterval(manualTimerHandle);
  manualTimerHandle = null;
  isManualRecording = false;
  speakHoldMode = false;
  stopDraftRecognition(true);
  if (activeMode && !isLiveActive) {
    startDraftRecognition(settings.targetLang);
  }
  haptic([12, 35, 18]);
  syncWakeLock();
  els.speakChineseBtn.classList.remove('recording');
  els.cancelRecBtn.classList.remove('visible');
  if (els.cameraBtn) els.cameraBtn.classList.remove('hidden');
  updateSwitchUI();

  const wav = await audio.stopManualCapture();
  if (!wav) {
    showToast('錄音時間太短，請再試一次');
    return;
  }

  await runOutboundTranslation({ wav });
}

function handleSpeakPointerDown(e) {
  if (e.button && e.button > 0) return;
  e.preventDefault();
  try {
    els.speakChineseBtn.setPointerCapture(e.pointerId);
  } catch (_) {}

  speakPressActive = true;
  speakPressDownTs = performance.now();
  speakWasRecOnDown = isManualRecording;

  if (!isManualRecording && !speakStarting) {
    speakHoldMode = true;
    speakPendingStop = false;
    beginManualRecording();
  }
}

function handleSpeakPointerUp(e) {
  if (!speakPressActive) return;
  e.preventDefault();
  speakPressActive = false;
  const heldMs = performance.now() - speakPressDownTs;

  if (speakWasRecOnDown) {
    // Second tap stops tap-to-toggle recording
    finishManualRecording();
    return;
  }

  if (heldMs >= 380) {
    // Walkie-talkie release: stop and translate immediately
    if (speakStarting) {
      speakPendingStop = true;
    } else {
      finishManualRecording();
    }
  } else {
    // Quick tap (<380ms): stay in hands-free tap-to-toggle mode
    speakHoldMode = false;
    if (isManualRecording) updateManualTimer();
  }
}

function handleSpeakPointerCancel() {
  speakPressActive = false;
  speakHoldMode = false;
  if (isManualRecording) updateManualTimer();
}

function cancelManualChineseSpeak() {
  if (!isManualRecording && !speakStarting) return;
  speakPendingStop = false;
  speakPressActive = false;
  speakHoldMode = false;
  clearInterval(manualTimerHandle);
  manualTimerHandle = null;
  isManualRecording = false;
  stopDraftRecognition(true);
  if (activeMode && !isLiveActive) {
    startDraftRecognition(settings.targetLang);
  }
  audio.cancelManualCapture();
  haptic(10);
  syncWakeLock();
  els.speakChineseBtn.classList.remove('recording');
  els.cancelRecBtn.classList.remove('visible');
  if (els.cameraBtn) els.cameraBtn.classList.remove('hidden');
  updateSwitchUI();
  showToast('已取消錄音');
}

function updateManualTimer() {
  const sec = Math.floor((Date.now() - manualStartTime) / 1000);
  els.speakBtnLabel.textContent = speakHoldMode
    ? `收音中 ${sec}s — 放開立即翻譯`
    : `錄音中 ${sec}s — 再點一下自動翻譯`;
}

function toggleKeyboardInput(forceState) {
  const willOpen =
    typeof forceState === 'boolean'
      ? forceState
      : els.quickTextRow.classList.contains('collapsed');
  els.quickTextRow.classList.toggle('collapsed', !willOpen);
  els.keyboardToggleBtn.classList.toggle('active', willOpen);
  haptic(8);
  if (willOpen) {
    requestAnimationFrame(() => els.quickChineseInput.focus());
  } else {
    els.quickChineseInput.blur();
  }
}

async function handleQuickTextSend() {
  const text = els.quickChineseInput.value.trim();
  if (!text) return;
  const hasCachedHit = Boolean(lookupPhraseCache(text, settings.targetLang, settings.tone, settings.glossary));
  if (!hasCachedHit) {
    if (!settings.apiKey) {
      showToast('請先填入 Gemini API Key');
      openSettings();
      return;
    }
    if (!isOnline) {
      showToast('目前處於離線狀態，無法翻譯');
      return;
    }
  }
  els.quickChineseInput.value = '';
  els.quickChineseInput.blur();
  haptic(10);
  audio.unlockPlayback();
  await runOutboundTranslation({ textInput: text });
}

function buildOutboundMessageFromResult(result) {
  return result.isSourceChinese
    ? {
        id: makeId(),
        direction: 'outbound',
        speaker: '我',
        lang: 'zh',
        targetLang: result.targetLang,
        isChinese: true,
        zh: result.sourceText,
        translated: result.translated,
        reading: result.reading,
        time: nowTimeStr(),
      }
    : {
        id: makeId(),
        direction: 'inbound',
        speaker: '譯',
        lang: result.sourceLang,
        isChinese: false,
        original: result.sourceText,
        zh: result.translated,
        time: nowTimeStr(),
      };
}

async function runOutboundTranslation({ wav = null, textInput = null }) {
  // Zero-risk exact-match local cache for repeated typed phrases (0ms latency, 0 API tokens; never used for voice)
  if (textInput && !wav) {
    const cached = lookupPhraseCache(textInput, settings.targetLang, settings.tone, settings.glossary);
    if (cached) {
      const msg = buildOutboundMessageFromResult(cached);
      messages.push(msg);
      saveState();
      appendMessageCard(msg, true);
      return;
    }
  }

  pendingCount += 1;
  syncPendingPillDom();
  updateHeaderStatus();
  const ctxLimit = settings.turboMode ? 2 : 5;
  const targetLangAtReq = settings.targetLang;
  const toneAtReq = settings.tone;
  const glossaryAtReq = settings.glossary || '';

  try {
    const invokeTranslate = (audioPayload) =>
      translateOutboundChinese({
        apiKey: settings.apiKey,
        model: settings.model,
        targetLang: targetLangAtReq,
        tone: toneAtReq,
        glossary: glossaryAtReq,
        wavBase64: audioPayload ? audioPayload.base64 : null,
        mimeType: audioPayload ? audioPayload.mimeType : 'audio/wav',
        textInput,
        recentContext: messages.slice(-ctxLimit),
        contextLimit: ctxLimit,
        onStream: (chunk) => {
          upsertDraftCaptionDom('');
          upsertStreamingCardDom(chunk);
        },
      });

    const result = wav ? await callWithOpusFallback(wav, invokeTranslate) : await invokeTranslate(null);

    clearStreamingCardDom();

    if (!result) {
      showToast('沒有辨識到清晰的語音或文字，請再試一次');
      return;
    }

    if (textInput && !wav) {
      storePhraseCache(textInput, targetLangAtReq, toneAtReq, glossaryAtReq, result);
    }

    const msg = buildOutboundMessageFromResult(result);
    messages.push(msg);
    saveState();
    appendMessageCard(msg, true);
  } catch (err) {
    clearStreamingCardDom();
    console.error('Outbound translate error:', err);
    showToast(err.message, 3800);
  } finally {
    if (pendingCount > 0) pendingCount -= 1;
    syncPendingPillDom();
    updateHeaderStatus();
  }
}

// Photo / Menu / Document Translation (Client-side JPEG compression -> Gemini multimodal)
function compressImageFile(file, maxDim = 1280, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const makeCanvasDataUrl = (limit, q) => {
          let { width, height } = img;
          const scale = Math.min(1, limit / Math.max(width, height));
          width = Math.max(1, Math.round(width * scale));
          height = Math.max(1, Math.round(height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          return canvas.toDataURL('image/jpeg', q);
        };
        const apiDataUrl = makeCanvasDataUrl(maxDim, quality);
        const thumbUrl = makeCanvasDataUrl(220, 0.65);
        const base64 = apiDataUrl.split(',')[1];
        resolve({ base64, mimeType: 'image/jpeg', thumbUrl });
      } catch (err) {
        reject(err);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('無法讀取這張圖片'));
    };
    img.src = url;
  });
}

async function handlePhotoFileSelected(file) {
  if (!file) return;
  if (file.type && !file.type.startsWith('image/')) {
    showToast('請選擇圖片檔案（JPG／PNG／WebP）');
    return;
  }
  if (typeof file.size === 'number' && file.size > 25 * 1024 * 1024) {
    showToast('圖片檔案過大（上限 25 MB），請重新拍攝或選擇較小照片');
    return;
  }
  if (!settings.apiKey) {
    showToast('請先填入 Gemini API Key 才能使用拍照翻譯');
    openSettings();
    return;
  }
  if (!isOnline) {
    showToast('目前處於離線狀態，無法辨識圖片');
    return;
  }

  haptic(12);
  pendingCount += 1;
  syncPendingPillDom();
  updateHeaderStatus();
  showToast('正在辨識圖片並翻譯⋯', 2200);

  try {
    const { base64, mimeType, thumbUrl } = await compressImageFile(file);
    const result = await translateImageWithGemini({
      apiKey: settings.apiKey,
      model: settings.model,
      imageBase64: base64,
      mimeType,
      targetLang: settings.targetLang,
    });

    if (!result) {
      showToast('圖片翻譯失敗，請換一張更清晰的照片再試');
      return;
    }

    const msg = {
      id: makeId(),
      type: 'photo',
      direction: 'inbound',
      speaker: '拍照',
      lang: result.sourceLang,
      targetLang: result.targetLang,
      isSourceChinese: result.isSourceChinese,
      isChinese: result.isSourceChinese,
      title: result.title,
      summary: result.summary,
      zh: result.summary,
      items: result.items,
      thumbUrl,
      time: nowTimeStr(),
    };

    messages.push(msg);
    saveState();
    appendMessageCard(msg, true);
    haptic([10, 30, 14]);
  } catch (err) {
    console.error('Photo translate error:', err);
    showToast(err.message, 3800);
  } finally {
    if (pendingCount > 0) pendingCount -= 1;
    syncPendingPillDom();
    updateHeaderStatus();
  }
}

// Show Card ("面對面破冰大字卡")
function openShowcard(msg) {
  activeShowcardMsg = msg;
  const isOutbound = msg.direction === 'outbound';
  const displayLang = isOutbound ? msg.targetLang : 'zh';
  const bannerText = ICEBREAKER_BANNERS[displayLang] || ICEBREAKER_BANNERS.en;

  if (els.showcardBanner) {
    renderFlagLabel(els.showcardBanner, { flagCode: displayLang, text: bannerText });
  }
  els.showcardMain.textContent = isOutbound ? msg.translated : msg.zh;
  els.showcardReading.textContent = isOutbound && msg.reading ? msg.reading : '';
  els.showcardSub.textContent = isOutbound ? msg.zh : (!msg.isChinese ? msg.original : '');
  els.showcardContent.classList.remove('flipped');
  els.showcardOverlay.classList.add('open');
  els.showcardOverlay.setAttribute('aria-hidden', 'false');
  haptic(10);
  syncWakeLock();
}

function closeShowcard() {
  els.showcardOverlay.classList.remove('open');
  els.showcardOverlay.setAttribute('aria-hidden', 'true');
  activeShowcardMsg = null;
  syncWakeLock();
}

// Settings Sheet
function openSettings() {
  els.apiKeyInput.value = settings.apiKey;
  els.modelSelect.value = settings.model;
  if (els.useLiveInDialogueCheck) {
    els.useLiveInDialogueCheck.checked = Boolean(settings.useLiveInDialogue);
  }
  if (els.liveModelSelect) {
    els.liveModelSelect.value = settings.liveModel || 'gemini-3.8-live';
  }
  els.ttsModelSelect.value = settings.ttsModel;
  els.voiceSelect.value = settings.voiceName;
  els.toneSelect.value = settings.tone;
  if (els.glossaryInput) els.glossaryInput.value = settings.glossary || '';
  const validSilences = ['600', '750', '1100', '1600'];
  const silStr = validSilences.includes(String(settings.silenceMs)) ? String(settings.silenceMs) : '750';
  els.silenceSelect.value = silStr;
  els.vadThresholdSelect.value = String(settings.vadThreshold);
  if (els.draftCaptionCheck) els.draftCaptionCheck.checked = Boolean(settings.draftCaption);
  if (els.liveAutoSpeakCheck) els.liveAutoSpeakCheck.checked = Boolean(settings.liveAutoSpeak);
  els.showOriginalCheck.checked = settings.showOriginal;
  els.testResult.textContent = '';
  els.testResult.className = 'test-result';
  els.settingsSheet.classList.add('open');
  els.settingsSheet.setAttribute('aria-hidden', 'false');
}

function closeSettings() {
  // Always re-mask API Key input when closing settings so it never stays exposed in plaintext
  if (els.apiKeyInput) els.apiKeyInput.type = 'password';
  if (els.toggleKeyVisibility) els.toggleKeyVisibility.textContent = '顯示';
  els.settingsSheet.classList.remove('open');
  els.settingsSheet.setAttribute('aria-hidden', 'true');
}

function saveSettingsFromForm() {
  const prevTts = settings.ttsModel;
  const prevVoice = settings.voiceName;
  const prevLiveModel = settings.liveModel;
  const prevUseLive = Boolean(settings.useLiveInDialogue);
  const prevTone = settings.tone;
  const prevGlossary = settings.glossary || '';

  settings.apiKey = els.apiKeyInput.value.trim();
  settings.model = els.modelSelect.value;
  if (els.useLiveInDialogueCheck) settings.useLiveInDialogue = els.useLiveInDialogueCheck.checked;
  if (els.liveModelSelect) settings.liveModel = els.liveModelSelect.value;
  settings.ttsModel = els.ttsModelSelect.value;
  settings.voiceName = els.voiceSelect.value;
  settings.tone = els.toneSelect.value;
  if (els.glossaryInput) settings.glossary = els.glossaryInput.value.trim().slice(0, 300);
  settings.silenceMs = Number(els.silenceSelect.value);
  settings.vadThreshold = Number(els.vadThresholdSelect.value);
  if (els.draftCaptionCheck) settings.draftCaption = els.draftCaptionCheck.checked;
  if (els.liveAutoSpeakCheck) settings.liveAutoSpeak = els.liveAutoSpeakCheck.checked;
  settings.showOriginal = els.showOriginalCheck.checked;

  if (prevTts !== settings.ttsModel || prevVoice !== settings.voiceName) {
    audio.clearTtsCache();
  }

  applyActiveAudioProfile();

  if (!settings.draftCaption) {
    stopDraftRecognition(true);
  } else if (activeMode === 'dialogue' && !isLiveActive) {
    startDraftRecognition(settings.targetLang);
  }

  // If currently in Dialogue mode and Live toggle or Live parameters changed, transition cleanly
  if (activeMode === 'dialogue') {
    if (prevUseLive !== Boolean(settings.useLiveInDialogue)) {
      const epoch = ++sessionEpoch;
      if (settings.useLiveInDialogue) {
        isLiveActive = true;
        startLiveSession({ resume: false, epoch }).catch((err) => {
          if (epoch !== sessionEpoch) return;
          isLiveActive = false;
          applyActiveAudioProfile();
          audio.startListening().catch(() => {});
          updateSwitchUI();
          showToast(`Live 啟動失敗，維持標準對話：${err.message}`, 3500);
        });
      } else {
        stopLiveSession(false);
        isLiveActive = false;
        applyActiveAudioProfile();
        audio.startListening().then(() => {
          if (epoch !== sessionEpoch) return;
          startDraftRecognition(settings.targetLang);
          els.vadStatus.textContent = getIdleVadHint();
          updateSwitchUI();
        }).catch(() => {});
      }
    } else if (
      isLiveActive &&
      liveConnected &&
      (prevLiveModel !== settings.liveModel ||
        prevVoice !== settings.voiceName ||
        prevTone !== settings.tone ||
        prevGlossary !== settings.glossary)
    ) {
      const epoch = ++sessionEpoch;
      startLiveSession({ resume: false, epoch }).catch((err) =>
        showToast(`重新連線 Live 失敗：${err.message}`, 3500)
      );
    }
  }

  saveState();
  applyTheme();
  updateSwitchUI();
  closeSettings();
  showToast('設定已儲存於本機');
}

// Export Transcript (context-aware: exports continuous Chinese paragraphs in Broadcast view, or conversation log in Dialogue view)
async function exportTranscript() {
  if (viewMode === 'broadcast') {
    const bcText = getBroadcastFullText();
    if (!bcText) {
      showToast('目前沒有可匯出的聆聽譯文');
      return;
    }
    const content = `隨身口譯官 — 聆聽翻譯紀錄 (${new Date().toLocaleDateString('zh-TW')})\n\n${bcText}\n`;
    if (navigator.share) {
      try {
        await navigator.share({ title: '隨身口譯官聆聽譯文', text: content });
        return;
      } catch (_) {}
    }
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `broadcast-zh-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('已下載純中文譯文檔');
    return;
  }

  if (messages.length === 0) {
    showToast('目前沒有可匯出的對話紀錄');
    return;
  }

  const lines = messages.map((m) => {
    if (m.type === 'photo') {
      const itemsText = (m.items || [])
        .map((it) => `    - ${it.translated}${it.original ? ` (${it.original})` : ''}${it.note ? ` [${it.note}]` : ''}`)
        .join('\n');
      return `[${m.time}] 📷 ${m.title || '拍照翻譯'}: ${m.summary || ''}${itemsText ? `\n${itemsText}` : ''}`;
    }
    const sp = displaySpeakerName(m.speaker, m.direction === 'outbound');
    if (m.direction === 'outbound') {
      const targetInfo = TARGET_LANGUAGES[m.targetLang] || TARGET_LANGUAGES.en;
      return `[${m.time}] ${sp} (中→${targetInfo.label}): ${m.translated}\n    原話：${m.zh}`;
    }
    if (m.isChinese) {
      return `[${m.time}] ${sp}: ${m.zh}`;
    }
    const shortLang = LANG_BADGE_MAP[m.lang] || String(m.lang || '外語').toUpperCase();
    return `[${m.time}] ${sp} (${shortLang}→中): ${m.zh}\n    原文：${m.original}`;
  });

  const content = `隨身口譯官 — 對話紀錄 (${new Date().toLocaleDateString('zh-TW')})\n\n${lines.join('\n\n')}\n`;

  if (navigator.share) {
    try {
      await navigator.share({ title: '隨身口譯官對話紀錄', text: content });
      return;
    } catch (_) {}
  }

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `translator-log-${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('已下載文字紀錄檔');
}

// Demo Mode (so user can try UI, speaker renaming, flip card & TTS immediately)
function loadDemoConversation() {
  speakerMemory = {
    A: { voiceHint: '男聲・英語', customName: '' },
    B: { voiceHint: '女聲・日語', customName: '' },
    C: { voiceHint: '男聲・瑞典語', customName: '' },
  };
  const t = nowTimeStr();
  messages = [
    {
      id: makeId(),
      direction: 'inbound',
      speaker: 'A',
      lang: 'en',
      isChinese: false,
      original: 'Hey! Welcome to Stockholm. How was your flight?',
      zh: '嗨！歡迎來到斯德哥爾摩。你的班機順利嗎？',
      time: t,
    },
    {
      id: makeId(),
      direction: 'inbound',
      speaker: 'B',
      lang: 'zh',
      isChinese: true,
      original: '飛得蠻順的，就是有點時差，謝謝你來接我！',
      zh: '飛得蠻順的，就是有點時差，謝謝你來接我！',
      time: t,
    },
    {
      id: makeId(),
      direction: 'inbound',
      speaker: 'C',
      lang: 'sv',
      isChinese: false,
      original: 'Vill du ta en fika först, eller åka direkt till hotellet?',
      zh: '你想先去喝杯咖啡吃點心（fika），還是直接去飯店？',
      time: t,
    },
    {
      id: makeId(),
      direction: 'outbound',
      speaker: '我',
      lang: 'zh',
      targetLang: 'sv',
      isChinese: true,
      zh: '先喝杯熱拿鐵好了，我超期待試試瑞典的肉桂捲！',
      translated: 'En varm latte låter toppen, jag ser verkligen fram emot att prova en svensk kanelbulle!',
      reading: '重音提示：KA-nel-bul-le（肉桂捲）／ FIK-a',
      time: t,
    },
    {
      id: makeId(),
      direction: 'inbound',
      speaker: 'B',
      lang: 'ja',
      isChinese: false,
      original: 'こちらのカフェはシナモンロールがとても有名ですよ。',
      zh: '這間咖啡廳的肉桂捲非常有名喔。',
      time: t,
    },
  ];
  saveState();
  renderFeed();
  showToast('已載入多語示範！點文字可放大給對方看，點 🔊 可試聽');
}

// Audio Callbacks
const waveBarSpans = Array.from(els.waveBars.querySelectorAll('span'));
const barWeights = [0.55, 0.9, 1.0, 0.85, 0.5];

audio.onLevel = (rms, mode) => {
  if (mode === 'muted') {
    waveBarSpans.forEach((s) => (s.style.height = '4px'));
    return;
  }
  const norm = Math.min(1, rms / 0.08);
  waveBarSpans.forEach((s, i) => {
    const jitter = 0.75 + Math.random() * 0.45;
    const h = Math.max(4, Math.round(4 + norm * 14 * barWeights[i] * jitter));
    s.style.height = `${h}px`;
  });
};

audio.onVadStateChange = (speaking) => {
  if (isLiveActive || !activeMode) return;
  if (!speaking) {
    els.vadStatus.textContent = getIdleVadHint();
    return;
  }
  if (activeMode === 'broadcast') {
    els.vadStatus.textContent =
      settings.turboMode && !turboThrottled
        ? '⚡ Turbo 收聽中⋯即時連翻純中文＋自動潤飾'
        : '📻 收聽語音中⋯即將連翻純中文並潤飾前句';
  } else {
    els.vadStatus.textContent =
      settings.turboMode && !turboThrottled
        ? '⚡ Turbo 收音中⋯停頓即並行互譯'
        : '💬 偵測到對話，收音中⋯停頓後自動互譯';
  }
};

audio.onCaptureProgress = (sec) => {
  if (isLiveActive || !activeMode || !audio.isSpeaking) return;
  if (activeMode === 'broadcast') {
    els.vadStatus.textContent =
      settings.turboMode && !turboThrottled
        ? `⚡ Turbo 收聽中（${sec}s・極速純中文）`
        : `📻 純中文收聽中（已收 ${sec}s・自動連翻）`;
  } else if (sec >= 2) {
    els.vadStatus.textContent =
      settings.turboMode && !turboThrottled
        ? `⚡ Turbo 對話收音中（${sec}s）`
        : `💬 對話收音中（${sec}s・停頓自動互譯）`;
  }
};

audio.onVadSegment = (wav) => {
  enqueueVadSegment(wav);
};

audio.onPlaybackChange = () => {
  syncPlaybackButtons();
  updateHeaderStatus();
};

// Event Wiring
if (els.dialogueSwitch) {
  els.dialogueSwitch.addEventListener('click', () => toggleScenario('dialogue'));
}
if (els.broadcastSwitch) {
  els.broadcastSwitch.addEventListener('click', () => toggleScenario('broadcast'));
}
if (els.turboBtn) {
  els.turboBtn.addEventListener('click', toggleTurboMode);
}

// Broadcast Reader Toolbar & Paused Controls
if (els.bcFontBtn) {
  els.bcFontBtn.addEventListener('click', () => {
    const idx = BC_FONT_ORDER.indexOf(settings.broadcastFontSize);
    settings.broadcastFontSize = BC_FONT_ORDER[(idx + 1) % BC_FONT_ORDER.length];
    haptic(8);
    applyBroadcastFont();
    saveState();
  });
}

if (els.bcPolishBtn) {
  els.bcPolishBtn.addEventListener('click', () => {
    haptic(10);
    polishBroadcastTail(true);
  });
}

if (els.bcCopyBtn) {
  els.bcCopyBtn.addEventListener('click', async () => {
    const text = getBroadcastFullText();
    if (!text) {
      showToast('目前沒有可複製的中文內容');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      haptic(10);
      showToast('已複製整篇中文譯文');
    } catch (_) {
      showToast('複製失敗');
    }
  });
}

if (els.bcDemoBtn) {
  els.bcDemoBtn.addEventListener('click', runBroadcastDemo);
}

if (els.bcResumeBtn) {
  els.bcResumeBtn.addEventListener('click', () => toggleScenario('broadcast'));
}

if (els.bcBackToChatBtn) {
  els.bcBackToChatBtn.addEventListener('click', () => {
    viewMode = 'dialogue';
    haptic(8);
    updateSwitchUI();
  });
}

if (els.toneQuickBtn) {
  els.toneQuickBtn.addEventListener('click', () => {
    const idx = TONE_ORDER.indexOf(settings.tone);
    settings.tone = TONE_ORDER[(idx + 1) % TONE_ORDER.length];
    haptic(10);
    saveState();
    updateSwitchUI();
    showToast((TONE_META[settings.tone] || TONE_META.natural).toast, 2200);
    if (activeMode === 'dialogue' && isLiveActive && liveConnected) {
      const epoch = ++sessionEpoch;
      startLiveSession({ resume: false, epoch }).catch(() => {});
    }
  });
}

els.langBar.addEventListener('click', (e) => {
  const pill = e.target.closest('.lang-pill');
  if (!pill) return;
  const changed = settings.targetLang !== pill.dataset.lang;
  settings.targetLang = pill.dataset.lang;
  haptic(10);
  saveState();
  updateSwitchUI();
  if (changed) {
    const langInfo = TARGET_LANGUAGES[settings.targetLang] || TARGET_LANGUAGES.en;
    if (activeMode === 'dialogue' && isLiveActive && liveConnected) {
      showToast(`Live 串流切換語言為「${langInfo.label}」⋯`, 2000);
      const epoch = ++sessionEpoch;
      startLiveSession({ resume: false, epoch }).catch(() => {});
    } else {
      showToast(`已切換為${langInfo.flag} ${langInfo.label}`, 1400);
      if (activeMode && !isLiveActive) {
        if (!audio.isSpeaking) {
          els.vadStatus.textContent = getIdleVadHint();
        }
        if (activeMode === 'dialogue') {
          startDraftRecognition(settings.targetLang);
        }
      }
    }
  }
});

els.flushBtn.addEventListener('click', () => {
  if (activeMode === 'dialogue' && isLiveActive) {
    const ok = liveClient.flushAudioStream();
    showToast(ok ? '已送出目前語音片段' : 'Live 尚未連線就緒');
    return;
  }
  const flushed = audio.flushListeningNow();
  if (!flushed) {
    showToast('目前沒有待送出的語音片段');
  }
});

window.addEventListener('online', () => {
  isOnline = true;
  updateHeaderStatus();
  showToast('網路已恢復連線', 2000);
});

window.addEventListener('offline', () => {
  isOnline = false;
  updateHeaderStatus();
  showToast('目前處於離線狀態，等待網路恢復⋯', 3000);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (els.showcardOverlay.classList.contains('open')) {
    closeShowcard();
  } else if (els.settingsSheet.classList.contains('open')) {
    closeSettings();
  }
});

window.addEventListener('beforeunload', () => {
  if (liveConnected || liveConnecting) {
    stopLiveSession(true);
  }
});

// Dual-gesture speak button (Hold-to-speak OR Tap-to-toggle)
els.speakChineseBtn.addEventListener('pointerdown', handleSpeakPointerDown);
els.speakChineseBtn.addEventListener('pointerup', handleSpeakPointerUp);
els.speakChineseBtn.addEventListener('pointercancel', handleSpeakPointerCancel);
els.speakChineseBtn.addEventListener('contextmenu', (e) => e.preventDefault());
els.cancelRecBtn.addEventListener('click', cancelManualChineseSpeak);

// Collapsible keyboard text input
if (els.keyboardToggleBtn) {
  els.keyboardToggleBtn.addEventListener('click', () => toggleKeyboardInput());
}

// Camera / Photo translation
if (els.cameraBtn && els.cameraInput) {
  els.cameraBtn.addEventListener('click', () => {
    if (!settings.apiKey) {
      showToast('請先填入 Gemini API Key 才能使用拍照翻譯');
      openSettings();
      return;
    }
    haptic(8);
    els.cameraInput.click();
  });
  els.cameraInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) handlePhotoFileSelected(file);
  });
}

els.quickSendBtn.addEventListener('click', handleQuickTextSend);
els.quickChineseInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    handleQuickTextSend();
  } else if (e.key === 'Escape') {
    toggleKeyboardInput(false);
  }
});

els.themeBtn.addEventListener('click', () => {
  settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
  saveState();
  applyTheme();
});

els.exportBtn.addEventListener('click', exportTranscript);

function clearCurrentTranslations(targetView = viewMode) {
  haptic(12);
  if (targetView === 'broadcast') {
    const hadContent = broadcastParagraphs.length > 0 || Boolean(bcStreamText);
    if (!hadContent) {
      showToast('目前沒有已翻譯的聆聽內容', 1600);
      return;
    }
    const backupParagraphs = broadcastParagraphs.slice();
    clearTimeout(bcDemoTimer);
    bcEpoch += 1;
    clearBroadcastStreamSpan();
    const pendingInline = document.getElementById('bcPendingInline');
    if (pendingInline) pendingInline.remove();
    if (activeMode === 'broadcast') {
      audio.resetActiveSpeechBuffer();
    }
    broadcastParagraphs = [];
    saveState();
    renderBroadcastCanvas(true);
    if (els.broadcastHint) {
      clearTimeout(bcHintTimer);
      els.broadcastHint.classList.remove('revised-notice');
      els.broadcastHint.textContent = '純繁體中文・自動回頭潤飾語意';
    }
    showToast('已清除聆聽譯文，從頭開始', 4800, {
      label: '復原',
      onClick: () => {
        if (broadcastParagraphs.length === 0) {
          broadcastParagraphs = backupParagraphs;
          saveState();
          renderBroadcastCanvas(true);
          showToast('已復原剛剛清除的聆聽譯文', 1800);
        }
      },
    });
    return;
  }

  const hadDialogue = messages.length > 0 || Boolean(activeStreamState) || Boolean(currentDraftText);
  if (!hadDialogue) {
    showToast('目前沒有已翻譯的對話內容', 1600);
    return;
  }
  const backupMessages = messages.slice();
  const backupSpeakers = JSON.parse(JSON.stringify(speakerMemory));
  feedEpoch += 1;
  cancelActiveSpeak();
  audio.clearTtsCache();
  clearStreamingCardDom();
  upsertDraftCaptionDom('');
  const pendingPill = document.getElementById('pendingPill');
  if (pendingPill) pendingPill.remove();
  if (activeMode === 'dialogue' && !isLiveActive) {
    audio.resetActiveSpeechBuffer();
  }
  // If Live WebSocket is active, restart a clean session so AI forgets old context
  if (activeMode === 'dialogue' && isLiveActive && liveConnected) {
    const epoch = ++sessionEpoch;
    startLiveSession({ resume: false, epoch }).catch(() => {});
  }
  messages = [];
  speakerMemory = {};
  openSpeakerPickerMsgId = null;
  saveState();
  renderFeed(true);
  showToast('已清除翻譯內容，從頭開始', 4800, {
    label: '復原',
    onClick: () => {
      if (messages.length === 0) {
        messages = backupMessages;
        speakerMemory = backupSpeakers;
        saveState();
        renderFeed(true);
        showToast('已復原剛剛清除的對話內容', 1800);
      }
    },
  });
}

els.clearBtn.addEventListener('click', () => clearCurrentTranslations(viewMode));
if (els.bcClearBtn) {
  els.bcClearBtn.addEventListener('click', () => clearCurrentTranslations('broadcast'));
}

els.settingsBtn.addEventListener('click', openSettings);
els.bannerSetupBtn.addEventListener('click', openSettings);
els.bannerDemoBtn.addEventListener('click', loadDemoConversation);
els.emptyDemoBtn.addEventListener('click', loadDemoConversation);
els.closeSettingsBtn.addEventListener('click', closeSettings);
els.settingsSheet.addEventListener('click', (e) => {
  if (e.target === els.settingsSheet) closeSettings();
});

els.toggleKeyVisibility.addEventListener('click', () => {
  const isPwd = els.apiKeyInput.type === 'password';
  els.apiKeyInput.type = isPwd ? 'text' : 'password';
  els.toggleKeyVisibility.textContent = isPwd ? '隱藏' : '顯示';
});

els.testKeyBtn.addEventListener('click', async () => {
  const key = els.apiKeyInput.value.trim();
  const model = els.modelSelect.value;
  els.testResult.className = 'test-result';
  els.testResult.textContent = '連線測試中⋯';
  try {
    await testApiKey({ apiKey: key, model });
    els.testResult.className = 'test-result ok';
    els.testResult.textContent = `連線成功！模型 ${model} 可正常使用。`;
  } catch (err) {
    els.testResult.className = 'test-result err';
    els.testResult.textContent = err.message;
  }
});

els.testVoiceBtn.addEventListener('click', async () => {
  const key = els.apiKeyInput.value.trim() || settings.apiKey;
  const ttsModel = els.ttsModelSelect.value;
  const voiceName = els.voiceSelect.value;
  const sampleText = '你好，我是你的專屬隨身口譯官。Nice to meet you. よろしくお願いします。Trevligt att träffas!';

  audio.unlockPlayback();
  try {
    if (ttsModel === 'browser' || !key) {
      await audio.speakBrowserFallback('__preview__', '你好，這是瀏覽器內建語音試聽。', 'zh');
      return;
    }
    showToast('生成試聽語音中⋯', 1500);
    const { base64, mimeType } = await synthesizeGeminiSpeech({
      apiKey: key,
      ttsModel,
      voiceName,
      text: sampleText,
      langCode: 'zh',
    });
    await audio.playGeminiAudio(null, base64, mimeType);
  } catch (err) {
    showToast(err.message, 3500);
  }
});

els.saveSettingsBtn.addEventListener('click', saveSettingsFromForm);

// Show Card events
els.flipShowcardBtn.addEventListener('click', () => {
  els.showcardContent.classList.toggle('flipped');
});
els.closeShowcardBtn.addEventListener('click', closeShowcard);
els.speakShowcardBtn.addEventListener('click', () => {
  if (!activeShowcardMsg) return;
  const isOut = activeShowcardMsg.direction === 'outbound';
  speakMessage(
    activeShowcardMsg,
    isOut ? activeShowcardMsg.translated : activeShowcardMsg.zh,
    isOut ? activeShowcardMsg.targetLang : 'zh'
  );
});

// Version badge: tap to force-check & reload latest PWA version (keeps localStorage API Key & history)
const versionBadgeEl = $('versionBadge');
if (versionBadgeEl) {
  versionBadgeEl.addEventListener('click', async () => {
    showToast('正在檢查並更新至最新版本⋯', 1800);
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.update().catch(() => {})));
      }
    } catch (_) {}
    window.location.reload();
  });
}

// Service Worker registration for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// Viewport Lock & Header Scroll Elevation Wiring (keeps Row 1 pinned 100% of the time on Android Chrome PWA)
if (els.transcriptFeed) {
  els.transcriptFeed.addEventListener('scroll', syncHeaderScrollElevation, { passive: true });
}
if (els.broadcastCanvas) {
  els.broadcastCanvas.addEventListener('scroll', syncHeaderScrollElevation, { passive: true });
}
if (els.quickChineseInput) {
  els.quickChineseInput.addEventListener('blur', () => {
    requestAnimationFrame(syncViewportMetrics);
    setTimeout(syncViewportMetrics, 140);
  });
}
window.addEventListener('resize', syncViewportMetrics, { passive: true });
window.addEventListener('orientationchange', () => {
  syncViewportMetrics();
  setTimeout(syncViewportMetrics, 160);
});
window.addEventListener('pageshow', syncViewportMetrics);
window.addEventListener('scroll', syncViewportMetrics, { passive: true });
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewportMetrics);
  window.visualViewport.addEventListener('scroll', syncViewportMetrics);
}

// Init
syncViewportMetrics();
requestAnimationFrame(syncViewportMetrics);
setTimeout(syncViewportMetrics, 120);
setTimeout(syncViewportMetrics, 400);
applyActiveAudioProfile();
applyTheme();
updateSwitchUI();
renderFeed();
renderBroadcastCanvas(true);
