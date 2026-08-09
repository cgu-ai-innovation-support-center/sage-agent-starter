# 15 分鐘開始使用

這份 Starter 的目標，是讓你把教學需求交給 **Codex / Claude Code**，由
coding assistant 在既有安全邊界內修改範例，而不必先理解整份 API 規格。

## 1. 先寫需求 brief

把以下內容寫成簡短條列：

1. 使用者與學習目標。
2. Agent 會接收什麼、回傳什麼。
3. 是否使用外部資料或 tools；哪些動作必須先取得同意。
4. 是否處理敏感資料或檔案，以及保留多久。
5. 預期模型、流量、預算與失敗時行為。
6. 誰負責部署、監控、備份、credential rotation 與 rollback。

可以將這段話交給 coding assistant：

```text
請先閱讀 README.md、contracts/stateful-v1.md、compatibility.json 與
SECURITY.md。根據下面的教學需求，在最適合的 Node 或 FastAPI template
中實作。不得新增 full-history、direct model key、private-network 或
credential fallback。修改後執行 npm test，並列出仍需人工確認的部署、
資料與工具風險。

需求：<貼上需求 brief>
```

## 2. 檢查環境

需要 Node.js 22.13 以上與 Python 3.12；執行：

```bash
git clone --branch v0.1.0 --depth 1 https://github.com/cgu-ai-innovation-support-center/sage-agent-starter.git
cd sage-agent-starter
npm run doctor
npm test
cp .env.example .env
```

將 `.env` 內的 placeholder 換成自己的本機測試值。不要把 `.env` commit
或貼到對話中。Invocation credential 與 model/provider key 是不同秘密，
不可重用。`SAGE_PLATFORM_ORIGIN` 只填 SAGE 的公開 HTTPS origin（例如
`https://sage.example.edu`），不可帶路徑；Starter 只會把短效 lease 傳回
這個 origin。

## 3. 選擇 template

- Node：想維持最少 web framework 時使用。
- FastAPI：既有服務以 Python 為主時使用。

兩者必須通過相同 contract tests。框架選擇不會改變 SAGE protocol。

## 4. 本機啟動

Node：

```bash
set -a; . ./.env; set +a
node node/server.mjs
```

FastAPI：

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r fastapi/requirements.txt
set -a; . ./.env; set +a
uvicorn --app-dir fastapi app:app --host 127.0.0.1 --port 8080
```

確認 `/healthz` 與 `/readyz` 回應成功。正式環境的
`AGENT_STATE_DB` 必須位於持久化磁碟；多主機部署需換成共享資料庫 adapter。

也可以用 hardened Compose profile 啟動單一 template；Node 對外使用
`127.0.0.1:8080`，FastAPI 使用 `127.0.0.1:8081`：

```bash
docker compose --profile node up --build
# 或
docker compose --profile fastapi up --build
```

## 5. 上線前檢查

1. 建置其中一個 Dockerfile，secret 不可進 image layer。
2. 在 HTTPS reverse proxy 後測試 health/readiness、timeout 與取消。
3. 將 state volume 納入 backup/restore，演練 rollback。
4. 在 SAGE 建立 Agent，填入 HTTPS Base URL 與獨立 invocation credential。
5. 選擇 Responses API 與 platform model access。
6. 測試第一回合、第二回合、restart 後續談、取消與 approval/result。

若收到 `previous_response_not_found`，建立新對話；不要重新傳送完整歷史。
