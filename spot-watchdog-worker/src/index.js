/**
 * GCP Spot 实例看门狗 — Cloudflare Worker（Cron Trigger）
 *
 * 每次触发：对 TARGETS 里的每台实例做 HTTP 探测；探测失败则查 GCP 实例状态，
 * 状态为 TERMINATED/STOPPED 时调用 GCP Compute API 开机。
 *
 * env:
 *   TARGETS            (var)    JSON 数组：[{project,zone,instance,healthUrl}, ...]
 *   GCP_SA_EMAIL       (secret) 服务账号邮箱
 *   GCP_SA_PRIVATE_KEY (secret) 服务账号私钥 PEM（sa-key.json 里的 private_key）
 *   PROBE_TIMEOUT_MS   (var, 可选) HTTP 探测超时毫秒，默认 10000
 */

export default {
  async scheduled(event, env, ctx) {
    await run(env);
  },

  // 便于手动触发调试：GET /run 会执行一轮并返回日志
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      const logs = await run(env);
      return new Response(logs.join("\n") + "\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("spot-watchdog: POST/GET /run to trigger\n", { status: 200 });
  },
};

async function run(env) {
  const logs = [];
  const log = (...a) => {
    const line = a.join(" ");
    logs.push(line);
    console.log(line);
  };

  let targets;
  try {
    targets = JSON.parse(env.TARGETS);
  } catch (e) {
    log("ERROR TARGETS 不是合法 JSON:", e.message);
    return logs;
  }

  const timeoutMs = Number(env.PROBE_TIMEOUT_MS || 10000);
  let token = null; // 本轮内缓存 access token

  for (const t of targets) {
    if (await probe(t.healthUrl, timeoutMs)) {
      log("OK   ", t.instance, `(${t.healthUrl})`);
      continue;
    }
    log("DOWN ", t.instance, "探测失败，查询状态...");

    try {
      token ||= await getAccessToken(env);
      const status = await getStatus(t, token);
      if (status === "TERMINATED" || status === "STOPPED") {
        log("START", t.instance, `status=${status} -> 开机`);
        const ok = await startInstance(t, token, log);
        const when = new Date().toISOString();
        if (ok) {
          await notifyTelegram(env,
            `🔴→🟢 Spot 实例已自动开机\n实例: ${t.instance}\n项目: ${t.project}\n区域: ${t.zone}\n之前状态: ${status}\n时间: ${when}`);
        } else {
          await notifyTelegram(env,
            `❗ Spot 实例开机失败\n实例: ${t.instance}\n项目: ${t.project}\n区域: ${t.zone}\n时间: ${when}`);
        }
      } else if (status === "UNKNOWN") {
        log("ERROR", t.instance, "无法获取状态（权限/名称？）");
      } else {
        log("SKIP ", t.instance, `status=${status}（正在启动或应用层故障，不开机）`);
      }
    } catch (e) {
      log("ERROR", t.instance, "处理异常:", e.message);
    }
  }
  return logs;
}

// ---- HTTP 探测：只要能连上并收到任意 HTTP 响应（200/404/500 都算在线）就返回 true；
//      仅连接失败/超时/TLS 失败（fetch 抛异常）视为离线。 ----
async function probe(url, timeoutMs) {
  const c = new AbortController();
  const id = setTimeout(() => c.abort(), timeoutMs);
  try {
    await fetch(url, { signal: c.signal, redirect: "manual" });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(id);
  }
}

// ---- 查询实例状态 ----
async function getStatus(t, token) {
  const u = `https://compute.googleapis.com/compute/v1/projects/${t.project}/zones/${t.zone}/instances/${t.instance}`;
  const r = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return "UNKNOWN";
  const body = await r.json();
  return body.status || "UNKNOWN";
}

// ---- 开机（返回是否成功下发） ----
async function startInstance(t, token, log) {
  const u = `https://compute.googleapis.com/compute/v1/projects/${t.project}/zones/${t.zone}/instances/${t.instance}/start`;
  const r = await fetch(u, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-length": "0" },
  });
  if (r.ok) {
    log("START", t.instance, "已下发 start 请求");
    return true;
  }
  log("ERROR", t.instance, "start 失败", r.status, await r.text());
  return false;
}

// ---- 可选 Telegram 通知：仅当 TG_BOT_TOKEN 与 TG_CHAT_ID 都设置时才发送 ----
async function notifyTelegram(env, text) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TG_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.log("Telegram 通知失败:", e.message);
  }
}

// ---- 服务账号 JWT 签名换 OAuth access token ----
async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: env.GCP_SA_EMAIL,
    scope: "https://www.googleapis.com/auth/compute",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc(header)}.${enc(claim)}`;

  const key = await importPrivateKey(env.GCP_SA_PRIVATE_KEY);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`;

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!r.ok) {
    throw new Error(`token 交换失败 ${r.status}: ${await r.text()}`);
  }
  const body = await r.json();
  if (!body.access_token) throw new Error("token 响应无 access_token");
  return body.access_token;
}

// PEM(pkcs8) -> CryptoKey。兼容 secret 里换行为字面 \n 的情况。
async function importPrivateKey(pem) {
  const normalized = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
  const body = normalized
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

function b64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
