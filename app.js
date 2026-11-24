/**
 * app.js — Main UI controller for 隨身口譯官 PWA
 */

import { AudioEngine } from './audio.js';
import {
  TARGET_LANGUAGES,
  interpretListeningAudio,
  translateOutboundChinese,
  synthesizeGeminiSpeech,
  testApiKey,
} from './gemini.js';

const STORAGE_KEYS = {
  settings: 'pt_settings_v1',
  messages: 'pt_messages_v1',
  speakers: 'pt_speakers_v1',
};

const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'gemini-3.5-flash-lite',
  ttsModel: 'gemini-3.8-flash-lite-tts',
  voiceName: 'Kore',
  tone: 'natural',
  silenceMs: 1300,
  vadThreshold: 0.018,
  showOriginal: true,
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

// State
let settings = loadJson(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
settings = { ...DEFAULT_SETTINGS, ...settings };

let messages = loadJson(STORAGE_KEYS.messages, []);
let speakerMemory = loadJson(STORAGE_KEYS.speakers, {}); // { A: { voiceHint, customName } }

let isListening = false;
let isManualRecording = false;
let manualTimerHandle = null;
let manualStartTime = 0;

// Sequential queue for VAD segments so speaker continuity stays ordered
const vadQueue = [];
let vadProcessing = false;
let pendingCount = 0;
let activeShowcardMsg = null;

const audio = new AudioEngine();

// DOM references
const $ = (id) => document.getElementById(id);

const els = {
  appShell: $('appShell'),
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  themeBtn: $('themeBtn'),
  exportBtn: $('exportBtn'),
  clearBtn: $('clearBtn'),
  settingsBtn: $('settingsBtn'),
  langBar: $('langBar'),
  listenSwitch: $('listenSwitch'),
  listenSub: $('listenSub'),
  ttsSwitch: $('ttsSwitch'),
  ttsSub: $('ttsSub'),
  listenStrip: $('listenStrip'),
  waveBars: $('waveBars'),
  vadStatus: $('vadStatus'),
  flushBtn: $('flushBtn'),
  setupBanner: $('setupBanner'),
  bannerSetupBtn: $('bannerSetupBtn'),
  bannerDemoBtn: $('bannerDemoBtn'),
  transcriptFeed: $('transcriptFeed'),
  emptyState: $('emptyState'),
  emptyDemoBtn: $('emptyDemoBtn'),
  quickChineseInput: $('quickChineseInput'),
  quickSendBtn: $('quickSendBtn'),
  speakChineseBtn: $('speakChineseBtn'),
  speakBtnLabel: $('speakBtnLabel'),
  cancelRecBtn: $('cancelRecBtn'),

  settingsSheet: $('settingsSheet'),
  closeSettingsBtn: $('closeSettingsBtn'),
  apiKeyInput: $('apiKeyInput'),
  toggleKeyVisibility: $('toggleKeyVisibility'),
  testKeyBtn: $('testKeyBtn'),
  testResult: $('testResult'),
  modelSelect: $('modelSelect'),
  ttsModelSelect: $('ttsModelSelect'),
  voiceSelect: $('voiceSelect'),
  testVoiceBtn: $('testVoiceBtn'),
  toneSelect: $('toneSelect'),
  silenceSelect: $('silenceSelect'),
  vadThresholdSelect: $('vadThresholdSelect'),
  showOriginalCheck: $('showOriginalCheck'),
  saveSettingsBtn: $('saveSettingsBtn'),

  showcardOverlay: $('showcardOverlay'),
  flipShowcardBtn: $('flipShowcardBtn'),
  closeShowcardBtn: $('closeShowcardBtn'),
  showcardContent: $('showcardContent'),
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
    localStorage.setItem(STORAGE_KEYS.messages, JSON.stringify(messages.slice(-120)));
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
    els.statusText.textContent = '正在收錄你的中文⋯';
    return;
  }
  if (pendingCount > 0) {
    els.statusDot.classList.add('processing');
    els.statusText.textContent = `Gemini 翻譯辨識中 (${pendingCount})⋯`;
    return;
  }
  if (isListening) {
    els.statusDot.classList.add('listening');
    els.statusText.textContent = '即時聆聽翻譯中';
    return;
  }
  els.statusDot.classList.add('ready');
  els.statusText.textContent = settings.apiKey ? '已連線・待命中' : '尚未設定 API Key';
}

function updateSwitchUI() {
  // Switch 1: Listen
  els.listenSwitch.classList.toggle('listen-on', isListening);
  els.listenSwitch.setAttribute('aria-checked', String(isListening));
  els.listenSub.textContent = isListening ? '開啟中・外語→中／中文直出' : '開啟自動收音辨識';
  els.listenStrip.classList.toggle('visible', isListening);

  // Switch 2: Auto AI TTS
  els.ttsSwitch.classList.toggle('tts-on', settings.autoTts);
  els.ttsSwitch.setAttribute('aria-checked', String(settings.autoTts));
  els.ttsSub.textContent = settings.autoTts ? '開啟中・譯文自動唸出' : '已關閉・點單句可播';

  // Target language pills & outbound button label
  const langInfo = TARGET_LANGUAGES[settings.targetLang] || TARGET_LANGUAGES.en;
  els.langBar.querySelectorAll('.lang-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.lang === settings.targetLang);
  });

  els.quickChineseInput.placeholder = `或輸入中文，翻成${langInfo.label}給對方聽⋯`;
  if (!isManualRecording) {
    const voiceHint = settings.autoTts ? '並唸出' : '';
    els.speakBtnLabel.textContent = `點擊說中文 → 翻成${langInfo.label}${voiceHint}`;
  }

  // Setup banner
  els.setupBanner.classList.toggle('hidden', Boolean(settings.apiKey));
  updateHeaderStatus();
}

function speakerColorClass(speakerCode, isOutbound) {
  if (isOutbound || speakerCode === '我') return 'sp-me';
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

function renderFeed() {
  // Preserve pending pill if any
  const feed = els.transcriptFeed;
  feed.innerHTML = '';

  if (messages.length === 0) {
    feed.appendChild(els.emptyState);
  } else {
    for (const msg of messages) {
      feed.appendChild(createMessageCard(msg));
    }
  }

  if (pendingCount > 0) {
    const pill = document.createElement('div');
    pill.className = 'pending-pill';
    pill.innerHTML = `<span class="spinner"></span><span>Gemini 辨識翻譯中⋯</span>`;
    feed.appendChild(pill);
  }

  requestAnimationFrame(() => {
    feed.scrollTop = feed.scrollHeight;
  });
}

function createMessageCard(msg) {
  const card = document.createElement('article');
  card.className = `utterance-card${msg.direction === 'outbound' ? ' outbound' : ''}`;
  card.dataset.id = msg.id;

  const isOutbound = msg.direction === 'outbound';
  const spName = displaySpeakerName(msg.speaker, isOutbound);
  const spClass = speakerColorClass(msg.speaker, isOutbound);

  let langPillText = '中文';
  if (isOutbound) {
    const targetInfo = TARGET_LANGUAGES[msg.targetLang] || TARGET_LANGUAGES.en;
    langPillText = `中 → ${targetInfo.flag} ${targetInfo.label}`;
  } else if (!msg.isChinese) {
    const shortLang = LANG_BADGE_MAP[msg.lang] || msg.lang.toUpperCase();
    langPillText = `${shortLang} → 中文`;
  }

  const isPlaying = audio.playingId === msg.id;

  // Determine main text & speakable payload
  const mainText = isOutbound ? msg.translated : msg.zh;
  const speakText = isOutbound ? msg.translated : msg.zh;
  const speakLang = isOutbound ? msg.targetLang : 'zh';

  const top = document.createElement('div');
  top.className = 'utterance-top';

  const spGroup = document.createElement('div');
  spGroup.className = 'speaker-group';

  const spBtn = document.createElement('button');
  spBtn.type = 'button';
  spBtn.className = `speaker-badge ${spClass}`;
  spBtn.textContent = `${spName}:`;
  spBtn.title = isOutbound ? '你說的中文' : '點擊重新命名這位說話者';
  if (!isOutbound) {
    spBtn.addEventListener('click', () => renameSpeaker(msg.speaker));
  }

  const langTag = document.createElement('span');
  langTag.className = 'lang-tag';
  langTag.textContent = langPillText;

  const timeTag = document.createElement('span');
  timeTag.className = 'time-tag';
  timeTag.textContent = msg.time || '';

  spGroup.append(spBtn, langTag, timeTag);

  const actions = document.createElement('div');
  actions.className = 'utterance-actions';

  // Speak Button (🔊)
  const speakBtn = document.createElement('button');
  speakBtn.type = 'button';
  speakBtn.className = `mini-btn${isPlaying ? ' playing' : ''}`;
  speakBtn.title = isPlaying ? '停止播放' : 'AI 真人唸出這一句';
  speakBtn.setAttribute('aria-label', speakBtn.title);
  speakBtn.innerHTML = isPlaying
    ? `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
  speakBtn.addEventListener('click', () => {
    if (audio.playingId === msg.id) {
      audio.stopPlayback();
    } else {
      speakMessage(msg, speakText, speakLang);
    }
  });

  // Fullscreen Show Card Button
  const expandBtn = document.createElement('button');
  expandBtn.type = 'button';
  expandBtn.className = 'mini-btn';
  expandBtn.title = '放大給對方看';
  expandBtn.setAttribute('aria-label', '放大給對方看');
  expandBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
  expandBtn.addEventListener('click', () => openShowcard(msg));

  // Copy Button
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'mini-btn';
  copyBtn.title = '複製文字';
  copyBtn.setAttribute('aria-label', '複製文字');
  copyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(mainText);
      showToast('已複製到剪貼簿');
    } catch (_) {
      showToast('複製失敗');
    }
  });

  actions.append(speakBtn, expandBtn, copyBtn);
  top.append(spGroup, actions);
  card.appendChild(top);

  const mainEl = document.createElement('div');
  mainEl.className = 'utterance-main';
  mainEl.textContent = mainText;
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
    subEl.textContent = msg.original;
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

// TTS Playback
async function speakMessage(msg, text, langCode) {
  if (!text) return;
  try {
    await audio.ensureContext();
    if (audio.hasCachedAudio(msg.id)) {
      await audio.playCachedAudio(msg.id);
      return;
    }

    const useGeminiTts = settings.ttsModel !== 'browser' && Boolean(settings.apiKey);
    if (useGeminiTts) {
      updateHeaderStatus();
      showToast('AI 語音生成中⋯', 1400);
      const { base64, mimeType } = await synthesizeGeminiSpeech({
        apiKey: settings.apiKey,
        ttsModel: settings.ttsModel,
        voiceName: settings.voiceName,
        text,
        langCode,
      });
      await audio.playGeminiAudio(msg.id, base64, mimeType);
    } else {
      if (settings.ttsModel !== 'browser' && !settings.apiKey) {
        showToast('未設定 API Key，暫用手機內建語音示範');
      }
      await audio.speakBrowserFallback(msg.id, text, langCode);
    }
  } catch (err) {
    console.error('TTS error:', err);
    showToast(`AI 語音失敗，改用瀏覽器語音：${err.message}`, 3200);
    await audio.speakBrowserFallback(msg.id, text, langCode);
  }
}

// Listening Switch (Switch 1)
async function toggleListening() {
  if (!isListening) {
    if (!settings.apiKey) {
      showToast('請先填入 Gemini API Key 才能啟用即時聆聽');
      openSettings();
      return;
    }
    try {
      audio.configureVad({
        threshold: Number(settings.vadThreshold),
        silenceMs: Number(settings.silenceMs),
      });
      await audio.startListening();
      isListening = true;
      updateSwitchUI();
      showToast('即時聆聽已開啟：外語自動翻中文，中文直接印出');
    } catch (err) {
      console.error(err);
      showToast(`無法啟動麥克風：${err.message}`, 3600);
    }
  } else {
    audio.stopListening();
    isListening = false;
    updateSwitchUI();
    showToast('已關閉即時聆聽');
  }
}

function enqueueVadSegment(wav) {
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
      });

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

      // If Auto AI Read-Aloud switch is ON, speak newly translated non-Chinese utterances in Chinese
      if (settings.autoTts && newlyAdded.length > 0) {
        const translatedLines = newlyAdded.filter((m) => !m.isChinese);
        if (translatedLines.length > 0) {
          const lastMsg = translatedLines[translatedLines.length - 1];
          const combined = translatedLines.map((m) => m.zh).join('。');
          // Render first so user sees text immediately while audio loads
          pendingCount = Math.max(0, pendingCount - 1);
          renderFeed();
          updateHeaderStatus();
          await speakMessage(lastMsg, combined, 'zh');
          continue;
        }
      }
    } catch (err) {
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

// Outbound Mode: "我說中文 -> 對方語言 (EN / JA / SV)"
async function toggleManualChineseSpeak() {
  if (!isManualRecording) {
    if (!settings.apiKey) {
      showToast('請先填入 Gemini API Key');
      openSettings();
      return;
    }
    try {
      await audio.startManualCapture();
      isManualRecording = true;
      manualStartTime = Date.now();
      els.speakChineseBtn.classList.add('recording');
      els.cancelRecBtn.classList.add('visible');
      updateManualTimer();
      manualTimerHandle = setInterval(updateManualTimer, 250);
      updateHeaderStatus();
    } catch (err) {
      console.error(err);
      showToast(`無法啟動麥克風：${err.message}`, 3500);
    }
  } else {
    clearInterval(manualTimerHandle);
    manualTimerHandle = null;
    isManualRecording = false;
    els.speakChineseBtn.classList.remove('recording');
    els.cancelRecBtn.classList.remove('visible');
    updateSwitchUI();

    const wav = audio.stopManualCapture();
    if (!wav) {
      showToast('錄音時間太短，請再試一次');
      return;
    }

    await runOutboundTranslation({ wav });
  }
}

function cancelManualChineseSpeak() {
  if (!isManualRecording) return;
  clearInterval(manualTimerHandle);
  manualTimerHandle = null;
  isManualRecording = false;
  audio.cancelManualCapture();
  els.speakChineseBtn.classList.remove('recording');
  els.cancelRecBtn.classList.remove('visible');
  updateSwitchUI();
  showToast('已取消錄音');
}

function updateManualTimer() {
  const sec = Math.floor((Date.now() - manualStartTime) / 1000);
  const langInfo = TARGET_LANGUAGES[settings.targetLang] || TARGET_LANGUAGES.en;
  els.speakBtnLabel.textContent = `錄音中 ${sec}s — 再點一下翻成${langInfo.label}`;
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
    });

    if (!result) {
      showToast('沒有辨識到清晰的中文內容，請再說一次');
      return;
    }

    const msg = {
      id: makeId(),
      direction: 'outbound',
      speaker: '我',
      lang: 'zh',
      targetLang: result.targetLang,
      isChinese: true,
      zh: result.zh,
      translated: result.translated,
      reading: result.reading,
      time: nowTimeStr(),
    };

    messages.push(msg);
    saveState();

    pendingCount = Math.max(0, pendingCount - 1);
    renderFeed();
    updateHeaderStatus();

    // Speak translated foreign sentence aloud when AI Voice switch is ON
    if (settings.autoTts) {
      await speakMessage(msg, msg.translated, msg.targetLang);
    }
    return;
  } catch (err) {
    console.error('Outbound translate error:', err);
    showToast(err.message, 3800);
  } finally {
    if (pendingCount > 0) pendingCount -= 1;
    renderFeed();
    updateHeaderStatus();
  }
}

// Show Card ("放大給對方看")
function openShowcard(msg) {
  activeShowcardMsg = msg;
  const isOutbound = msg.direction === 'outbound';
  els.showcardMain.textContent = isOutbound ? msg.translated : msg.zh;
  els.showcardReading.textContent = isOutbound && msg.reading ? msg.reading : '';
  els.showcardSub.textContent = isOutbound ? msg.zh : (!msg.isChinese ? msg.original : '');
  els.showcardContent.classList.remove('flipped');
  els.showcardOverlay.classList.add('open');
  els.showcardOverlay.setAttribute('aria-hidden', 'false');
}

function closeShowcard() {
  els.showcardOverlay.classList.remove('open');
  els.showcardOverlay.setAttribute('aria-hidden', 'true');
  activeShowcardMsg = null;
}

// Settings Sheet
function openSettings() {
  els.apiKeyInput.value = settings.apiKey;
  els.modelSelect.value = settings.model;
  els.ttsModelSelect.value = settings.ttsModel;
  els.voiceSelect.value = settings.voiceName;
  els.toneSelect.value = settings.tone;
  els.silenceSelect.value = String(settings.silenceMs);
  els.vadThresholdSelect.value = String(settings.vadThreshold);
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
  settings.apiKey = els.apiKeyInput.value.trim();
  settings.model = els.modelSelect.value;
  settings.ttsModel = els.ttsModelSelect.value;
  settings.voiceName = els.voiceSelect.value;
  settings.tone = els.toneSelect.value;
  settings.silenceMs = Number(els.silenceSelect.value);
  settings.vadThreshold = Number(els.vadThresholdSelect.value);
  settings.showOriginal = els.showOriginalCheck.checked;

  audio.configureVad({
    threshold: settings.vadThreshold,
    silenceMs: settings.silenceMs,
  });

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
  showToast('已載入英・日・瑞典・中多語示範！點 A/B/C 可改名，點 🔊 可試聽');
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
  els.vadStatus.textContent = speaking
    ? '偵測到人聲，收音中⋯停頓後將自動翻譯'
    : '聆聽環境聲音中⋯聽到說話會自動斷句翻譯';
};

audio.onVadSegment = (wav) => {
  enqueueVadSegment(wav);
};

audio.onPlaybackChange = () => {
  renderFeed();
  updateHeaderStatus();
};

// Event Wiring
els.listenSwitch.addEventListener('click', toggleListening);

els.ttsSwitch.addEventListener('click', async () => {
  await audio.ensureContext().catch(() => {});
  settings.autoTts = !settings.autoTts;
  saveState();
  updateSwitchUI();
  showToast(settings.autoTts ? 'AI 真人唸出：已開啟' : 'AI 真人唸出：已關閉（點單句 🔊 仍可播報）');
});

els.langBar.addEventListener('click', (e) => {
  const pill = e.target.closest('.lang-pill');
  if (!pill) return;
  settings.targetLang = pill.dataset.lang;
  saveState();
  updateSwitchUI();
});

els.flushBtn.addEventListener('click', () => {
  const flushed = audio.flushListeningNow();
  if (!flushed) {
    showToast('目前沒有待送出的語音片段');
  }
});

els.speakChineseBtn.addEventListener('click', toggleManualChineseSpeak);
els.cancelRecBtn.addEventListener('click', cancelManualChineseSpeak);

els.quickSendBtn.addEventListener('click', handleQuickTextSend);
els.quickChineseInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    handleQuickTextSend();
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
