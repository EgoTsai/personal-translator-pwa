/**
 * drive.js — Personal Google Drive / Google Docs Bridge Client (Apps Script Web App)
 *
 * Security & CORS design:
 *  - Strictly restricts target URLs to `https://script.google.com/macros/`
 *  - Sends JSON via `Content-Type: text/plain;charset=utf-8` (CORS simple request, no OPTIONS preflight)
 *  - Transmits per-user random secret ONLY inside HTTPS POST body (never in URL query parameters)
 *  - Validates returned `docUrl` is a genuine `https://docs.google.com/` URL before opening
 */

const APPS_SCRIPT_URL_RE = /^https:\/\/script\.google\.com\/macros\/(?:u\/\d+\/)?s\/[A-Za-z0-9_-]{20,}\/(?:exec|dev)$/;
const DOC_ID_RE = /^[A-Za-z0-9_-]{10,128}$/;
export const MIN_DRIVE_SECRET_LEN = 16;

export function generateDriveSecret(length = 28) {
  const targetLen = Math.max(MIN_DRIVE_SECRET_LEN, Math.min(128, Number(length) || 28));
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('瀏覽器不支援安全亂數產生器（Web Crypto API），無法產生私人密鑰。');
  }
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const maxValid = Math.floor(256 / alphabet.length) * alphabet.length; // Unbiased rejection sampling
  const buf = new Uint8Array(targetLen * 2);
  let out = '';
  while (out.length < targetLen) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < targetLen; i++) {
      if (buf[i] < maxValid) {
        out += alphabet[buf[i] % alphabet.length];
      }
    }
  }
  return out;
}

export function isValidAppsScriptUrl(url) {
  return APPS_SCRIPT_URL_RE.test(String(url || '').trim());
}

/**
 * Strictly validate Google Docs / Drive document URLs returned by Apps Script.
 * Note: DocumentApp.create().getUrl() returns `https://docs.google.com/open?id=<ID>`
 * in Google Apps Script, in addition to `/document/d/<ID>/edit`.
 */
export function isValidGoogleDocUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    if (u.protocol !== 'https:') return false;
    if (u.hostname === 'docs.google.com') {
      if (/^\/document\/(?:u\/\d+\/)?d\/[A-Za-z0-9_-]{10,128}(?:\/[A-Za-z0-9_/-]*)?$/.test(u.pathname)) {
        return true;
      }
      if (u.pathname === '/open' && DOC_ID_RE.test(u.searchParams.get('id') || '')) {
        return true;
      }
      return false;
    }
    if (u.hostname === 'drive.google.com') {
      if (/^\/file\/(?:u\/\d+\/)?d\/[A-Za-z0-9_-]{10,128}(?:\/[A-Za-z0-9_/-]*)?$/.test(u.pathname)) {
        return true;
      }
      if (u.pathname === '/open' && DOC_ID_RE.test(u.searchParams.get('id') || '')) {
        return true;
      }
      return false;
    }
    return false;
  } catch (_) {
    return false;
  }
}

export function normalizeGoogleDocUrl(docUrl, docId = '') {
  const cleanId = String(docId || '').trim();
  const rawUrl = String(docUrl || '').trim();
  if (rawUrl && !isValidGoogleDocUrl(rawUrl)) {
    return '';
  }
  if (DOC_ID_RE.test(cleanId)) {
    return `https://docs.google.com/document/d/${cleanId}/edit`;
  }
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl);
    if (u.pathname === '/open') {
      const idParam = u.searchParams.get('id') || '';
      if (DOC_ID_RE.test(idParam)) {
        return `https://docs.google.com/document/d/${idParam}/edit`;
      }
    }
  } catch (_) {
    return '';
  }
  return rawUrl;
}

function sanitizeFolderName(name) {
  const cleaned = String(name || '')
    .replace(/[\x00-\x1f\x7f/\\<>:"|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 60) || '隨身口譯官';
}

function escapeJsSingleQuoted(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/[\x00-\x1f\x7f\u2028\u2029]/g, '');
}

/**
 * Generate ready-to-paste Google Apps Script (Code.gs) pre-configured with the user's
 * personal random secret token and target Drive folder name.
 */
export function buildAppsScriptCode({ secret = '', folderName = '隨身口譯官' } = {}) {
  const safeSecret = escapeJsSingleQuoted(secret || generateDriveSecret());
  const safeFolder = escapeJsSingleQuoted(sanitizeFolderName(folderName));

  return `/**
 * 隨身口譯官 — 個人 Google Drive / Google Docs 自動建立橋接腳本（安全強化版）
 * 部署方式：
 *   1. 前往 https://script.new 貼上本程式碼並儲存
 *   2. 點右上角「部署」→「新增部署作業」→ 類型選「網頁應用程式」
 *   3. 執行身分選「我」、誰可以存取選「所有人」→ 按「部署」並授權
 *   4. 複製「網頁應用程式網址」(https://script.google.com/macros/s/.../exec) 貼回隨身口譯官設定頁
 */
const SECRET_TOKEN = '${safeSecret}';
const DEFAULT_FOLDER_NAME = '${safeFolder}';
const MAX_BODY_CHARS = 1500000;
const MAX_PARAGRAPHS = 400;
const MAX_PARA_CHARS = 8000;

function safeEqual(a, b) {
  const s1 = String(a || '');
  const s2 = String(b || '');
  if (s2.length < 16) return false;
  const maxLen = Math.max(s1.length, s2.length);
  let diff = s1.length ^ s2.length;
  for (let i = 0; i < maxLen; i++) {
    const c1 = i < s1.length ? s1.charCodeAt(i) : 0;
    const c2 = i < s2.length ? s2.charCodeAt(i) : 0;
    diff |= c1 ^ c2;
  }
  return diff === 0;
}

function cleanSingleLine(str, maxLen, fallback) {
  const cleaned = String(str || '')
    .replace(/[\\x00-\\x1f\\x7f]/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
  return cleaned || fallback;
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateFolder(name) {
  const folderName = cleanSingleLine(String(name || '').replace(/[/\\\\<>:"|?*]/g, ' '), 60, DEFAULT_FOLDER_NAME);
  const iter = DriveApp.getFoldersByName(folderName);
  if (iter.hasNext()) return iter.next();
  return DriveApp.createFolder(folderName);
}

function doGet() {
  return jsonOut({ ok: false, error: 'Method not allowed' });
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents ? String(e.postData.contents) : '{}';
    if (raw.length > MAX_BODY_CHARS) {
      return jsonOut({ ok: false, error: '傳入內容超過上限。' });
    }
    const data = JSON.parse(raw);

    if (!data || typeof data !== 'object' || !safeEqual(data.secret, SECRET_TOKEN)) {
      return jsonOut({ ok: false, error: '密鑰驗證失敗，請確認設定頁與 Apps Script 的密鑰一致。' });
    }

    const folderName = cleanSingleLine(String(data.folderName || '').replace(/[/\\\\<>:"|?*]/g, ' '), 60, DEFAULT_FOLDER_NAME);

    if (data.action === 'ping') {
      const folder = getOrCreateFolder(folderName);
      return jsonOut({ ok: true, folderName: folder.getName(), version: '1.1' });
    }

    if (data.action !== 'createDoc') {
      return jsonOut({ ok: false, error: '不支援的操作類型' });
    }

    const docTitle = cleanSingleLine(data.title, 140, '隨身口譯官翻譯紀錄');
    const createdAt = cleanSingleLine(data.createdAt, 64, '');
    const modeLabel = cleanSingleLine(data.modeLabel, 64, '聆聽翻譯（中英對照）');
    const layout = data.layout === 'appendix' ? 'appendix' : 'bilingual';
    const summaryBullets = Array.isArray(data.summaryBullets)
      ? data.summaryBullets.map(function (s) { return cleanSingleLine(s, 260, ''); }).filter(Boolean).slice(0, 5)
      : [];
    const paragraphs = Array.isArray(data.paragraphs)
      ? data.paragraphs
          .filter(function (p) { return p && (p.zh || p.orig); })
          .slice(0, MAX_PARAGRAPHS)
          .map(function (p) {
            return {
              zh: String(p.zh || '').trim().slice(0, MAX_PARA_CHARS),
              orig: String(p.orig || '').trim().slice(0, MAX_PARA_CHARS),
            };
          })
      : [];

    if (!paragraphs.length) {
      return jsonOut({ ok: false, error: '沒有可建立文件的翻譯內容。' });
    }

    const doc = DocumentApp.create(docTitle);
    const body = doc.getBody();
    body.setMarginTop(52);
    body.setMarginBottom(52);
    body.setMarginLeft(56);
    body.setMarginRight(56);

    // Title
    const h1 = body.appendParagraph(docTitle);
    h1.setHeading(DocumentApp.ParagraphHeading.HEADING1);
    h1.setSpacingAfter(4);
    h1.editAsText().setFontFamily('Noto Sans TC').setForegroundColor('#111315');

    // Subtitle metadata
    const metaParts = [];
    if (createdAt) metaParts.push('日期時間：' + createdAt);
    if (modeLabel) metaParts.push(modeLabel);
    metaParts.push('共 ' + paragraphs.length + ' 段');
    const metaP = body.appendParagraph(metaParts.join('  ·  '));
    metaP.setSpacingAfter(14);
    metaP.editAsText().setFontFamily('Noto Sans TC').setFontSize(9.5).setForegroundColor('#6B7280');

    // Optional AI Summary Callout Box
    if (summaryBullets.length > 0) {
      const summaryTable = body.appendTable([['']]);
      summaryTable.setBorderColor('#B8DBD8');
      summaryTable.setBorderWidth(1);
      const cell = summaryTable.getCell(0, 0);
      cell.setBackgroundColor('#F1F8F7');
      cell.setPaddingTop(10);
      cell.setPaddingBottom(10);
      cell.setPaddingLeft(14);
      cell.setPaddingRight(14);

      const boxHead = cell.getChild(0).asParagraph();
      boxHead.setText('✨ 重點摘要');
      boxHead.setSpacingAfter(6);
      boxHead.editAsText().setFontFamily('Noto Sans TC').setFontSize(11).setBold(true).setForegroundColor('#0A7D79');

      for (let i = 0; i < summaryBullets.length; i++) {
        const bp = cell.appendParagraph('•  ' + summaryBullets[i]);
        bp.setSpacingAfter(i === summaryBullets.length - 1 ? 0 : 4);
        bp.setLineSpacing(1.38);
        bp.editAsText().setFontFamily('Noto Sans TC').setFontSize(10.5).setBold(false).setForegroundColor('#1F2937');
      }
      const spacer = body.appendParagraph('');
      spacer.setSpacingAfter(6);
    }

    body.appendHorizontalRule();

    if (layout === 'appendix') {
      // Section 1: Full Traditional Chinese
      const zhHead = body.appendParagraph('繁體中文譯文');
      zhHead.setHeading(DocumentApp.ParagraphHeading.HEADING2);
      zhHead.setSpacingBefore(10);
      zhHead.setSpacingAfter(8);
      zhHead.editAsText().setFontFamily('Noto Sans TC').setForegroundColor('#0A7D79');

      for (let i = 0; i < paragraphs.length; i++) {
        const zh = String(paragraphs[i].zh || '').trim();
        if (!zh) continue;
        const p = body.appendParagraph(zh);
        p.setLineSpacing(1.52);
        p.setSpacingAfter(10);
        p.editAsText().setFontFamily('Noto Sans TC').setFontSize(11.5).setForegroundColor('#1A1D21');
      }

      // Section 2: Original Transcript Appendix
      const hasOrig = paragraphs.some(function (x) { return String(x.orig || '').trim(); });
      if (hasOrig) {
        body.appendHorizontalRule();
        const enHead = body.appendParagraph('Original Transcript（原文紀錄）');
        enHead.setHeading(DocumentApp.ParagraphHeading.HEADING2);
        enHead.setSpacingBefore(10);
        enHead.setSpacingAfter(8);
        enHead.editAsText().setFontFamily('Arial').setForegroundColor('#4B5563');

        for (let i = 0; i < paragraphs.length; i++) {
          const orig = String(paragraphs[i].orig || '').trim();
          if (!orig) continue;
          const p = body.appendParagraph(orig);
          p.setLineSpacing(1.42);
          p.setSpacingAfter(10);
          p.editAsText().setFontFamily('Arial').setFontSize(10.5).setForegroundColor('#4B5563');
        }
      }
    } else {
      // Default: Bilingual paragraph-by-paragraph (Chinese on top, Original below)
      for (let i = 0; i < paragraphs.length; i++) {
        const zh = String(paragraphs[i].zh || '').trim();
        const orig = String(paragraphs[i].orig || '').trim();
        if (zh) {
          const pZh = body.appendParagraph(zh);
          pZh.setLineSpacing(1.5);
          pZh.setSpacingBefore(i === 0 ? 10 : 4);
          pZh.setSpacingAfter(orig ? 3 : 12);
          pZh.editAsText().setFontFamily('Noto Sans TC').setFontSize(11.5).setForegroundColor('#1A1D21');
        }
        if (orig) {
          const pEn = body.appendParagraph(orig);
          pEn.setLineSpacing(1.38);
          pEn.setIndentStart(12);
          pEn.setSpacingAfter(13);
          pEn.editAsText().setFontFamily('Arial').setFontSize(10).setForegroundColor('#5A6470');
        }
      }
    }

    doc.saveAndClose();

    const folder = getOrCreateFolder(folderName);
    const file = DriveApp.getFileById(doc.getId());
    file.moveTo(folder);

    const docId = doc.getId();
    return jsonOut({
      ok: true,
      docId: docId,
      docUrl: 'https://docs.google.com/document/d/' + docId + '/edit',
      title: docTitle,
      folderName: folder.getName(),
    });
  } catch (err) {
    return jsonOut({ ok: false, error: '建立文件失敗：' + String(err && err.message ? err.message : err) });
  }
}
`;
}

async function postToDriveBridge(webhookUrl, payload, timeoutMs = 28000) {
  const url = String(webhookUrl || '').trim();
  if (!isValidAppsScriptUrl(url)) {
    throw new Error('Google Apps Script 網址格式不正確，須為 https://script.google.com/macros/s/.../exec');
  }
  const secretStr = String(payload?.secret || '').trim();
  if (secretStr.length < MIN_DRIVE_SECRET_LEN) {
    throw new Error(`私人密鑰長度不足（至少需 ${MIN_DRIVE_SECRET_LEN} 碼），請先於設定頁產生並部署 Apps Script。`);
  }

  const redactBridgeText = (s) =>
    String(s || '')
      .replaceAll(secretStr, '[REDACTED]')
      .replace(/AKfycb[0-9A-Za-z_-]{16,}/g, '[REDACTED_SCRIPT_ID]')
      .slice(0, 260);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Use `text/plain;charset=utf-8` + `credentials: 'omit'` for a clean CORS simple request
    // (Apps Script does not handle OPTIONS preflight and multi-account Google cookies can break redirects)
    const resp = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await resp.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_) {
      if (!resp.ok) {
        throw new Error(`雲端橋接回應錯誤（HTTP ${resp.status}），請確認部署設定為「執行身分：我、誰可以存取：所有人」。`);
      }
      throw new Error('Google Apps Script 回傳非預期格式（請確認已部署為「網頁應用程式」且存取權限設為「所有人」）。');
    }

    if (!data || data.ok !== true) {
      throw new Error(redactBridgeText(data?.error || '雲端建立 Google Doc 失敗，請稍後再試。'));
    }

    return data;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('連線逾時，請確認網路狀態後重試。');
    }
    const msg = redactBridgeText(err?.message || err || '');
    if (/failed to fetch|load failed|networkerror/i.test(msg)) {
      throw new Error(
        '連線被阻擋（Failed to fetch）：請在 Apps Script「部署 → 管理部署作業」確認「誰可以存取」已改為「所有人（Anyone）」，且存檔後有部署「新版本」。'
      );
    }
    throw new Error(msg || '雲端上傳發生錯誤，請稍後再試。');
  } finally {
    clearTimeout(timer);
  }
}

export async function testDriveBridge({ webhookUrl, secret, folderName = '隨身口譯官' }) {
  return postToDriveBridge(
    webhookUrl,
    {
      action: 'ping',
      secret: String(secret || '').trim(),
      folderName: sanitizeFolderName(folderName),
    },
    18000
  );
}

export async function uploadDocToDrive({
  webhookUrl,
  secret,
  folderName = '隨身口譯官',
  title,
  createdAt,
  modeLabel = '聆聽翻譯（中英對照）',
  layout = 'bilingual',
  summaryBullets = [],
  paragraphs = [],
}) {
  const data = await postToDriveBridge(
    webhookUrl,
    {
      action: 'createDoc',
      secret: String(secret || '').trim(),
      folderName: sanitizeFolderName(folderName),
      title: String(title || '隨身口譯官翻譯紀錄').trim().slice(0, 140),
      createdAt: String(createdAt || '').trim(),
      modeLabel: String(modeLabel || '').trim(),
      layout: layout === 'appendix' ? 'appendix' : 'bilingual',
      summaryBullets: Array.isArray(summaryBullets) ? summaryBullets.slice(0, 5) : [],
      paragraphs: Array.isArray(paragraphs)
        ? paragraphs.map((p) => ({
            zh: String(p?.zh || '').trim(),
            orig: String(p?.orig || '').trim(),
          }))
        : [],
    },
    32000
  );

  if (data.docUrl && !isValidGoogleDocUrl(data.docUrl)) {
    throw new Error('回傳的文件連結格式異常，已攔截開啟以保護安全。');
  }
  const normalizedUrl = normalizeGoogleDocUrl(data.docUrl, data.docId);
  if (normalizedUrl) {
    data.docUrl = normalizedUrl;
  }
  return data;
}

export function buildBilingualPlainText({
  title = '隨身口譯官翻譯紀錄',
  createdAt = '',
  summaryBullets = [],
  paragraphs = [],
  layout = 'bilingual',
} = {}) {
  const lines = [title];
  if (createdAt) lines.push(`時間：${createdAt}`);
  if (Array.isArray(summaryBullets) && summaryBullets.length) {
    lines.push('', '【重點摘要】');
    for (const b of summaryBullets) {
      lines.push(`• ${b}`);
    }
  }
  lines.push('', '────────────────────', '');

  if (layout === 'appendix') {
    lines.push('【繁體中文譯文】', '');
    for (const p of paragraphs) {
      if (p.zh) lines.push(p.zh, '');
    }
    const origs = paragraphs.map((p) => String(p.orig || '').trim()).filter(Boolean);
    if (origs.length) {
      lines.push('────────────────────', '', '【Original Transcript】', '');
      for (const o of origs) {
        lines.push(o, '');
      }
    }
  } else {
    for (const p of paragraphs) {
      if (p.zh) lines.push(p.zh);
      if (p.orig) lines.push(p.orig);
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}
