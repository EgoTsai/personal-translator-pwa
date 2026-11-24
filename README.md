# 隨身口譯官（Personal Voice Translator PWA）

使用 **Google AI Pro 每月贈送的 \$10 Gemini API 額度** 打造的個人專屬手機翻譯官，支援 **英語 ↔ 中文**、**日語 ↔ 中文**、**瑞典語 ↔ 中文**。

---

## 核心功能

1. **開關 1 — 即時聆聽翻譯**
   - 打開後持續自動收音（內建靜音偵測與 0.45 秒前導緩衝，不截字、靜音不浪費額度）。
   - 聽到 **非中文**（英／日／瑞典或其他外語）→ 自動翻譯成自然繁體中文，下方附原文對照。
   - 聽到 **中文** → 直接印出繁體中文原話。
   - 自動區分並標註說話者（`A:`、`B:`、`C:`），點擊代號即可改名（例如改成 `Erik`、`田中先生`）。
2. **開關 2 — AI 真人唸出**
   - 關閉時為靜音文字模式（最省額度）；點擊任一則訊息旁的 🔊 仍可單獨播放 AI 真人朗讀（同一句重播會使用本機快取，不重複扣費）。
   - 開啟時自動使用 **Gemini 3.8 Flash-Lite TTS** 真人語音唸出譯文。
3. **換我說（中文 → 英 / 日 / 瑞典）**
   - 選擇上方目標語言（🇬🇧 英語 / 🇯🇵 日語 / 🇸🇪 瑞典語），點擊底部麥克風說中文（或直接打字），即時翻譯成自然外語（日文附假名與羅馬拼音），並可讓 AI 直接唸給對方聽，或點放大按鈕「上下翻轉給對方看」。
4. **純前端本機存 Key**
   - API Key 僅存在你手機瀏覽器的 `localStorage`，請求直接發往 Google Gemini API，完全免架後端。

---

## 第一步：領取 Google AI Pro 每月 \$10 免費 API 額度

1. 用你訂閱 Google AI Pro 的**主帳號**登入 [Google AI Studio](https://aistudio.google.com/)。
2. 點擊左下角選單的 **Claim free API credits / Redeem credits**。
3. 依畫面引導連結 Google Cloud Billing 帳戶，並勾選 **Auto-apply future credits**（新建立 Prepay 帳單需先預存 \$5 啟用，使用時會優先扣除免費贈送額度；建議順手設定每月花費上限）。
4. 到左側 **API keys** 頁面複製你的付費專案 API Key。
   > 每月 \$10 額度自發放日起有效期 **12 個月**，跨月自動疊加！

---

## 第二步：免費部署到 HTTPS（手機才能使用麥克風與安裝成 App）

本專案是純靜態網頁（免編譯、免後端），任選下列一種 1 分鐘完成部署：

### 方法 A：Cloudflare Pages（推薦・超快免費）
1. 登入 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Pages** → **Upload assets**。
2. 直接把整個 `personal-translator` 資料夾拖曳上傳並部署，立刻取得 `https://你的名稱.pages.dev` 網址。

### 方法 B：Vercel / Netlify Drop
- 開啟 [Netlify Drop](https://app.netlify.com/drop) 直接把 `personal-translator` 資料夾拖進去，30 秒取得 HTTPS 網址。
- 或使用 Vercel CLI：`npx vercel --prod`

### 方法 C：GitHub Pages
- 把這個資料夾推送到自己的 GitHub Repo → Settings → Pages → 選擇 `main` 分支根目錄即可。

---

## 第三步：在手機「加入主畫面」當原生 App 用

- **iPhone (Safari)**：用 Safari 打開部署好的網址 → 點下方「分享」按鈕 → **加入主畫面**。
- **Android (Chrome)**：用 Chrome 打開網址 → 點右上角選單 → **安裝應用程式 / 加到主畫面**。
- 打開 App 後點右上角 ⚙️「設定」貼上 Gemini API Key → 點「測試連線」確認通過，就能開始使用！
