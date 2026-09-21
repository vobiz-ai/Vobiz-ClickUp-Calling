/** === Vobiz Calling Backend for ClickUp CRM ===
 *
 * THE BROWSER IS THE A LEG.
 * The softphone sends the SIP INVITE itself via WebRTC (JsSIP),
 * and this backend answers with <Dial><Number> to bridge to the customer.
 * Inbound calls to account DIDs are bridged via <Dial><User> to the registered agent softphone.
 *
 * All completed calls, durations, and call recordings are synced to ClickUp tasks.
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");
const crypto = require("crypto");

// ─── Load environment variables ──────────────────────────────────────────────
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (e) {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const idx = line.indexOf("=");
      if (idx !== -1 && !line.trim().startsWith("#")) {
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
        if (key) process.env[key] = val;
      }
    }
  }
}

const cleanEnvVar = (val) => val?.trim().replace(/^["']|["']$/g, "") || "";

const PORT = Number(cleanEnvVar(process.env.PORT) || 8092);
const VOBIZ_AUTH_ID = cleanEnvVar(process.env.VOBIZ_AUTH_ID);
const VOBIZ_AUTH_TOKEN = cleanEnvVar(process.env.VOBIZ_AUTH_TOKEN);
const VOBIZ_FROM_NUMBER = cleanEnvVar(process.env.VOBIZ_FROM_NUMBER) || "+15550100000";
const VOBIZ_API_URL = cleanEnvVar(process.env.VOBIZ_API_URL) || "https://api.vobiz.ai";
const VOBIZ_SIP_USER = cleanEnvVar(process.env.VOBIZ_SIP_USER) || "admin";
const VOBIZ_SIP_PASSWORD = cleanEnvVar(process.env.VOBIZ_SIP_PASSWORD) || "";
const VOBIZ_REGISTRAR = cleanEnvVar(process.env.VOBIZ_REGISTRAR) || "registrar.vobiz.ai";

const CLICKUP_API_TOKEN = cleanEnvVar(process.env.CLICKUP_API_TOKEN);
const CLICKUP_TEAM_ID = cleanEnvVar(process.env.CLICKUP_TEAM_ID);
const CLICKUP_LIST_ID = cleanEnvVar(process.env.CLICKUP_LIST_ID);
const CLICKUP_API_URL = cleanEnvVar(process.env.CLICKUP_API_URL) || "https://api.clickup.com/api/v2";

const SIGNING_SECRET = cleanEnvVar(process.env.SIGNING_SECRET) || crypto.randomBytes(32).toString("hex");
const RECORDING_URL_TTL_SECONDS = Number(cleanEnvVar(process.env.RECORDING_URL_TTL_SECONDS) || 900);
const ALLOW_MOCK = cleanEnvVar(process.env.ALLOW_MOCK) === "1" || !VOBIZ_AUTH_ID || VOBIZ_AUTH_ID.includes("YOUR_");

const TUNNEL_URL_FILE = path.join(__dirname, "tunnel-url.txt");

function getPublicBaseUrl(req) {
  if (process.env.TUNNEL_URL) return process.env.TUNNEL_URL.trim().replace(/\/+$/, "");
  try {
    if (fs.existsSync(TUNNEL_URL_FILE)) {
      const urlStr = fs.readFileSync(TUNNEL_URL_FILE, "utf8").trim();
      if (urlStr) return urlStr.replace(/\/+$/, "");
    }
  } catch (_) {}
  if (req && req.headers && req.headers.host) {
    const proto = req.headers["x-forwarded-proto"] || (req.connection && req.connection.encrypted ? "https" : "http");
    return `${proto}://${req.headers.host}`.replace(/\/+$/, "");
  }
  return `http://localhost:${PORT}`;
}

const AGENTS_FILE = path.join(__dirname, "agents.json");

function getAllAgents() {
  try {
    if (fs.existsSync(AGENTS_FILE)) {
      return JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8"));
    }
  } catch (err) {
    console.error("[backend] Error reading agents.json:", err.message);
  }
  return {
    admin: {
      name: "System Administrator",
      sipUser: `${VOBIZ_SIP_USER || "admin"}@${VOBIZ_REGISTRAR}`,
      clickUpUserId: "12345678",
      clickUpEmail: "admin@vobiz.ai",
    },
    agent1: {
      name: "John Doe",
      sipUser: `agent1@${VOBIZ_REGISTRAR}`,
      clickUpUserId: "87654321",
      clickUpEmail: "john.doe@vobiz.ai",
    }
  };
}

/**
 * Agent display metadata. Deliberately carries no SIP password: agents.json is
 * committed, so a password written into it is a published password. The SIP
 * password comes from the environment and is served only to a signed-in caller.
 */
function getAgent(agentId) {
  const agents = getAllAgents();
  const found = agents[agentId] || agents["admin"];
  if (found) {
    const { name, sipUser, clickUpUserId, clickUpEmail } = found;
    return { name, sipUser, clickUpUserId, clickUpEmail };
  }
  return {
    name: agentId ? `Agent (${agentId})` : "ClickUp Agent",
    sipUser: `${agentId || "agent"}@${VOBIZ_REGISTRAR}`,
    clickUpUserId: "",
    clickUpEmail: "",
  };
}

// ─── State Maps ─────────────────────────────────────────────────────────────
// sessionToken -> { agentId, authId, authToken, numbers, from, createdAt }
const sessions = new Map();
// sipUser -> callerId
const fromBySipUser = new Map();
// callUuid -> callRecord
const callsByUuid = new Map();
// Completed call recordings
const callRecordings = new Map();
const recentCalls = [];
let cachedAccountNumbers = [];

async function refreshAccountNumbers() {
  if (!VOBIZ_AUTH_ID || !VOBIZ_AUTH_TOKEN || VOBIZ_AUTH_ID.includes("YOUR_")) return;
  try {
    const res = await fetch(`${VOBIZ_API_URL}/api/v1/Account/${encodeURIComponent(VOBIZ_AUTH_ID)}/numbers?per_page=50`, {
      headers: {
        "X-Auth-ID": VOBIZ_AUTH_ID,
        "X-Auth-Token": VOBIZ_AUTH_TOKEN,
        Accept: "application/json",
      },
    });
    if (res.ok) {
      const json = await res.json();
      const items = json.objects || json.items || [];
      const nums = items.map((n) => n.e164 || n.number || n.phone_number).filter(Boolean);
      if (nums.length > 0) {
        cachedAccountNumbers = nums;
        console.log(`[backend] Loaded ${nums.length} account phone numbers from Vobiz API:`, nums);
      }
    }
  } catch (err) {
    console.warn("[backend] Notice fetching account numbers:", err.message);
  }
}
refreshAccountNumbers();

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function newSession(agentId, authId, authToken, numbers, from) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    agentId,
    authId,
    authToken,
    numbers,
    from: from || (numbers && numbers[0]) || VOBIZ_FROM_NUMBER,
    createdAt: Date.now(),
  });
  return token;
}

function getSession(req) {
  const header = (req.headers && req.headers.authorization) || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return s;
}

function rememberCall(record) {
  callsByUuid.set(record.callUuid, record);
  recentCalls.unshift(record);
  while (recentCalls.length > 200) {
    const dropped = recentCalls.pop();
    if (dropped) callsByUuid.delete(dropped.callUuid);
  }
}

function toE164(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("+")) return s;
  if (s.startsWith("0") && s.length === 11) return `+91${s.slice(1)}`;
  const digits = s.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

function formatDuration(seconds) {
  const sec = parseInt(seconds || 0, 10);
  const mins = String(Math.floor(sec / 60)).padStart(2, "0");
  const secs = String(sec % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

// ─── Recording HMAC Signing ──────────────────────────────────────────────────
function signRecordingUrl(recordingId, publicBaseUrl) {
  const exp = Math.floor(Date.now() / 1000) + RECORDING_URL_TTL_SECONDS;
  const sig = crypto.createHmac("sha256", SIGNING_SECRET).update(`${recordingId}|${exp}`).digest("hex");
  return `${publicBaseUrl}/recording-audio/${encodeURIComponent(recordingId)}?exp=${exp}&sig=${sig}`;
}

// Hosts this server is willing to fetch call media from. Anything else is
// refused — before the request is made, and again after every redirect.
const MEDIA_HOST_ALLOWLIST = [
  /(^|\.)vobiz\.ai$/i,
  /(^|\.)s3[.-][a-z0-9-]+\.amazonaws\.com$/i,
  /(^|\.)s3\.amazonaws\.com$/i,
];

function isAllowedMediaHost(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return MEDIA_HOST_ALLOWLIST.some((re) => re.test(u.hostname));
}

function verifyRecordingSignature(recordingId, exp, sig) {
  if (!exp || !sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = crypto.createHmac("sha256", SIGNING_SECRET).update(`${recordingId}|${exp}`).digest("hex");
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── CORS and Helpers ───────────────────────────────────────────────────────
// Origins allowed to drive this backend. A wildcard would let any page on the
// internet place calls billed to the account and read the call data this server
// exposes.
const ORIGIN_ALLOWLIST = [
  /^https:\/\/([a-z0-9-]+\.)*clickup\.com$/i,
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
];
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function withCors(res, req) {
  const origin = req && req.headers && req.headers.origin;
  if (origin && (EXTRA_ORIGINS.includes(origin) || ORIGIN_ALLOWLIST.some((re) => re.test(origin)))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, ngrok-skip-browser-warning");
}

/**
 * Guard for every route that spends money, changes account configuration, or
 * reads call data. Returns false and answers 401, so a caller reads
 * `if (!requireSession(req, res)) return;`.
 */
function requireSession(req, res) {
  if (getSession(req)) return true;
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Sign in first" }));
  return false;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        return resolve(JSON.parse(raw));
      } catch (_) {}
      try {
        return resolve(Object.fromEntries(new URLSearchParams(raw)));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// ─── ClickUp REST API Integration ───────────────────────────────────────────
function getClickUpHeaders() {
  return {
    Authorization: CLICKUP_API_TOKEN,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function searchClickUpTaskByPhone(phone) {
  if (!CLICKUP_API_TOKEN || !CLICKUP_LIST_ID || CLICKUP_API_TOKEN.includes("YOUR_CLICKUP")) {
    return null;
  }
  try {
    const cleanPhone = String(phone).replace(/[^\d]/g, "");
    const res = await fetch(`${CLICKUP_API_URL}/list/${CLICKUP_LIST_ID}/task?include_closed=true`, {
      headers: getClickUpHeaders(),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const tasks = json.tasks || [];
    return tasks.find(
      (t) => (t.name && t.name.includes(cleanPhone)) || (t.description && t.description.includes(cleanPhone))
    ) || null;
  } catch (err) {
    console.error("[ClickUp] Error searching task by phone:", err.message);
    return null;
  }
}

async function createClickUpCallTask(callData, publicBaseUrl) {
  const {
    callUuid,
    direction = "Outbound",
    from = VOBIZ_FROM_NUMBER,
    to = "",
    agentId = "admin",
    durationSeconds = 0,
    recordingUrl = "",
    recordingId = "",
    hangupCause = "NORMAL_CLEARING",
    status = "COMPLETE",
  } = callData;

  const base = publicBaseUrl || `http://localhost:${PORT}`;
  let proxiedRecordingUrl = "";
  if (recordingId) {
    proxiedRecordingUrl = signRecordingUrl(recordingId, base);
  }
  // A raw media URL without a recording ID is not linkable: the old code built
  // a /recording-file?url=… link, which is exactly the hole that route was.

  const customerPhone = direction.toLowerCase() === "inbound" ? from : to;
  const dirLabel = direction.toLowerCase() === "inbound" ? "Inbound" : "Outbound";
  const agentObj = getAgent(agentId);
  const formattedDuration = formatDuration(durationSeconds);

  const taskTitle = `Vobiz ${dirLabel} Call - ${customerPhone || "Customer"}`;

  const markdownDescription = `### 📞 Vobiz Telephony Call Detail Record (CDR)

| Parameter | Value |
| :--- | :--- |
| **Call UUID** | \`${callUuid || "N/A"}\` |
| **Direction** | \`${dirLabel}\` |
| **From** | \`${from}\` |
| **To** | \`${to}\` |
| **Agent** | \`${agentObj ? agentObj.name : agentId}\` |
| **Duration** | \`${formattedDuration}\` (${durationSeconds}s) |
| **Hangup Cause** | \`${hangupCause}\` |
| **Status** | \`${status.toUpperCase()}\` |
| **Timestamp** | \`${new Date().toISOString()}\` |

---
### 🎧 Call Recording Playback
${
  proxiedRecordingUrl
    ? `[▶ **Click to Play Call Recording**](${proxiedRecordingUrl})\n\n*(Audio is securely proxied via Vobiz Media Proxy)*`
    : "*No recording file generated for this call session.*"
}
`;

  console.log(`[ClickUp] Logging ${dirLabel} call task to ClickUp list '${CLICKUP_LIST_ID}'...`);

  if (
    !CLICKUP_API_TOKEN ||
    !CLICKUP_LIST_ID ||
    CLICKUP_API_TOKEN.includes("YOUR_CLICKUP") ||
    CLICKUP_LIST_ID.includes("YOUR_CLICKUP")
  ) {
    console.log("[ClickUp] Notice: ClickUp token not set. Simulating Task creation locally.");
    return {
      simulated: true,
      id: `sim_task_${Date.now()}`,
      name: taskTitle,
      description: markdownDescription,
      url: `https://app.clickup.com/t/sim_${Date.now()}`,
    };
  }

  try {
    const payload = {
      name: taskTitle,
      description: markdownDescription,
      status: "CONNECTED",
      priority: 3,
      tags: ["vobiz-call", direction.toLowerCase(), "cdr"],
    };

    const res = await fetch(`${CLICKUP_API_URL}/list/${CLICKUP_LIST_ID}/task`, {
      method: "POST",
      headers: getClickUpHeaders(),
      body: JSON.stringify(payload),
    });

    const resText = await res.text();
    let json;
    try {
      json = JSON.parse(resText);
    } catch {
      json = { raw: resText };
    }

    if (!res.ok) {
      console.error(`[ClickUp] API error (${res.status}):`, resText);
      return { error: resText, status: res.status };
    }

    console.log(`[ClickUp] ✅ Task created successfully! ID: ${json.id}, URL: ${json.url}`);
    return json;
  } catch (err) {
    console.error("[ClickUp] Network error creating task:", err.message);
    return { error: err.message };
  }
}

/**
 * Resolve a recording ID to its media URL through the Vobiz API and stream it.
 *
 * The account credentials go out on these requests, so the destination is never
 * allowed to come from a caller: it is resolved server-side and checked against
 * the host allowlist, and every redirect is re-checked before it is followed.
 * A presigned object-storage URL carries its own authorisation, so ours is
 * dropped on the way.
 */
async function streamRecordingById(recordingId, res) {
  if (!VOBIZ_AUTH_ID || !VOBIZ_AUTH_TOKEN || VOBIZ_AUTH_ID.includes("YOUR_")) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Vobiz credentials are not configured on this server" }));
    return;
  }
  const authHeaders = {
    "X-Auth-ID": VOBIZ_AUTH_ID,
    "X-Auth-Token": VOBIZ_AUTH_TOKEN,
    Accept: "application/json",
  };

  try {
    const metaRes = await fetch(
      `${VOBIZ_API_URL}/api/v1/Account/${VOBIZ_AUTH_ID}/Recording/${encodeURIComponent(recordingId)}/`,
      { headers: authHeaders }
    );
    if (!metaRes.ok) {
      res.writeHead(metaRes.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Vobiz returned ${metaRes.status} for that recording` }));
      return;
    }
    const meta = await metaRes.json().catch(() => ({}));
    const mediaUrl = meta.recording_url || meta.url || meta.file;
    if (!mediaUrl) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No audio is available for that recording yet" }));
      return;
    }
    if (!isAllowedMediaHost(mediaUrl)) {
      console.error(`[/recording-audio] refusing off-allowlist media host: ${mediaUrl}`);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Recording is hosted somewhere this server will not fetch from" }));
      return;
    }

    let mediaRes = await fetch(mediaUrl, { headers: authHeaders, redirect: "manual" });
    let hops = 0;
    while (mediaRes.status >= 300 && mediaRes.status < 400 && hops < 3) {
      const location = mediaRes.headers.get("location");
      if (!location) break;
      const next = new URL(location, mediaUrl).toString();
      if (!isAllowedMediaHost(next)) {
        console.error(`[/recording-audio] refusing redirect to ${next}`);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Recording redirected somewhere this server will not follow" }));
        return;
      }
      mediaRes = await fetch(next, { redirect: "manual" });
      hops++;
    }

    if (!mediaRes.ok) {
      res.writeHead(mediaRes.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Media server returned ${mediaRes.status}` }));
      return;
    }

    const headersOut = {
      "Content-Type": mediaRes.headers.get("content-type") || "audio/mpeg",
      "Accept-Ranges": "bytes",
    };
    const len = mediaRes.headers.get("content-length");
    if (len) headersOut["Content-Length"] = len;
    res.writeHead(200, headersOut);
    res.end(Buffer.from(await mediaRes.arrayBuffer()));
  } catch (err) {
    console.error("[/recording-audio] error:", err.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Could not stream that recording" }));
  }
}

// ─── HTTP Server & Route Handlers ───────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  withCors(res, req);
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  if (method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  console.log(`[backend] ${method} ${pathname}`);

  // 1. Health & Status
  if (pathname === "/health" || pathname === "/status") {
    const publicBaseUrl = getPublicBaseUrl(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        // Health is unauthenticated, so it reports whether things are
        // configured, never what they are — publishing the account Auth ID or
        // the SIP username here would hand them to anyone who asks.
        status: "ok",
        service: "vobiz-clickup-calling",
        publicBaseUrl,
        vobizConfigured: !!(VOBIZ_AUTH_ID && VOBIZ_AUTH_TOKEN && !VOBIZ_AUTH_ID.includes("YOUR_")),
        sipConfigured: !!(VOBIZ_SIP_USER && VOBIZ_SIP_PASSWORD),
        vobizRegistrar: VOBIZ_REGISTRAR,
        clickUpConfigured: !!(CLICKUP_API_TOKEN && !CLICKUP_API_TOKEN.includes("YOUR_CLICKUP")),
        activeCallsCount: callsByUuid.size,
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }

  // 1b. List Account Phone Numbers (All purchased account DIDs)
  if (pathname === "/api/numbers" && method === "GET") {
    if (!requireSession(req, res)) return;
    if (cachedAccountNumbers.length === 0) {
      await refreshAccountNumbers();
    }
    const nums = cachedAccountNumbers.length > 0 ? cachedAccountNumbers : (VOBIZ_FROM_NUMBER ? [VOBIZ_FROM_NUMBER] : []);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, numbers: nums, selected: VOBIZ_FROM_NUMBER || nums[0] }));
    return;
  }

  // 2. Dual Login: Mode 1 - Vobiz Account Login (Auth ID & Auth Token)
  if (pathname === "/login" && method === "POST") {
    try {
      const body = await readJsonBody(req);
      const { agentId = "admin", authId, authToken } = body;
      if (!authId || !authToken) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "authId and authToken are required" }));
        return;
      }

      let numbers = [];
      const authHeaders = {
        "X-Auth-ID": authId,
        "X-Auth-Token": authToken,
        "Content-Type": "application/json",
        Accept: "application/json",
      };

      // Credentials are proven, not assumed.
      //
      // The numbers lookup below is not proof: it is allowed to fail, and a
      // sign-in that treated it as validation would admit anyone who typed
      // anything.
      let isValid = false;
      if (VOBIZ_AUTH_ID && authId === VOBIZ_AUTH_ID && authToken === VOBIZ_AUTH_TOKEN) {
        isValid = true;
      } else {
        try {
          // 405 means the resource exists and rejected the verb, which still
          // proves the credentials were accepted.
          const check = await fetch(`${VOBIZ_API_URL}/api/v1/Account/${encodeURIComponent(authId)}/`, {
            headers: authHeaders,
          });
          isValid = check.ok || check.status === 405;
          if (!isValid) console.log(`[backend] Vobiz rejected ${authId}: HTTP ${check.status}`);
        } catch (e) {
          console.error("[backend] Could not reach Vobiz to validate credentials:", e.message);
          isValid = false;
        }
      }

      if (!isValid) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid Vobiz Auth ID or Auth Token." }));
        return;
      }

      try {
        const numRes = await fetch(`${VOBIZ_API_URL}/api/v1/Account/${encodeURIComponent(authId)}/numbers`, {
          headers: authHeaders,
        });
        if (numRes.ok) {
          const numJson = await numRes.json();
          const items = numJson.objects || numJson.items || [];
          numbers = items.map((n) => n.e164 || n.number || n.phone_number).filter(Boolean);
        }
      } catch (e) {
        console.warn("[backend] Numbers lookup notice:", e.message);
      }

      if (numbers.length === 0 && VOBIZ_FROM_NUMBER) {
        numbers.push(VOBIZ_FROM_NUMBER);
      }

      const selected = numbers[0] || VOBIZ_FROM_NUMBER;

      // Auto-discover endpoints from Vobiz API using the provided Auth credentials
      let sipUser = VOBIZ_SIP_USER || agentId;
      // No hardcoded fallback password. A published default password is a
      // published password, and it was committed in this file.
      let sipPassword = VOBIZ_SIP_PASSWORD || "";
      let sipAvailable = false;

      try {
        const endRes = await fetch(`${VOBIZ_API_URL}/api/v1/Account/${encodeURIComponent(authId)}/Endpoint/`, {
          headers: authHeaders,
        });
        if (endRes.ok) {
          const endJson = await endRes.json();
          const endpoints = endJson.objects || endJson.items || [];
          if (endpoints.length > 0) {
            sipUser = endpoints[0].username || endpoints[0].sip_username || sipUser;
            sipAvailable = true;
            console.log(`[backend] Auto-discovered Vobiz SIP endpoint '${sipUser}' for ${authId}`);
          }
        }
      } catch (e) {
        console.warn("[backend] Endpoint discovery notice:", e.message);
      }

      const token = newSession(agentId, authId, authToken, numbers, selected);
      const sessionObj = sessions.get(token);
      if (sessionObj) {
        sessionObj.sipUser = sipUser;
        sessionObj.sipPassword = sipPassword;
      }

      const cleanUser = String(sipUser).replace(/^sip:/, "").split("@")[0];
      fromBySipUser.set(cleanUser, selected);

      console.log(`[backend] Account login ok for agent '${agentId}' (${authId}). Numbers: ${numbers.length}`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          success: true,
          token,
          numbers,
          selected,
          authId,
          agentId,
          sipAvailable,
        })
      );
    } catch (err) {
      console.error("[backend] Login error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 2b. Dual Login: Mode 2 - SIP Direct Registration Endpoint
  if (pathname === "/login-sip" && method === "POST") {
    try {
      const body = await readJsonBody(req);
      const { sipUser, callerId } = body;
      if (!sipUser || !callerId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "sipUser and callerId are required" }));
        return;
      }
      const cleanUser = String(sipUser).replace(/^sip:/, "").split("@")[0];

      // The caller ID is what the customer's handset displays and what the
      // carrier bills against. Accepting an arbitrary string here let anyone
      // who could reach the tunnel set the number this account dials out as.
      if (cachedAccountNumbers.length === 0) await refreshAccountNumbers();
      const owned = [...cachedAccountNumbers];
      if (VOBIZ_FROM_NUMBER) owned.push(VOBIZ_FROM_NUMBER);
      const wanted = toE164(callerId);
      if (owned.length > 0 && !owned.some((n) => toE164(n) === wanted)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: `${callerId} is not a number on this Vobiz account, so it cannot be a caller ID.` })
        );
        return;
      }

      fromBySipUser.set(cleanUser, callerId);

      // A session scoped to SIP-direct mode. It carries no account credentials,
      // and /api/agent-sip refuses it: an agent signing in this way already
      // holds their own SIP password, and serving the account's password to
      // anyone who can name an endpoint would be the /agent hole by another door.
      const token = newSession(cleanUser, null, null, [callerId], callerId);
      sessions.get(token).mode = "sip";

      console.log(`[backend] SIP direct caller ID registered: ${cleanUser} -> ${callerId}`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, success: true, token, sipUser: cleanUser, callerId }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 2c. Session Query Endpoint
  // The bearer token is the only thing that identifies a session.
  //
  // Two shapes to avoid here: answering /session/<agentId> from any live
  // session whose agent id matches, and answering a request with no session at
  // all as `loggedIn: true` because the server happens to have credentials
  // configured. Either makes the whole panel unauthenticated. The path form is
  // kept so older widgets do not 404.
  if ((pathname === "/session" || pathname.startsWith("/session/")) && method === "GET") {
    const s = getSession(req);
    if (s) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          loggedIn: true,
          agentId: s.agentId,
          authId: s.authId,
          numbers: s.numbers,
          from: s.from,
        })
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ loggedIn: false }));
    return;
  }

  // 2d. Logout Endpoint
  if (pathname === "/logout" && method === "POST") {
    const header = (req.headers && req.headers.authorization) || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (token) sessions.delete(token);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, success: true }));
    return;
  }

  // 2e. Select Outgoing Caller ID
  if (pathname === "/select-number" && method === "POST") {
    if (!requireSession(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const { number, agentId = "admin" } = body;
      const s = getSession(req);
      if (s) {
        s.from = number;
      }
      const cleanUser = String(VOBIZ_SIP_USER || agentId).replace(/^sip:/, "").split("@")[0];
      fromBySipUser.set(cleanUser, number);

      console.log(`[backend] Outbound Caller ID updated to ${number} for ${cleanUser}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, selected: number }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 2f. SIP Credentials for Softphone Registration
  // SIP credentials for the softphone to register with.
  //
  // Behind the session deliberately: SIP credentials let anyone place calls
  // billed to this account. An unknown agent id is refused rather than filled in
  // with a default, and there is no hardcoded fallback password — a default
  // password in a published file is a published password.
  if ((pathname === "/api/agent-sip" || pathname === "/agent" || pathname.startsWith("/agent/")) && method === "GET") {
    const s = getSession(req);
    if (!s) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Sign in first" }));
      return;
    }
    if (s.mode === "sip") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "SIP-direct sessions register with the password the agent supplied, not this one." })
      );
      return;
    }
    const agentObj = getAgent(s.agentId || "admin");
    const effectiveSipUser = s.sipUser || VOBIZ_SIP_USER || agentObj.sipUser;
    const effectivePassword = s.sipPassword || VOBIZ_SIP_PASSWORD || "";
    if (!effectiveSipUser || !effectivePassword) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "VOBIZ_SIP_USER / VOBIZ_SIP_PASSWORD are not configured on this server" }));
      return;
    }
    const sipUserClean = effectiveSipUser.includes("@") ? effectiveSipUser : `${effectiveSipUser}@${VOBIZ_REGISTRAR}`;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        displayName: agentObj.name || s.agentId,
        sipUser: sipUserClean,
        sipPassword: effectivePassword,
        registrarUrl: `wss://${VOBIZ_REGISTRAR}:5063/`,
      })
    );
    return;
  }

  // 2g. List Agents
  if (pathname === "/api/agents" && method === "GET") {
    if (!requireSession(req, res)) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getAllAgents()));
    return;
  }

  // 2h. Start API Call Session (Triggers real Vobiz Outbound Call API to dial the destination phone)
  if (pathname === "/api/calls/start" && method === "POST") {
    if (!requireSession(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const s = getSession(req);
      const agentId = body.agentId || (s ? s.agentId : "admin");
      const from = body.from || (s ? s.from : VOBIZ_FROM_NUMBER);
      const to = body.to || "";
      const direction = body.direction || "Outbound";
      const publicBaseUrl = getPublicBaseUrl(req);
      let callUuid = `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      // Credentials come from the session or the server's own config, never
      // from the request body: reading them from the body let an unauthenticated
      // caller place calls billed to this account, and steered whose they were.
      const authId = (s && s.authId) || VOBIZ_AUTH_ID;
      const authToken = (s && s.authToken) || VOBIZ_AUTH_TOKEN;

      let vobizCallResult = null;

      if (authId && authToken && !authId.includes("YOUR_") && to) {
        try {
          const vobizCallUrl = `${VOBIZ_API_URL}/api/v1/Account/${encodeURIComponent(authId)}/Call/`;
          const callPayload = {
            from: from,
            to: to,
            answer_url: `${publicBaseUrl}/answer`,
            answer_method: "POST",
            hangup_url: `${publicBaseUrl}/dial-status`,
            hangup_method: "POST",
          };

          console.log(`[backend] 📞 Placing real Outbound call from ${from} to ${to} via Vobiz API...`);

          const callRes = await fetch(vobizCallUrl, {
            method: "POST",
            headers: {
              "X-Auth-ID": authId,
              "X-Auth-Token": authToken,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(callPayload),
          });

          const resText = await callRes.text();
          try {
            vobizCallResult = JSON.parse(resText);
          } catch (_) {
            vobizCallResult = { message: resText };
          }

          console.log(`[backend] Vobiz Call API response [${callRes.status}]:`, vobizCallResult);

          if (vobizCallResult.request_uuid || vobizCallResult.call_uuid) {
            callUuid = vobizCallResult.request_uuid || vobizCallResult.call_uuid;
          }
        } catch (apiErr) {
          console.error("[backend] Vobiz Outbound Call API error:", apiErr.message);
        }
      }

      const record = {
        callUuid,
        direction,
        agentSipUser: agentId,
        from,
        to,
        startedAt: Date.now(),
        vobizResponse: vobizCallResult,
      };
      rememberCall(record);
      console.log(`[backend] 📞 Registered ${direction} API call session: ${callUuid} (from ${from} to ${to})`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          success: true,
          callUuid,
          record,
          vobizResponse: vobizCallResult,
        })
      );
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 2i. End API Call Session and sync task to ClickUp
  if (pathname === "/api/calls/end" && method === "POST") {
    if (!requireSession(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const s = getSession(req);
      const callUuid = body.callUuid || `call_${Date.now()}`;
      const durationSeconds = Number(body.durationSeconds || 0);
      const agentId = body.agentId || (s ? s.agentId : "admin");
      const direction = body.direction || "Outbound";
      const from = body.from || (s ? s.from : VOBIZ_FROM_NUMBER);
      const to = body.to || "";
      const hangupCause = body.hangupCause || "NORMAL_CLEARING";

      let rec = callsByUuid.get(callUuid);
      if (!rec) {
        rec = {
          callUuid,
          direction,
          agentSipUser: agentId,
          from,
          to,
          startedAt: Date.now() - durationSeconds * 1000,
        };
      }
      rec.duration = durationSeconds;
      rec.endedAt = Date.now();
      rec.hangupCause = hangupCause;
      rec.dialStatus = "completed";
      rememberCall(rec);

      console.log(`[backend] 📴 Ended API call session: ${callUuid} (${durationSeconds}s). Syncing ClickUp CDR...`);

      const task = await createClickUpCallTask(
        {
          callUuid: rec.callUuid,
          direction: rec.direction,
          from: rec.from,
          to: rec.to,
          agentId: rec.agentSipUser,
          durationSeconds: rec.duration,
          recordingUrl: rec.recordingUrl || "",
          recordingId: rec.recordingId || "",
          hangupCause: rec.hangupCause,
          status: "COMPLETE",
        },
        getPublicBaseUrl(req)
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, success: true, task, record: rec }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 3. THE BROWSER-AS-A-LEG ANSWER CALLBACK: GET/POST /answer, /fallback, /inbound-answer
  if (
    (pathname === "/answer" || pathname === "/fallback" || pathname === "/inbound-answer") &&
    (method === "GET" || method === "POST")
  ) {
    try {
      const body = method === "POST" ? await readJsonBody(req) : {};
      const params = { ...parsedUrl.query, ...body };

      const callUuid = String(params.CallUUID || params.call_uuid || `call_${Date.now()}`);
      const from = String(params.From || params.from || "");
      const to = String(params.To || params.to || "");
      const routeType = String(params.RouteType || params.routetype || "").toLowerCase();

      // Browser is the A leg when 'from' is a sip: URI or routeType is sip
      const fromBrowser = from.startsWith("sip:") || routeType === "sip";

      const publicBaseUrl = getPublicBaseUrl(req);
      const dialStatusUrl = `${publicBaseUrl}/dial-status`;
      const recordCallbackUrl = `${publicBaseUrl}/recording-ready`;

      const recordXml = `<Record fileFormat="mp3" recordSession="true" maxLength="3600" playBeep="false" redirect="false" callbackUrl="${recordCallbackUrl}" callbackMethod="POST"/>`;

      if (fromBrowser) {
        // OUTBOUND CALL from agent browser to customer PSTN
        const sipUser = (from.match(/^sip:([^@]+)@/) || [])[1] || VOBIZ_SIP_USER || "admin";
        const sipHeaderCallerId =
          params["SIPHeader_X-VH-Caller-ID"] ||
          params["SIPHeader_X-PH-Caller-ID"] ||
          params["X-VH-Caller-ID"] ||
          params["X-PH-Caller-ID"] ||
          params.CallerID ||
          params.caller_id;

        const callerId = sipHeaderCallerId || fromBySipUser.get(sipUser) || VOBIZ_FROM_NUMBER;
        const destination = to.replace(/[^\d+]/g, "");

        rememberCall({
          callUuid,
          direction: "Outbound",
          agentSipUser: sipUser,
          from: callerId,
          to: destination,
          startedAt: Date.now(),
        });

        console.log(`[backend] 📞 Browser A-leg: Outbound call to ${destination} via callerId ${callerId}`);

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${recordXml}
  <Dial callerId="${callerId}" timeout="30" timeLimit="14400" action="${dialStatusUrl}" method="POST" redirect="false">
    <Number>${destination}</Number>
  </Dial>
</Response>`;

        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end(xml);
        return;
      }

      // INBOUND CALL from customer PSTN to account DID -> bridge to agent SIP softphone
      const callerId = toE164(to) || VOBIZ_FROM_NUMBER;
      let targetSipUser = VOBIZ_SIP_USER || "admin";
      for (const s of sessions.values()) {
        if (s.sipUser) {
          targetSipUser = s.sipUser.split("@")[0].replace(/^sip:/, "");
          break;
        }
      }

      rememberCall({
        callUuid,
        direction: "Inbound",
        agentSipUser: targetSipUser,
        from,
        to: callerId,
        startedAt: Date.now(),
      });

      console.log(`[backend] 🔔 Call answered: ${from} to ${callerId} -> greeting & bridging to sip:${targetSipUser}@${VOBIZ_REGISTRAR}`);

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${recordXml}
  <Dial callerId="${callerId}" timeout="20" action="${dialStatusUrl}" method="POST" redirect="false">
    <User>sip:${targetSipUser}@${VOBIZ_REGISTRAR}</User>
  </Dial>
  <Speak voice="Polly.Aditi" language="en-IN">The ClickUp softphone agent is currently offline. Your call has been recorded and logged to ClickUp. Goodbye!</Speak>
</Response>`;

      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(xml);
      return;
    } catch (err) {
      console.error("[backend] Error in /answer:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(err.message);
    }
    return;
  }

  // 4. Dial Status Webhook: GET/POST /dial-status
  if (pathname === "/dial-status" && (method === "GET" || method === "POST")) {
    try {
      const body = method === "POST" ? await readJsonBody(req) : {};
      const d = { ...parsedUrl.query, ...body };
      const callUuid = String(d.CallUUID || d.call_uuid || "");
      const bleg = d.DialBLegUUID || "";
      const dialStatus = d.DialStatus || "";
      const duration = Number(d.DialBLegDuration || d.duration || 0);

      console.log(`[backend] DIAL STATUS: call=${callUuid} status=${dialStatus} bleg=${bleg} dur=${duration}s`);

      let rec = callsByUuid.get(callUuid);
      if (rec) {
        rec.dialStatus = dialStatus;
        rec.hangupCause = d.DialHangupCause || "NORMAL_CLEARING";
        rec.bLegUuid = bleg || null;
        rec.duration = duration;
        rec.endedAt = Date.now();

        // Create / update ClickUp task
        await createClickUpCallTask(
          {
            callUuid,
            direction: rec.direction || "Outbound",
            from: rec.from,
            to: rec.to,
            agentId: rec.agentSipUser || "admin",
            durationSeconds: duration,
            recordingUrl: rec.recordingUrl || "",
            recordingId: rec.recordingId || "",
            hangupCause: rec.hangupCause,
            status: dialStatus === "answered" || dialStatus === "completed" ? "COMPLETE" : dialStatus,
          },
          getPublicBaseUrl(req)
        );
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error("[backend] Error in /dial-status:", err);
      res.writeHead(200);
      res.end();
    }
    return;
  }

  // 5. Recording Webhook: POST /recording-ready or POST /recording-callback
  if (
    (pathname === "/recording-ready" || pathname === "/recording-callback") &&
    (method === "GET" || method === "POST")
  ) {
    try {
      const body = method === "POST" ? await readJsonBody(req) : {};
      const d = { ...parsedUrl.query, ...body };
      const callUuid = String(d.CallUUID || d.call_uuid || "");
      const recordingId = d.RecordingID || d.RecordingId || d.recording_id || null;
      const recordUrl = d.RecordUrl || d.record_url || d.recording_url || d.RecordFile || "";
      const recordingDuration = Number(d.RecordingDuration || d.duration || 0);

      console.log(`[backend] 🎧 RECORDING READY: call=${callUuid} id=${recordingId} url=${recordUrl}`);

      let rec = callsByUuid.get(callUuid) || {
        callUuid,
        direction: d.Direction || "Outbound",
        from: d.From || VOBIZ_FROM_NUMBER,
        to: d.To || "",
        agentSipUser: "admin",
      };

      rec.recordingId = recordingId;
      rec.recordingUrl = recordUrl;
      rec.recordingDuration = recordingDuration;
      callRecordings.set(callUuid, rec);

      const publicBaseUrl = getPublicBaseUrl(req);

      // Create or update ClickUp call task with recording link
      const clickUpResult = await createClickUpCallTask(
        {
          callUuid,
          direction: rec.direction,
          from: rec.from,
          to: rec.to,
          agentId: rec.agentSipUser,
          durationSeconds: recordingDuration || rec.duration || 30,
          recordingUrl: recordUrl,
          recordingId: recordingId,
          hangupCause: rec.hangupCause || "NORMAL_CLEARING",
        },
        publicBaseUrl
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, clickUpResult }));
    } catch (err) {
      console.error("[backend] Error in recording webhook:", err);
      res.writeHead(200);
      res.end();
    }
    return;
  }

  // 6. Hangup Callback: POST /hangup-callback or POST /cdr-callback
  if ((pathname === "/hangup-callback" || pathname === "/cdr-callback") && method === "POST") {
    try {
      const body = await readJsonBody(req);
      const callUuid = String(body.CallUUID || body.call_uuid || "");
      const duration = parseInt(body.Duration || body.duration || 0, 10);
      const hangupCause = body.HangupCause || body.hangup_cause || "NORMAL_CLEARING";

      if (callUuid && callsByUuid.has(callUuid)) {
        const callInfo = callsByUuid.get(callUuid);
        callInfo.duration = duration;
        callInfo.hangupCause = hangupCause;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "success" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 7. Recordings List Endpoint: GET /recordings or GET /api/recordings
  if ((pathname === "/recordings" || pathname === "/api/recordings") && method === "GET") {
    if (!requireSession(req, res)) return;
    try {
      const publicBaseUrl = getPublicBaseUrl(req);
      const limit = Math.min(Number(parsedUrl.query.limit || 15), 50);
      let recordings = [];

      if (VOBIZ_AUTH_ID && VOBIZ_AUTH_TOKEN && !VOBIZ_AUTH_ID.includes("YOUR_")) {
        try {
          const r = await fetch(`${VOBIZ_API_URL}/api/v1/Account/${VOBIZ_AUTH_ID}/Recording/?limit=${limit}`, {
            headers: {
              "X-Auth-ID": VOBIZ_AUTH_ID,
              "X-Auth-Token": VOBIZ_AUTH_TOKEN,
              Accept: "application/json",
            },
          });
          if (r.ok) {
            const data = await r.json();
            const objects = data.objects || data.items || [];
            recordings = objects.map((o) => ({
              recording_id: o.recording_id,
              add_time: o.add_time,
              rounded_recording_duration: o.rounded_recording_duration,
              call_uuid: o.call_uuid,
              playUrl: signRecordingUrl(o.recording_id, publicBaseUrl),
            }));
          }
        } catch (e) {
          console.warn("[/recordings] Vobiz fetch error:", e.message);
        }
      }

      if (recordings.length === 0 && (callRecordings.size > 0 || recentCalls.length > 0)) {
        const pool = callRecordings.size > 0 ? Array.from(callRecordings.values()) : recentCalls;
        recordings = pool.slice(0, limit).map((c) => ({
          recording_id: c.recordingId || c.callUuid,
          add_time: new Date(c.startedAt || Date.now()).toLocaleTimeString(),
          rounded_recording_duration: c.duration || c.recordingDuration || 35,
          call_uuid: c.callUuid,
          playUrl: c.recordingId ? signRecordingUrl(c.recordingId, publicBaseUrl) : "",
        }));
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ recordings, objects: recordings }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ recordings: [], error: err.message }));
    }
    return;
  }

  // 8. Play Recording Endpoint: GET /play-recording?callUuid=...
  if (pathname === "/play-recording" && method === "GET") {
    const callUuid = parsedUrl.query.callUuid;
    const publicBaseUrl = getPublicBaseUrl(req);
    const rec = callUuid ? callRecordings.get(callUuid) || callsByUuid.get(callUuid) : null;
    if (rec && rec.recordingId) {
      res.writeHead(302, { Location: signRecordingUrl(rec.recordingId, publicBaseUrl) });
      res.end();
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Recording not found for call" }));
    return;
  }

  // 9. HMAC Signed Recording Audio Stream: GET /recording-audio/:recordingId
  if (pathname.startsWith("/recording-audio/") && method === "GET") {
    const recordingId = decodeURIComponent(pathname.slice("/recording-audio/".length));
    const { exp, sig } = parsedUrl.query;
    if (!verifyRecordingSignature(recordingId, exp, sig) && !getSession(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or expired playback signature" }));
      return;
    }
    await streamRecordingById(recordingId, res);
    return;
  }

  // 10. GET /recording-file?url=… is deliberately not implemented, and says so.
  //
  // Fetching a caller-supplied URL with the account's Vobiz credentials
  // attached is a credential-exfiltration primitive, not merely SSRF: it
  // delivers X-Auth-ID and X-Auth-Token to whatever host the caller names.
  // Stripping the headers on redirects is no defence — the first request
  // already carried them wherever it was told to go.
  //
  // Playback goes through the signed /recording-audio/<recordingId> above,
  // which takes an id, resolves the media URL server-side, and refuses any host
  // off the allowlist, on the first request and again after each redirect.
  if (pathname === "/recording-file" && method === "GET") {
    res.writeHead(410, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "This endpoint has been removed. Use the signed /recording-audio/<recordingId> link instead.",
      })
    );
    return;
  }

  // 11. ClickUp Task Search Endpoint: GET /api/clickup/search-task?phone=...
  if (pathname === "/api/clickup/search-task" && method === "GET") {
    if (!requireSession(req, res)) return;
    const phone = parsedUrl.query.phone || "";
    try {
      const task = await searchClickUpTaskByPhone(phone);
      if (task) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            found: true,
            task: {
              id: task.id,
              name: task.name,
              status: task.status,
              url: task.url,
              assignee: task.assignees && task.assignees[0] ? task.assignees[0].username : "",
            },
          })
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ found: false, listId: CLICKUP_LIST_ID }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ found: false, error: err.message }));
    }
    return;
  }

  // 12. Live CDR Sync Endpoint: GET/POST /sync-recent-cdrs
  if (pathname === "/sync-recent-cdrs" && (method === "GET" || method === "POST")) {
    if (!requireSession(req, res)) return;
    console.log(`[backend] Fetching live CDRs & recordings from Vobiz API for account ${VOBIZ_AUTH_ID}...`);
    const publicBaseUrl = getPublicBaseUrl(req);

    if (!VOBIZ_AUTH_ID || !VOBIZ_AUTH_TOKEN || VOBIZ_AUTH_ID.includes("YOUR_")) {
      // Simulate CDR sync if not configured
      const mockCdrTask = await createClickUpCallTask(
        {
          callUuid: `cdr_sync_${Date.now()}`,
          direction: "Outbound",
          from: VOBIZ_FROM_NUMBER,
          to: "+15550199999",
          agentId: "admin",
          durationSeconds: 48,
          recordingUrl: "sample",
          hangupCause: "NORMAL_CLEARING",
        },
        publicBaseUrl
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "success",
          totalFetched: 1,
          syncedTasks: [{ uuid: `cdr_sync_${Date.now()}`, clickUpTask: mockCdrTask }],
        })
      );
      return;
    }

    try {
      const headers = { "X-Auth-ID": VOBIZ_AUTH_ID, "X-Auth-Token": VOBIZ_AUTH_TOKEN };
      const cdrRes = await fetch(`${VOBIZ_API_URL}/api/v1/Account/${VOBIZ_AUTH_ID}/cdr/recent?limit=5`, { headers });
      const cdrJson = await cdrRes.json();
      const cdrs = cdrRes.ok && cdrJson.data ? cdrJson.data : [];

      const syncResults = [];
      for (const cdr of cdrs) {
        const task = await createClickUpCallTask(
          {
            callUuid: cdr.uuid,
            direction: cdr.call_direction || "Outbound",
            from: cdr.caller_id_number || VOBIZ_FROM_NUMBER,
            to: cdr.destination_number || "",
            agentId: "admin",
            durationSeconds: parseInt(cdr.duration || 0, 10),
            recordingUrl: "",
            hangupCause: cdr.hangup_cause || "NORMAL_CLEARING",
          },
          publicBaseUrl
        );
        syncResults.push({ uuid: cdr.uuid, clickUpTask: task });
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "success", totalFetched: cdrs.length, syncedTasks: syncResults }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 13. Simulated Call Test Endpoint: POST /test-simulated-call
  if (pathname === "/test-simulated-call" && method === "POST") {
    if (!requireSession(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const direction = body.direction || "outbound";
      const from = body.from || VOBIZ_FROM_NUMBER;
      const to = body.to || "+15550199999";
      const durationSeconds = parseInt(body.duration || body.Duration || 45, 10);
      const agentId = body.agentId || "admin";
      const callUuid = body.callUuid || `sim_${Date.now()}`;
      const recordingUrl = body.recordingUrl || "";
      const publicBaseUrl = getPublicBaseUrl(req);

      const clickUpTask = await createClickUpCallTask(
        {
          callUuid,
          direction,
          from,
          to,
          agentId,
          durationSeconds,
          recordingUrl,
          hangupCause: body.hangupCause || "NORMAL_CLEARING",
        },
        publicBaseUrl
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "success",
          message: `Simulated ${direction} call logged to ClickUp`,
          callUuid,
          clickUpTask,
        })
      );
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 14. Static File Serving for Softphone UI
  let subPath = pathname;
  if (subPath.startsWith("/clickup-app")) {
    subPath = subPath.replace(/^\/clickup-app\/?/, "");
  }
  if (!subPath || subPath === "/" || subPath === "/index.html") {
    subPath = "index.html";
  }

  // Serve only from inside clickup-app/.
  //
  // `url.parse` does not normalise dot segments, so a path like
  // `/../backend/.env` arrives here intact and path.join would walk straight
  // out of the static directory — over a tunnel, that is every credential this
  // integration holds. Resolve first, then require the result to still be
  // inside the static root.
  const staticBase = path.resolve(__dirname, "..", "clickup-app");
  const filePath = path.resolve(staticBase, "." + path.posix.normalize("/" + subPath));

  if (filePath !== staticBase && !filePath.startsWith(staticBase + path.sep)) {
    console.warn(`[backend] refusing path traversal: ${pathname}`);
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".ico": "image/x-icon",
    };
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "text/plain" });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // 404 Fallback
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: `Not found: ${pathname}` }));
});

server.listen(PORT, () => {
  const publicBaseUrl = getPublicBaseUrl();
  console.log(`\n==================================================`);
  console.log(`🚀 Vobiz ClickUp Integration Server Active!`);
  console.log(`--------------------------------------------------`);
  console.log(`Local URL:             http://localhost:${PORT}`);
  console.log(`Public Base:           ${publicBaseUrl}`);
  console.log(`Softphone UI:          http://localhost:${PORT}/clickup-app/index.html`);
  console.log(`Vobiz SIP User:        ${VOBIZ_SIP_USER}@${VOBIZ_REGISTRAR}`);
  console.log(`ClickUp List ID:       ${CLICKUP_LIST_ID || "Not set"}`);
  console.log(`==================================================\n`);
});
