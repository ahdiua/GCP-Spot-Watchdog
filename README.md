<p align="center">
  <h1 align="center">GCP Spot Watchdog</h1>
  <p align="center">
    自动监控 GCP Spot（抢占式）实例，被关机后通过 API 重新启动，并推送 Telegram 通知。
    <br />
    <a href="./README_EN.md"><strong>English</strong></a>
    &nbsp;&middot;&nbsp;
    <a href="#快速开始">快速开始</a>
    &nbsp;&middot;&nbsp;
    <a href="#方案对比">方案对比</a>
    &nbsp;&middot;&nbsp;
    <a href="#telegram-通知">Telegram 通知</a>
  </p>
</p>

---

## 它能做什么

GCP 的 Spot 实例随时可能被抢占关机（状态变为 `TERMINATED`）。本项目提供一个**定时看门狗**，每 5 分钟自动：

1. **HTTPS 探测**每台实例 —— 只要能连上返回任何 HTTP 响应（200 / 404 / 500 都算）就视为在线
2. 探测失败时**查询 GCP 实例状态** —— 仅 `TERMINATED` / `STOPPED` 才触发开机
3. 调用 **`instances.start` API** 自动重启，并通过 **Telegram Bot** 推送通知

> **为什么不直接根据探测失败就开机？**
> 用 GCP API 状态作为闸门，能避免对正在启动（`STAGING`）的实例重复下发 start，也能区分"被抢占关机"和"服务自身挂了但 VM 还在"。

## 方案对比

提供两套**互不依赖**的方案，按需选一个部署：

| | 方案 A：Debian watchdog | 方案 B：Cloudflare Worker |
|:--|:--|:--|
| **目录** | [`spot-watchdog/`](./spot-watchdog/) | [`spot-watchdog-worker/`](./spot-watchdog-worker/) |
| **运行环境** | 一台常在线的 Linux 机器 | Cloudflare 无服务器 |
| **定时机制** | systemd timer | Cron Trigger |
| **探测方式** | `curl` | `fetch()` |
| **鉴权** | `gcloud` CLI 服务账号激活 | JS 内 Web Crypto 签 RS256 JWT 换 OAuth token |
| **依赖** | `bash` `curl` `gcloud` | Node.js + `wrangler` |
| **需要常在线机器** | 是 | **否** |
| **适用场景** | 已有一台稳定在线的 VPS / 家庭服务器 | 不想维护额外机器，追求零运维 |

## 前置条件

- 一个 GCP 项目，内有一台或多台 Spot 实例
- 每台被监控实例有**公网可达的 HTTPS 端点**（如 `https://your-ip/`）
- 已安装 [`gcloud` CLI](https://cloud.google.com/sdk/docs/install) 且登录了有 IAM 管理权限的账号

## 快速开始

### Step 0：克隆仓库

```bash
git clone https://github.com/YOUR_USERNAME/GCP_Start.git
cd GCP_Start
```

### Step 1：创建 GCP 服务账号（两套共用，只做一次）

编辑 [`setup-gcp.sh`](./setup-gcp.sh) 顶部的 `PROJECT_ID`，然后运行：

```bash
bash setup-gcp.sh
```

这会自动完成：
- 创建服务账号 `spot-watchdog@PROJECT_ID.iam.gserviceaccount.com`
- 创建最小权限自定义角色（仅 `compute.instances.get` / `.start` / `.list`）
- 绑定角色到服务账号
- 下载密钥文件 `sa-key.json`（已被 `.gitignore` 排除，请勿提交）

### Step 2：选一套方案部署

<details>
<summary><b>方案 A：Debian watchdog（bash + gcloud + systemd timer）</b></summary>

#### 安装依赖

```bash
# Debian / Ubuntu
sudo apt-get update && sudo apt-get install -y curl
# 按 Google 官方源安装 gcloud CLI：
# https://cloud.google.com/sdk/docs/install#deb
```

#### 配置目标实例

编辑 `spot-watchdog/targets.conf`，每行一台实例（空格分隔）：

```
# project            zone              instance      health_url
my-project           us-central1-a     web-1         https://web1.example.com/
my-project           asia-east1-b      worker-1      https://worker1.example.com/
```

#### 部署

```bash
sudo mkdir -p /opt/spot-watchdog
sudo cp spot-watchdog/watchdog.sh spot-watchdog/targets.conf sa-key.json /opt/spot-watchdog/
sudo chmod 600 /opt/spot-watchdog/sa-key.json
sudo chmod +x /opt/spot-watchdog/watchdog.sh

sudo cp spot-watchdog/spot-watchdog.service spot-watchdog/spot-watchdog.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now spot-watchdog.timer
```

#### 验证

```bash
# 手动停一台测试实例造出 TERMINATED 状态
gcloud compute instances stop TEST_INSTANCE --zone=ZONE

# 手动跑一次看门狗
sudo systemctl start spot-watchdog.service

# 查看日志
journalctl -u spot-watchdog.service -f
```

#### 运维命令

```bash
systemctl list-timers spot-watchdog.timer   # 查看下次触发时间
systemctl start spot-watchdog.service       # 立即手动触发
journalctl -u spot-watchdog.service -n 50   # 最近 50 行日志
```

#### 环境变量

| 变量 | 默认值 | 说明 |
|:--|:--|:--|
| `GCP_SA_KEY` | `<脚本目录>/sa-key.json` | 服务账号密钥路径 |
| `WATCHDOG_CONF` | `<脚本目录>/targets.conf` | 目标清单路径 |
| `PROBE_TIMEOUT` | `10` | HTTP 探测超时（秒） |
| `TG_BOT_TOKEN` | — | Telegram bot token |
| `TG_CHAT_ID` | — | Telegram chat id |

</details>

<details>
<summary><b>方案 B：Cloudflare Worker + Cron Trigger（无服务器）</b></summary>

#### 安装依赖

```bash
cd spot-watchdog-worker
npm install
npx wrangler login
```

#### 配置目标实例

编辑 `wrangler.toml` 里的 `TARGETS`（JSON 数组）：

```toml
[vars]
TARGETS = '''[
  {"project":"my-project","zone":"us-central1-a","instance":"web-1","healthUrl":"https://web1.example.com/"},
  {"project":"my-project","zone":"asia-east1-b","instance":"worker-1","healthUrl":"https://worker1.example.com/"}
]'''
```

#### 设置 Secrets

```bash
# 服务账号邮箱
npx wrangler secret put GCP_SA_EMAIL
# 输入: spot-watchdog@my-project.iam.gserviceaccount.com

# 服务账号私钥（从 sa-key.json 的 private_key 字段取值）
npx wrangler secret put GCP_SA_PRIVATE_KEY
```

> **提取 private_key（PowerShell）：**
> ```powershell
> (Get-Content sa-key.json | ConvertFrom-Json).private_key
> ```
> **提取 private_key（bash / jq）：**
> ```bash
> jq -r '.private_key' sa-key.json
> ```

#### 部署

```bash
npx wrangler deploy
```

#### 验证

```bash
# 本地开发模式
npx wrangler dev

# 另一个终端 —— 触发一轮并查看输出
curl http://localhost:8787/run

# 手动停一台实例后再触发
gcloud compute instances stop TEST_INSTANCE --zone=ZONE
curl http://localhost:8787/run
# 期望: DOWN ... -> START ... status=TERMINATED -> 开机
```

#### 运维命令

```bash
npx wrangler tail             # 线上实时日志
npx wrangler deploy           # 重新部署
```

也可在 **Cloudflare Dashboard → Workers → spot-watchdog → Triggers** 手动触发 cron。

#### 环境变量

| 名称 | 类型 | 说明 |
|:--|:--|:--|
| `TARGETS` | var | 目标实例 JSON 数组 |
| `PROBE_TIMEOUT_MS` | var | 探测超时毫秒（默认 `10000`） |
| `GCP_SA_EMAIL` | secret | 服务账号邮箱 |
| `GCP_SA_PRIVATE_KEY` | secret | 服务账号私钥 PEM |
| `TG_BOT_TOKEN` | secret | Telegram bot token |
| `TG_CHAT_ID` | secret | Telegram chat id |

</details>

### Step 3：配置 Telegram 通知（可选）

两套方案均支持通过 Telegram Bot 推送开机通知。设置后的效果：

```
🔴→🟢 Spot 实例已自动开机
实例: web-1
项目: my-project
区域: us-central1-a
之前状态: TERMINATED
时间: 2026-07-01T12:00:00+08:00
```

#### 获取 Bot Token 和 Chat ID

1. 在 Telegram 找 **@BotFather** → 发送 `/newbot` → 按提示创建，拿到 **Bot Token**
2. 给你的新 Bot 发一条消息
3. 访问 `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`，从返回的 JSON 中读取 `result[0].message.chat.id`
   （或直接在 Telegram 找 **@userinfobot** 获取你的 Chat ID）

#### 配置到看门狗

**方案 A（Debian）：** 编辑 `/etc/systemd/system/spot-watchdog.service`，取消注释并填值：

```ini
Environment=TG_BOT_TOKEN=123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Environment=TG_CHAT_ID=987654321
```

```bash
sudo systemctl daemon-reload
```

**方案 B（Worker）：**

```bash
npx wrangler secret put TG_BOT_TOKEN
npx wrangler secret put TG_CHAT_ID
npx wrangler deploy
```

不设置则不发通知，不影响看门狗正常运行。

## 工作原理

```
每 5 分钟触发
     │
     ▼
┌──────────────┐     连接成功      ┌────────┐
│ HTTPS 探测   │ ──────────────▶  │  在线   │
│ GET /        │     (任意响应)    │  跳过   │
└──────────────┘                  └────────┘
     │ 连接失败 / 超时 / TLS 失败
     ▼
┌──────────────┐
│ 查 GCP API   │
│ 实例状态     │
└──────────────┘
     │
     ├── TERMINATED / STOPPED ──▶  调用 instances.start ──▶ Telegram 通知
     │
     └── RUNNING / STAGING ────▶  跳过（正在启动或应用层问题）
```

## 调整探测频率

默认每 **5 分钟**探测一次。修改方式：

- **方案 A：** 编辑 `spot-watchdog.timer` 中的 `OnUnitActiveSec=5min`，然后：
  ```bash
  sudo systemctl daemon-reload && sudo systemctl restart spot-watchdog.timer
  ```
- **方案 B：** 编辑 `wrangler.toml` 中的 `crons = ["*/5 * * * *"]`，然后 `npx wrangler deploy`

## 安全说明

- `sa-key.json` 已被 `.gitignore` 排除 —— **切勿提交到版本库**
- 服务账号使用**最小权限自定义角色**，仅有 `compute.instances.get` / `.start` / `.list` 三个权限
- Worker 方案中私钥存为 Cloudflare **加密 Secret**，不出现在代码或配置文件中
- `.gitattributes` 强制 `eol=lf`，避免 Windows 的 CRLF 在 Linux 上破坏 shebang

## 项目结构

```
GCP_Start/
├── README.md                           # 本文件（中文）
├── README_EN.md                        # English version
├── setup-gcp.sh                        # GCP 服务账号初始化脚本（两套共用）
├── .gitignore
├── .gitattributes
│
├── spot-watchdog/                      # 方案 A：Debian watchdog
│   ├── watchdog.sh                     #   主脚本
│   ├── targets.conf                    #   目标实例清单
│   ├── spot-watchdog.service           #   systemd oneshot unit
│   ├── spot-watchdog.timer             #   systemd timer
│   └── README.md                       #   方案 A 详细文档
│
└── spot-watchdog-worker/               # 方案 B：Cloudflare Worker
    ├── src/index.js                    #   Worker 全部逻辑
    ├── wrangler.toml                   #   配置 + Cron Trigger
    ├── package.json
    └── README.md                       #   方案 B 详细文档
```

## License

MIT
