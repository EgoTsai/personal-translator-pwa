/**
 * gemini.js — Direct browser REST client for Gemini API:
 *  1) Ambient audio listening -> speaker diarization (A/B/C) + non-Chinese to zh-TW translation / Chinese verbatim
 *  2) Outbound Chinese (audio or text) -> natural English / Japanese / Swedish translation
 *  3) Gemini 3.8 TTS speech synthesis
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export const TARGET_LANGUAGES = {
  en: {
    code: 'en',
    label: '英語',
    short: 'EN',
    nativeName: 'English',
    flag: '🇺🇸',
    ttsHint: 'natural conversational English',
  },
  ja: {
    code: 'ja',
    label: '日語',
    short: 'JA',
    nativeName: '日本語',
    flag: '🇯🇵',
    ttsHint: 'natural conversational Japanese',
  },
  sv: {
    code: 'sv',
    label: '瑞典語',
    short: 'SV',
    nativeName: 'Svenska',
    flag: '🇸🇪',
    ttsHint: 'natural conversational Swedish',
  },
};

export const TONE_PRESETS = {
  natural: '自然得體、符合日常真實對話口吻',
  polite: '禮貌尊重、適合商務會議或對長輩／陌生人（日文請用丁寧語／敬語）',
  casual: '輕鬆親切、像朋友間聊天一樣自然口語',
};

const TONE_PRESETS_EN = {
  natural: 'natural, idiomatic everyday speech',
  polite: 'polite and respectful (business/strangers; Japanese teineigo/keigo)',
  casual: 'relaxed, friendly casual speech',
};

export function formatGlossaryLine(glossary) {
  const clean = String(glossary || '')
    .replace(/[\r\n]+/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/,\s*,+/g, ', ')
    .trim();
  if (!clean) return '';
  return `Glossary (use exact terms): ${clean.slice(0, 260)}`;
}

export const ICEBREAKER_BANNERS = {
  en: 'AI Translator · Please feel free to speak',
  ja: 'AI通訳中です・どうぞお話しください',
  sv: 'AI-översättare · Varsågod och prata',
  zh: '隨身 AI 口譯官',
};

export function sanitizeLangCode(raw, fallback = 'unknown') {
  const clean = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 8);
  return clean || fallback;
}

function redactSecrets(text) {
  return String(text || '').replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]');
}

function friendlyApiError(status, bodyText) {
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.error?.message || '';
  } catch (_) {
    detail = bodyText || '';
  }
  detail = redactSecrets(detail).slice(0, 260);

  if (status === 400 && /API key not valid/i.test(detail)) {
    return new Error('API Key 無效，請確認是否完整複製自 Google AI Studio。');
  }
  if (status === 401 || status === 403) {
    return new Error(`API 權限不足或帳單尚未啟用 (${status})：${detail}`);
  }
  if (status === 404) {
    return new Error(`找不到指定的模型 (${status})，請在設定中切換模型：${detail}`);
  }
  if (status === 429) {
    return new Error('目前請求頻率超過配額 (429)，請稍候幾秒再試，或在 AI Studio 確認已綁定 Pro 贈送額度。');
  }
  return new Error(`Gemini API 錯誤 (${status})：${detail || '未知錯誤'}`);
}

async function fetchWithTimeout(url, options, timeoutMs = 22000, externalSignal = null) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      throw new Error('網路連線逾時，請檢查訊號後重試。');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

async function postGenerateContent(apiKey, model, payload, signal, timeoutMs = 24000) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('尚未設定 Gemini API Key，請點右上角「設定」填入。');
  }

  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const resp = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey.trim(),
      },
      body: JSON.stringify(payload),
    },
    timeoutMs,
    signal
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw friendlyApiError(resp.status, text);
  }

  return resp.json();
}

async function postStreamGenerateContent(apiKey, model, payload, onPartialText, signal, timeoutMs = 24000) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('尚未設定 Gemini API Key，請點右上角「設定」填入。');
  }

  const url = `${API_BASE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const resp = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey.trim(),
      },
      body: JSON.stringify(payload),
    },
    timeoutMs,
    signal
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw friendlyApiError(resp.status, text);
  }

  if (!resp.body || !resp.body.getReader) {
    const data = await resp.json();
    const txt = extractTextPart(data);
    if (onPartialText && txt) onPartialText(txt);
    return txt;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let sseBuffer = '';
  let fullText = '';

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const jsonStr = trimmed.slice(5).trim();
    if (!jsonStr || jsonStr === '[DONE]') return;
    try {
      const chunk = JSON.parse(jsonStr);
      const parts = chunk?.candidates?.[0]?.content?.parts || [];
      let delta = '';
      for (const p of parts) {
        if (typeof p.text === 'string' && !p.thought) {
          delta += p.text;
        }
      }
      if (delta) {
        fullText += delta;
        if (onPartialText) onPartialText(fullText);
      }
    } catch (_) {
      // Ignore partial / heartbeat SSE data lines
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split(/\r?\n/);
    sseBuffer = lines.pop() || '';
    for (const line of lines) {
      processLine(line);
    }
  }
  sseBuffer += decoder.decode();
  if (sseBuffer.trim()) {
    for (const line of sseBuffer.split(/\r?\n/)) {
      processLine(line);
    }
  }

  return fullText.trim();
}

/**
 * Incrementally extract a decoded string value for `fieldName` from a partially streamed JSON buffer.
 */
export function extractPartialJsonStringField(raw, fieldName) {
  if (!raw || !fieldName) return '';
  const pattern = new RegExp(`"${fieldName}"\\s*:\\s*"`, 'g');
  let match = null;
  let lastMatch = null;
  while ((match = pattern.exec(raw)) !== null) {
    lastMatch = match;
  }
  if (!lastMatch) return '';

  let idx = lastMatch.index + lastMatch[0].length;
  let out = '';
  while (idx < raw.length) {
    const ch = raw[idx];
    if (ch === '"') break;
    if (ch === '\\') {
      if (idx + 1 >= raw.length) break; // incomplete escape at stream edge
      const next = raw[idx + 1];
      if (next === 'n') { out += '\n'; idx += 2; continue; }
      if (next === 'r') { out += '\r'; idx += 2; continue; }
      if (next === 't') { out += '\t'; idx += 2; continue; }
      if (next === '"' || next === '\\' || next === '/') { out += next; idx += 2; continue; }
      if (next === 'u') {
        if (idx + 6 > raw.length) break; // wait for complete \uXXXX
        const hex = raw.slice(idx + 2, idx + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          idx += 6;
          continue;
        }
      }
      out += next;
      idx += 2;
      continue;
    }
    out += ch;
    idx += 1;
  }
  return out;
}

function extractTextPart(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
}

function buildThinkingConfig(model) {
  if (!model) return {};
  if (model.startsWith('gemini-4-')) {
    // Gemini 4 Neon & Hydrogen support 'minimal'; Carbon & Argon support 'low'
    const level = model === 'gemini-4-neon' || model === 'gemini-4-hydrogen' ? 'minimal' : 'low';
    return { thinkingConfig: { thinkingLevel: level } };
  }
  if (model === 'gemini-3.5-flash-lite') {
    return { thinkingConfig: { thinkingLevel: 'minimal' } };
  }
  if (model === 'gemini-3.8-flash') {
    return { thinkingConfig: { thinkingLevel: 'low' } };
  }
  return {};
}

export function safeJsonParse(raw) {
  if (!raw) return null;
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // Recover valid JSON object if wrapped by stray leading/trailing prose
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return JSON.parse(cleaned.slice(first, last + 1));
    }
    throw _;
  }
}

function looksUntranslatedForZh(zhText, originalText, lang) {
  if (!zhText) return true;
  // Japanese Hiragana or Katakana should never appear in a Traditional Chinese translation
  if (/[\u3040-\u30ff]/.test(zhText)) return true;
  // Non-Chinese output with zero Chinese Han characters (e.g. raw English/Swedish leaked into zh)
  if (!/[\u4e00-\u9fff]/.test(zhText)) return true;
  // Identical to original for non-Chinese source (e.g. Kanji-only Japanese copied verbatim)
  if (lang !== 'zh' && originalText && zhText.trim() === originalText.trim()) return true;
  return false;
}

async function rescueTranslateToZhTW({ apiKey, model, text, sourceLang, signal }) {
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `請將以下${sourceLang || '外語'}句子翻譯成自然流暢的繁體中文（台灣慣用語），只輸出繁體中文譯文，不要任何解釋或原文：\n\n${text}`,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 256,
      ...buildThinkingConfig(model),
    },
  };
  const data = await postGenerateContent(apiKey, model, payload, signal);
  return extractTextPart(data);
}

async function generateJsonWithStreamingFallback({
  apiKey,
  model,
  payload,
  onPartialText = null,
  signal = null,
  timeoutMs = 24000,
}) {
  if (typeof onPartialText === 'function') {
    try {
      const streamed = await postStreamGenerateContent(apiKey, model, payload, onPartialText, signal, timeoutMs);
      if (streamed) return streamed;
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw err;
      // Do not retry auth/quota errors (400 invalid key, 401, 403, 404, 429)
      if (/\((400|401|403|404|429)\)|API Key 無效|配額/.test(err?.message || '')) {
        throw err;
      }
      console.warn('SSE stream failed, falling back to unary generateContent:', err?.message || err);
    }
  }
  const data = await postGenerateContent(apiKey, model, payload, signal, timeoutMs);
  return extractTextPart(data);
}

/**
 * Scenario 1: Bidirectional Auto-Dialogue Interpreter ("對話" 模式)
 * - Non-Chinese speech (EN/JA/SV/etc.) -> inbound card translated to natural zh-TW + speaker diarization (A/B/C/D)
 * - Chinese speech -> outbound card translated to selected targetLang (EN/JA/SV) with tone + Kana/stress reading
 */
export async function interpretDialogueAudio({
  apiKey,
  model,
  wavBase64,
  mimeType = 'audio/wav',
  targetLang = 'en',
  tone = 'natural',
  glossary = '',
  speakerMemory = {},
  recentContext = [],
  contextLimit = 4,
  onStream = null,
  signal,
}) {
  const langInfo = TARGET_LANGUAGES[targetLang] || TARGET_LANGUAGES.en;
  const toneDescEn = TONE_PRESETS_EN[tone] || TONE_PRESETS_EN.natural;
  const glossaryLine = formatGlossaryLine(glossary);

  const speakerLines = Object.entries(speakerMemory)
    .slice(0, 6)
    .map(([id, info]) => `- ${id}${info.customName ? ` (${info.customName})` : ''}: ${info.voiceHint || 'speaker'}`)
    .join('\n');

  const limit = Math.max(0, Number(contextLimit) || 4);
  const contextLines =
    limit > 0
      ? recentContext
          .slice(-limit)
          .map((m) => {
            if (m.direction === 'outbound') {
              return `我: ${m.zh} -> ${m.translated}`;
            }
            return `${m.speaker}: ${m.zh}${m.original && !m.isChinese ? ` (${m.original})` : ''}`;
          })
          .join('\n')
      : '';

  const systemInstruction = `Real-time bidirectional interpreter for a Taiwan Traditional Chinese (zh-TW) user speaking with ${langInfo.nativeName} or other language speakers.
Rules:
1. Non-Chinese speech -> direction:"inbound", speaker:"A"/"B"/"C"/"D" (consistent by voice/turn), source_lang:ISO-639-1, target_lang:"zh", original_text:accurate verbatim transcript, translated_text:natural fluent Taiwan zh-TW (NEVER leave foreign text or Japanese Kana), reading:"".
2. Chinese speech -> direction:"outbound", speaker:"我", source_lang:"zh", target_lang:"${langInfo.code}", original_text:zh-TW verbatim, translated_text:natural native ${langInfo.nativeName} (tone: ${toneDescEn}), reading:${
    langInfo.code === 'ja'
      ? 'Hiragana/Katakana + Romaji'
      : langInfo.code === 'sv'
        ? 'brief stress hint if helpful, else ""'
        : '""'
  }.
3. Split multiple speakers chronologically into separate utterances.
4. Silence, music, coughing, or unintelligible noise -> {"utterances":[]}. Output strict JSON only.`;

  const promptText = [
    glossaryLine,
    speakerLines ? `Speakers:\n${speakerLines}` : '',
    contextLines ? `Context:\n${contextLines}` : '',
    `Interpret audio: non-Chinese -> zh-TW; Chinese -> ${langInfo.nativeName}.`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const payload = {
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType,
              data: wavBase64,
            },
          },
          { text: promptText },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.15,
      ...buildThinkingConfig(model),
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          utterances: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                direction: {
                  type: 'STRING',
                  description: 'inbound (non-Chinese -> zh-TW) or outbound (Chinese -> target)',
                },
                speaker: {
                  type: 'STRING',
                  description: 'A/B/C/D for inbound; 我 for outbound',
                },
                voice_hint: {
                  type: 'STRING',
                  description: 'Brief voice/lang tag for inbound (e.g. 男聲・英語); empty for outbound',
                },
                source_lang: {
                  type: 'STRING',
                  description: 'ISO 639-1 code (en, ja, sv, zh)',
                },
                target_lang: {
                  type: 'STRING',
                  description: `zh for inbound, ${langInfo.code} for outbound`,
                },
                original_text: {
                  type: 'STRING',
                  description: 'Verbatim source transcript',
                },
                translated_text: {
                  type: 'STRING',
                  description: 'Natural translation (zh-TW for inbound; target language for outbound)',
                },
                reading: {
                  type: 'STRING',
                  description: 'Japanese Kana+Romaji or brief Swedish stress hint; else empty',
                },
              },
              required: [
                'direction',
                'speaker',
                'voice_hint',
                'source_lang',
                'target_lang',
                'original_text',
                'translated_text',
                'reading',
              ],
            },
          },
        },
        required: ['utterances'],
      },
    },
  };

  const raw = await generateJsonWithStreamingFallback({
    apiKey,
    model,
    payload,
    onPartialText:
      typeof onStream === 'function'
        ? (partial) => {
            const dir = (extractPartialJsonStringField(partial, 'direction') || '').toLowerCase();
            const srcLang = (extractPartialJsonStringField(partial, 'source_lang') || '').toLowerCase();
            const original = extractPartialJsonStringField(partial, 'original_text');
            const translated = extractPartialJsonStringField(partial, 'translated_text');
            const reading = extractPartialJsonStringField(partial, 'reading');
            const speaker = extractPartialJsonStringField(partial, 'speaker');
            if (translated || original) {
              const isOut = dir === 'outbound' || srcLang.startsWith('zh');
              onStream({
                direction: isOut ? 'outbound' : 'inbound',
                speaker: isOut ? '我' : (speaker || 'A').toUpperCase().slice(0, 4),
                lang: isOut ? langInfo.code : (srcLang || langInfo.code),
                mainText: translated || original,
                subText:
                  translated && original && translated !== original
                    ? isOut
                      ? `原話：${original}`
                      : original
                    : '',
                reading: isOut ? reading : '',
              });
            }
          }
        : null,
    signal,
  });

  const parsed = safeJsonParse(raw);
  const list = Array.isArray(parsed?.utterances) ? parsed.utterances : [];

  const normalized = [];
  for (const u of list) {
    if (!u) continue;
    let original = String(u.original_text || u.original || '').trim();
    let translated = String(u.translated_text || u.translated || u.chinese_translation || '').trim();
    if (!original && !translated) continue;

    const sourceLang = sanitizeLangCode(u.source_lang || u.lang, 'unknown');
    const dirRaw = String(u.direction || '').trim().toLowerCase();
    const isOutbound = dirRaw === 'outbound' || (dirRaw !== 'inbound' && sourceLang.startsWith('zh'));

    if (isOutbound) {
      normalized.push({
        direction: 'outbound',
        speaker: '我',
        voiceHint: '',
        sourceLang: 'zh',
        targetLang: langInfo.code,
        isChinese: true,
        original: original || translated,
        zh: original || translated,
        translated: translated || original,
        reading: String(u.reading || '').trim(),
      });
    } else {
      const lang = sourceLang.startsWith('zh') ? langInfo.code : sourceLang;
      if (looksUntranslatedForZh(translated, original, lang)) {
        const sourceForRescue =
          /[\u3040-\u30ff]/.test(translated) && (!original || original.length <= translated.length)
            ? translated
            : original || translated;
        original = sourceForRescue;
        try {
          const rescued = await rescueTranslateToZhTW({
            apiKey,
            model,
            text: sourceForRescue,
            sourceLang: lang,
            signal,
          });
          if (rescued) translated = rescued.trim();
        } catch (_) {}
      }

      const spCode = String(u.speaker || 'A').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 1) || 'A';
      normalized.push({
        direction: 'inbound',
        speaker: spCode,
        voiceHint: String(u.voice_hint || '').trim(),
        sourceLang: lang,
        targetLang: 'zh',
        isChinese: false,
        original: original || translated,
        zh: translated || original,
        translated: translated || original,
        reading: '',
      });
    }
  }

  return normalized;
}

const BROADCAST_REVISE_MARKER = '<<<REVISE>>>';
const BROADCAST_REVISE_RE = /\r?\n?\s*<<<\s*REVISE\s*>>>\s*\r?\n?/i;

/**
 * Incrementally extract clean Traditional Chinese preview from first-token-first Broadcast SSE stream,
 * suppressing control tags ([P], [SILENT]) and any partial trailing `<<<REVISE>>>` delimiter.
 */
export function extractBroadcastStreamPreview(raw) {
  const trimmedStart = String(raw || '').replace(/^\s+/, '');
  if (!trimmedStart) return { currentZh: '', revising: false };

  let body = trimmedStart;
  if (body.startsWith('[')) {
    const closeIdx = body.indexOf(']');
    if (closeIdx === -1) {
      if (body.length < 10) return { currentZh: '', revising: false };
    } else if (closeIdx <= 10) {
      const tag = body.slice(0, closeIdx + 1).toUpperCase();
      if (tag === '[SILENT]') return { currentZh: '', revising: false };
      if (tag === '[P]') {
        body = body.slice(closeIdx + 1).replace(/^\s+/, '');
      }
    }
  }

  const stripInlineMarkers = (txt) => String(txt || '').replace(/\s*\[(?:P|SILENT)\]\s*/gi, '').trim();

  const fullMatch = BROADCAST_REVISE_RE.exec(body);
  if (fullMatch) {
    return {
      currentZh: stripInlineMarkers(body.slice(0, fullMatch.index)),
      revising: true,
    };
  }

  // Strip any partial trailing prefix of `<<<REVISE>>>` so raw delimiter characters never flicker on screen
  const maxSuffix = Math.min(body.length, BROADCAST_REVISE_MARKER.length - 1);
  for (let len = maxSuffix; len >= 1; len--) {
    const suffix = body.slice(body.length - len);
    if (BROADCAST_REVISE_MARKER.startsWith(suffix.toUpperCase())) {
      return {
        currentZh: stripInlineMarkers(body.slice(0, body.length - len)),
        revising: len >= 3,
      };
    }
  }

  return { currentZh: stripInlineMarkers(body), revising: false };
}

/**
 * Parse completed first-token-first plain-text response from `interpretBroadcastAudio`.
 */
export function parseBroadcastStreamResponse(raw) {
  let cleaned = String(raw || '').trim();
  if (!cleaned) return null;

  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  if (!cleaned || /^\[SILENT\]$/i.test(cleaned)) return null;

  const stripInlineMarkers = (txt) => String(txt || '').replace(/\s*\[(?:P|SILENT)\]\s*/gi, '').trim();

  // Defensive fallback if model ever returns legacy JSON structure
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
    try {
      const j = safeJsonParse(cleaned);
      if (j && (typeof j.current_zh === 'string' || typeof j.revised_prev === 'string')) {
        const currentZh = stripInlineMarkers(j.current_zh);
        const revisedPrev = stripInlineMarkers(j.revised_prev);
        if (!currentZh && !revisedPrev) return null;
        return { currentZh, revisedPrev, newParagraph: Boolean(j.new_paragraph) };
      }
    } catch (_) {}
  }

  let newParagraph = false;
  if (/^\[P\]/i.test(cleaned)) {
    newParagraph = true;
    cleaned = cleaned.replace(/^\[P\]\s*/i, '').trim();
  }
  if (!cleaned || /^\[SILENT\]$/i.test(cleaned)) return null;

  const match = BROADCAST_REVISE_RE.exec(cleaned);
  if (match) {
    const rawCurrent = cleaned.slice(0, match.index).trim();
    const rawRevised = cleaned.slice(match.index + match[0].length).trim();
    const safeCurrent = /^\[SILENT\]$/i.test(rawCurrent) ? '' : stripInlineMarkers(rawCurrent);
    const safeRevised = /^\[SILENT\]$/i.test(rawRevised) ? '' : stripInlineMarkers(rawRevised);
    if (!safeCurrent && !safeRevised) return null;
    return { currentZh: safeCurrent, revisedPrev: safeRevised, newParagraph };
  }

  const finalZh = stripInlineMarkers(cleaned);
  if (!finalZh) return null;
  return { currentZh: finalZh, revisedPrev: '', newParagraph };
}

/**
 * Scenario 2 (Primary): Continuous Chinese-Only Broadcast Interpreter ("聆聽翻譯" 連續純中文＋回頭潤飾)
 * - First-token-first plain-text streaming protocol: Token #1 is immediately the first Chinese character on screen!
 * - Zero JSON wrapper overhead and optional trailing `<<<REVISE>>>` single-pass retroactive self-correction.
 */
export async function interpretBroadcastAudio({
  apiKey,
  model,
  wavBase64,
  mimeType = 'audio/wav',
  preferredLang = 'en',
  glossary = '',
  prevTailText = '',
  priorContext = '',
  onStream = null,
  signal,
}) {
  const langInfo = TARGET_LANGUAGES[preferredLang] || TARGET_LANGUAGES.en;
  const cleanPrev = String(prevTailText || '').trim();
  const cleanPrior = String(priorContext || '').trim();
  const glossaryLine = formatGlossaryLine(glossary);

  const systemInstruction = `Simultaneous broadcast interpreter. Translate audio (primarily ${langInfo.nativeName} or any language) directly into fluent, natural Taiwan Traditional Chinese (zh-TW) like professional news subtitles. Never output foreign sentences or Japanese Kana (keep standard acronyms like AI, GDP, NATO). Keep Chinese speech verbatim in zh-TW.
Output plain text ONLY (NO JSON, NO markdown):
- Silence, music, or noise only -> output exactly: [SILENT]
- Prefix with [P] ONLY on a clear new topic or news segment shift.
- Stream the new zh-TW translation immediately. Seamlessly skip any 1-2 word audio overlap from PREV.
- ONLY IF PREV was provided and the new audio clearly clarifies or improves PREV (fixing SVO/SOV clause order, cut endings, pronouns, or proper nouns), append a newline, then <<<REVISE>>>, then a newline, then the complete improved zh-TW for PREV so PREV + new text read smoothly with zero duplication or omission.
- If PREV already reads smoothly, STOP right after the new translation (omit <<<REVISE>>>).`;

  const promptParts = [];
  if (glossaryLine) {
    promptParts.push(glossaryLine);
  }
  if (cleanPrior) {
    promptParts.push(`PRIOR (read-only context for consistency):\n${cleanPrior}`);
  }
  if (cleanPrev) {
    promptParts.push(`PREV (append <<<REVISE>>> only if new audio improves it):\n${cleanPrev}`);
  }
  promptParts.push('Translate the new audio into continuous Taiwan zh-TW.');

  const payload = {
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType,
              data: wavBase64,
            },
          },
          { text: promptParts.join('\n\n') },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.15,
      ...buildThinkingConfig(model),
    },
  };

  const raw = await generateJsonWithStreamingFallback({
    apiKey,
    model,
    payload,
    onPartialText:
      typeof onStream === 'function'
        ? (partial) => {
            const preview = extractBroadcastStreamPreview(partial);
            if (preview.currentZh || preview.revising) {
              onStream(preview);
            }
          }
        : null,
    signal,
  });

  const parsed = parseBroadcastStreamResponse(raw);
  if (!parsed) return null;

  let revisedPrev = cleanPrev ? String(parsed.revisedPrev || '').trim() : '';
  let currentZh = String(parsed.currentZh || '').trim();
  const newParagraph = Boolean(parsed.newParagraph);

  // Guardrail: reject malformed or untranslated revisedPrev so we never corrupt prior good Chinese
  if (revisedPrev) {
    const tooShort = cleanPrev.length >= 16 && revisedPrev.length < Math.floor(cleanPrev.length * 0.4);
    if (revisedPrev === cleanPrev || tooShort || looksUntranslatedForZh(revisedPrev, '', preferredLang)) {
      revisedPrev = '';
    }
  }

  // Guardrail: rescue if raw foreign text accidentally leaked into currentZh
  if (currentZh && looksUntranslatedForZh(currentZh, '', preferredLang)) {
    try {
      const rescued = await rescueTranslateToZhTW({
        apiKey,
        model,
        text: currentZh,
        sourceLang: preferredLang,
        signal,
      });
      if (rescued) currentZh = rescued.trim();
    } catch (_) {}
  }

  if (!revisedPrev && !currentZh) return null;

  return {
    revisedPrev,
    currentZh,
    newParagraph,
  };
}

/**
 * Ultra-lightweight text-only retroactive polisher (~150 tokens, ~0.1x cost of an audio call).
 * Used to smooth parallel Turbo broadcast bursts or polish a paragraph on demand without losing any facts.
 */
export async function polishBroadcastText({
  apiKey,
  model,
  glossary = '',
  priorContext = '',
  draftText,
  signal,
}) {
  const cleanDraft = String(draftText || '').trim();
  if (!cleanDraft || cleanDraft.length < 8) return null;
  const cleanPrior = String(priorContext || '').trim();
  const glossaryLine = formatGlossaryLine(glossary);

  const prompt = [
    glossaryLine,
    cleanPrior ? `PRIOR (read-only context, do NOT output):\n${cleanPrior}` : '',
    `DRAFT:\n${cleanDraft}`,
    'Polish DRAFT into completely smooth, idiomatic Taiwan Traditional Chinese (zh-TW): fix chunk breaks, inverted clause order, inconsistent pronouns/proper nouns, and repeated words. Preserve ALL original facts and details (never summarize or omit). Return strict JSON.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.15,
      ...buildThinkingConfig(model),
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          polished_zh: {
            type: 'STRING',
            description: 'Smooth complete Taiwan zh-TW preserving all original facts',
          },
        },
        required: ['polished_zh'],
      },
    },
  };

  const data = await postGenerateContent(apiKey, model, payload, signal, 16000);
  const raw = extractTextPart(data);
  const parsed = safeJsonParse(raw);
  const polished = String(parsed?.polished_zh || '').trim();

  // Safety guard: never replace with empty, untranslated, or aggressively summarized text
  if (
    !polished ||
    polished === cleanDraft ||
    polished.length < Math.floor(cleanDraft.length * 0.55) ||
    looksUntranslatedForZh(polished, '', 'en')
  ) {
    return null;
  }

  return polished;
}

/**
 * Legacy / Multi-speaker Listening Interpreter (kept for compatibility)
 * - Non-Chinese speech -> Traditional Chinese (zh-TW) + original text
 * - Chinese speech -> transcribe verbatim into Traditional Chinese
 * - Tag speakers consistently (A, B, C, ...)
 */
export async function interpretListeningAudio({
  apiKey,
  model,
  wavBase64,
  mimeType = 'audio/wav',
  preferredLang = 'en',
  mode = 'broadcast',
  speakerMemory = {},
  recentContext = [],
  contextLimit = 4,
  onStream = null,
  signal,
}) {
  const langInfo = TARGET_LANGUAGES[preferredLang] || TARGET_LANGUAGES.en;
  const isBroadcast = mode === 'broadcast';

  const speakerLines = Object.entries(speakerMemory)
    .slice(0, 6)
    .map(([id, info]) => `- ${id}${info.customName ? `（${info.customName}）` : ''}：${info.voiceHint || '說話者'}`)
    .join('\n');

  const limit = Math.max(0, Number(contextLimit) || 4);
  const contextLines =
    limit > 0
      ? recentContext
          .slice(-limit)
          .map((m) => `${m.speaker}: ${m.zh}${m.original && !m.isChinese ? ` (${m.original})` : ''}`)
          .join('\n')
      : '';

  const broadcastRule = isBroadcast
    ? `
0. **新聞／演講連貫段落模式（2–3 句整合翻譯）**：
   - 這段音訊是連續收聽的新聞、Podcast、影片或演講片段（通常包含 2–3 句話）。
   - 若為**同一位講者**連續說的數句話，請將它們合併為**同一筆連貫流暢的繁體中文段落**（不要拆成零碎短句），並完整保留所有重點資訊與專有名詞一致性。
   - 若片段開頭因無縫收音與【最近紀錄】的最後 1–2 個字重疊，請自然銜接、不要重複翻譯前文已翻過的部分。
   - 僅當同一段音訊中明顯切換不同說話者（例如主播與受訪者）時，才拆分為多筆 \`utterances\`。`
    : '';

  const systemInstruction = `你是一位專業、精準、反應迅速的個人隨身即時口譯官。使用者以繁體中文（台灣用語）為母語，目前收聽的內容可能是英語、日語、瑞典語、中文或其他語言（重點語言：${langInfo.label} / ${langInfo.nativeName}）。

請仔細聆聽音訊並嚴格遵守以下規則：${broadcastRule}

1. **說話者區分（Speaker Diarization）**：
   - 為每位說話者標註一致的單一大寫英文字母代號：\`A\`、\`B\`、\`C\`、\`D\`...
   - 比對聲音特徵（性別、音色、口音、語言）：不同聲音請給不同代號，同一位講者沿用原代號。

2. **語言判斷與翻譯規則（極重要！）**：
   - **聽到「非中文」**（英語、日語、瑞典語或任何其他外語）：
     - \`is_chinese\` 設為 \`false\`，\`lang\` 填 ISO 639-1 語言碼（如 \`en\`、\`ja\`、\`sv\`）
     - \`original_text\` 填該外語完整正確逐字稿
     - \`chinese_translation\` **必須完整翻譯成自然流暢的繁體中文（台灣慣用語）**！絕對不可直接留外語或日文假名！
   - **聽到「中文」**：
     - \`is_chinese\` 設為 \`true\`，\`lang\` 設為 \`zh\`，\`original_text\` 與 \`chinese_translation\` 都填精準繁體中文原話。

3. **過濾雜訊**：
   - 若只有背景音樂、純雜訊、空白或無法辨識的氣音，回傳 \`{"utterances": []}\`，勿捏造內容。
4. 只輸出符合 schema 的 JSON。`;

  const promptText = [
    speakerLines ? `【已知講者】\n${speakerLines}` : '',
    contextLines ? `【前文脈絡（保持專有名詞一致，若開頭重疊勿重複翻）】\n${contextLines}` : '',
    isBroadcast
      ? '請將這段連續收聽的語音（約 2–3 句）完整、連貫地翻譯成自然流暢的繁體中文段落，輸出 JSON。'
      : '請分析這段新收錄的音訊，確保外語的 chinese_translation 必為繁體中文翻譯，輸出 JSON。',
  ]
    .filter(Boolean)
    .join('\n\n');

  const payload = {
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType,
              data: wavBase64,
            },
          },
          { text: promptText },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.15,
      ...buildThinkingConfig(model),
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          utterances: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                speaker: {
                  type: 'STRING',
                  description: '單一大寫英文字母說話者代號，如 A, B, C, D',
                },
                voice_hint: {
                  type: 'STRING',
                  description: '聲音特徵（性別・語言），例如：男主播・英語',
                },
                lang: {
                  type: 'STRING',
                  description: 'ISO 639-1 語言碼，例如 zh, en, ja, sv',
                },
                is_chinese: {
                  type: 'BOOLEAN',
                  description: '原話是否為中文',
                },
                original_text: {
                  type: 'STRING',
                  description: '原話完整逐字稿（保留原語言）',
                },
                chinese_translation: {
                  type: 'STRING',
                  description: '必須為自然連貫的繁體中文翻譯！不可留外語；中文時照原話輸出',
                },
              },
              required: ['speaker', 'voice_hint', 'lang', 'is_chinese', 'original_text', 'chinese_translation'],
            },
          },
        },
        required: ['utterances'],
      },
    },
  };

  const raw = await generateJsonWithStreamingFallback({
    apiKey,
    model,
    payload,
    onPartialText:
      typeof onStream === 'function'
        ? (partial) => {
            const zh = extractPartialJsonStringField(partial, 'chinese_translation');
            const original = extractPartialJsonStringField(partial, 'original_text');
            const speaker = extractPartialJsonStringField(partial, 'speaker') || 'A';
            const lang = extractPartialJsonStringField(partial, 'lang') || '';
            if (zh || original) {
              onStream({
                direction: 'inbound',
                speaker: speaker.toUpperCase().slice(0, 4) || 'A',
                lang: sanitizeLangCode(lang, ''),
                mainText: zh || original,
                subText: zh && original && original !== zh ? original : '',
              });
            }
          }
        : null,
    signal,
  });

  const parsed = safeJsonParse(raw);
  const list = Array.isArray(parsed?.utterances) ? parsed.utterances : [];

  const normalized = [];
  for (const u of list) {
    if (!u) continue;
    let original = String(u.original_text || u.original || '').trim();
    let zh = String(u.chinese_translation || u.zh || '').trim();
    if (!original && !zh) continue;

    const lang = sanitizeLangCode(u.lang, 'unknown');
    const isChinese = Boolean(u.is_chinese) || lang.startsWith('zh');

    if (!isChinese && looksUntranslatedForZh(zh, original, lang)) {
      const sourceForRescue =
        /[\u3040-\u30ff]/.test(zh) && (!original || original.length <= zh.length) ? zh : original || zh;
      original = sourceForRescue;
      try {
        const rescued = await rescueTranslateToZhTW({
          apiKey,
          model,
          text: sourceForRescue,
          sourceLang: lang,
          signal,
        });
        if (rescued) zh = rescued.trim();
      } catch (_) {}
    }

    normalized.push({
      direction: 'inbound',
      speaker: String(u.speaker || 'A').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 1) || 'A',
      voiceHint: String(u.voice_hint || '').trim(),
      lang,
      isChinese,
      original: original || zh,
      zh: zh || original,
    });
  }

  return normalized;
}

/**
 * Manual Voice / Text Quick Translation — Auto-detects Chinese <-> English / Japanese / Swedish.
 */
export async function translateOutboundChinese({
  apiKey,
  model,
  targetLang = 'en',
  tone = 'natural',
  glossary = '',
  wavBase64 = null,
  mimeType = 'audio/wav',
  textInput = null,
  recentContext = [],
  contextLimit = 5,
  onStream = null,
  signal,
}) {
  const langInfo = TARGET_LANGUAGES[targetLang] || TARGET_LANGUAGES.en;
  const toneDescEn = TONE_PRESETS_EN[tone] || TONE_PRESETS_EN.natural;
  const glossaryLine = formatGlossaryLine(glossary);

  const limit = Math.max(0, Number(contextLimit) || 5);
  const contextLines =
    limit > 0
      ? recentContext
          .slice(-limit)
          .map((m) => `${m.speaker}: ${m.zh}${m.original && !m.isChinese ? ` (${m.original})` : ''}`)
          .join('\n')
      : '';

  const systemInstruction = `Personal bidirectional interpreter. Auto-detect input language (text or audio):
1. Chinese input -> source_lang:"zh", target_lang:"${langInfo.code}", translated:natural idiomatic ${langInfo.nativeName} (tone: ${toneDescEn}).
2. Non-Chinese input -> source_lang:ISO-639-1, target_lang:"zh", translated:natural fluent Taiwan Traditional Chinese (zh-TW).
3. source_text: exact input text or accurate audio transcript. If audio has no intelligible speech, leave source_text and translated empty.
4. reading: ONLY when target_lang is "ja" provide Kana + Romaji (e.g. おげんきですか (Ogenki desu ka)); for "sv" provide brief stress hint if helpful; else "".
Output strict JSON only.`;

  const parts = [];
  if (wavBase64) {
    parts.push({
      inlineData: {
        mimeType,
        data: wavBase64,
      },
    });
  }

  const promptText = [
    glossaryLine,
    contextLines ? `Context:\n${contextLines}` : '',
    textInput
      ? `Input:\n${textInput}\n\nAuto-translate: Chinese -> ${langInfo.nativeName}; non-Chinese -> zh-TW.`
      : `Transcribe and auto-translate audio: Chinese -> ${langInfo.nativeName}; non-Chinese -> zh-TW.`,
  ]
    .filter(Boolean)
    .join('\n\n');

  parts.push({ text: promptText });

  const payload = {
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    contents: [
      {
        role: 'user',
        parts,
      },
    ],
    generationConfig: {
      temperature: 0.2,
      ...buildThinkingConfig(model),
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          source_lang: {
            type: 'STRING',
            description: 'Detected ISO 639-1 code (zh, en, ja, sv)',
          },
          target_lang: {
            type: 'STRING',
            description: `${langInfo.code} if Chinese input; zh if non-Chinese input`,
          },
          source_text: {
            type: 'STRING',
            description: 'Original text or audio transcript',
          },
          translated: {
            type: 'STRING',
            description: 'Natural idiomatic translation',
          },
          reading: {
            type: 'STRING',
            description: 'Japanese Kana+Romaji or brief Swedish stress hint; else empty',
          },
        },
        required: ['source_lang', 'target_lang', 'source_text', 'translated', 'reading'],
      },
    },
  };

  const raw = await generateJsonWithStreamingFallback({
    apiKey,
    model,
    payload,
    onPartialText:
      typeof onStream === 'function'
        ? (partial) => {
            const srcLang = (extractPartialJsonStringField(partial, 'source_lang') || '').toLowerCase();
            const srcText = extractPartialJsonStringField(partial, 'source_text') || textInput || '';
            const translated = extractPartialJsonStringField(partial, 'translated');
            const reading = extractPartialJsonStringField(partial, 'reading');
            if (translated || srcText) {
              const isSrcZh = srcLang ? srcLang.startsWith('zh') : /[\u4e00-\u9fff]/.test(srcText);
              onStream({
                direction: isSrcZh ? 'outbound' : 'inbound',
                speaker: isSrcZh ? '我' : '譯',
                lang: isSrcZh ? langInfo.code : srcLang || langInfo.code,
                mainText: translated || srcText,
                subText:
                  translated && srcText && translated !== srcText
                    ? isSrcZh
                      ? `原話：${srcText}`
                      : srcText
                    : '',
                reading: isSrcZh ? reading : '',
              });
            }
          }
        : null,
    signal,
  });

  const parsed = safeJsonParse(raw);

  if (!parsed || !parsed.translated || !parsed.translated.trim()) {
    return null;
  }

  const sourceLang = sanitizeLangCode(parsed.source_lang, 'zh');
  const isSourceChinese = sourceLang.startsWith('zh');
  const resolvedTargetLang = isSourceChinese ? langInfo.code : 'zh';
  const sourceText = String(parsed.source_text || textInput || '').trim();
  let translated = String(parsed.translated || '').trim();

  // Safety rescue if non-Chinese input leaked untranslated text into Chinese output
  if (!isSourceChinese && looksUntranslatedForZh(translated, sourceText, sourceLang)) {
    try {
      const rescued = await rescueTranslateToZhTW({
        apiKey,
        model,
        text: sourceText || translated,
        sourceLang,
        signal,
      });
      if (rescued) translated = rescued.trim();
    } catch (_) {}
  }

  return {
    sourceLang: isSourceChinese ? 'zh' : sourceLang,
    targetLang: resolvedTargetLang,
    isSourceChinese,
    sourceText,
    zh: isSourceChinese ? sourceText : translated,
    translated,
    reading: isSourceChinese ? String(parsed.reading || '').trim() : '',
  };
}

/**
 * Mode 3: Gemini 3.8 TTS — Synthesize natural spoken audio.
 * Returns { base64, mimeType }.
 */
export async function synthesizeGeminiSpeech({
  apiKey,
  ttsModel = 'gemini-3.8-flash-lite-tts',
  voiceName = 'Kore',
  text,
  langCode = 'zh',
  signal,
}) {
  // Gemini 3.8 TTS treats `text` strictly as a verbatim transcript and auto-detects language.
  // Never wrap it in English instructions or the model will read those instructions aloud!
  const cleanText = String(text || '').trim();
  if (!cleanText) {
    throw new Error('沒有可朗讀的文字內容');
  }

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: cleanText,
          },
        ],
      },
    ],
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
  };

  const data = await postGenerateContent(apiKey, ttsModel, payload, signal);
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const audioPart = parts.find((p) => p.inlineData && p.inlineData.data);

  if (!audioPart) {
    throw new Error('Gemini TTS 未回傳音訊資料，請確認模型設定或改用瀏覽器語音。');
  }

  return {
    base64: audioPart.inlineData.data,
    mimeType: audioPart.inlineData.mimeType || 'audio/wav',
  };
}

/**
 * Mode 4: Photo / Menu / Sign / Document Translation
 * - Non-Chinese photo -> translate cleanly into Traditional Chinese (zh-TW) with item breakdown
 * - Chinese photo -> translate into selected counterpart language (en / ja / sv)
 */
export async function translateImageWithGemini({
  apiKey,
  model,
  imageBase64,
  mimeType = 'image/jpeg',
  targetLang = 'en',
  signal,
}) {
  const langInfo = TARGET_LANGUAGES[targetLang] || TARGET_LANGUAGES.en;

  const systemInstruction = `你是使用者的隨身視覺翻譯官，專精於旅遊與日常面對面場景（餐廳菜單、飲料單、路標、車站時刻表、收據、食品成分、商店告示與文件）。

請仔細閱讀圖片中的文字，並嚴格遵守以下規則：
1. **自動語言判斷**：
   - 若圖片主要文字是**非中文**（日語、英語、瑞典語或其他外語）：將內容清楚翻譯成自然道地的**繁體中文（台灣慣用語）**，\`target_lang\` 設為 \`"zh"\`。
   - 若圖片主要文字是**中文**：翻譯成「${langInfo.label}（${langInfo.nativeName}）」，\`target_lang\` 設為 \`"${langInfo.code}"\`。
2. **結構化整理（適合手機快速閱讀）**：
   - \`title\`：簡短標題（12字內，例如「日文拉麵菜單」「瑞典咖啡廳價目表」「英文告示」）。
   - \`summary\`：若為單段告示／路標，直接給出完整自然譯文；若為菜單／清單，給出一句話總覽（例如「共辨識 6 項餐點，皆含稅價」）。
   - \`items\`：若圖片有多個條目（如菜單菜名＋價格、注意事項條列），請逐項整理（最多 15 項最重要條目）：
     - \`original\`：原文（方便使用者點選發音或對照點菜）
     - \`translated\`：對應譯文（若是菜單可保留價格數字與簡短食材說明）
     - \`note\`：簡短補充（如「含堅果」「辣」「人氣推薦」；無則留空字串）
   - 若圖片只是單一短句或路標，\`items\` 可放 1 筆即可。
3. 若圖片完全沒有可辨識文字，請在 \`summary\` 說明「圖片中未偵測到清楚文字」，\`items\` 設為空陣列。
4. 只輸出符合 schema 的 JSON。`;

  const payload = {
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType,
              data: imageBase64,
            },
          },
          {
            text: `請辨識並翻譯這張圖片中的所有重要文字（非中文翻成繁體中文；中文翻成${langInfo.label}）。`,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.15,
      ...buildThinkingConfig(model),
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          source_lang: {
            type: 'STRING',
            description: '圖片主要文字語言 ISO 639-1 代碼，如 ja, en, sv, zh',
          },
          target_lang: {
            type: 'STRING',
            description: `翻譯目標語言代碼：外語圖片為 zh，中文圖片為 ${langInfo.code}`,
          },
          title: {
            type: 'STRING',
            description: '簡短標題，例如「日文菜單翻譯」',
          },
          summary: {
            type: 'STRING',
            description: '主譯文或摘要',
          },
          items: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                original: { type: 'STRING', description: '圖片原文條目' },
                translated: { type: 'STRING', description: '自然譯文（可含價格）' },
                note: { type: 'STRING', description: '簡短備註，無則留空' },
              },
              required: ['original', 'translated', 'note'],
            },
          },
        },
        required: ['source_lang', 'target_lang', 'title', 'summary', 'items'],
      },
    },
  };

  const data = await postGenerateContent(apiKey, model, payload, signal, 35000);
  const raw = extractTextPart(data);
  const parsed = safeJsonParse(raw);

  if (!parsed) return null;

  const sourceLang = sanitizeLangCode(parsed.source_lang, 'en');
  const isSourceChinese = sourceLang.startsWith('zh');
  const resolvedTargetLang = isSourceChinese ? langInfo.code : 'zh';
  const items = Array.isArray(parsed.items)
    ? parsed.items
        .filter((it) => it && (it.translated || it.original))
        .slice(0, 15)
        .map((it) => ({
          original: String(it.original || '').trim(),
          translated: String(it.translated || it.original || '').trim(),
          note: String(it.note || '').trim(),
        }))
    : [];

  return {
    sourceLang: isSourceChinese ? 'zh' : sourceLang,
    targetLang: resolvedTargetLang,
    isSourceChinese,
    title: String(parsed.title || '拍照翻譯').trim(),
    summary: String(parsed.summary || (items[0]?.translated || '')).trim(),
    items,
  };
}

/**
 * Lightweight API key & model connectivity check.
 */
export async function testApiKey({ apiKey, model = 'gemini-3.5-flash-lite' }) {
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: 'Reply with just OK.' }],
      },
    ],
    generationConfig: {
      maxOutputTokens: 32,
      temperature: 0,
      ...buildThinkingConfig(model),
    },
  };

  const data = await postGenerateContent(apiKey, model, payload);
  const txt = extractTextPart(data);
  return { ok: true, reply: txt || 'OK' };
}
