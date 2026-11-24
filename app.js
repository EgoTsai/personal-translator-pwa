/**
 * app.js — Main UI controller for 隨身口譯官 PWA
 */

import { AudioEngine } from './audio.js?v=2.3';
import {
  TARGET_LANGUAGES,
  ICEBREAKER_BANNERS,
  interpretListeningAudio,
  translateOutboundChinese,
  translateImageWithGemini,
  synthesizeGeminiSpeech,
  testApiKey,
} from './gemini.js?v=2.3';
import { GeminiLiveClient } from './live.js?v=2.3';

const STORAGE_KEYS = {
  settings: 'pt_settings_v1',
  messages: 'pt_messages_v1',
  speakers: 'pt_speakers_v1',
};

const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'gemini-3.5-flash-lite',
  liveModel: 'gemini-3.8-live',
  ttsModel: 'gemini-3.8-flash-lite-tts',
  voiceName: 'Kore',
  tone: 'natural',
  silenceMs: 850,
  vadThreshold: 0.018,
  showOriginal: true,
  draftCaption: true,
  liveAutoSpeak: false,
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

// State
let settings = loadJson(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
settings = { ...DEFAULT_SETTINGS, ...settings };

let messages = loadJson(STORAGE_KEYS.messages, []);
let speakerMemory = loadJson(STORAGE_KEYS.speakers, {}); // { A: { voiceHint, customName } }

let isListening = false;
let isLiveMode = false; // Always defaults to Plan A (false) on launch to protect credits
let liveConnected = false;
let liveConnecting = false;
let liveStartTs = 0;
let liveTimerHandle = null;
let liveIdleHandle = null;
let liveInboundCount = 0;
let isManualRecording = false;
let manualTimerHandle = null;
let manualStartTime = 0;

// Sequential queue for Plan A VAD segments so speaker continuity stays ordered
const vadQueue = [];
let vadProcessing = false;
let pendingCount = 0;
let activeShowcardMsg = null;
let wakeLockSentinel = null;

// Free browser live draft caption (SpeechRecognition)
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
  const shouldLock = isListening || isManualRecording || Boolean(activeShowcardMsg);
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
  }
});

// DOM references
const $ = (id) => document.getElementById(id);

const els = {
  appShell: $('appShell'),
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  toneQuickBtn: $('toneQuickBtn'),
  themeBtn: $('themeBtn'),
  exportBtn: $('exportBtn'),
  clearBtn: $('clearBtn'),
  settingsBtn: $('settingsBtn'),
  langBar: $('langBar'),
  listenSwitch: $('listenSwitch'),
  listenSub: $('listenSub'),
  liveModeSwitch: $('liveModeSwitch'),
  liveModeSub: $('liveModeSub'),
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
  liveModelSelect: $('liveModelSelect'),
  ttsModelSelect: $('ttsModelSelect'),
  voiceSelect: $('voiceSelect'),
  testVoiceBtn: $('testVoiceBtn'),
  toneSelect: $('toneSelect'),
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
  try {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
    // Keep at most 120 messages and strip thumbnails from older photo cards to stay safely under storage quota
    const recent = messages.slice(-120);
    let keptThumbs = 0;
    const pruned = [];
    for (let i = recent.length - 1; i >= 0; i--) {
      const m = recent[i];
      if (m.type === 'photo' && m.thumbUrl) {
        keptThumbs += 1;
        pruned.unshift(keptThumbs <= 6 ? m : { ...m, thumbUrl: '' });
      } else {
        pruned.unshift(m);
      }
    }
    localStorage.setItem(STORAGE_KEYS.messages, JSON.stringify(pruned));
    localStorage.setItem(STORAGE_KEYS.speakers, JSON.stringify(speakerMemory));
  } catch (_) {}
}

let toastTimer = null;
function showToast(msg, duration = 2600) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
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
}

function updateHeaderStatus() {
  els.statusDot.className = 'status-dot';
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
  if (isListening && isLiveMode) {
    if (liveConnecting) {
      els.statusDot.classList.add('processing');
      els.statusText.textContent = '⚡ Live 串流連線中⋯';
    } else if (liveConnected) {
      els.statusDot.classList.add('live-ws');
      els.statusText.textContent = '⚡ Live 雙向串流中・螢幕恆亮';
    } else {
      els.statusDot.classList.add('processing');
      els.statusText.textContent = '⚡ Live 準備中⋯';
    }
    return;
  }
  if (pendingCount > 0) {
    els.statusDot.classList.add('processing');
    els.statusText.textContent = `Gemini 串流翻譯中 (${pendingCount})⋯`;
    return;
  }
  if (isListening) {
    els.statusDot.classList.add('listening');
    els.statusText.textContent = '極速聆聽中・螢幕恆亮';
    return;
  }
  els.statusDot.classList.add('ready');
  els.statusText.textContent = settings.apiKey ? '已連線・待命中（極速方案 A）' : '尚未設定 API Key';
}

function updateSwitchUI() {
  // Listening Master Switch
  els.listenSwitch.classList.toggle('listen-on', isListening);
  els.listenSwitch.setAttribute('aria-checked', String(isListening));
  els.listenSub.textContent = isListening
    ? (isLiveMode ? 'Live 雙向口譯中' : '極速聆聽中・防休眠')
    : '極速串流・防休眠';

  // Live Streaming Mode Switch
  if (els.liveModeSwitch) {
    els.liveModeSwitch.classList.toggle('live-on', isLiveMode);
    els.liveModeSwitch.setAttribute('aria-checked', String(isLiveMode));
  }
  if (els.liveModeSub) {
    if (!isLiveMode) {
      els.liveModeSub.textContent = '關閉（極速省額度）';
    } else if (liveConnecting) {
      els.liveModeSub.textContent = '正在建立連線⋯';
    } else if (isListening && liveConnected) {
      els.liveModeSub.textContent = '超低延遲連線中';
    } else {
      els.liveModeSub.textContent = '已待機（未計費）';
    }
  }

  // Listening Strip
  els.listenStrip.classList.toggle('visible', isListening);
  els.listenStrip.classList.toggle('live-mode', isListening && isLiveMode);
  if (els.liveTimerPill) {
    els.liveTimerPill.classList.toggle('hidden', !(isListening && isLiveMode && liveConnected));
  }
  if (els.flushBtn) {
    els.flushBtn.textContent = isListening && isLiveMode ? '送出此句' : '立即送出';
  }

  // Tone Quick Chip
  if (els.toneQuickBtn) {
    const meta = TONE_META[settings.tone] || TONE_META.natural;
    els.toneQuickBtn.textContent = meta.short;
    els.toneQuickBtn.classList.toggle('polite', settings.tone === 'polite');
  }

  // Target language pills & outbound button label
  const langInfo = TARGET_LANGUAGES[settings.targetLang] || TARGET_LANGUAGES.en;
  const shortTarget = LANG_BADGE_MAP[langInfo.code] || langInfo.label;
  els.langBar.querySelectorAll('.lang-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.lang === settings.targetLang);
  });

  els.quickChineseInput.placeholder = `輸入中文或外語，自動互譯（中文 ↔ ${langInfo.label}）⋯`;
  if (!isManualRecording) {
    els.speakBtnLabel.textContent = `按住或點擊說話（中 ↔ ${shortTarget}）`;
  }

  // Setup banner
  els.setupBanner.classList.toggle('hidden', Boolean(settings.apiKey));
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
    return;
  }

  if (els.emptyState && els.emptyState.parentNode === feed) {
    els.emptyState.remove();
  }

  if (existing) {
    const span = existing.querySelector('.draft-caption-text');
    if (span) span.textContent = currentDraftText;
  } else {
    feed.appendChild(buildDraftCaptionElement(currentDraftText));
  }
  feed.scrollTop = feed.scrollHeight;
}

function buildStreamingCardElement(data) {
  const isOut = data.direction === 'outbound';
  const spClass = data.isLive ? 'sp-c' : speakerColorClass(data.speaker || 'A', isOut);
  const card = document.createElement('article');
  card.id = 'liveStreamingCard';
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

  if (data.reading) {
    const readEl = document.createElement('div');
    readEl.className = 'utterance-reading';
    readEl.textContent = data.reading;
    card.appendChild(readEl);
  }

  if (data.subText) {
    const subEl = document.createElement('div');
    subEl.className = 'utterance-sub';
    subEl.textContent = data.subText;
    card.appendChild(subEl);
  }

  return card;
}

function upsertStreamingCardDom(data) {
  activeStreamState = data;
  const feed = els.transcriptFeed;
  if (!data || (!data.mainText && !data.subText)) {
    clearStreamingCardDom();
    return;
  }

  if (els.emptyState && els.emptyState.parentNode === feed) {
    els.emptyState.remove();
  }

  // Hide generic spinner pill once actual streaming tokens are visible
  const pendingPill = feed.querySelector('.pending-pill');
  if (pendingPill) pendingPill.remove();

  const existing = document.getElementById('liveStreamingCard');
  const nextCard = buildStreamingCardElement(data);
  if (existing) {
    existing.replaceWith(nextCard);
  } else {
    feed.appendChild(nextCard);
  }
  feed.scrollTop = feed.scrollHeight;
}

function clearStreamingCardDom() {
  activeStreamState = null;
  const existing = document.getElementById('liveStreamingCard');
  if (existing) existing.remove();
}

function renderFeed() {
  const feed = els.transcriptFeed;
  feed.innerHTML = '';

  if (messages.length === 0 && !activeStreamState && !currentDraftText) {
    feed.appendChild(els.emptyState);
  } else {
    for (const msg of messages) {
      feed.appendChild(createMessageCard(msg));
    }
  }

  if (currentDraftText) {
    feed.appendChild(buildDraftCaptionElement(currentDraftText));
  }

  if (activeStreamState && (activeStreamState.mainText || activeStreamState.subText)) {
    feed.appendChild(buildStreamingCardElement(activeStreamState));
  } else if (pendingCount > 0) {
    const pill = document.createElement('div');
    pill.className = 'pending-pill';
    pill.innerHTML = `<span class="spinner"></span><span>Gemini 極速翻譯中⋯</span>`;
    feed.appendChild(pill);
  }

  requestAnimationFrame(() => {
    feed.scrollTop = feed.scrollHeight;
  });
}

const FLAG_SVG_MAP = {
  en: `<svg class="flag-svg sm" viewBox="0 0 24 16" aria-hidden="true"><rect width="24" height="16" rx="2" fill="#B22234"/><path d="M0 2.5h24M0 5h24M0 7.5h24M0 10h24M0 12.5h24M0 15h24" stroke="#FFF" stroke-width="1.25"/><rect width="10.5" height="8.5" rx="1" fill="#3C3B6E"/><circle cx="2.3" cy="2.1" r=".6" fill="#FFF"/><circle cx="5.2" cy="2.1" r=".6" fill="#FFF"/><circle cx="8.1" cy="2.1" r=".6" fill="#FFF"/><circle cx="3.8" cy="4.2" r=".6" fill="#FFF"/><circle cx="6.7" cy="4.2" r=".6" fill="#FFF"/><circle cx="2.3" cy="6.3" r=".6" fill="#FFF"/><circle cx="5.2" cy="6.3" r=".6" fill="#FFF"/><circle cx="8.1" cy="6.3" r=".6" fill="#FFF"/></svg>`,
  ja: `<svg class="flag-svg sm" viewBox="0 0 24 16" aria-hidden="true"><rect width="24" height="16" rx="2" fill="#FFFFFF"/><circle cx="12" cy="8" r="4.6" fill="#BC002D"/></svg>`,
  sv: `<svg class="flag-svg sm" viewBox="0 0 24 16" aria-hidden="true"><rect width="24" height="16" rx="2" fill="#006AA7"/><rect x="7" width="3.2" height="16" fill="#FECC00"/><rect y="6.4" width="24" height="3.2" fill="#FECC00"/></svg>`,
};

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
      if (audio.playingId === cacheId) {
        audio.stopPlayback();
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
      langTag.innerHTML = `中 → ${FLAG_SVG_MAP[targetInfo.code] || ''}<span>${targetInfo.label}</span>`;
    } else {
      const shortLang = LANG_BADGE_MAP[msg.lang] || (msg.lang || '外語').toUpperCase();
      langTag.innerHTML = `${FLAG_SVG_MAP[msg.lang] || ''}<span>${shortLang} → 中文</span>`;
    }
  } else if (isOutbound) {
    const targetInfo = TARGET_LANGUAGES[msg.targetLang] || TARGET_LANGUAGES.en;
    const flagHtml = FLAG_SVG_MAP[targetInfo.code] || '';
    langTag.innerHTML = `中 → ${flagHtml}<span>${targetInfo.label}</span>`;
  } else if (!msg.isChinese) {
    const shortLang = LANG_BADGE_MAP[msg.lang] || msg.lang.toUpperCase();
    const flagHtml = FLAG_SVG_MAP[msg.lang] || '';
    langTag.innerHTML = `${flagHtml}<span>${shortLang} → 中文</span>`;
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

// TTS Playback (updates only the active speaker button in-place — zero flicker)
async function speakMessage(msgOrId, text, langCode) {
  const cacheId = typeof msgOrId === 'string' ? msgOrId : msgOrId?.id;
  if (!text) return;
  // Unlock dedicated speaker playback synchronously inside the user tap gesture
  audio.unlockPlayback();
  try {
    if (audio.hasCachedAudio(cacheId)) {
      await audio.playCachedAudio(cacheId);
      return;
    }

    const useGeminiTts = settings.ttsModel !== 'browser' && Boolean(settings.apiKey);
    if (useGeminiTts) {
      loadingSpeakId = cacheId;
      syncPlaybackButtons();
      updateHeaderStatus();
      const { base64, mimeType } = await synthesizeGeminiSpeech({
        apiKey: settings.apiKey,
        ttsModel: settings.ttsModel,
        voiceName: settings.voiceName,
        text,
        langCode,
      });
      loadingSpeakId = null;
      syncPlaybackButtons();
      await audio.playGeminiAudio(cacheId, base64, mimeType);
    } else {
      if (settings.ttsModel !== 'browser' && !settings.apiKey) {
        showToast('未設定 API Key，暫用手機內建語音示範');
      }
      await audio.speakBrowserFallback(cacheId, text, langCode);
    }
  } catch (err) {
    loadingSpeakId = null;
    syncPlaybackButtons();
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
  if (!settings.draftCaption || draftRecognitionDisabled || isLiveMode) return;
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
      if (draftRecognitionActive && !draftRecognitionDisabled && (isListening || isManualRecording) && !isLiveMode) {
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

// Language heuristic helpers for Gemini Live turns
function isLikelyChineseText(text) {
  if (!text) return false;
  if (/[\u3040-\u30ff]/.test(text)) return false; // Japanese Kana -> not Chinese
  return /[\u4e00-\u9fff]/.test(text);
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
      stopLiveSession(true);
      isListening = false;
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
    els.vadStatus.textContent = '⚡ Live 雙向串流已連線・直接開口即可即時翻譯';
    updateSwitchUI();
  } else if (state === 'closed') {
    const wasActive = liveConnected;
    liveConnecting = false;
    liveConnected = false;
    stopLiveTimers();
    clearStreamingCardDom();
    if (wasActive && isListening && isLiveMode) {
      audio.stopLiveStream();
      isListening = false;
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
  renderFeed();
  updateHeaderStatus();
};

liveClient.onGoAway = () => {
  if (isListening && isLiveMode) {
    showToast('Live 連線即將到期，自動重新連線中⋯', 2500);
    startLiveSession().catch(() => {});
  }
};

async function startLiveSession() {
  stopDraftRecognition(true);
  audio.stopListening();
  liveConnecting = true;
  updateSwitchUI();

  try {
    await audio.ensureMicrophone();
    await liveClient.connect({
      apiKey: settings.apiKey,
      model: settings.liveModel || 'gemini-3.8-live',
      targetLang: settings.targetLang,
      tone: settings.tone,
      voiceName: settings.voiceName,
    });
    await audio.startLiveStream((pcm16) => {
      liveClient.sendAudioPcm16k(pcm16);
    });
  } catch (err) {
    liveConnecting = false;
    liveConnected = false;
    audio.stopLiveStream();
    liveClient.disconnect();
    throw err;
  }
}

function stopLiveSession(releaseMic = true) {
  stopLiveTimers();
  liveConnecting = false;
  liveConnected = false;
  clearStreamingCardDom();
  liveClient.disconnect();
  if (releaseMic) {
    audio.stopLiveStream();
  } else {
    audio.liveStreaming = false;
    audio.onLivePcmChunk = null;
    audio.stopLivePlayback();
  }
}

// Live Mode Switch (Default OFF = Plan A; ON = Gemini Live WebSocket)
async function toggleLiveMode() {
  if (!isLiveMode) {
    if (!settings.apiKey) {
      showToast('請先填入 Gemini API Key 才能使用 Live 串流模式');
      openSettings();
      return;
    }
    isLiveMode = true;
    haptic(15);
    // 1-tap Live start: automatically engage Listening & connect WebSocket immediately!
    isListening = true;
    syncWakeLock();
    updateSwitchUI();
    showToast('⚡ 正在連線 Gemini Live 超低延遲串流⋯', 2200);
    try {
      await startLiveSession();
      showToast('⚡ Live 雙向串流已就緒（點 🔊 可 0 秒重播）');
    } catch (err) {
      console.error('Live start error:', err);
      isLiveMode = false;
      isListening = false;
      syncWakeLock();
      updateSwitchUI();
      showToast(err.message || 'Live 連線失敗，已切回方案 A', 4000);
    }
  } else {
    isLiveMode = false;
    haptic(10);
    if (isListening) {
      stopLiveSession(false);
      try {
        audio.configureVad({
          threshold: Number(settings.vadThreshold),
          silenceMs: Number(settings.silenceMs),
        });
        await audio.startListening();
        startDraftRecognition(settings.targetLang);
        els.vadStatus.textContent = '極速聆聽中⋯停頓 0.85 秒自動串流翻譯';
        showToast('已切回標準串流（方案 A・省額度）');
      } catch (err) {
        isListening = false;
        audio.stopListening();
        showToast(`切回失敗：${err.message}`, 3500);
      }
    } else {
      stopLiveSession(true);
      showToast('已關閉 Live 串流模式（預設方案 A）');
    }
    syncWakeLock();
    updateSwitchUI();
  }
}

// Listening Switch (with Screen Wake Lock + haptic — uses Plan A by default, or Live when toggled ON)
async function toggleListening() {
  if (!isListening) {
    if (!settings.apiKey) {
      showToast('請先填入 Gemini API Key 才能啟用即時聆聽');
      openSettings();
      return;
    }
    try {
      if (isLiveMode) {
        isListening = true;
        haptic(15);
        syncWakeLock();
        updateSwitchUI();
        await startLiveSession();
        showToast('⚡ Live 雙向串流已開啟（螢幕自動防休眠）');
      } else {
        audio.configureVad({
          threshold: Number(settings.vadThreshold),
          silenceMs: Number(settings.silenceMs),
        });
        await audio.startListening();
        isListening = true;
        startDraftRecognition(settings.targetLang);
        haptic(15);
        syncWakeLock();
        updateSwitchUI();
        els.vadStatus.textContent = '極速聆聽中⋯停頓即串流翻譯';
        showToast('即時聆聽已開啟（方案 A 極速串流・防休眠）');
      }
    } catch (err) {
      console.error(err);
      isListening = false;
      syncWakeLock();
      updateSwitchUI();
      showToast(`無法啟動聆聽：${err.message}`, 3800);
    }
  } else {
    if (isLiveMode) {
      stopLiveSession(true);
    } else {
      stopDraftRecognition(true);
      audio.stopListening();
    }
    isListening = false;
    haptic(10);
    syncWakeLock();
    updateSwitchUI();
    showToast('已關閉即時聆聽');
  }
}

function enqueueVadSegment(wav) {
  upsertDraftCaptionDom('');
  vadQueue.push(wav);
  pendingCount += 1;
  renderFeed();
  updateHeaderStatus();
  processVadQueue();
}

async function processVadQueue() {
  if (vadProcessing) return;
  vadProcessing = true;

  while (vadQueue.length > 0) {
    const wav = vadQueue.shift();
    try {
      const utterances = await interpretListeningAudio({
        apiKey: settings.apiKey,
        model: settings.model,
        wavBase64: wav.base64,
        mimeType: wav.mimeType,
        preferredLang: settings.targetLang,
        speakerMemory,
        recentContext: messages.slice(-6),
        onStream: (chunk) => {
          upsertDraftCaptionDom('');
          upsertStreamingCardDom(chunk);
        },
      });

      clearStreamingCardDom();
      const newlyAdded = [];
      for (const u of utterances) {
        if (!speakerMemory[u.speaker]) {
          speakerMemory[u.speaker] = { voiceHint: u.voiceHint, customName: '' };
        } else if (u.voiceHint) {
          speakerMemory[u.speaker].voiceHint = u.voiceHint;
        }

        const msg = {
          id: makeId(),
          direction: 'inbound',
          speaker: u.speaker,
          lang: u.lang,
          isChinese: u.isChinese,
          original: u.original,
          zh: u.zh,
          time: nowTimeStr(),
        };
        messages.push(msg);
        newlyAdded.push(msg);
      }

      if (newlyAdded.length > 0) {
        saveState();
      }
    } catch (err) {
      clearStreamingCardDom();
      console.error('VAD interpret error:', err);
      showToast(err.message, 3800);
    } finally {
      if (pendingCount > 0) pendingCount -= 1;
      renderFeed();
      updateHeaderStatus();
    }
  }

  vadProcessing = false;
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
  if (isListening && !isLiveMode) {
    startDraftRecognition(settings.targetLang);
  }
  haptic([12, 35, 18]);
  syncWakeLock();
  els.speakChineseBtn.classList.remove('recording');
  els.cancelRecBtn.classList.remove('visible');
  if (els.cameraBtn) els.cameraBtn.classList.remove('hidden');
  updateSwitchUI();

  const wav = audio.stopManualCapture();
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
  if (isListening && !isLiveMode) {
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
  if (!settings.apiKey) {
    showToast('請先填入 Gemini API Key');
    openSettings();
    return;
  }
  els.quickChineseInput.value = '';
  els.quickChineseInput.blur();
  haptic(10);
  await audio.ensureContext().catch(() => {});
  await runOutboundTranslation({ textInput: text });
}

async function runOutboundTranslation({ wav = null, textInput = null }) {
  pendingCount += 1;
  renderFeed();
  updateHeaderStatus();

  try {
    const result = await translateOutboundChinese({
      apiKey: settings.apiKey,
      model: settings.model,
      targetLang: settings.targetLang,
      tone: settings.tone,
      wavBase64: wav ? wav.base64 : null,
      mimeType: wav ? wav.mimeType : 'audio/wav',
      textInput,
      recentContext: messages.slice(-6),
      onStream: (chunk) => {
        upsertDraftCaptionDom('');
        upsertStreamingCardDom(chunk);
      },
    });

    clearStreamingCardDom();

    if (!result) {
      showToast('沒有辨識到清晰的語音或文字，請再試一次');
      return;
    }

    const msg = result.isSourceChinese
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

    messages.push(msg);
    saveState();
  } catch (err) {
    clearStreamingCardDom();
    console.error('Outbound translate error:', err);
    showToast(err.message, 3800);
  } finally {
    if (pendingCount > 0) pendingCount -= 1;
    renderFeed();
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
  if (!settings.apiKey) {
    showToast('請先填入 Gemini API Key 才能使用拍照翻譯');
    openSettings();
    return;
  }

  haptic(12);
  pendingCount += 1;
  renderFeed();
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
    haptic([10, 30, 14]);
  } catch (err) {
    console.error('Photo translate error:', err);
    showToast(err.message, 3800);
  } finally {
    if (pendingCount > 0) pendingCount -= 1;
    renderFeed();
    updateHeaderStatus();
  }
}

// Show Card ("面對面破冰大字卡")
function openShowcard(msg) {
  activeShowcardMsg = msg;
  const isOutbound = msg.direction === 'outbound';
  const displayLang = isOutbound ? msg.targetLang : 'zh';
  const bannerText = ICEBREAKER_BANNERS[displayLang] || ICEBREAKER_BANNERS.en;
  const flagHtml = FLAG_SVG_MAP[displayLang] || '';

  if (els.showcardBanner) {
    els.showcardBanner.innerHTML = `${flagHtml}<span>${bannerText}</span>`;
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
  if (els.liveModelSelect) {
    els.liveModelSelect.value = settings.liveModel || 'gemini-3.8-live';
  }
  els.ttsModelSelect.value = settings.ttsModel;
  els.voiceSelect.value = settings.voiceName;
  els.toneSelect.value = settings.tone;
  const validSilences = ['650', '850', '1300', '1800'];
  const silStr = validSilences.includes(String(settings.silenceMs)) ? String(settings.silenceMs) : '850';
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
  els.settingsSheet.classList.remove('open');
  els.settingsSheet.setAttribute('aria-hidden', 'true');
}

function saveSettingsFromForm() {
  const prevTts = settings.ttsModel;
  const prevVoice = settings.voiceName;
  const prevLiveModel = settings.liveModel;
  const prevTone = settings.tone;

  settings.apiKey = els.apiKeyInput.value.trim();
  settings.model = els.modelSelect.value;
  if (els.liveModelSelect) settings.liveModel = els.liveModelSelect.value;
  settings.ttsModel = els.ttsModelSelect.value;
  settings.voiceName = els.voiceSelect.value;
  settings.tone = els.toneSelect.value;
  settings.silenceMs = Number(els.silenceSelect.value);
  settings.vadThreshold = Number(els.vadThresholdSelect.value);
  if (els.draftCaptionCheck) settings.draftCaption = els.draftCaptionCheck.checked;
  if (els.liveAutoSpeakCheck) settings.liveAutoSpeak = els.liveAutoSpeakCheck.checked;
  settings.showOriginal = els.showOriginalCheck.checked;

  if (prevTts !== settings.ttsModel || prevVoice !== settings.voiceName) {
    audio.clearTtsCache();
  }

  audio.configureVad({
    threshold: settings.vadThreshold,
    silenceMs: settings.silenceMs,
  });

  if (!settings.draftCaption) {
    stopDraftRecognition(true);
  } else if (isListening && !isLiveMode) {
    startDraftRecognition(settings.targetLang);
  }

  // If Live session is active and Live model / voice / tone changed, reconnect smoothly
  if (
    isListening &&
    isLiveMode &&
    liveConnected &&
    (prevLiveModel !== settings.liveModel || prevVoice !== settings.voiceName || prevTone !== settings.tone)
  ) {
    startLiveSession().catch((err) => showToast(`重新連線 Live 失敗：${err.message}`, 3500));
  }

  saveState();
  applyTheme();
  updateSwitchUI();
  closeSettings();
  showToast('設定已儲存於本機');
}

// Export Transcript
async function exportTranscript() {
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
    const shortLang = LANG_BADGE_MAP[m.lang] || m.lang.toUpperCase();
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
  URL.revokeObjectURL(url);
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
  if (isLiveMode) return;
  els.vadStatus.textContent = speaking
    ? '偵測到人聲，收音中⋯停頓後將極速串流翻譯'
    : '極速聆聽中⋯停頓即串流翻譯';
};

audio.onVadSegment = (wav) => {
  enqueueVadSegment(wav);
};

audio.onPlaybackChange = () => {
  syncPlaybackButtons();
  updateHeaderStatus();
};

// Event Wiring
els.listenSwitch.addEventListener('click', toggleListening);
if (els.liveModeSwitch) {
  els.liveModeSwitch.addEventListener('click', toggleLiveMode);
}

if (els.toneQuickBtn) {
  els.toneQuickBtn.addEventListener('click', () => {
    const idx = TONE_ORDER.indexOf(settings.tone);
    settings.tone = TONE_ORDER[(idx + 1) % TONE_ORDER.length];
    haptic(10);
    saveState();
    updateSwitchUI();
    showToast((TONE_META[settings.tone] || TONE_META.natural).toast, 2200);
    if (isListening && isLiveMode && liveConnected) {
      startLiveSession().catch(() => {});
    }
  });
}

els.langBar.addEventListener('click', (e) => {
  const pill = e.target.closest('.lang-pill');
  if (!pill) return;
  const changed = settings.targetLang !== pill.dataset.lang;
  settings.targetLang = pill.dataset.lang;
  haptic(8);
  saveState();
  updateSwitchUI();
  if (changed && isListening) {
    if (isLiveMode && liveConnected) {
      showToast(`Live 串流切換語言為「${(TARGET_LANGUAGES[settings.targetLang] || TARGET_LANGUAGES.en).label}」⋯`, 2000);
      startLiveSession().catch(() => {});
    } else if (!isLiveMode) {
      startDraftRecognition(settings.targetLang);
    }
  }
});

els.flushBtn.addEventListener('click', () => {
  if (isListening && isLiveMode) {
    const ok = liveClient.flushAudioStream();
    showToast(ok ? '已送出目前語音片段' : 'Live 尚未連線就緒');
    return;
  }
  const flushed = audio.flushListeningNow();
  if (!flushed) {
    showToast('目前沒有待送出的語音片段');
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

els.clearBtn.addEventListener('click', () => {
  if (messages.length === 0) return;
  if (!window.confirm('確定要清除目前所有對話紀錄與說話者記憶嗎？')) return;
  audio.stopPlayback();
  messages = [];
  speakerMemory = {};
  saveState();
  renderFeed();
  showToast('已清除對話紀錄');
});

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

  try {
    await audio.ensureContext();
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

// Init
applyTheme();
updateSwitchUI();
renderFeed();
s').catch(() => {});
  });
}

// Init
applyTheme();
updateSwitchUI();
renderFeed();
