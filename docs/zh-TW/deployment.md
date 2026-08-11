# 部署與 rollback

Starter 提供本機 Compose profiles 與 optional Private HTTPS kit，但不會代替
教師維運主機；runtime、reachability、TLS private material、state、secrets、
監控與維護責任仍屬於 Agent operator。

## Container

```bash
docker build --pull -f node/Dockerfile -t my-sage-agent:v0.1.4 .
# 或
docker build --pull -f fastapi/Dockerfile -t my-sage-agent:v0.1.4 .
```

以非 root user 執行、drop all capabilities、使用 read-only filesystem，並
只將 `/data` 掛載為持久化 volume。Secret 只能由 runtime secret store 注入。

## HTTPS 與網路

在 Agent 前方放置受維護的 HTTPS reverse proxy。SAGE 會拒絕 redirect、
loopback、private、link-local、metadata 或解析結果不安全的 public endpoint；
不要要求停用這些防護。校內私有連線必須由平台管理者另行建立精確的
deployment-owned connectivity profile。

Starter 維護的選項是[每個 Agent 專屬的 Private HTTPS kit](private-https.md)，
不需要使用 SAGE domain 或公信憑證。公開 CA trust 與 private-network routing
仍是兩個分開的控制面。

## State、備份與 scale

SQLite adapter 適用於本機與單一主機共享持久化 volume。請使用 SQLite
online backup API，或先正常停止 runtime 再複製已關閉的 database；WAL 仍在
寫入時不可只複製 main file。先還原到隔離路徑，再測一般 continuation 與
`SAGE_APPROVAL_DEMO` 的 restart／approve／replay。多主機部署必須先實作
共享 database adapter；不可 fallback 到 memory。

## Rollback

1. 保留前一個 image digest 與相容的 state backup。
2. 停止接收新流量，再停止舊 container。
3. 若 schema 未改，啟動前一個 image；若 schema 改過，依該 release 的
   migration/restore runbook 處理，不能猜測 downgrade。
4. 檢查 `/readyz`，建立新的 SAGE 測試對話並完成兩回合。
5. 舊對話若無法續接，回傳 exact `previous_response_not_found`，不得 replay。

## Credential rotation

先在 Agent secret store 加入新 invocation credential，再於 SAGE Agent
設定中替換，完成 smoke test 後撤銷舊值。不要把 invocation credential 與
model/provider key 設成同一值。
