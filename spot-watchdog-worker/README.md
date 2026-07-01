# 方案 B：Cloudflare Worker + Cron Trigger（无服务器）

无需常在线机器：Cloudflare 的 Cron Trigger 定时执行 Worker，对 GCP Spot 实例做 HTTP 探测，
被抢占关机后调用 GCP Compute REST API 自动开机。

> Worker 环境只能 HTTP `fetch()`（无法 ICMP ping），正好用于 HTTP 探测。
> 鉴权：在 JS 里用 Web Crypto 对 JWT 做 RS256 签名，换取 OAuth token 后调 API。

## 文件

| 文件 | 说明 |
|---|---|
| `wrangler.toml` | Worker 配置 + Cron Trigger + 目标清单（`TARGETS`） |
| `src/index.js` | 探测、查状态、开机、JWT 签名换 token 全部逻辑 |
| `package.json` | 依赖 wrangler |

## 前置

1. 先在项目根目录运行 `setup-gcp.sh` 生成 `sa-key.json`，记下服务账号邮箱。
2. 安装依赖：
   ```bash
   cd spot-watchdog-worker
   npm install
   npx wrangler login    # 登录 Cloudflare
   ```

## 配置

编辑 `wrangler.toml` 里的 `TARGETS`（JSON 数组），每台实例一项：
```json
{"project":"my-project","zone":"us-central1-a","instance":"web-1","healthUrl":"https://web1.example.com/"}
```
`healthUrl` 只要能连上并返回**任意** HTTP 响应（200/404/500 都算在线）即视为存活；
只有连接失败/超时/TLS 失败才判离线。直接用 `https://.../` 即可。

设置密钥（从 `sa-key.json` 取值）：
```bash
npx wrangler secret put GCP_SA_EMAIL
# 输入： spot-watchdog@my-project.iam.gserviceaccount.com

npx wrangler secret put GCP_SA_PRIVATE_KEY
# 粘贴 sa-key.json 里的 private_key 值。
# 含字面 \n 或真实换行都可，代码里已兼容处理。
```

### Telegram 通知（可选）

设置这两个 secret 后，实例被自动开机/开机失败时会推送到 Telegram：
```bash
npx wrangler secret put TG_BOT_TOKEN     # @BotFather /newbot 拿到的 token
npx wrangler secret put TG_CHAT_ID       # 你的 chat id
```
获取方式：Telegram 找 **@BotFather** → `/newbot` 得 token；给 bot 发条消息后访问
`https://api.telegram.org/bot<token>/getUpdates` 读 `chat.id`（或用 **@userinfobot**）。
不设置这两个 secret 则不发通知。

> 从 sa-key.json 提取 private_key（PowerShell）：
> ```powershell
> (Get-Content sa-key.json | ConvertFrom-Json).private_key
> ```

## 部署

```bash
npx wrangler deploy
```

## 手动测试

```bash
# 本地起 Worker：
npx wrangler dev
# 另开终端触发一轮并看日志输出：
curl http://localhost:8787/run

# 或触发 scheduled 事件：
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

造一个被抢占场景验证：
```bash
gcloud compute instances stop TEST_INSTANCE --zone=ZONE
curl http://localhost:8787/run
# 期望： DOWN ... / START ... status=TERMINATED -> 开机 / START ... 已下发 start 请求
```

## 日志

```bash
npx wrangler tail          # 线上实时日志
```
也可在 Cloudflare Dashboard → Workers → 该 Worker → Logs / Triggers 手动触发 cron 观察。

## env 一览

| 名称 | 类型 | 说明 |
|---|---|---|
| `TARGETS` | var | 目标实例 JSON 数组 |
| `PROBE_TIMEOUT_MS` | var | HTTP 探测超时毫秒，默认 10000 |
| `GCP_SA_EMAIL` | secret | 服务账号邮箱 |
| `GCP_SA_PRIVATE_KEY` | secret | 服务账号私钥 PEM |
| `TG_BOT_TOKEN` | secret | Telegram bot token（可选，设置后启用通知） |
| `TG_CHAT_ID` | secret | Telegram 接收通知的 chat id（可选） |
