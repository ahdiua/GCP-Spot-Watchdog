#!/usr/bin/env bash
#
# 一次性 GCP 准备：创建服务账号、最小权限自定义角色、绑定、下载密钥。
# 两套方案（Debian watchdog / Cloudflare Worker）共用产出的 sa-key.json。
#
# 用法：编辑下面的 PROJECT_ID，然后 `bash setup-gcp.sh`
# 需要你本机已用有 IAM 权限的账号登录 gcloud。
set -euo pipefail

# ===== 按需修改 =====
PROJECT_ID="my-project-id"
SA_NAME="spot-watchdog"
ROLE_ID="spotWatchdog"            # 自定义角色 ID（项目级）
KEY_OUT="sa-key.json"            # 输出的密钥文件
# ====================

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo ">> 项目: ${PROJECT_ID}"
echo ">> 服务账号: ${SA_EMAIL}"

# 1) 服务账号（若已存在则跳过）
if ! gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" \
    --project="$PROJECT_ID" \
    --display-name="Spot Watchdog"
else
  echo ">> 服务账号已存在，跳过创建"
fi

# 2) 最小权限自定义角色（若已存在则更新）
if ! gcloud iam roles describe "$ROLE_ID" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam roles create "$ROLE_ID" --project="$PROJECT_ID" \
    --title="Spot Watchdog" \
    --description="Get/start/list compute instances for the spot watchdog" \
    --permissions=compute.instances.get,compute.instances.start,compute.instances.list \
    --stage=GA
else
  gcloud iam roles update "$ROLE_ID" --project="$PROJECT_ID" \
    --permissions=compute.instances.get,compute.instances.start,compute.instances.list
fi

# 3) 绑定角色到服务账号
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="projects/${PROJECT_ID}/roles/${ROLE_ID}" \
  --condition=None

# 4) 下载密钥
gcloud iam service-accounts keys create "$KEY_OUT" \
  --iam-account="$SA_EMAIL"

echo ""
echo ">> 完成。密钥已写入: ${KEY_OUT}"
echo ">> 服务账号邮箱（Worker 方案的 GCP_SA_EMAIL）: ${SA_EMAIL}"
echo ">> 请妥善保管 ${KEY_OUT}，勿提交进版本库。"
