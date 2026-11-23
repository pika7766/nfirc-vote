# NFIRC 社課電影票選

網站由 Render Node.js Web Service 提供前端與 API，後端使用 Supabase PostgreSQL Connection string 連線。Connection string、資料庫密碼和管理員密碼都只放在 Render 環境變數，不提交到 Git，也不傳給瀏覽器。

## 1. 設定 Supabase 資料庫

1. 在 Supabase 專案的 **SQL Editor → New query** 執行 [`supabase/schema.sql`](./supabase/schema.sql) 全文。資料庫已建立的話也請重新執行，以建立投票統計索引；此 schema 可重複執行。
2. 在 Supabase 的 **Database → Connect** 複製 PostgreSQL connection string。Render 建議使用可長時間連線的 **Session pooler**。若字串仍含 `[YOUR-PASSWORD]`，以資料庫密碼替換；密碼若含特殊字元，需依 URI 格式編碼。
3. 在 Supabase **Database Settings → SSL Configuration** 下載 CA certificate。此憑證用來驗證資料庫伺服器身分；不要停用 TLS 憑證驗證。
4. 不要將 connection string 傳給瀏覽器、貼到聊天室或寫入程式檔案。

## 2. 部署到 Render

1. 在 Render 選 **New → Web Service**，連結此 Git repository。
2. 設定：
   - Runtime：Node
   - Build Command：`npm install`
   - Start Command：`npm start`
   - Health Check Path：`/api/health`
3. 在 Render 的 **Environment** 設定以下變數：
   - `DATABASE_URL`：完整 Supabase PostgreSQL connection string
   - `DATABASE_CA_CERT_BASE64`：下載的 Supabase CA certificate 轉成 Base64 後的內容
   - `ADMIN_PASSWORD`：管理員登入密碼（例如你先前設定的密碼）
   - `SESSION_SECRET`：至少 32 個字元的隨機密鑰
   - `VOTE_IP_HASH_SECRET`：另一組至少 32 個字元的隨機密鑰
4. 儲存並部署。Render 的 HTTPS 網址就是網站網址；管理頁為該網址加上 `/admin`。

在 Windows PowerShell 使用以下指令，將下載憑證檔轉成 Base64；把輸出貼入 Render 的 `DATABASE_CA_CERT_BASE64`，不要提交憑證檔或輸出到 Git：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\prod-ca-2021.crt"))
```

將範例路徑換成你下載的憑證檔位置。產生隨機密鑰則可在本機執行：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

請分別產生 `SESSION_SECRET` 和 `VOTE_IP_HASH_SECRET`，只貼到 Render 的 Environment，不要放進檔案或 Git。

## 管理與資料安全

- 管理員帳號名稱固定為 `nfirc`；密碼由後端的 `ADMIN_PASSWORD` 驗證，並以 HttpOnly、SameSite cookie 管理登入狀態。
- `DATABASE_URL` 僅由 Node 後端讀取。SQL schema 會撤銷 Supabase `anon`、`authenticated` 和 `service_role` 對投票資料表的 API 權限，避免繞過後端直接讀寫。
- 投票服務端使用 Render `X-Forwarded-For` 中完整的用戶端 IP（不截斷網段）做 HMAC 識別；不會退回使用 Render 機器的 socket IP。若平台未提供有效的用戶端 IP，投票會明確回報錯誤。使用者若共用同一個對外公開 IP（例如同一個 NAT 出口），仍會被視為同一個 IP。
- 使用者端在頁面可見時每 2 秒以單一請求向後端讀取電影清單與票數；背景分頁會暫停輪詢。這是 Connection string 後端模式的輪詢更新，不使用瀏覽器直接連 PostgreSQL 或 Supabase Realtime。
- 使用 Supabase Dashboard 的 SQL Editor 執行資料庫 schema；Render 不需要 Supabase anon key 或 service-role key。

## 功能

- 使用者可提交電影、查看清單與即時票數。
- 管理員可編輯電影名稱、片長和 1x／1.25x 倍速、刪除電影、切換投稿、開始/結束/重新投票，以及清空資料。
- 管理員在結果頁選擇重新投票時，會清除上一輪票數並回到開始投票設定；投稿預設關閉，可自行選擇是否重新開放。
- 每人可投 1–5 票，且可將多票分配給同一部電影。

## 網頁文字與 Logo

- 網頁固定文字和 API 提示集中在根目錄的 [`content.json`](./content.json)，修改內容後重新部署即可套用。
- 文字中的 `{count}`、`{title}` 等欄位是動態資料位置，請保留大括號與欄位名稱。
- 頁首圖示使用根目錄的 [`nfirc_logo.png`](./nfirc_logo.png)；替換圖檔時請保留此檔名。
