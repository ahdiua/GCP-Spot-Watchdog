#!/usr/bin/env bash
#
# GCP Spot 实例看门狗：HTTP 探测各目标实例，探测失败且状态为 TERMINATED/STOPPED 时自动开机。
# 由 systemd timer（或 cron）定时调用。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="${WATCHDOG_CONF:-${SCRIPT_DIR}/targets.conf}"
KEY_FILE="${GCP_SA_KEY:-${SCRIPT_DIR}/sa-key.json}"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-10}"    # HTTP 探测超时（秒）

log() { echo "$(date -Is) $*"; }

# 可选 Telegram 通知：仅当 TG_BOT_TOKEN 与 TG_CHAT_ID 都设置时才发送
notify_tg() {
  [[ -z "${TG_BOT_TOKEN:-}" || -z "${TG_CHAT_ID:-}" ]] && return 0
  curl -fsS -o /dev/null --max-time 10 \
    "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TG_CHAT_ID}" \
    --data-urlencode "text=$1" \
    --data-urlencode "disable_web_page_preview=true" \
    || log "WARN  Telegram 通知发送失败"
}

if [[ ! -f "$CONF" ]]; then
  log "ERROR 找不到配置文件: $CONF"
  exit 1
fi
if [[ ! -f "$KEY_FILE" ]]; then
  log "ERROR 找不到服务账号密钥: $KEY_FILE (可用 GCP_SA_KEY 覆盖)"
  exit 1
fi

# 激活服务账号（幂等；gcloud 会缓存凭据）
gcloud auth activate-service-account --key-file="$KEY_FILE" --quiet

# 探测一个 URL：只要能建立连接并收到任意 HTTP 响应（200/404/500 都算在线）就返回成功；
# 仅连接失败/超时/TLS 失败（curl 非 0 退出）视为离线。故意不加 -f。
probe_ok() {
  curl -sS -o /dev/null --max-time "$PROBE_TIMEOUT" "$1"
}

rc=0
# 逐行读取配置：project zone instance url（空格分隔，# 为注释）
while read -r project zone instance url _rest; do
  # 跳过空行与注释
  [[ -z "${project:-}" ]] && continue
  [[ "$project" == \#* ]] && continue
  if [[ -z "${zone:-}" || -z "${instance:-}" || -z "${url:-}" ]]; then
    log "WARN  配置行不完整，跳过: $project $zone $instance $url"
    continue
  fi

  if probe_ok "$url"; then
    log "OK    $instance ($url)"
    continue
  fi
  log "DOWN  $instance 探测失败 ($url)，查询实例状态..."

  status="$(gcloud compute instances describe "$instance" \
    --project="$project" --zone="$zone" \
    --format='value(status)' 2>/dev/null || echo UNKNOWN)"

  case "$status" in
    TERMINATED|STOPPED)
      log "START $instance status=$status -> 开机"
      if gcloud compute instances start "$instance" \
           --project="$project" --zone="$zone" --quiet; then
        log "START $instance 已下发 start 请求"
        notify_tg "$(printf '\xF0\x9F\x94\xB4\xE2\x86\x92\xF0\x9F\x9F\xA2 Spot 实例已自动开机\n实例: %s\n项目: %s\n区域: %s\n之前状态: %s\n时间: %s' \
          "$instance" "$project" "$zone" "$status" "$(date -Is)")"
      else
        log "ERROR $instance start 失败"
        notify_tg "$(printf '\xE2\x9D\x97 Spot 实例开机失败\n实例: %s\n项目: %s\n区域: %s\n时间: %s' \
          "$instance" "$project" "$zone" "$(date -Is)")"
        rc=1
      fi
      ;;
    UNKNOWN)
      log "ERROR $instance 无法获取状态（权限/网络/名称？）"
      rc=1
      ;;
    *)
      log "SKIP  $instance status=$status（正在启动或应用层故障，不开机）"
      ;;
  esac
done < "$CONF"

exit "$rc"
