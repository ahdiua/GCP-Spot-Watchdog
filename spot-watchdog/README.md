# 方案 A：Debian 13 watchdog（bash + gcloud + systemd timer）

在一台**常在线**的 Debian 13 机器上定时探测 GCP Spot 实例，被抢占关机后自动开机。

## 文件

| 文件 | 说明 |
|---|---|
| `watchdog.sh` | 主脚本：探测 + 按状态决定是否开机 |
| `targets.conf` | 目标实例清单（`project zone instance health_url`） |
| `spot-watchdog.service` | systemd oneshot unit |
| `spot-watchdog.timer` | systemd timer（每 5 分钟） |

## 前置

1. 先在项目根目录运行 `setup-gcp.sh` 生成 `sa-key.json`。
2. 本机安装 gcloud 与 curl：
   ```bash
   sudo apt-get update && sudo apt-get install -y curl
   # 按 Google 官方源安装 google-cloud-cli：
   # https://cloud.google.com/sdk/docs/install#deb
   ```

## 配置

编辑 `targets.conf`，每行填一台实例：
```
my-project   us-central1-a   web-1   https://web1.example.com/
```
`health_url` 只要能连上并返回**任意** HTTP 响应（200/404/500 都算在线）即视为存活；
只有连接失败/超时/TLS 失败才判为离线。直接用 `https://.../` 即可。

## 安装

```bash
sudo mkdir -p /opt/spot-watchdog
sudo cp watchdog.sh targets.conf sa-key.json /opt/spot-watchdog/
sudo chmod 600 /opt/spot-watchdog/sa-key.json
sudo chmod +x /opt/spot-watchdog/watchdog.sh
sudo cp spot-watchdog.service spot-watchdog.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now spot-watchdog.timer
```

调探测周期：改 `spot-watchdog.timer` 里的 `OnUnitActiveSec`，再 `daemon-reload` + `restart` timer。

## 手动测试

```bash
# 造一个 TERMINATED 状态：
gcloud compute instances stop TEST_INSTANCE --zone=ZONE

# 手动跑一次看门狗：
GCP_SA_KEY=/opt/spot-watchdog/sa-key.json \
WATCHDOG_CONF=/opt/spot-watchdog/targets.conf \
  /opt/spot-watchdog/watchdog.sh
# 期望输出： DOWN ... -> 开机 / START ... 已下发 start 请求
```

## 日志与运维

```bash
journalctl -u spot-watchdog.service -f      # 跟踪运行日志
systemctl list-timers spot-watchdog.timer   # 查看下次触发时间
systemctl start spot-watchdog.service       # 立即手动触发一次
```

## 可覆盖的环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `GCP_SA_KEY` | `<脚本目录>/sa-key.json` | 服务账号密钥路径 |
| `WATCHDOG_CONF` | `<脚本目录>/targets.conf` | 目标清单路径 |
| `PROBE_TIMEOUT` | `10` | HTTP 探测超时（秒） |
| `TG_BOT_TOKEN` | 空 | Telegram bot token（设置后启用通知） |
| `TG_CHAT_ID` | 空 | Telegram 接收通知的 chat id |

## Telegram 通知（可选）

设置 `TG_BOT_TOKEN` 与 `TG_CHAT_ID` 后，实例被自动开机（或开机失败）时会推送到 Telegram。
在 `spot-watchdog.service` 里取消注释那两行 `Environment=` 并填值即可。

获取 token / chat id：
1. 在 Telegram 找 **@BotFather** → `/newbot` → 拿到 bot token。
2. 给你的新 bot 发一句话，然后访问
   `https://api.telegram.org/bot<token>/getUpdates`，从返回里读 `chat.id`（或用 **@userinfobot** 直接获取你的 id）。

改完 service 后：
```bash
sudo systemctl daemon-reload
sudo systemctl start spot-watchdog.service   # 触发一次验证通知
```
