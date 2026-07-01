# GCP Spot 实例自动开机看门狗

监控 GCP 上的 **Spot（抢占式）** 实例，被 GCP 关机（`TERMINATED`）后自动通过 API 重新开机。

## 核心逻辑（两套方案共用）

对每台目标实例：

1. **HTTP 探测** 健康 URL（带超时）。只要能连上并返回**任意** HTTP 响应（200/404/500 都算）→ 在线，跳过。
2. 探测失败（连接失败/超时/TLS 失败）→ **查 GCP 实例状态**：
   - `TERMINATED` / `STOPPED` → 调用 `instances.start` 开机，并（可选）推送 **Telegram** 通知。
   - `RUNNING` / `STAGING` / `PROVISIONING` → 正在启动或服务自身挂了，**不开机**，仅记日志。

> 用 API 状态作为"是否开机"的闸门，避免对正在启动的实例重复下发 start，也能区分"被抢占关机"和"服务自身挂了"。

> **Telegram 通知**（两套均支持，可选）：设置 `TG_BOT_TOKEN` + `TG_CHAT_ID` 后，实例被自动开机/开机失败时推送。配置见各方案 README。

## 两套方案

| | 方案 A：Debian watchdog | 方案 B：Cloudflare Worker |
|---|---|---|
| 目录 | [`spot-watchdog/`](./spot-watchdog/) | [`spot-watchdog-worker/`](./spot-watchdog-worker/) |
| 运行环境 | 一台常在线的 Debian 13 机器 | Cloudflare 无服务器（Cron Trigger） |
| 探测 | `curl` | `fetch()` |
| 鉴权 | `gcloud auth activate-service-account` | JS 手动签 JWT 换 OAuth token |
| 定时 | `systemd timer`（每 5 分钟） | Cron Trigger（每 5 分钟） |
| 需要常在线机器 | 是 | 否 |

按需选一套部署，两套互不依赖。

## 第一步（两套共用）：GCP 准备

编辑 [`setup-gcp.sh`](./setup-gcp.sh) 顶部的 `PROJECT_ID`，然后运行它创建服务账号、最小权限角色并下载 `sa-key.json`。详见各方案目录下的 README。

## 前提假设

- 每台被监控实例有一个**从探测端可达的 HTTP(S) 健康 URL**（一般需公网 IP + 防火墙放行端口）。
  若实例没有公网 HTTP 服务，需改用 TCP 探测或直接查 API 状态（当前实现为 HTTP 探测）。
