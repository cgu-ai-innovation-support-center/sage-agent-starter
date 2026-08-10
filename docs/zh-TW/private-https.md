# 不使用公信憑證的 Private HTTPS

教師不需要使用 SAGE 的網域，也不必申請公信憑證。Starter 可以啟動已鎖定
digest 的 Caddy sidecar，為這個 Agent 建立專屬 private CA、自動更新 server
leaf certificate，並只輸出 SAGE 所需的公開信任資料。

這個功能的前提，是 SAGE 原本就能連到該 endpoint。Private HTTPS 負責確認
對方身分並加密既有路徑；它不會建立 tunnel、穿透 NAT，也不會授權任意
私有網路位址。校內私網仍須由平台管理者建立精確 connectivity profile。

## 一次性設定

先完成 `.env`，選擇 Node 或 FastAPI，並填入之後會登錄到 SAGE 的 exact
公開 Base URL。可以直接使用穩定 public IP，不一定要有 domain。

```bash
# Node 範例；8443 可避免 container 需要 privileged port。
npm run https:setup -- \
  --base-url https://agent.example.edu:8443 \
  --profile node \
  --start

# FastAPI 則改用 --profile fastapi。
npm run https:doctor
```

`--start` 會建置選定的 app、啟動 Caddy，將 CA 持久化於已忽略的
`data/https/`，並輸出 `sage-agent-trust.json`。若不加 `--start`，setup 只會
列出精確 Compose 指令；啟動後再執行 `npm run https:export`。

Data path 必須是新目錄，或 Starter 先前建立、帶有 private-HTTPS marker，且
頂層只有 `caddy-data`/`caddy-config` 的專用目錄。Setup 會拒絕 `.`、repo、
home/system directory、symlink 與既有的一般用途目錄，不會挪用或 chmod 它們。

在 SAGE Agent 編輯頁只上傳 `sage-agent-trust.json`。內容固定只有：

```json
{
  "schema": "sage-agent-trust-v1",
  "base_url": "https://agent.example.edu:8443",
  "ca_pem": "-----BEGIN CERTIFICATE-----\n（只有公開 CA）\n-----END CERTIFICATE-----\n"
}
```

不要上傳或複製 `data/https`、`root.key`、其他 `.key`、`.p12` 或 `.pfx`。
公開 trust JSON 不是 private key。

## Doctor 會確認什麼

`https:doctor` 會 fail closed，除非：

- trust JSON 具有 exact schema、canonical Base URL，且只有一張不超過
  16 KiB 的 self-signed CA certificate；
- Caddy data tree 沒有 symlink，private key owner 只能是 root 或 setup user，
  且 group/world 都不可讀；
- 使用正常 certificate verification 完成 Base URL TLS handshake，包括
  hostname 或 IP SAN 驗證；
- proxy 後的 `/readyz` 回傳 HTTP 204。

它無法證明 SAGE 的網路一定能抵達教師主機。啟用 Agent 前，仍要在 SAGE
按下「測試安全連線」。

## Rotation、備份與復原

Caddy internal issuer 會自動更新 leaf certificate。SAGE 信任的是這個
Agent 專屬 CA，因此一般 leaf rotation 不需要教師重新設定。必須讓
`data/https/caddy-data` 在 restart 後仍存在，並納入受保護備份；裡面包含 CA
private key，絕對不可放入 Git、對話或 SAGE。

這一版 Starter 與 SAGE 一次只接受一張 CA，不提供新舊 trust overlap。若 CA
遺失或需要更換，請安排短暫維護窗口：先記錄所有 Group availability、全部改為
Inactive，再將全域 Agent 改為 Inactive；更換 Agent 端 CA、輸出新的公開 trust，
並在 Agent 維持 Inactive 時於 SAGE 完成替換。必須先讓本機 doctor 與 SAGE
安全連線檢查都通過，再只恢復 exact pilot；smoke test 通過後，才依紀錄逐一恢復
其他 Group 狀態。舊 private material 只在有上限的 rollback window 內離線保留，
之後就應退役。主機復原時若遺失 CA，應視為一次 trust rotation，絕不能關閉
certificate verification，或直接信任目前 endpoint 顯示的 leaf certificate。

Sidecar 會使用產生的非 root numeric UID/GID（絕不使用 UID 0）、只監聽 container 內非
privileged 的 8443，並 drop 全部 Linux capabilities。官方 image 的 binary
本身帶有 file capability，因此固定、tracked 的 runner 會先將 digest-pinned
binary 複製到 bounded executable tmpfs；複本不帶 file capability。其餘 root
filesystem 維持 read-only，只能寫入 bind-mounted data/config 與該 tmpfs。
Caddy config 不會綁定 privileged container port；Docker daemon 再將選定的
host port 映射到 container 8443。

每個 Agent 都要使用不同的 generated data directory；不要在不同 Agent
registration 之間共用同一把 CA private key。
