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

function friendlyApiError(status, bodyText) {
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.error?.message || '';
  } catch (_) {
    detail = bodyText || '';
  }

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

async function postGenerateContent(apiKey, model, payload, signal) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('尚未設定 Gemini API Key，請點右上角「設定」填入。');
  }

  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey.trim(),
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw friendlyApiError(resp.status, text);
  }

  return resp.json();
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
  if (model === 'gemini-3.8-flash') {
    return { thinkingConfig: { thinkingLevel: 'low' } };
  }
  return {};
}

function safeJsonParse(raw) {
  if (!raw) return null;
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  return JSON.parse(cleaned);
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

/**
 * Mode 1: Continuous Listening Interpreter
 * - Non-Chinese speech -> translate into natural Traditional Chinese (zh-TW) + keep original text
 * - Chinese speech -> transcribe directly into Traditional Chinese (no translation)
 * - Tag speakers consistently (A, B, C, ...)
 */
export async function interpretListeningAudio({
  apiKey,
  model,
  wavBase64,
  mimeType = 'audio/wav',
  preferredLang = 'en',
  speakerMemory = {},
  recentContext = [],
  signal,
}) {
  const langInfo = TARGET_LANGUAGES[preferredLang] || TARGET_LANGUAGES.en;

  const speakerLines = Object.entries(speakerMemory)
    .map(([id, info]) => `- ${id}${info.customName ? `（別名：${info.customName}）` : ''}：${info.voiceHint || '已出現說話者'}`)
    .join('\n');

  const contextLines = recentContext
    .slice(-6)
    .map((m) => `${m.speaker}: ${m.zh}${m.original && !m.isChinese ? ` (${m.original})` : ''}`)
    .join('\n');

  const systemInstruction = `你是一位專業、精準、反應迅速的個人隨身即時口譯官。使用者以繁體中文（台灣用語）為母語，目前對話對象可能使用英語、日語、瑞典語、中文或其他語言（目前重點關注語言：${langInfo.label} / ${langInfo.nativeName}）。

請仔細聆聽音訊並嚴格遵守以下規則：

1. **說話者區分（Speaker Diarization）**：
   - 為每位說話者標註一致的單一大寫英文字母代號：\`A\`、\`B\`、\`C\`、\`D\`...
   - **務必仔細比對聲音特徵（性別、音高、音色、語速、口音、語言）以及對話輪替語境**：
     - 如果這句話的聲音與先前說話者不同，或**明顯是對前一位說話者的回應／回答**（例如 A 問「你聽得到我嗎？」，接著有人回答「我聽得到你」），請給予**不同的說話者代號**（例如改標 \`B\`），不要把所有人都全部標成 \`A\`！
     - 若聲音與語境明確屬於先前已知的同一位說話者，則沿用原本的代號。
   - 若同一段音訊中有多人輪流說話，請依時間順序拆分為多筆 \`utterances\`。

2. **語言判斷與翻譯規則（極重要！）**：
   - **聽到「非中文」**（英語、日語、瑞典語或任何其他外語）：
     - \`is_chinese\` 設為 \`false\`
     - \`lang\` 填入 ISO 639-1 語言代碼（如 \`en\`、\`ja\`、\`sv\`）
     - \`original_text\` 填入該外語正確自然的逐字原文（日文請用正常漢字與假名拼寫）
     - \`chinese_translation\` **必須完整翻譯成自然流暢的繁體中文（台灣慣用語）**！**絕對不可**直接複製日文假名、英文或瑞典文到 \`chinese_translation\` 欄位！
   - **聽到「中文」**（國語／普通話／台灣華語等）：
     - \`is_chinese\` 設為 \`true\`
     - \`lang\` 設為 \`zh\`
     - \`original_text\` 與 \`chinese_translation\` 都直接填入精準的繁體中文原話，不要改寫也不要翻譯。

3. **正確輸出範例**：
   - 聽到日文「いただきます」→ \`{"speaker":"A","voice_hint":"男聲・日語","lang":"ja","is_chinese":false,"original_text":"いただきます","chinese_translation":"我要開動了"}\`
   - 聽到英文 "Can you hear me?" 後接著另一人答 "Yes, I can hear you." → 第一句 \`speaker:"A"\`、\`chinese_translation:"你聽得到我嗎？"\`；第二句 \`speaker:"B"\`、\`chinese_translation:"對，我聽得到你。"\`
   - 聽到中文「我很好，謝謝」→ \`{"speaker":"B","voice_hint":"女聲・中文","lang":"zh","is_chinese":true,"original_text":"我很好，謝謝","chinese_translation":"我很好，謝謝"}\`

4. **過濾雜訊**：
   - 若音訊只有背景雜音、空白、呼吸聲、咳嗽或無法辨識的片段，直接回傳 \`{"utterances": []}\`，絕對不要捏造內容。
5. 只輸出符合 schema 的 JSON。`;

  const promptText = [
    speakerLines
      ? `【先前已記錄的說話者特徵】\n${speakerLines}\n（請比對音色、語言與問答輪替：若為不同聲音或對話回應方，請使用下一個代號如 B / C）`
      : '【目前尚無先前說話者記錄：第一位開口者標記為 A，第二位不同聲音或回應方標記為 B】',
    contextLines ? `【最近對話紀錄（供問答輪替與語境參考）】\n${contextLines}` : '',
    '請分析這段新收錄的音訊，並嚴格確保外語的 chinese_translation 欄位一定是繁體中文翻譯，輸出 JSON。',
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
                  description: '聲音特徵（性別・音高・語言），例如：男聲・低沉・英語',
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
                  description: '原話正確逐字稿（保留原語言，如日文／英文／瑞典文／中文）',
                },
                chinese_translation: {
                  type: 'STRING',
                  description: '必須為繁體中文！非中文時務必翻譯成自然繁體中文，不可留外語；中文時照原話輸出',
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

  const data = await postGenerateContent(apiKey, model, payload, signal);
  const raw = extractTextPart(data);
  const parsed = safeJsonParse(raw);
  const list = Array.isArray(parsed?.utterances) ? parsed.utterances : [];

  const normalized = [];
  for (const u of list) {
    if (!u) continue;
    let original = String(u.original_text || u.original || '').trim();
    let zh = String(u.chinese_translation || u.zh || '').trim();
    if (!original && !zh) continue;

    const lang = String(u.lang || 'unknown').trim().toLowerCase().slice(0, 8);
    const isChinese = Boolean(u.is_chinese) || lang.startsWith('zh');

    if (!isChinese && looksUntranslatedForZh(zh, original, lang)) {
      // If the cleaner foreign phrase accidentally landed in `zh`, keep the better original & rescue translate to zh-TW
      const sourceForRescue =
        /[\u3040-\u30ff]/.test(zh) && (!original || original.length <= zh.length) ? zh : (original || zh);
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
      speaker: String(u.speaker || 'A').trim().toUpperCase().slice(0, 4) || 'A',
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
 * Mode 2: Outbound Translation — User speaks (audio) or types (text) Chinese,
 * translate into natural English / Japanese / Swedish to speak to the other person.
 */
export async function translateOutboundChinese({
  apiKey,
  model,
  targetLang = 'en',
  tone = 'natural',
  wavBase64 = null,
  mimeType = 'audio/wav',
  textInput = null,
  recentContext = [],
  signal,
}) {
  const langInfo = TARGET_LANGUAGES[targetLang] || TARGET_LANGUAGES.en;
  const toneDesc = TONE_PRESETS[tone] || TONE_PRESETS.natural;

  const contextLines = recentContext
    .slice(-6)
    .map((m) => `${m.speaker}: ${m.zh}${m.original && !m.isChinese ? ` (${m.original})` : ''}`)
    .join('\n');

  const systemInstruction = `你是使用者的專屬隨身雙向口譯官。請自動偵測使用者輸入（文字或語音）的語言，並遵守以下雙向翻譯規則：

1. **自動語言判斷與翻譯方向**：
   - 若輸入是**中文**（繁體／簡體／台灣華語）：設 \`source_lang\` 為 \`"zh"\`、\`target_lang\` 為 \`"${langInfo.code}"\`，將其自然地道地翻譯成「${langInfo.label}（${langInfo.nativeName}）」，語氣風格：${toneDesc}。
   - 若輸入是**非中文**（英語、日語、瑞典語或任何其他外語）：設 \`source_lang\` 為該語言的 ISO 639-1 代碼（如 \`"en"\`、\`"ja"\`、\`"sv"\`），設 \`target_lang\` 為 \`"zh"\`，將其翻譯成自然流暢的**繁體中文（台灣慣用語）**。
2. \`source_text\`：
   - 若輸入為文字，填入使用者原始文字；若輸入為音訊，先精準轉寫原話。若音訊無有效語音則讓 \`source_text\` 與 \`translated\` 皆為空字串。
3. \`reading\` 欄位：
   - 僅當 \`target_lang\` 為日語（\`ja\`）時，提供假名與羅馬拼音（例如：おげんきですか (Ogenki desu ka)）。
   - 當 \`target_lang\` 為瑞典語（\`sv\`）且有必要時，提供簡短重音提示；其餘情況（包含翻成中文或英語）留空字串即可。
4. 譯文必須自然像母語者說的話，不要生硬直譯。只輸出符合 schema 的 JSON。`;

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
    contextLines ? `【目前對話上下文（幫助代名詞與語氣銜接）】\n${contextLines}` : '',
    textInput
      ? `【使用者輸入文字】\n${textInput}\n\n請自動判斷語言：若是中文請翻成 ${langInfo.label}（${langInfo.nativeName}）；若是非中文請翻成繁體中文。`
      : `請聽這段語音並自動判斷語言：若是中文請翻成 ${langInfo.label}（${langInfo.nativeName}）；若是非中文請翻成繁體中文。`,
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
            description: '偵測到的輸入語言 ISO 639-1 代碼，例如 zh, en, ja, sv',
          },
          target_lang: {
            type: 'STRING',
            description: `輸出譯文語言代碼：輸入為中文時為 ${langInfo.code}，輸入為非中文時為 zh`,
          },
          source_text: {
            type: 'STRING',
            description: '原始輸入文字或語音轉寫稿',
          },
          translated: {
            type: 'STRING',
            description: '自然道地的譯文',
          },
          reading: {
            type: 'STRING',
            description: '日語假名/羅馬音或瑞典語簡短重音提示；其餘留空',
          },
        },
        required: ['source_lang', 'target_lang', 'source_text', 'translated', 'reading'],
      },
    },
  };

  const data = await postGenerateContent(apiKey, model, payload, signal);
  const raw = extractTextPart(data);
  const parsed = safeJsonParse(raw);

  if (!parsed || !parsed.translated || !parsed.translated.trim()) {
    return null;
  }

  const sourceLang = String(parsed.source_lang || 'zh').trim().toLowerCase().slice(0, 8);
  const isSourceChinese = sourceLang.startsWith('zh');
  const resolvedTargetLang = isSourceChinese ? langInfo.code : 'zh';
  const sourceText = String(parsed.source_text || textInput || '').trim();
  const translated = String(parsed.translated || '').trim();

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
