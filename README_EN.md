<p align="center">
  <h1 align="center">GCP Spot Watchdog</h1>
  <p align="center">
    Automatically monitor GCP Spot (preemptible) instances and restart them via API when preempted, with optional Telegram notifications.
    <br />
    <a href="./README.md"><strong>中文</strong></a>
    &nbsp;&middot;&nbsp;
    <a href="#quick-start">Quick Start</a>
    &nbsp;&middot;&nbsp;
    <a href="#variant-comparison">Variant Comparison</a>
    &nbsp;&middot;&nbsp;
    <a href="#telegram-notifications">Telegram Notifications</a>
  </p>
</p>

---

## What It Does

GCP Spot instances can be preempted at any time (status becomes `TERMINATED`). This project provides a **watchdog** that runs every 5 minutes to:

1. **HTTPS-probe** each instance — any HTTP response (200 / 404 / 500) counts as alive
2. On probe failure, **query the GCP instance status** — only `TERMINATED` / `STOPPED` triggers a restart
3. Call the **`instances.start` API** to auto-restart and push a **Telegram Bot** notification

> **Why not restart on probe failure alone?**
> Using the GCP API status as a gate prevents duplicate start calls on instances that are still booting (`STAGING`), and distinguishes "preempted" from "VM is running but the app crashed."

## Variant Comparison

Two **independent** variants are provided — pick whichever fits your setup:

| | Variant A: Debian watchdog | Variant B: Cloudflare Worker |
|:--|:--|:--|
| **Directory** | [`spot-watchdog/`](./spot-watchdog/) | [`spot-watchdog-worker/`](./spot-watchdog-worker/) |
| **Runtime** | An always-on Linux machine | Cloudflare serverless |
| **Scheduler** | systemd timer | Cron Trigger |
| **Probing** | `curl` | `fetch()` |
| **Auth** | `gcloud` CLI service account activation | JS Web Crypto RS256 JWT → OAuth token |
| **Dependencies** | `bash` `curl` `gcloud` | Node.js + `wrangler` |
| **Requires always-on machine** | Yes | **No** |
| **Best for** | Already have a stable VPS / home server | Zero-ops, no extra machine |

## Prerequisites

- A GCP project with one or more Spot instances
- Each monitored instance has a **publicly reachable HTTPS endpoint** (e.g., `https://your-ip/`)
- [`gcloud` CLI](https://cloud.google.com/sdk/docs/install) installed and authenticated with IAM admin permissions

## Quick Start

### Step 0: Clone the Repo

```bash
git clone https://github.com/YOUR_USERNAME/GCP_Start.git
cd GCP_Start
```

### Step 1: Create a GCP Service Account (shared, one-time)

Edit `PROJECT_ID` at the top of [`setup-gcp.sh`](./setup-gcp.sh), then run:

```bash
bash setup-gcp.sh
```

This will:
- Create service account `spot-watchdog@PROJECT_ID.iam.gserviceaccount.com`
- Create a least-privilege custom role (`compute.instances.get` / `.start` / `.list` only)
- Bind the role to the service account
- Download the key file `sa-key.json` (excluded by `.gitignore` — never commit this)

### Step 2: Deploy One Variant

<details>
<summary><b>Variant A: Debian watchdog (bash + gcloud + systemd timer)</b></summary>

#### Install Dependencies

```bash
# Debian / Ubuntu
sudo apt-get update && sudo apt-get install -y curl
# Install gcloud CLI per the official docs:
# https://cloud.google.com/sdk/docs/install#deb
```

#### Configure Target Instances

Edit `spot-watchdog/targets.conf` — one instance per line (space-separated):

```
# project            zone              instance      health_url
my-project           us-central1-a     web-1         https://web1.example.com/
my-project           asia-east1-b      worker-1      https://worker1.example.com/
```

#### Deploy

```bash
sudo mkdir -p /opt/spot-watchdog
sudo cp spot-watchdog/watchdog.sh spot-watchdog/targets.conf sa-key.json /opt/spot-watchdog/
sudo chmod 600 /opt/spot-watchdog/sa-key.json
sudo chmod +x /opt/spot-watchdog/watchdog.sh

sudo cp spot-watchdog/spot-watchdog.service spot-watchdog/spot-watchdog.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now spot-watchdog.timer
```

#### Verify

```bash
# Create a TERMINATED state for testing
gcloud compute instances stop TEST_INSTANCE --zone=ZONE

# Trigger the watchdog manually
sudo systemctl start spot-watchdog.service

# Check logs
journalctl -u spot-watchdog.service -f
```

#### Operations

```bash
systemctl list-timers spot-watchdog.timer   # Next trigger time
systemctl start spot-watchdog.service       # Trigger manually
journalctl -u spot-watchdog.service -n 50   # Last 50 log lines
```

#### Environment Variables

| Variable | Default | Description |
|:--|:--|:--|
| `GCP_SA_KEY` | `<script_dir>/sa-key.json` | Path to service account key |
| `WATCHDOG_CONF` | `<script_dir>/targets.conf` | Path to target list |
| `PROBE_TIMEOUT` | `10` | HTTP probe timeout in seconds |
| `TG_BOT_TOKEN` | — | Telegram bot token |
| `TG_CHAT_ID` | — | Telegram chat ID |

</details>

<details>
<summary><b>Variant B: Cloudflare Worker + Cron Trigger (serverless)</b></summary>

#### Install Dependencies

```bash
cd spot-watchdog-worker
npm install
npx wrangler login
```

#### Configure Target Instances

Edit the `TARGETS` var in `wrangler.toml` (JSON array):

```toml
[vars]
TARGETS = '''[
  {"project":"my-project","zone":"us-central1-a","instance":"web-1","healthUrl":"https://web1.example.com/"},
  {"project":"my-project","zone":"asia-east1-b","instance":"worker-1","healthUrl":"https://worker1.example.com/"}
]'''
```

#### Set Secrets

```bash
# Service account email
npx wrangler secret put GCP_SA_EMAIL
# Enter: spot-watchdog@my-project.iam.gserviceaccount.com

# Service account private key (from sa-key.json's private_key field)
npx wrangler secret put GCP_SA_PRIVATE_KEY
```

> **Extract private_key (bash / jq):**
> ```bash
> jq -r '.private_key' sa-key.json
> ```
> **Extract private_key (PowerShell):**
> ```powershell
> (Get-Content sa-key.json | ConvertFrom-Json).private_key
> ```

#### Deploy

```bash
npx wrangler deploy
```

#### Verify

```bash
# Local dev mode
npx wrangler dev

# In another terminal — trigger one round
curl http://localhost:8787/run

# Stop a test instance, then trigger
gcloud compute instances stop TEST_INSTANCE --zone=ZONE
curl http://localhost:8787/run
# Expected: DOWN ... -> START ... status=TERMINATED -> starting
```

#### Operations

```bash
npx wrangler tail             # Live production logs
npx wrangler deploy           # Redeploy
```

You can also trigger the cron manually from **Cloudflare Dashboard → Workers → spot-watchdog → Triggers**.

#### Environment Variables

| Name | Type | Description |
|:--|:--|:--|
| `TARGETS` | var | Target instances JSON array |
| `PROBE_TIMEOUT_MS` | var | Probe timeout in ms (default `10000`) |
| `GCP_SA_EMAIL` | secret | Service account email |
| `GCP_SA_PRIVATE_KEY` | secret | Service account private key (PEM) |
| `TG_BOT_TOKEN` | secret | Telegram bot token |
| `TG_CHAT_ID` | secret | Telegram chat ID |

</details>

### Step 3: Set Up Telegram Notifications (Optional)

Both variants support Telegram Bot notifications on instance restart. Example message:

```
🔴→🟢 Spot 实例已自动开机
实例: web-1
项目: my-project
区域: us-central1-a
之前状态: TERMINATED
时间: 2026-07-01T12:00:00+08:00
```

#### Get Your Bot Token and Chat ID

1. Find **@BotFather** on Telegram → send `/newbot` → follow prompts to get a **Bot Token**
2. Send any message to your new bot
3. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` and read `result[0].message.chat.id`
   (or use **@userinfobot** on Telegram to get your Chat ID directly)

#### Configure

**Variant A (Debian):** Edit `/etc/systemd/system/spot-watchdog.service` — uncomment and fill in:

```ini
Environment=TG_BOT_TOKEN=123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Environment=TG_CHAT_ID=987654321
```

```bash
sudo systemctl daemon-reload
```

**Variant B (Worker):**

```bash
npx wrangler secret put TG_BOT_TOKEN
npx wrangler secret put TG_CHAT_ID
npx wrangler deploy
```

If not configured, notifications are silently skipped — the watchdog runs normally either way.

## How It Works

```
Every 5 minutes
     │
     ▼
┌──────────────┐     Connection OK    ┌────────┐
│ HTTPS probe  │ ───────────────────▶ │  Alive │
│ GET /        │   (any HTTP status)  │  Skip  │
└──────────────┘                      └────────┘
     │ Connection refused / timeout / TLS error
     ▼
┌──────────────┐
│  Query GCP   │
│  API status  │
└──────────────┘
     │
     ├── TERMINATED / STOPPED ──▶  Call instances.start ──▶ Telegram notification
     │
     └── RUNNING / STAGING ────▶  Skip (booting or app-level issue)
```

## Adjusting Probe Frequency

Default: every **5 minutes**. To change:

- **Variant A:** Edit `OnUnitActiveSec=5min` in `spot-watchdog.timer`, then:
  ```bash
  sudo systemctl daemon-reload && sudo systemctl restart spot-watchdog.timer
  ```
- **Variant B:** Edit `crons = ["*/5 * * * *"]` in `wrangler.toml`, then `npx wrangler deploy`

## Security Notes

- `sa-key.json` is excluded by `.gitignore` — **never commit it**
- The service account uses a **least-privilege custom role** with only `compute.instances.get` / `.start` / `.list`
- In the Worker variant, the private key is stored as a Cloudflare **encrypted Secret**
- `.gitattributes` enforces `eol=lf` to prevent Windows CRLF from breaking shebangs on Linux

## Project Structure

```
GCP_Start/
├── README.md                           # Chinese docs
├── README_EN.md                        # This file (English)
├── setup-gcp.sh                        # GCP service account setup (shared)
├── .gitignore
├── .gitattributes
│
├── spot-watchdog/                      # Variant A: Debian watchdog
│   ├── watchdog.sh                     #   Main script
│   ├── targets.conf                    #   Target instance list
│   ├── spot-watchdog.service           #   systemd oneshot unit
│   ├── spot-watchdog.timer             #   systemd timer
│   └── README.md                       #   Variant A details
│
└── spot-watchdog-worker/               # Variant B: Cloudflare Worker
    ├── src/index.js                    #   All Worker logic
    ├── wrangler.toml                   #   Config + Cron Trigger
    ├── package.json
    └── README.md                       #   Variant B details
```

## License

MIT
