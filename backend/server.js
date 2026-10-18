/** === Vobiz Calling Backend for ClickUp CRM ===
 *
 * THE BROWSER IS THE A LEG.
 * The softphone sends the SIP INVITE itself via WebRTC (JsSIP),
 * and this backend answers with <Dial><Number> to bridge to the customer.
 * Inbound calls to a signed-in account's DIDs are bridged via <Dial><User> to
 * that account's registered agent softphones.
 *
 * ANY VOBIZ ACCOUNT CAN SIGN IN.
 * Nothing account-specific lives in the environment. An agent types their own
 * Auth ID and Auth Token into the panel; this backend checks the pair against
 * Vobiz, then, in that account:
 *   - finds or creates this integration's Application (matched on answer_url);
 *   - finds or creates one SIP endpoint per (account, agent), sets a fresh SIP
 *     password for this sign-in, and binds the endpoint to the application.
 * The Auth Token is held in memory only, keyed by Auth ID. It is never written
 * to disk, never logged and never returned to the browser.
 *
 * All completed calls, durations, and call recordings are synced to ClickUp tasks.
 */

const http = require("http");
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

// Deployment configuration only. No Vobiz account, number or endpoint is
// configured here: those come from whoever signs in.
const PORT = Number(cleanEnvVar(process.env.PORT) || 8092);
const VOBIZ_API_URL = (cleanEnvVar(process.env.VOBIZ_API_URL) || "https://api.vobiz.ai").replace(/\/+$/, "");
const VOBIZ_REGISTRAR = cleanEnvVar(process.env.VOBIZ_REGISTRAR) || "registrar.vobiz.ai";
// The softphone's WebSocket registrar. The browser is told this (and the SIP
// domain above) by /health, so the page never carries a registrar of its own.
const VOBIZ_REGISTRAR_WSS = `wss://${VOBIZ_REGISTRAR}:5063/`;
const DATA_DIR = path.resolve(cleanEnvVar(process.env.DATA_DIR) || path.join(__dirname, "data"));
const APP_NAME = "Vobiz ClickUp Calling";

const CLICKUP_API_TOKEN = cleanEnvVar(process.env.CLICKUP_API_TOKEN);
const CLICKUP_LIST_ID = cleanEnvVar(process.env.CLICKUP_LIST_ID);
const CLICKUP_API_URL = cleanEnvVar(process.env.CLICKUP_API_URL) || "https://api.clickup.com/api/v2";
const CLICKUP_TASK_STATUS = cleanEnvVar(process.env.CLICKUP_TASK_STATUS);

const SIGNING_SECRET = cleanEnvVar(process.env.SIGNING_SECRET) || crypto.randomBytes(32).toString("hex");
const RECORDING_URL_TTL_SECONDS = Number(cleanEnvVar(process.env.RECORDING_URL_TTL_SECONDS) || 900);

const TUNNEL_URL_FILE = path.join(__dirname, "tunnel-url.txt");

function getPublicBaseUrl(req) {
  const configured = cleanEnvVar(process.env.PUBLIC_BASE_URL) || cleanEnvVar(process.env.TUNNEL_URL);
  if (configured) return configured.replace(/\/+$/, "");
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

// Optional. Maps an agent ID to a display name and the ClickUp user that the
// agent's call tasks are assigned to. Without it, agents type any agent ID and
// tasks are left unassigned.
const AGENTS_FILE = path.resolve(cleanEnvVar(process.env.AGENTS_FILE) || path.join(__dirname, "agents.json"));

// An agent ID names the agent's SIP endpoint (its alias) and its entry in the
// endpoint map, so it is kept to characters the alias keeps.
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,30}$/;

function getAllAgents() {
  try {
    if (fs.existsSync(AGENTS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      console.error("[backend] agents.json is not an object of agent profiles; ignoring it");
    }
  } catch (err) {
    console.error("[backend] Error reading agents.json:", err.message);
  }
  return {};
}

/** Profiles the sign-in form may suggest: id and display name only. */
function listAgentProfiles() {
  return Object.entries(getAllAgents())
    .filter(([id, a]) => AGENT_ID_RE.test(id) && a && typeof a === "object")
    .map(([id, a]) => ({ id, name: typeof a.name === "string" ? a.name : "" }));
}

/** The ClickUp user id to assign this agent's call tasks to, or "". */
function clickUpAssigneeFor(agentId) {
  const id = String(getAgent(agentId).clickUpUserId || "").trim();
  return /^\d{1,15}$/.test(id) ? id : "";
}

/**
 * Agent display metadata (name, ClickUp user). agents.json carries no SIP
 * identity at all: each agent's endpoint is provisioned in the signed-in
 * account when they sign in.
 */
function getAgent(agentId) {
  const agents = getAllAgents();
  const found = agents[agentId];
  if (found) {
    const { name, clickUpUserId, clickUpEmail } = found;
    return { name, clickUpUserId, clickUpEmail };
  }
  return { name: agentId ? `Agent (${agentId})` : "ClickUp Agent", clickUpUserId: "", clickUpEmail: "" };
}

// ─── State Maps ─────────────────────────────────────────────────────────────
// authId -> { authToken, numbers, appId }. Memory only: the token never touches disk.
const accounts = new Map();
// sessionToken -> { agentId, authId, numbers, from, sipUser, sipPassword, createdAt }
const sessions = new Map();
// SIP username -> { authId, agentId, callerId }. How a webhook finds its account.
const sipUsers = new Map();
// callUuid -> callRecord
const callsByUuid = new Map();
// Completed call recordings
const callRecordings = new Map();
const recentCalls = [];

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

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

function xmlEscape(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Vobiz REST helpers ──────────────────────────────────────────────────────
//
// Vobiz ids (app_id in particular) are 17 digits, above
// Number.MAX_SAFE_INTEGER. JSON.parse would round an unquoted one, so long
// integer literals are quoted before parsing and every id stays a string end to
// end. Request bodies that must carry an id as an integer have it spliced into
// the JSON text after a /^\d+$/ check, never passed through Number().

function parseJsonKeepingBigInts(text) {
  const quoted = String(text || "").replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"');
  return JSON.parse(quoted);
}

function idString(v) {
  if (v == null) return "";
  if (typeof v === "object") return idString(v.app_id || v.id || "");
  return String(v);
}

function vobizHeaders(authId, authToken) {
  return {
    "X-Auth-ID": authId,
    "X-Auth-Token": authToken,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/** Call the Vobiz API for one account. Resolves { status, ok, text, json }. */
async function vobiz(authId, authToken, method, apiPath, rawBody) {
  const res = await fetch(`${VOBIZ_API_URL}/api/v1/Account/${encodeURIComponent(authId)}${apiPath}`, {
    method,
    headers: vobizHeaders(authId, authToken),
    ...(rawBody != null ? { body: rawBody } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? parseJsonKeepingBigInts(text) : null;
  } catch (_) {}
  return { status: res.status, ok: res.ok, text, json };
}

/**
 * Caller IDs an agent may pick: the account's numbers that are active and
 * voice-enabled, as { e164, applicationId }. applicationId is the app the
 * number is attached to now, so "Enable inbound calls" can say what it moves
 * the number away from.
 */
function parseNumberItems(json) {
  const items = (json && (json.items || json.objects)) || [];
  return items
    .filter((n) => n && n.status === "active" && n.voice_enabled !== false)
    .map((n) => ({ e164: toE164(n.e164), applicationId: idString(n.application_id) }))
    .filter((n) => n.e164);
}

/**
 * Verify the pair and load the account's numbers, every page of them.
 * Throws { status } when Vobiz refuses the credentials.
 */
async function loadAccountNumbers(authId, authToken) {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const r = await vobiz(authId, authToken, "GET", `/numbers?page=${page}&per_page=100`);
    if (!r.ok) {
      if (page === 1) {
        const err = new Error(`Vobiz refused these credentials (HTTP ${r.status})`);
        err.status = r.status;
        throw err;
      }
      console.warn(`[backend] ${authId}: numbers page ${page} failed (HTTP ${r.status}); using the first ${page - 1} page(s)`);
      break;
    }
    const raw = (r.json && (r.json.items || r.json.objects)) || [];
    all.push(...parseNumberItems(r.json));
    const total = Number(r.json && r.json.total);
    const seen = (page - 1) * 100 + raw.length;
    if (raw.length === 0 || raw.length < 100 || (Number.isFinite(total) && seen >= total)) break;
  }
  const seenE164 = new Set();
  return all.filter((n) => (seenE164.has(n.e164) ? false : seenE164.add(n.e164)));
}

// ─── Endpoint store ─────────────────────────────────────────────────────────
// `${authId}:${agentId}` -> { endpointId, username }. No passwords, no tokens.
const ENDPOINTS_FILE = path.join(DATA_DIR, "endpoints.json");

function readEndpointStore() {
  try {
    if (fs.existsSync(ENDPOINTS_FILE)) return JSON.parse(fs.readFileSync(ENDPOINTS_FILE, "utf8")) || {};
  } catch (err) {
    console.error("[backend] endpoints.json unreadable, starting empty:", err.message);
  }
  return {};
}

function writeEndpointStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(ENDPOINTS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(ENDPOINTS_FILE, 0o600);
  } catch (_) {}
}

// ─── Synced-call store ──────────────────────────────────────────────────────
// authId -> [callUuid, …]: calls that already have a ClickUp task, whether the
// live webhooks made it or "Sync CDRs" did. "Sync CDRs" skips these, so it can
// be pressed any number of times without duplicating tasks.
const SYNCED_FILE = path.join(DATA_DIR, "synced-calls.json");
const SYNCED_PER_ACCOUNT = 5000;

function readSyncedStore() {
  try {
    if (fs.existsSync(SYNCED_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SYNCED_FILE, "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch (err) {
    console.error("[backend] synced-calls.json unreadable, starting empty:", err.message);
  }
  return {};
}

function isCallSynced(authId, callUuid) {
  if (!authId || !callUuid) return false;
  const list = readSyncedStore()[authId];
  return Array.isArray(list) && list.includes(String(callUuid));
}

function markCallSynced(authId, callUuid) {
  if (!authId || !callUuid) return;
  const store = readSyncedStore();
  const list = Array.isArray(store[authId]) ? store[authId] : [];
  if (list.includes(String(callUuid))) return;
  list.push(String(callUuid));
  store[authId] = list.slice(-SYNCED_PER_ACCOUNT);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(SYNCED_FILE, JSON.stringify(store), { mode: 0o600 });
    fs.chmodSync(SYNCED_FILE, 0o600);
  } catch (err) {
    console.error("[backend] could not record a synced call:", err.message);
  }
}

/** A task that really exists in ClickUp (not simulated, not an error). */
function isRealTask(task) {
  return Boolean(task && task.id && !task.simulated && !task.error);
}

// ─── Per-sign-in provisioning ───────────────────────────────────────────────

/**
 * Find this integration's application in the account, or create it. Only an
 * application whose answer_url is exactly ours counts: an application this
 * integration did not create is never repointed.
 */
async function ensureApplication(authId, authToken, answerUrl, hangupUrl) {
  const acct = accounts.get(authId);
  if (acct && acct.appId && acct.answerUrl === answerUrl) return acct.appId;

  for (let offset = 0, page = 0; page < 20; page++, offset += 100) {
    const r = await vobiz(authId, authToken, "GET", `/Application/?limit=100&offset=${offset}`);
    if (!r.ok) throw new Error(`listing applications failed (HTTP ${r.status})`);
    const objects = (r.json && r.json.objects) || [];
    const mine = objects.find((a) => a && a.answer_url === answerUrl);
    if (mine && /^\d+$/.test(idString(mine.app_id))) {
      const appId = idString(mine.app_id);
      console.log(`[provision] ${authId}: using existing application ${appId}`);
      return appId;
    }
    if (objects.length < 100 || !(r.json.meta && r.json.meta.next)) break;
  }

  const body = JSON.stringify({
    app_name: APP_NAME,
    answer_url: answerUrl,
    answer_method: "POST",
    hangup_url: hangupUrl,
    hangup_method: "POST",
  });
  const r = await vobiz(authId, authToken, "POST", "/Application/", body);
  const appId = idString(r.json && r.json.app_id);
  if (!r.ok || !/^\d+$/.test(appId)) throw new Error(`creating the application failed (HTTP ${r.status})`);
  console.log(`[provision] ${authId}: created application ${appId} -> ${answerUrl}`);
  return appId;
}

function newSipPassword() {
  // Hex: alphanumeric, 24 characters, comfortably above the 8-character minimum.
  return crypto.randomBytes(12).toString("hex");
}

function endpointBoundApp(json) {
  if (!json) return "";
  return idString(json.application) || idString(json.app_id);
}

/**
 * Bind the endpoint to the application. First the form the reference
 * playground uses in production, {"app_id":"<id>"} with the id as a string;
 * verify by reading the endpoint back; if it did not take, retry once with the
 * documented {"application": <integer>}, spliced as text so the 17-digit id is
 * sent exactly. The outcome is logged either way.
 */
async function bindEndpoint(authId, authToken, endpointId, appId) {
  if (!/^\d+$/.test(appId)) throw new Error("refusing to bind a non-numeric app id");
  const ep = encodeURIComponent(endpointId);
  await vobiz(authId, authToken, "POST", `/Endpoint/${ep}/`, JSON.stringify({ app_id: appId }));
  let check = await vobiz(authId, authToken, "GET", `/Endpoint/${ep}/`);
  if (endpointBoundApp(check.json) === appId) {
    console.log(`[provision] ${authId}: endpoint ${endpointId} bound to application ${appId}`);
    return true;
  }
  await vobiz(authId, authToken, "POST", `/Endpoint/${ep}/`, '{"application":' + appId + "}");
  check = await vobiz(authId, authToken, "GET", `/Endpoint/${ep}/`);
  const bound = endpointBoundApp(check.json) === appId;
  console.log(
    `[provision] ${authId}: endpoint ${endpointId} ${bound ? "bound" : "NOT bound"} to application ${appId} after retrying with "application"` +
      (bound ? "" : `; it reports '${endpointBoundApp(check.json) || "none"}'`)
  );
  return bound;
}

function endpointAlias(agentId) {
  return `ClickUp-${String(agentId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 30) || "agent"}`;
}

/** An endpoint in the account whose alias is exactly ours, or null. */
async function findEndpointByAlias(authId, authToken, alias) {
  for (let offset = 0, page = 0; page < 20; page++, offset += 100) {
    const r = await vobiz(authId, authToken, "GET", `/Endpoint/?limit=100&offset=${offset}`);
    if (!r.ok) return null;
    const objects = (r.json && r.json.objects) || [];
    const hit = objects.find((e) => e && e.alias === alias && e.endpoint_id && e.username);
    if (hit) return { endpointId: idString(hit.endpoint_id), username: hit.username };
    if (objects.length < 100 || !(r.json.meta && r.json.meta.next)) break;
  }
  return null;
}

/**
 * One endpoint per (account, agent). Reused across sign-ins; every sign-in
 * gets a fresh SIP password, handed only to that browser session.
 */
async function ensureEndpoint(authId, authToken, agentId, appId) {
  const key = `${authId}:${agentId}`;
  const store = readEndpointStore();
  const password = newSipPassword();
  let entry = store[key];

  if (entry && entry.endpointId) {
    const ep = encodeURIComponent(entry.endpointId);
    const existing = await vobiz(authId, authToken, "GET", `/Endpoint/${ep}/`);
    if (existing.ok) {
      const upd = await vobiz(authId, authToken, "POST", `/Endpoint/${ep}/`, JSON.stringify({ password }));
      if (!upd.ok) throw new Error(`setting the SIP password failed (HTTP ${upd.status})`);
      const storedName = existing.json && existing.json.username;
      if (storedName && storedName !== entry.username) {
        entry = { ...entry, username: storedName };
        store[key] = entry;
        writeEndpointStore(store);
      }
    } else if (existing.status === 404) {
      entry = null; // deleted in the console; make a new one
    } else {
      throw new Error(`reading endpoint ${entry.endpointId} failed (HTTP ${existing.status})`);
    }
  }

  if (!entry || !entry.endpointId) {
    // Not in the local map (first sign-in, or the data dir was lost): reuse
    // the endpoint with this agent's exact alias if the account has one.
    const found = await findEndpointByAlias(authId, authToken, endpointAlias(agentId));
    if (found) {
      const upd = await vobiz(authId, authToken, "POST", `/Endpoint/${encodeURIComponent(found.endpointId)}/`, JSON.stringify({ password }));
      if (!upd.ok) throw new Error(`setting the SIP password failed (HTTP ${upd.status})`);
      entry = found;
      store[key] = entry;
      writeEndpointStore(store);
      console.log(`[provision] ${authId}: reusing endpoint ${found.endpointId} (${found.username}) for agent '${agentId}'`);
    }
  }

  if (!entry || !entry.endpointId) {
    const submitted = `cu${String(agentId).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}${crypto.randomBytes(3).toString("hex")}`;
    const alias = endpointAlias(agentId);
    const body = JSON.stringify({ username: submitted, password, alias, app_id: appId });
    const created = await vobiz(authId, authToken, "POST", "/Endpoint/", body);
    const endpointId = idString(created.json && created.json.endpoint_id);
    if (!created.ok || !endpointId) throw new Error(`creating the SIP endpoint failed (HTTP ${created.status})`);
    // Vobiz rewrites the submitted username. Only the stored one registers.
    const readBack = await vobiz(authId, authToken, "GET", `/Endpoint/${encodeURIComponent(endpointId)}/`);
    const username = (readBack.json && readBack.json.username) || "";
    if (!readBack.ok || !username) throw new Error(`reading back endpoint ${endpointId} failed (HTTP ${readBack.status})`);
    entry = { endpointId, username };
    store[key] = entry;
    writeEndpointStore(store);
    console.log(`[provision] ${authId}: created endpoint ${endpointId} (${username}) for agent '${agentId}'`);
  }

  await bindEndpoint(authId, authToken, entry.endpointId, appId);
  return { endpointId: entry.endpointId, username: entry.username, password };
}

// ─── Recording HMAC Signing ──────────────────────────────────────────────────
// The account is part of the signed payload and of the link, so a link minted
// for one account can never be replayed against another account's audio.
function recordingSig(authId, recordingId, exp) {
  return crypto.createHmac("sha256", SIGNING_SECRET).update(`${authId}|${recordingId}|${exp}`).digest("hex");
}

function signRecordingUrl(authId, recordingId, publicBaseUrl) {
  const exp = Math.floor(Date.now() / 1000) + RECORDING_URL_TTL_SECONDS;
  const sig = recordingSig(authId, recordingId, exp);
  return `${publicBaseUrl}/recording-audio/${encodeURIComponent(recordingId)}?a=${encodeURIComponent(authId)}&exp=${exp}&sig=${sig}`;
}

function verifyRecordingSignature(authId, recordingId, exp, sig) {
  if (!authId || !exp || !sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = recordingSig(authId, recordingId, exp);
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

/**
 * Guard for routes that need the Vobiz account API (recordings, numbers, CDRs,
 * inbound attach) or read account/CRM data. A SIP-direct session has no account
 * credentials, so it is told to sign in with the account instead.
 */
function requireAccountSession(req, res) {
  const s = getSession(req);
  if (!s) {
    sendJson(res, 401, { error: "Sign in first" });
    return false;
  }
  if (s.mode === "sip") {
    sendJson(res, 403, { error: "Sign in with your Vobiz account to use this. SIP-direct sessions can only place and take calls." });
    return false;
  }
  return true;
}

const STRICT_E164 = /^\+\d{10,15}$/;

/** A typed phone number as E.164 (+ and 8-15 digits), or "" if it is not one. */
function cleanPhone(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const digits = s.replace(/[^\d]/g, "");
  if (digits.length < 8 || digits.length > 15) return "";
  if (/[^\d+\s().-]/.test(s)) return "";
  return `+${digits}`;
}

/** A caller ID is acceptable only if this account owns it. */
function ownedCallerId(authId, candidate) {
  const acct = accounts.get(authId);
  const wanted = toE164(candidate);
  if (!acct || !wanted) return "";
  return acct.numbers.includes(wanted) ? wanted : "";
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

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function sendXml(res, xml) {
  res.writeHead(200, { "Content-Type": "application/xml" });
  res.end(xml);
}

function politeHangup(message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>${xmlEscape(message)}</Speak>
  <Hangup/>
</Response>`;
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
  let {
    callUuid,
    direction = "Outbound",
    authId = "",
    from = "",
    to = "",
    agentId = "",
    durationSeconds = 0,
    recordingUrl = "",
    recordingId = "",
    hangupCause = "NORMAL_CLEARING",
    status = "COMPLETE",
    existingTaskId = "",
  } = callData;

  // Webhook values land in Markdown inside inline code; a backtick, pipe or
  // newline would break out of the table cell and inject links into the task.
  const md = (v) => String(v == null ? "" : v).replace(/[`|\r\n\[\]()<>]/g, "").slice(0, 120);
  ({ callUuid, from, to, hangupCause, status } = {
    callUuid: md(callUuid), from: md(from), to: md(to), hangupCause: md(hangupCause), status: md(status),
  });

  const base = publicBaseUrl || `http://localhost:${PORT}`;
  let proxiedRecordingUrl = "";
  // The link names the account the recording belongs to, and the signature
  // covers it, so a link for one account can never fetch another's audio.
  if (recordingId && authId) {
    proxiedRecordingUrl = signRecordingUrl(authId, recordingId, base);
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
| **Agent** | \`${md(agentId ? agentObj.name || agentId : "Unassigned")}\` |
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
    // Status is left to the list's default unless CLICKUP_TASK_STATUS names
    // one: ClickUp rejects a status the list does not define, and a hardcoded
    // "CONNECTED" failed every write to a list created with ClickUp's defaults.
    // The agent's ClickUp user, from agents.json, owns the task. With no
    // clickUpUserId on file the task is left unassigned.
    const assignee = clickUpAssigneeFor(agentId);
    const payload = {
      name: taskTitle,
      description: markdownDescription,
      ...(CLICKUP_TASK_STATUS ? { status: CLICKUP_TASK_STATUS } : {}),
      ...(assignee ? { assignees: [Number(assignee)] } : {}),
      priority: 3,
      tags: ["vobiz-call", direction.toLowerCase(), "cdr"],
    };
    const createTask = (body) =>
      fetch(`${CLICKUP_API_URL}/list/${CLICKUP_LIST_ID}/task`, {
        method: "POST",
        headers: getClickUpHeaders(),
        body: JSON.stringify(body),
      });

    // One task per call: the dial result creates it, and the recording, which
    // arrives separately, updates the same task instead of adding a second.
    let res = existingTaskId
      ? await fetch(`${CLICKUP_API_URL}/task/${encodeURIComponent(existingTaskId)}`, {
          method: "PUT",
          headers: getClickUpHeaders(),
          body: JSON.stringify({ name: taskTitle, description: markdownDescription }),
        })
      : await createTask(payload);

    // A clickUpUserId that is not a member of the workspace makes ClickUp
    // refuse the whole task. The call is still logged, unassigned.
    if (!existingTaskId && assignee && res.status === 400) {
      console.warn(`[ClickUp] ClickUp refused assignee ${assignee} for agent '${agentId}'; creating the task unassigned`);
      const { assignees, ...unassigned } = payload;
      res = await createTask(unassigned);
    }

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

    console.log(`[ClickUp] ✅ Task ${existingTaskId ? "updated" : "created"} successfully! ID: ${json.id}, URL: ${json.url}`);
    return json;
  } catch (err) {
    console.error("[ClickUp] Network error creating task:", err.message);
    return { error: err.message };
  }
}

/**
 * Create the call's ClickUp task, or update it if one already exists.
 * Calls are serialised per call record so that a dial result and a recording
 * callback arriving together cannot both create a task.
 */
function syncCallTask(rec, callData, publicBaseUrl) {
  const previous = rec.taskPromise;
  rec.taskPromise = (async () => {
    const existing = previous ? await previous.catch(() => null) : null;
    const existingTaskId = existing && !existing.simulated && !existing.error ? existing.id : "";
    const result = await createClickUpCallTask({ ...callData, existingTaskId }, publicBaseUrl);
    if (isRealTask(result)) markCallSynced(callData.authId, callData.callUuid);
    // Keep the earlier task id if an update failed, so a later event still updates.
    return result && result.id ? result : existing || result;
  })();
  return rec.taskPromise;
}

/**
 * Resolve a recording ID to its media URL through the Vobiz API and stream it,
 * using the credentials of the account the recording belongs to.
 *
 * The account credentials go out on these requests, so the destination is never
 * allowed to come from a caller: it is resolved server-side and checked against
 * the host allowlist, and every redirect is re-checked before it is followed.
 * A presigned object-storage URL carries its own authorisation, so ours is
 * dropped on the way.
 */
async function streamRecordingById(authId, recordingId, res) {
  const acct = accounts.get(authId);
  if (!acct) {
    // Tokens live in memory only. After a restart, nobody from this account
    // has signed in again yet, so there is nothing to fetch the audio with.
    sendJson(res, 409, { error: "This recording's Vobiz account is not signed in on this server. Sign in again, then retry." });
    return;
  }
  const authHeaders = {
    "X-Auth-ID": authId,
    "X-Auth-Token": acct.authToken,
    Accept: "application/json",
  };

  try {
    const metaRes = await fetch(
      `${VOBIZ_API_URL}/api/v1/Account/${encodeURIComponent(authId)}/Recording/${encodeURIComponent(recordingId)}/`,
      { headers: authHeaders }
    );
    if (!metaRes.ok) {
      sendJson(res, metaRes.status, { error: `Vobiz returned ${metaRes.status} for that recording` });
      return;
    }
    const meta = await metaRes.json().catch(() => ({}));
    const mediaUrl = meta.recording_url || meta.url || meta.file;
    if (!mediaUrl) {
      sendJson(res, 404, { error: "No audio is available for that recording yet" });
      return;
    }
    if (!isAllowedMediaHost(mediaUrl)) {
      console.error(`[/recording-audio] refusing off-allowlist media host: ${mediaUrl}`);
      sendJson(res, 502, { error: "Recording is hosted somewhere this server will not fetch from" });
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
        sendJson(res, 502, { error: "Recording redirected somewhere this server will not follow" });
        return;
      }
      mediaRes = await fetch(next, { redirect: "manual" });
      hops++;
    }

    if (!mediaRes.ok) {
      sendJson(res, mediaRes.status, { error: `Media server returned ${mediaRes.status}` });
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
    sendJson(res, 500, { error: "Could not stream that recording" });
  }
}

// ─── CDR sync ───────────────────────────────────────────────────────────────
const CDR_SYNC_LIMIT = 5;
const cdrSyncs = new Map(); // authId -> in-flight sync

/** The recording for a call: from this server's own webhook, else from Vobiz. */
async function recordingIdForCall(authId, authToken, callUuid) {
  const local = callRecordings.get(callUuid) || callsByUuid.get(callUuid);
  if (local && local.authId === authId && local.recordingId) return String(local.recordingId);
  try {
    const r = await vobiz(authId, authToken, "GET", `/Recording/?call_uuid=${encodeURIComponent(callUuid)}&limit=1`);
    const objects = (r.ok && r.json && (r.json.objects || r.json.items)) || [];
    const hit = objects.find((o) => o && o.recording_id && (!o.call_uuid || o.call_uuid === callUuid));
    return hit ? String(hit.recording_id) : "";
  } catch (err) {
    console.warn(`[sync-cdrs] recording lookup for ${callUuid} failed: ${err.message}`);
    return "";
  }
}

/** Call UUIDs already present in task descriptions on the configured list. */
async function callUuidsInClickUpList(uuids) {
  const found = new Set();
  if (!CLICKUP_API_TOKEN || !CLICKUP_LIST_ID || CLICKUP_API_TOKEN.includes("YOUR_CLICKUP")) return found;
  try {
    const res = await fetch(`${CLICKUP_API_URL}/list/${CLICKUP_LIST_ID}/task?include_closed=true`, {
      headers: getClickUpHeaders(),
    });
    if (!res.ok) return found;
    const json = await res.json().catch(() => ({}));
    for (const t of (json && json.tasks) || []) {
      const text = String((t && t.description) || "") + String((t && t.text_content) || "");
      for (const u of uuids) if (text.includes(`\`${u}\``)) found.add(u);
    }
  } catch (err) {
    console.warn("[sync-cdrs] could not read the ClickUp list:", err.message);
  }
  return found;
}

/**
 * Import the account's most recent CDRs as ClickUp tasks, skipping every call
 * that already has one: calls recorded in the synced-call store (live webhook
 * tasks and earlier syncs), and calls whose UUID already appears in a task on
 * the list.
 */
async function syncRecentCdrs(session, acct, publicBaseUrl) {
  const authId = session.authId;
  console.log(`[backend] Fetching recent CDRs from Vobiz for ${authId}...`);
  const r = await vobiz(authId, acct.authToken, "GET", `/cdr/recent?limit=${CDR_SYNC_LIMIT}`);
  const cdrs = (r.ok && r.json && Array.isArray(r.json.data) ? r.json.data : []).filter((c) => c && c.uuid);

  const pending = cdrs.filter((c) => !isCallSynced(authId, c.uuid));
  const onList = pending.length ? await callUuidsInClickUpList(pending.map((c) => String(c.uuid))) : new Set();
  for (const u of onList) markCallSynced(authId, u);

  const syncedTasks = [];
  const skipped = [];
  for (const cdr of cdrs) {
    const uuid = String(cdr.uuid);
    if (isCallSynced(authId, uuid)) {
      skipped.push(uuid);
      continue;
    }
    const local = callsByUuid.get(uuid);
    const recordingId = await recordingIdForCall(authId, acct.authToken, uuid);
    const task = await createClickUpCallTask(
      {
        authId,
        callUuid: uuid,
        direction: cdr.call_direction || "Outbound",
        from: cdr.caller_id_number || "",
        to: cdr.destination_number || "",
        // The agent who handled it, when this server saw the call; otherwise
        // nobody can say, and the task is left unassigned.
        agentId: local && local.authId === authId ? local.agentId || "" : "",
        durationSeconds: parseInt(cdr.duration || 0, 10),
        recordingId,
        hangupCause: cdr.hangup_cause || "NORMAL_CLEARING",
      },
      publicBaseUrl
    );
    if (isRealTask(task)) markCallSynced(authId, uuid);
    syncedTasks.push({ uuid, clickUpTask: task });
  }

  console.log(`[sync-cdrs] ${authId}: ${cdrs.length} fetched, ${syncedTasks.length} new task(s), ${skipped.length} already synced`);
  return {
    status: "success",
    totalFetched: cdrs.length,
    created: syncedTasks.filter((t) => !t.clickUpTask || !t.clickUpTask.error).length,
    skipped: skipped.length,
    syncedTasks,
  };
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
    // Unauthenticated, so it reports whether things are configured, never
    // which accounts are signed in or what their numbers are.
    sendJson(res, 200, {
      status: "ok",
      service: "vobiz-clickup-calling",
      publicBaseUrl: getPublicBaseUrl(req),
      vobizRegistrar: VOBIZ_REGISTRAR,
      vobizRegistrarWss: VOBIZ_REGISTRAR_WSS,
      clickUpConfigured: !!(CLICKUP_API_TOKEN && !CLICKUP_API_TOKEN.includes("YOUR_CLICKUP")),
      activeCallsCount: callsByUuid.size,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // 1b. Numbers on the signed-in account
  if (pathname === "/api/numbers" && method === "GET") {
    if (!requireAccountSession(req, res)) return;
    const s = getSession(req);
    const acct = accounts.get(s.authId);
    if (acct) {
      try {
        acct.numberDetails = await loadAccountNumbers(s.authId, acct.authToken);
        acct.numbers = acct.numberDetails.map((n) => n.e164);
        s.numbers = acct.numbers;
        if (!acct.numbers.includes(s.from)) s.from = acct.numbers[0] || "";
      } catch (e) {
        console.warn(`[backend] numbers refresh for ${s.authId}: ${e.message}`);
      }
    }
    sendJson(res, 200, {
      ok: true,
      numbers: s.numbers || [],
      numberDetails: (acct && acct.numberDetails) || [],
      appId: (acct && acct.appId) || "",
      selected: s.from || "",
    });
    return;
  }

  // 2. Sign in with any Vobiz account (Auth ID & Auth Token)
  if (pathname === "/login" && method === "POST") {
    try {
      const body = await readJsonBody(req);
      const agentId = String(body.agentId || "").trim();
      if (!AGENT_ID_RE.test(agentId)) {
        sendJson(res, 400, { error: "Enter your agent ID: 1-30 letters, digits, - or _." });
        return;
      }
      const authId = String(body.authId || "").trim();
      const authToken = String(body.authToken || "").trim();
      if (!authId || !authToken) {
        sendJson(res, 400, { error: "authId and authToken are required" });
        return;
      }
      if (!/^[A-Za-z0-9_-]{2,64}$/.test(authId)) {
        sendJson(res, 401, { ok: false, error: "Invalid Vobiz Auth ID or Auth Token." });
        return;
      }

      // Credentials are proven, not assumed: Vobiz must accept the pair.
      let numberDetails;
      try {
        numberDetails = await loadAccountNumbers(authId, authToken);
      } catch (e) {
        if (e.status) {
          console.log(`[backend] Vobiz refused sign-in for ${authId}: HTTP ${e.status}`);
          sendJson(res, 401, { ok: false, error: "Invalid Vobiz Auth ID or Auth Token." });
        } else {
          console.error(`[backend] Could not reach Vobiz to check ${authId}: ${e.message}`);
          sendJson(res, 502, { ok: false, error: "Could not reach Vobiz to check those credentials. Try again." });
        }
        return;
      }

      const base = getPublicBaseUrl(req);
      const answerUrl = `${base}/answer`;
      const hangupUrl = `${base}/hangup-callback`;

      let provisioned;
      let appId;
      try {
        appId = await ensureApplication(authId, authToken, answerUrl, hangupUrl);
        provisioned = await ensureEndpoint(authId, authToken, agentId, appId);
      } catch (e) {
        console.error(`[provision] ${authId}: ${e.message}`);
        sendJson(res, 502, { ok: false, error: `Signed in to Vobiz, but setting up the softphone failed: ${e.message}` });
        return;
      }

      // The token stays here, in memory, keyed by account. Never on disk, never
      // in a response, never in a log line.
      const numbers = numberDetails.map((n) => n.e164);
      accounts.set(authId, { authToken, numbers, numberDetails, appId, answerUrl });

      // Default to the first number; a returning agent keeps their last pick.
      const previous = [...sessions.values()].find((o) => o.authId === authId && o.agentId === agentId);
      const selected = previous && numbers.includes(previous.from) ? previous.from : numbers[0] || "";
      // A previous sign-in for this agent registered as the same endpoint; its
      // password was just replaced, so its session is finished.
      for (const [tok, old] of sessions) {
        if (old.authId === authId && old.agentId === agentId) sessions.delete(tok);
      }
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, {
        agentId,
        authId,
        numbers,
        from: selected,
        sipUser: provisioned.username,
        sipPassword: provisioned.password,
        createdAt: Date.now(),
      });
      sipUsers.set(provisioned.username, { authId, agentId, callerId: selected });

      console.log(`[backend] Sign-in ok for agent '${agentId}' (${authId}) as ${provisioned.username}. Numbers: ${numbers.length}`);

      sendJson(res, 200, {
        ok: true,
        success: true,
        token,
        numbers,
        numberDetails,
        appId,
        selected,
        authId,
        agentId,
        sipAvailable: true,
      });
    } catch (err) {
      console.error("[backend] Login error:", err.message);
      sendJson(res, 500, { error: "Sign-in failed" });
    }
    return;
  }

  // 2b. SIP direct: the agent's softphone registers with an existing
  // endpoint's own SIP username and password, typed into the panel and never
  // sent here. The backend only records which caller ID that SIP user dials out
  // with, and which DID rings it, so /answer can route its calls. No account
  // credentials exist in this mode, so nothing account-owned (recordings, the
  // number list, inbound attach) is reachable from it.
  //
  // The caller ID is format-checked only. This backend cannot prove ownership
  // without the account API; Vobiz itself refuses a caller ID the endpoint's
  // account does not own.
  if (pathname === "/login-sip" && method === "POST") {
    try {
      const body = await readJsonBody(req);
      const cleanUser = String(body.sipUser || "").trim().replace(/^sip:/, "").split("@")[0];
      const callerId = cleanPhone(body.callerId);
      if (!/^[A-Za-z0-9]{1,64}$/.test(cleanUser)) {
        sendJson(res, 400, { error: "Enter the endpoint's SIP username (letters and digits only)." });
        return;
      }
      if (!callerId) {
        sendJson(res, 400, { error: "Enter the caller ID as a full number with country code, e.g. +91…" });
        return;
      }
      const existing = sipUsers.get(cleanUser);
      if (existing && existing.mode !== "sip") {
        // An account sign-in provisioned this endpoint; its routing is not
        // something an unauthenticated request may rewrite.
        sendJson(res, 409, { error: "That SIP user belongs to a Vobiz account sign-in on this server." });
        return;
      }
      for (const [u, a] of sipUsers) {
        if (u !== cleanUser && a.mode === "sip" && a.inboundNumber === callerId) {
          sendJson(res, 409, { error: `${callerId} is already in use by another SIP-direct agent on this server.` });
          return;
        }
      }
      for (const [tok, old] of sessions) {
        if (old.mode === "sip" && old.sipUser === cleanUser) sessions.delete(tok);
      }
      sipUsers.set(cleanUser, { authId: null, agentId: cleanUser, callerId, inboundNumber: callerId, mode: "sip" });
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, {
        mode: "sip",
        agentId: cleanUser,
        authId: null,
        numbers: [callerId],
        from: callerId,
        sipUser: cleanUser,
        createdAt: Date.now(),
      });
      console.log(`[backend] SIP-direct sign-in: ${cleanUser} -> caller ID ${callerId}`);
      sendJson(res, 200, { ok: true, success: true, token, sipUser: cleanUser, callerId, mode: "sip" });
    } catch (err) {
      sendJson(res, 500, { error: "SIP-direct sign-in failed" });
    }
    return;
  }

  // 2c. Session Query Endpoint — the bearer token is the only proof.
  if ((pathname === "/session" || pathname.startsWith("/session/")) && method === "GET") {
    const s = getSession(req);
    if (s) {
      sendJson(res, 200, {
        loggedIn: true,
        mode: s.mode === "sip" ? "sip" : "account",
        agentId: s.agentId,
        authId: s.authId,
        numbers: s.numbers,
        from: s.from,
      });
      return;
    }
    sendJson(res, 200, { loggedIn: false });
    return;
  }

  // 2d. Logout Endpoint
  if (pathname === "/logout" && method === "POST") {
    const header = (req.headers && req.headers.authorization) || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const s = token ? sessions.get(token) : null;
    if (s) {
      sessions.delete(token);
      const entry = sipUsers.get(s.sipUser);
      if (entry && entry.authId === s.authId && entry.agentId === s.agentId) sipUsers.delete(s.sipUser);
    }
    sendJson(res, 200, { ok: true, success: true });
    return;
  }

  // 2e. Select Outgoing Caller ID — must be a number on the signed-in account.
  if (pathname === "/select-number" && method === "POST") {
    if (!requireAccountSession(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const s = getSession(req);
      const number = ownedCallerId(s.authId, body.number);
      if (!number) {
        sendJson(res, 400, { error: `${body.number} is not a number on this Vobiz account, so it cannot be a caller ID.` });
        return;
      }
      s.from = number;
      const entry = sipUsers.get(s.sipUser);
      if (entry) entry.callerId = number;
      console.log(`[backend] Outbound caller ID for ${s.sipUser} is now ${number}`);
      sendJson(res, 200, { ok: true, selected: number });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // 2e-bis. Enable inbound calls on one of the account's numbers.
  // Explicit only: attaching moves the number off whatever application it is
  // on now, so it never happens as a side effect of signing in.
  if (pathname === "/api/inbound/enable" && method === "POST") {
    if (!requireAccountSession(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const s = getSession(req);
      const acct = accounts.get(s.authId);
      const number = ownedCallerId(s.authId, body.number || s.from);
      if (!acct || !number) {
        sendJson(res, 400, { error: "Choose a number on this Vobiz account first." });
        return;
      }
      const digits = number.replace(/\D/g, "");
      const r = await vobiz(
        s.authId,
        acct.authToken,
        "POST",
        `/numbers/%2B${digits}/application`,
        JSON.stringify({ application_id: acct.appId })
      );
      if (!r.ok) {
        console.error(`[backend] ${s.authId}: attaching ${number} to ${acct.appId} failed: HTTP ${r.status}`);
        sendJson(res, 502, { error: `Vobiz refused to attach ${number} (HTTP ${r.status})` });
        return;
      }
      console.log(`[backend] ${s.authId}: inbound enabled on ${number} -> application ${acct.appId}`);
      sendJson(res, 200, { ok: true, number });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // 2f. SIP credentials for this session's softphone registration.
  if ((pathname === "/api/agent-sip" || pathname === "/agent" || pathname.startsWith("/agent/")) && method === "GET") {
    const s = getSession(req);
    if (!s) {
      sendJson(res, 401, { error: "Sign in first" });
      return;
    }
    if (s.mode === "sip") {
      sendJson(res, 403, { error: "SIP-direct sessions register with the password the agent typed; this server holds none." });
      return;
    }
    if (!s.sipUser || !s.sipPassword) {
      sendJson(res, 500, { error: "This session has no SIP endpoint. Sign out and sign in again." });
      return;
    }
    const agentObj = getAgent(s.agentId);
    sendJson(res, 200, {
      displayName: agentObj.name || s.agentId,
      sipUser: `${s.sipUser}@${VOBIZ_REGISTRAR}`,
      sipPassword: s.sipPassword,
      registrarUrl: VOBIZ_REGISTRAR_WSS,
    });
    return;
  }

  // 2g. List Agents — full profiles, ClickUp user ids included, signed in only.
  if (pathname === "/api/agents" && method === "GET") {
    if (!requireAccountSession(req, res)) return;
    sendJson(res, 200, getAllAgents());
    return;
  }

  // 2g-bis. Agent profiles for the sign-in form. Read before anyone signs in,
  // so it carries the id and display name only: no ClickUp user id or email.
  if (pathname === "/api/agent-profiles" && method === "GET") {
    sendJson(res, 200, { profiles: listAgentProfiles() });
    return;
  }

  // 2h. /api/calls/start no longer originates calls. The softphone is the A
  // leg: it sends the INVITE itself once registered.
  if (pathname === "/api/calls/start" && method === "POST") {
    if (!requireAccountSession(req, res)) return;
    sendJson(res, 409, {
      ok: false,
      error: "Calls are placed by the softphone over WebRTC. Wait for the status to read Ready, then dial.",
    });
    return;
  }

  // 2i. End API Call Session and sync task to ClickUp
  if (pathname === "/api/calls/end" && method === "POST") {
    if (!requireAccountSession(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const s = getSession(req);
      const callUuid = body.callUuid || `call_${Date.now()}`;
      const durationSeconds = Number(body.durationSeconds || 0);

      let rec = callsByUuid.get(callUuid);
      if (rec && rec.authId !== s.authId) {
        sendJson(res, 404, { error: "No such call on this account" });
        return;
      }
      if (!rec) {
        rec = {
          callUuid,
          authId: s.authId,
          agentId: s.agentId,
          direction: body.direction || "Outbound",
          from: ownedCallerId(s.authId, body.from) || s.from,
          to: body.to || "",
          startedAt: Date.now() - durationSeconds * 1000,
        };
      }
      rec.duration = durationSeconds;
      rec.endedAt = Date.now();
      rec.hangupCause = body.hangupCause || "NORMAL_CLEARING";
      rec.dialStatus = "completed";
      rememberCall(rec);

      const task = await createClickUpCallTask(
        {
          authId: rec.authId,
          callUuid: rec.callUuid,
          direction: rec.direction,
          from: rec.from,
          to: rec.to,
          agentId: rec.agentId,
          durationSeconds: rec.duration,
          recordingId: rec.recordingId || "",
          hangupCause: rec.hangupCause,
          status: "COMPLETE",
        },
        getPublicBaseUrl(req)
      );
      if (isRealTask(task)) markCallSynced(rec.authId, rec.callUuid);

      sendJson(res, 200, { ok: true, success: true, task, record: rec });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // 3. THE BROWSER-AS-A-LEG ANSWER CALLBACK: GET/POST /answer, /fallback, /inbound-answer
  //
  // Multi-tenant: the webhook is matched to an account by who is calling.
  //   outbound — From is sip:<user>@…, and the SIP user maps to the agent who
  //              signed in with it;
  //   inbound  — To is a DID, found among the signed-in accounts' numbers.
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

      const bareFrom = from.replace(/^sip:/, "").split("@")[0];
      const fromBrowser = from.startsWith("sip:") || routeType === "sip" || sipUsers.has(bareFrom);

      const publicBaseUrl = getPublicBaseUrl(req);
      const dialStatusUrl = `${publicBaseUrl}/dial-status`;
      const recordCallbackUrl = `${publicBaseUrl}/recording-ready`;
      const recordXml = `<Record fileFormat="mp3" recordSession="true" maxLength="3600" playBeep="false" redirect="false" callbackUrl="${recordCallbackUrl}" callbackMethod="POST"/>`;

      if (fromBrowser) {
        // OUTBOUND: an agent's softphone calling a customer.
        const agent = sipUsers.get(bareFrom);
        if (!agent) {
          console.warn(`[backend] /answer: outbound from unknown SIP user '${bareFrom}'; hanging up`);
          sendXml(res, politeHangup("This phone is not signed in. Please sign in to the ClickUp softphone and try again."));
          return;
        }
        const sipHeaderCallerId =
          params["SIPHeader_X-VH-Caller-ID"] ||
          params["SIPHeader_X-PH-Caller-ID"] ||
          params["X-VH-Caller-ID"] ||
          params["X-PH-Caller-ID"] ||
          params.CallerID ||
          params.caller_id;

        // The header comes from the browser, so it is a request, not a fact:
        // only a number this agent's account owns is used as the caller ID.
        // SIP direct has no account to check against: the caller ID is the one
        // typed at sign-in (format-checked), and Vobiz enforces ownership.
        // Per-SIP-user state set from the panel, overridden by the X-VH-Caller-ID
        // header on the INVITE when that is a strict E.164 number.
        const headerCallerId = STRICT_E164.test(toE164(sipHeaderCallerId)) ? toE164(sipHeaderCallerId) : "";
        const callerId =
          agent.mode === "sip"
            ? headerCallerId || agent.callerId
            : ownedCallerId(agent.authId, headerCallerId) || ownedCallerId(agent.authId, agent.callerId);
        if (!callerId) {
          console.warn(`[backend] /answer: ${agent.authId} has no number to call from; hanging up`);
          sendXml(res, politeHangup("This account has no phone number to call from. Add a number in the Vobiz console."));
          return;
        }
        const destination = to.replace(/[^\d+]/g, "");

        rememberCall({
          callUuid,
          authId: agent.authId,
          agentId: agent.agentId,
          agentSipUser: bareFrom,
          direction: "Outbound",
          from: callerId,
          to: destination,
          startedAt: Date.now(),
        });

        console.log(`[backend] 📞 Browser A-leg (${agent.authId || "sip-direct"}/${agent.agentId}): outbound to ${destination} via callerId ${callerId}`);

        sendXml(
          res,
          `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${recordXml}
  <Dial callerId="${xmlEscape(callerId)}" timeout="30" timeLimit="14400" action="${dialStatusUrl}" method="POST" redirect="false">
    <Number>${xmlEscape(destination)}</Number>
  </Dial>
</Response>`
        );
        return;
      }

      // INBOUND: a customer calling one of a signed-in account's DIDs.
      // Vobiz names the account on the webhook as ParentAuthID; that is the
      // primary key. Without it (or for an account nobody signed in with), the
      // dialled number is looked up among the signed-in accounts' numbers.
      const dialled = toE164(to);
      const parentAuthId = String(params.ParentAuthID || params.parentauthid || "");
      let authId = parentAuthId && accounts.has(parentAuthId) ? parentAuthId : "";
      if (!authId) {
        for (const [id, acct] of accounts) {
          if (dialled && acct.numbers.includes(dialled)) {
            authId = id;
            break;
          }
        }
      }
      // Account sign-ins own their numbers first; otherwise a SIP-direct agent
      // whose caller ID is the dialled number takes the call.
      const targets = authId
        ? [...sipUsers.entries()].filter(([, a]) => a.mode !== "sip" && a.authId === authId).map(([u]) => u)
        : [...sipUsers.entries()].filter(([, a]) => a.mode === "sip" && dialled && a.inboundNumber === dialled).map(([u]) => u);
      if (!authId && targets.length === 0) {
        console.warn(`[backend] /answer: inbound to ${dialled || "(none)"} matches no signed-in account or agent; hanging up`);
        sendXml(res, politeHangup("Sorry, this number cannot take calls right now. Goodbye."));
        return;
      }

      if (targets.length === 0) {
        console.warn(`[backend] /answer: inbound to ${dialled} (${authId}) but no agent is signed in; hanging up`);
        sendXml(res, politeHangup("Sorry, no one is available to take your call right now. Please try again later. Goodbye."));
        return;
      }

      rememberCall({
        callUuid,
        authId: authId || null,
        agentId: targets.length === 1 ? sipUsers.get(targets[0]).agentId : "",
        agentSipUser: targets.join(","),
        direction: "Inbound",
        from,
        to: dialled,
        startedAt: Date.now(),
      });

      console.log(`[backend] 🔔 Inbound ${from} -> ${dialled} (${authId || "sip-direct"}): ringing ${targets.length} agent(s)`);

      const users = targets.map((u) => `    <User>sip:${xmlEscape(u)}@${VOBIZ_REGISTRAR}</User>`).join("\n");
      sendXml(
        res,
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${recordXml}
  <Dial callerId="${xmlEscape(dialled)}" timeout="20" action="${dialStatusUrl}" method="POST" redirect="false">
${users}
  </Dial>
  <Speak>Sorry, no one is available to take your call right now. Please try again later. Goodbye.</Speak>
</Response>`
      );
      return;
    } catch (err) {
      console.error("[backend] Error in /answer:", err.message);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("error");
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

      const rec = callsByUuid.get(callUuid);
      if (rec) {
        rec.dialStatus = dialStatus;
        rec.hangupCause = d.DialHangupCause || "NORMAL_CLEARING";
        rec.bLegUuid = bleg || null;
        rec.duration = duration;
        rec.endedAt = Date.now();

        await syncCallTask(
          rec,
          {
            authId: rec.authId,
            callUuid,
            direction: rec.direction || "Outbound",
            from: rec.from,
            to: rec.to,
            agentId: rec.agentId,
            durationSeconds: duration,
            recordingId: rec.recordingId || "",
            hangupCause: rec.hangupCause,
            status: dialStatus === "answered" || dialStatus === "completed" ? "COMPLETE" : dialStatus,
          },
          getPublicBaseUrl(req)
        );
      }

      sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error("[backend] Error in /dial-status:", err.message);
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

      console.log(`[backend] 🎧 RECORDING READY: call=${callUuid} id=${recordingId}`);

      // Only calls this server answered get a task, and the account is the one
      // that call belongs to — never taken from the webhook body.
      const rec = callsByUuid.get(callUuid);
      if (!rec) {
        console.warn(`[backend] recording callback for unknown call ${callUuid}; ignored`);
        sendJson(res, 200, { ok: true });
        return;
      }

      rec.recordingId = recordingId;
      rec.recordingUrl = recordUrl;
      rec.recordingDuration = recordingDuration;
      callRecordings.set(callUuid, rec);

      await syncCallTask(
        rec,
        {
          authId: rec.authId,
          callUuid,
          direction: rec.direction,
          from: rec.from,
          to: rec.to,
          agentId: rec.agentId,
          durationSeconds: rec.duration || recordingDuration || 0,
          recordingId,
          hangupCause: rec.hangupCause || "NORMAL_CLEARING",
        },
        getPublicBaseUrl(req)
      );

      // The task result is not echoed: it carries a freshly signed playback
      // link, and this route is unauthenticated.
      sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error("[backend] Error in recording webhook:", err.message);
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
      sendJson(res, 200, { status: "success" });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // 7. Recordings List: the signed-in account's recordings, with its own credentials.
  if ((pathname === "/recordings" || pathname === "/api/recordings") && method === "GET") {
    if (!requireAccountSession(req, res)) return;
    try {
      const s = getSession(req);
      const acct = accounts.get(s.authId);
      const publicBaseUrl = getPublicBaseUrl(req);
      const limit = Math.min(Number(parsedUrl.query.limit || 15), 50);
      let recordings = [];

      if (acct) {
        try {
          const r = await vobiz(s.authId, acct.authToken, "GET", `/Recording/?limit=${limit}`);
          if (r.ok) {
            const objects = (r.json && (r.json.objects || r.json.items)) || [];
            recordings = objects.map((o) => ({
              recording_id: o.recording_id,
              add_time: o.add_time,
              rounded_recording_duration: o.rounded_recording_duration,
              call_uuid: o.call_uuid,
              playUrl: signRecordingUrl(s.authId, String(o.recording_id), publicBaseUrl),
            }));
          }
        } catch (e) {
          console.warn("[/recordings] Vobiz fetch error:", e.message);
        }
      }

      if (recordings.length === 0) {
        const pool = (callRecordings.size > 0 ? Array.from(callRecordings.values()) : recentCalls).filter(
          (c) => c.authId === s.authId
        );
        recordings = pool.slice(0, limit).map((c) => ({
          recording_id: c.recordingId || c.callUuid,
          add_time: new Date(c.startedAt || Date.now()).toLocaleTimeString(),
          rounded_recording_duration: c.duration || c.recordingDuration || 0,
          call_uuid: c.callUuid,
          playUrl: c.recordingId ? signRecordingUrl(s.authId, c.recordingId, publicBaseUrl) : "",
        }));
      }

      sendJson(res, 200, { recordings, objects: recordings });
    } catch (err) {
      sendJson(res, 500, { recordings: [], error: err.message });
    }
    return;
  }

  // 8. Play Recording Endpoint: GET /play-recording?callUuid=... (session only)
  if (pathname === "/play-recording" && method === "GET") {
    if (!requireAccountSession(req, res)) return;
    const s = getSession(req);
    const callUuid = parsedUrl.query.callUuid;
    const rec = callUuid ? callRecordings.get(callUuid) || callsByUuid.get(callUuid) : null;
    if (rec && rec.recordingId && rec.authId === s.authId) {
      res.writeHead(302, { Location: signRecordingUrl(rec.authId, rec.recordingId, getPublicBaseUrl(req)) });
      res.end();
      return;
    }
    sendJson(res, 404, { error: "Recording not found for call" });
    return;
  }

  // 9. HMAC Signed Recording Audio Stream: GET /recording-audio/:recordingId?a=<authId>&exp=&sig=
  if (pathname.startsWith("/recording-audio/") && method === "GET") {
    const recordingId = decodeURIComponent(pathname.slice("/recording-audio/".length));
    const { a, exp, sig } = parsedUrl.query;
    let authId = "";
    if (verifyRecordingSignature(String(a || ""), recordingId, exp, sig)) {
      authId = String(a);
    } else {
      // A signed-in agent may play their own account's recordings unsigned.
      const viewer = getSession(req);
      if (viewer && viewer.mode !== "sip" && viewer.authId && (!a || a === viewer.authId)) authId = viewer.authId;
    }
    if (!authId) {
      sendJson(res, 403, { error: "Invalid or expired playback signature" });
      return;
    }
    await streamRecordingById(authId, recordingId, res);
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
    if (!requireAccountSession(req, res)) return;
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

  // 12. Live CDR Sync Endpoint: GET/POST /sync-recent-cdrs — the signed-in account's CDRs.
  if (pathname === "/sync-recent-cdrs" && (method === "GET" || method === "POST")) {
    if (!requireAccountSession(req, res)) return;
    const s = getSession(req);
    const acct = accounts.get(s.authId);
    if (!acct) {
      sendJson(res, 409, { error: "Sign in again to sync CDRs." });
      return;
    }
    // One sync per account at a time: two clicks racing would both see a CDR
    // as new and both create its task.
    const previous = cdrSyncs.get(s.authId) || Promise.resolve();
    const run = previous.catch(() => {}).then(() => syncRecentCdrs(s, acct, getPublicBaseUrl(req)));
    cdrSyncs.set(s.authId, run);
    try {
      sendJson(res, 200, await run);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    } finally {
      if (cdrSyncs.get(s.authId) === run) cdrSyncs.delete(s.authId);
    }
    return;
  }

  // 13. Simulated Call Test Endpoint: POST /test-simulated-call
  if (pathname === "/test-simulated-call" && method === "POST") {
    if (!requireAccountSession(req, res)) return;
    try {
      const s = getSession(req);
      const body = await readJsonBody(req);
      const direction = body.direction || "outbound";
      const from = body.from || s.from || "";
      const to = body.to || "+15550199999";
      const durationSeconds = parseInt(body.duration || body.Duration || 45, 10);
      const callUuid = body.callUuid || `sim_${Date.now()}`;

      const clickUpTask = await createClickUpCallTask(
        {
          authId: s.authId,
          callUuid,
          direction,
          from,
          to,
          agentId: s.agentId,
          durationSeconds,
          hangupCause: body.hangupCause || "NORMAL_CLEARING",
        },
        getPublicBaseUrl(req)
      );

      sendJson(res, 200, {
        status: "success",
        message: `Simulated ${direction} call logged to ClickUp`,
        callUuid,
        clickUpTask,
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
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
  console.log(`Vobiz accounts:        any — agents sign in with their own Auth ID and Auth Token`);
  console.log(`ClickUp List ID:       ${CLICKUP_LIST_ID || "Not set"}`);
  console.log(`==================================================\n`);
});
