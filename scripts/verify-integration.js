/**
 * Verification test suite for Vobiz ClickUp Calling Integration.
 * Validates all 8 requirements:
 * 1. Dual login (Account & SIP direct)
 * 2. Outbound calling (Browser-as-A-leg XML)
 * 3. Inbound calling (PSTN to SIP Agent bridging XML)
 * 4. Number selection
 * 5. UI as per Zendesk (HTML elements & static assets)
 * 6. CDR creation & ClickUp task logging
 * 7. Call recording capture & signed playback proxy
 * 8. Inbound call popup & completed modal
 */

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8092);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// The suite signs in with whatever account the server under test is bound to.
// scripts/test-server.js starts one bound to these.
const TEST_AUTH_ID = process.env.VOBIZ_AUTH_ID || "test_auth_id";
const TEST_AUTH_TOKEN = process.env.VOBIZ_AUTH_TOKEN || "test_auth_token";
const TEST_FROM_NUMBER = process.env.VOBIZ_FROM_NUMBER || "+15550100000";
const MOCK_URL = process.env.MOCK_URL || "";

/** Requests the backend made to the stand-in Vobiz and ClickUp APIs. */
async function upstream() {
  if (!MOCK_URL) return [];
  const res = await fetch(`${MOCK_URL}/__requests`);
  return res.json();
}

function form(obj) {
  return { "Content-Type": "application/x-www-form-urlencoded" };
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

async function request(pathname, options = {}) {
  const url = `${BASE_URL}${pathname}`;
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, headers: res.headers, text, json };
}

/**
 * Send a request line verbatim, without letting a client library normalise it.
 *
 * fetch() collapses "/../" before the request leaves, so it cannot exercise a
 * path traversal — a test written with it passes whether or not the server is
 * vulnerable.
 */
function rawRequest(rawPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, "127.0.0.1", () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\n\r\n`);
    });
    let buf = "";
    socket.on("data", (d) => (buf += d.toString()));
    socket.on("end", () => {
      const status = Number((buf.match(/^HTTP\/1\.\d (\d{3})/) || [])[1] || 0);
      resolve({ status, text: buf });
    });
    socket.on("error", reject);
  });
}

async function runTests() {
  console.log("\n========================================================");
  console.log("🧪 RUNNING VOBIZ CLICKUP INTEGRATION TEST SUITE");
  console.log("========================================================\n");

  // 1. Health & Server Status
  console.log("[1/8] Checking Server Health & Status...");
  const health = await request("/health");
  assert(health.status === 200, "GET /health returns HTTP 200");
  assert(health.json && health.json.service === "vobiz-clickup-calling", "Service identifier is 'vobiz-clickup-calling'");

  // 2. Dual Login: Mode 1 (Account Login) & Mode 2 (SIP Direct)
  console.log("\n[2/8] Testing Dual Login APIs...");

  // Credentials Vobiz has not accepted must be refused. A suite that signs in
  // with a made-up id and asserts the 200 as a pass would call an
  // authentication bypass correct behaviour.
  const badLogin = await request("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: "attacker", authId: "totally-fake", authToken: "totally-fake" })
  });
  assert(badLogin.status === 401, "POST /login refuses credentials that are not this server's account");
  assert(!(badLogin.json && badLogin.json.token), "a refused login issues no session token");

  // Another account's credentials are valid at Vobiz — the stand-in API accepts
  // anything, as a stranger's own account would — but this backend is bound to
  // one account, and signing them in would hand over its SIP password.
  const strangerLogin = await request("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: "admin", authId: "MA_STRANGER", authToken: "a-valid-token-for-another-account" })
  });
  assert(strangerLogin.status === 401 && !(strangerLogin.json && strangerLogin.json.token), "POST /login refuses a different Vobiz account, even with valid credentials");

  // Mode 1: Account Login, with the credentials this server is bound to.
  const loginRes = await request("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId: "admin",
      authId: TEST_AUTH_ID,
      authToken: TEST_AUTH_TOKEN
    })
  });
  assert(loginRes.status === 200, "POST /login returns HTTP 200");
  assert(loginRes.json && loginRes.json.token, "POST /login returns session token");
  assert(loginRes.json && Array.isArray(loginRes.json.numbers), "POST /login returns numbers array");
  const sessionToken = loginRes.json.token;
  const auth = { Authorization: `Bearer ${sessionToken}` };

  // Session Query
  const sessionRes = await request("/session", {
    headers: { Authorization: `Bearer ${sessionToken}` }
  });
  assert(sessionRes.status === 200 && sessionRes.json.loggedIn === true, "GET /session validates session token");

  // Mode 2: SIP Direct Login
  const sipLoginRes = await request("/login-sip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sipUser: "play12345678",
      callerId: TEST_FROM_NUMBER
    })
  });
  assert(sipLoginRes.status === 200 && sipLoginRes.json.ok === true, "POST /login-sip returns HTTP 200");
  assert(sipLoginRes.json.callerId === TEST_FROM_NUMBER, "POST /login-sip registers direct caller ID");
  assert(Boolean(sipLoginRes.json.token), "POST /login-sip returns a SIP-scoped session token");

  // An arbitrary caller ID is caller-ID spoofing on the account.
  const spoof = await request("/login-sip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sipUser: "play12345678", callerId: "+19999999999" })
  });
  assert(spoof.status === 400, "POST /login-sip refuses a caller ID the account does not own");

  // /login-sip proves only knowledge of a DID, which is public. Its session
  // must not reach account data or anything that spends money.
  const sipAuth = { Authorization: `Bearer ${sipLoginRes.json.token}` };
  const sipRecordings = await request("/recordings", { headers: sipAuth });
  assert(sipRecordings.status === 403, "a SIP-direct session cannot list the account's recordings");
  const sipSearch = await request("/api/clickup/search-task?phone=15550188888", { headers: sipAuth });
  assert(sipSearch.status === 403, "a SIP-direct session cannot search ClickUp tasks");
  const sipCdrs = await request("/sync-recent-cdrs", { headers: sipAuth });
  assert(sipCdrs.status === 403, "a SIP-direct session cannot sync CDRs");
  const sipCall = await request("/api/calls/start", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...sipAuth },
    body: JSON.stringify({ to: "+15550199999" })
  });
  assert(sipCall.status === 403, "a SIP-direct session cannot use the call API");
  const sipAgentSip = await request("/api/agent-sip", { headers: sipAuth });
  assert(sipAgentSip.status === 403 && !sipAgentSip.text.includes("sipPassword"), "a SIP-direct session is never served the account SIP password");
  const sipAudio = await request("/recording-audio/rec_123", { headers: sipAuth });
  assert(sipAudio.status === 403, "a SIP-direct session cannot stream recordings without a signature");

  // SIP Credentials for Softphone UA — behind the session. An unauthenticated
  // caller is never shown a SIP password, whatever agent id they name.
  const agentSipAnon = await request("/agent/anyone");
  assert(agentSipAnon.status === 401, "GET /agent/<anyone> refuses an unauthenticated caller");
  assert(!agentSipAnon.text.includes("sipPassword"), "an unauthenticated caller is never shown a SIP password");

  const agentSip = await request("/api/agent-sip", { headers: auth });
  assert(agentSip.status === 200 && agentSip.json.sipUser, "GET /api/agent-sip returns SIP endpoint credentials");
  assert(agentSip.json.sipUser.startsWith("test_sip_user@"), "the configured SIP user is served, not a discovered endpoint paired with the configured password");
  assert(agentSip.json.registrarUrl.startsWith("wss://"), "Registrar URL uses secure WebSocket wss://");

  // 3. Number Selection
  console.log("\n[3/8] Testing Number Selection...");
  const selectAnon = await request("/select-number", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ number: "+15550123456", agentId: "admin" })
  });
  assert(selectAnon.status === 401, "POST /select-number refuses an unauthenticated caller");

  const selectNumRes = await request("/select-number", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`
    },
    body: JSON.stringify({ number: TEST_FROM_NUMBER, agentId: "admin" })
  });
  assert(selectNumRes.status === 200 && selectNumRes.json.selected === TEST_FROM_NUMBER, "POST /select-number updates selected caller ID");

  const selectSpoof = await request("/select-number", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ number: "+15550123456", agentId: "admin" })
  });
  assert(selectSpoof.status === 400, "POST /select-number refuses a caller ID the account does not own");

  // 4. Outbound Calling: Browser-as-A-leg Answer XML
  console.log("\n[4/8] Testing Outbound Call Flow (Browser-as-A-leg)...");
  const outboundAnswer = await request("/answer?From=sip:admin@sip.vobiz.ai&To=%2B15550199999&CallUUID=outbound_uuid_101&RouteType=sip");
  assert(outboundAnswer.status === 200, "GET /answer (Outbound) returns HTTP 200");
  assert(outboundAnswer.headers.get("content-type").includes("xml"), "/answer returns XML content-type");
  assert(outboundAnswer.text.includes("<Dial"), "/answer XML contains <Dial>");
  assert(outboundAnswer.text.includes("<Number>+15550199999</Number>") || outboundAnswer.text.includes("<Number>15550199999</Number>"), "/answer XML dials destination <Number>");
  assert(outboundAnswer.text.includes("<Record"), "/answer XML contains self-closing <Record> for call recording");
  assert(/<Record[^>]*\/>\s*<Dial/.test(outboundAnswer.text), "<Record> is a self-closing sibling before <Dial>, not nested");
  assert(/<Dial[^>]*action="[^"]+\/dial-status"[^>]*redirect="false"/.test(outboundAnswer.text), "<Dial> carries action and redirect=\"false\"");

  // Vobiz posts webhooks form-encoded. The browser's caller-ID header is a
  // request: a number the account does not own must not become the caller ID.
  const outboundForm = await request("/answer", {
    method: "POST",
    headers: form(),
    body: new URLSearchParams({
      From: "sip:test_sip_user@registrar.vobiz.ai",
      To: "+15550177777",
      CallUUID: "outbound_uuid_form",
      "X-VH-Caller-ID": "+19998887777",
    }).toString()
  });
  assert(outboundForm.text.includes("<Number>+15550177777</Number>"), "form-encoded /answer from the softphone dials <Number>");
  assert(outboundForm.text.includes(`callerId="${TEST_FROM_NUMBER}"`), "a caller ID the account does not own is replaced with an owned one");
  assert(!outboundForm.text.includes("<User>"), "an outbound call from the browser never bridges with <Dial><User>");

  // 5. Inbound Calling: PSTN DID to SIP Agent Bridging XML
  console.log("\n[5/8] Testing Inbound Call Flow (PSTN to SIP Agent)...");
  const inboundAnswer = await request("/answer?From=%2B15550188888&To=%2B15550100000&CallUUID=inbound_uuid_202");
  assert(inboundAnswer.status === 200, "GET /answer (Inbound) returns HTTP 200");
  assert(inboundAnswer.text.includes("<User>sip:"), "/answer XML bridges incoming call to agent <User>sip:...");
  assert(inboundAnswer.text.includes("<Record"), "Inbound XML contains <Record> tag");

  const inboundForm = await request("/answer", {
    method: "POST",
    headers: form(),
    body: new URLSearchParams({ From: "919812345678", To: "15550100000", CallUUID: "inbound_uuid_form" }).toString()
  });
  assert(inboundForm.text.includes(`callerId="+15550100000"`), "inbound <Dial> callerId is the dialled DID, in E.164");
  assert(inboundForm.text.includes("<User>sip:test_sip_user@"), "inbound rings the configured SIP endpoint");
  assert(!inboundForm.text.includes("Polly."), "inbound XML uses no voice outside the documented <Speak> set");

  // 6. CDR Logging & ClickUp Task Creation
  console.log("\n[6/8] Testing CDR Logging & ClickUp Task Generation...");
  const dialStatus = await request("/dial-status", {
    method: "POST",
    headers: form(),
    body: new URLSearchParams({
      CallUUID: "outbound_uuid_101",
      DialStatus: "completed",
      DialHangupCause: "NORMAL_CLEARING",
      DialBLegUUID: "bleg_uuid_555",
      DialBLegDuration: "52"
    }).toString()
  });
  assert(dialStatus.status === 200, "POST /dial-status (form-encoded) is acknowledged");

  const afterDial = (await upstream()).filter((r) => r.url.startsWith("/clickup/"));
  const created = afterDial.find((r) => r.method === "POST" && r.url === "/clickup/list/list_1/task");
  assert(Boolean(created), "the dial result creates a ClickUp task in CLICKUP_LIST_ID");
  const createdBody = created ? JSON.parse(created.body) : {};
  assert(createdBody.name === "Vobiz Outbound Call - +15550199999", "task title is direction and customer number");
  assert(String(createdBody.description || "").includes("`52s`") || String(createdBody.description || "").includes("(52s)"), "task carries the B-leg duration from the form-encoded webhook");
  assert(!("status" in createdBody), "no hardcoded status is sent — ClickUp rejects one the list does not define");

  // Simulated call endpoint
  const simCall = await request("/test-simulated-call", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({
      direction: "inbound",
      from: "+15550188888",
      to: "+15550100000",
      duration: 64,
      hangupCause: "NORMAL_CLEARING"
    })
  });
  assert(simCall.status === 200 && simCall.json.status === "success", "POST /test-simulated-call generates call and task");
  assert(simCall.json.clickUpTask && simCall.json.clickUpTask.description.includes("Call Detail Record"), "Task description contains structured Markdown CDR");

  // 7. Call Recording & Signed Playback Proxy
  console.log("\n[7/8] Testing Call Recording Webhooks & Playback Proxy...");
  const recCallback = await request("/recording-ready", {
    method: "POST",
    headers: form(),
    body: new URLSearchParams({
      CallUUID: "outbound_uuid_101",
      RecordingID: "rec_998877",
      RecordUrl: "https://media.vobiz.ai/v1/Account/demo/Recording/sample.mp3",
      RecordingDuration: "52"
    }).toString()
  });
  assert(recCallback.status === 200, "POST /recording-ready captures recording callback");
  assert(!recCallback.text.includes("sig="), "the unauthenticated recording webhook does not echo a signed playback link");

  const clickupCalls = (await upstream()).filter((r) => r.url.startsWith("/clickup/") && r.body.includes("outbound_uuid_101"));
  assert(clickupCalls.filter((r) => r.method === "POST").length === 1, "one call produces one ClickUp task, not one per webhook");
  const update = clickupCalls.find((r) => r.method === "PUT");
  assert(Boolean(update) && update.body.includes("/recording-audio/rec_998877?exp="), "the recording updates the same task with a signed playback link");

  const strayRec = await request("/recording-ready", {
    method: "POST",
    headers: form(),
    body: new URLSearchParams({ CallUUID: "never_answered_here", RecordingID: "rec_x", To: "[x](https://evil.example)" }).toString()
  });
  const strayTask = (await upstream()).some((r) => r.url.startsWith("/clickup/") && r.body.includes("never_answered_here"));
  assert(strayRec.status === 200 && !strayTask, "a recording webhook for a call this server never answered creates no task");

  // Recordings list
  const recListAnon = await request("/recordings");
  assert(recListAnon.status === 401, "GET /recordings refuses an unauthenticated caller");

  const recList = await request("/recordings", { headers: auth });
  assert(recList.status === 200 && Array.isArray(recList.json.recordings), "GET /recordings returns recording list");
  assert(recList.json.recordings.length > 0, "Recordings array contains recent recording");
  const firstRec = recList.json.recordings[0];
  assert(firstRec.playUrl && firstRec.playUrl.includes("sig="), "Recording includes a signed playUrl");

  // 8. Zendesk-Aligned UI, Inbound Call Popup & Static File Serving
  console.log("\n[8/8] Testing Zendesk UI Assets & Inbound Popup Modal markup...");
  const indexHtml = await request("/clickup-app/index.html");
  assert(indexHtml.status === 200, "GET /clickup-app/index.html returns HTTP 200");
  assert(indexHtml.text.includes('id="inboundCallDoneModal"'), "index.html contains Inbound Call Completed Modal");
  assert(indexHtml.text.includes('id="incoming"'), "index.html contains Incoming Call Popup Banner");
  assert(indexHtml.text.includes('id="mode-account-tab"') && indexHtml.text.includes('id="mode-sip-tab"'), "index.html contains Dual Login tabs");
  assert(indexHtml.text.includes('class="keypad-grid"'), "index.html contains DTMF keypad grid");
  assert(indexHtml.text.includes('id="clickupTaskBox"'), "index.html contains ClickUp task matching card");

  const jssipJs = await request("/clickup-app/lib/jssip.min.js");
  assert(jssipJs.status === 200 && jssipJs.text.includes("JsSIP"), "GET /clickup-app/lib/jssip.min.js serves valid JsSIP client library");

  const vobizSipJs = await request("/clickup-app/vobiz-sip.js");
  assert(vobizSipJs.status === 200 && vobizSipJs.text.includes("window.VobizSip"), "GET /clickup-app/vobiz-sip.js serves VobizSip WebRTC layer");

  const softphoneJs = await request("/clickup-app/softphone.js");
  assert(softphoneJs.status === 200 && softphoneJs.text.includes("inboundCallDoneModal"), "GET /clickup-app/softphone.js serves softphone controller");

  const styleCss = await request("/clickup-app/style.css");
  assert(styleCss.status === 200 && styleCss.text.includes(".call-done-modal-backdrop"), "GET /clickup-app/style.css serves Zendesk design stylesheet");

  // 9. Security properties
  //
  // Each of these is a guarantee this backend makes. They are permanent: if any
  // stops holding, the suite fails.
  console.log("\n[9/9] Security properties...");

  // Path traversal. `url.parse` does not normalise dot segments, so a path
  // like `/../backend/.env` reaches the static handler intact — and the file it
  // names holds every credential this integration has.
  const traversal = await rawRequest("/../backend/.env.example");
  assert(traversal.status === 403 || traversal.status === 404, "static serving must refuse ../ traversal");
  assert(!traversal.text.includes("VOBIZ_AUTH_TOKEN"), "traversal must never return backend files");

  const traversalNested = await rawRequest("/clickup-app/../backend/agents.json");
  assert(
    traversalNested.status === 403 || traversalNested.status === 404,
    "static serving must refuse traversal through a valid prefix"
  );
  assert(!traversalNested.text.includes("clickUpUserId"), "traversal must never return agents.json");

  const traversalDeep = await rawRequest("/../../../../etc/passwd");
  assert(traversalDeep.status === 403 || traversalDeep.status === 404, "static serving must refuse absolute escapes");
  assert(!traversalDeep.text.includes("root:"), "traversal must never reach files outside the repo");

  // A media proxy that fetches a caller-supplied URL with X-Auth-ID and
  // X-Auth-Token attached hands them to whatever host is named.
  const exfil = await request(`/recording-file?url=${encodeURIComponent("http://127.0.0.1:1/steal")}`);
  assert(exfil.status === 410, "/recording-file?url= is not implemented, not merely guarded");

  // Playback signatures must actually be checked.
  const unsigned = await request("/recording-audio/rec_123");
  assert(unsigned.status === 403, "/recording-audio must verify the playback signature");
  const forged = await request("/recording-audio/rec_123?exp=99999999999&sig=deadbeef");
  assert(forged.status === 403, "/recording-audio must reject a forged signature");

  // A request with no token is not a session. Answering one `loggedIn: true`
  // with the account's Auth ID would make the whole panel unauthenticated.
  const anonSession = await request("/session");
  assert(anonSession.json && anonSession.json.loggedIn === false, "GET /session without a token is not logged in");
  assert(!anonSession.text.includes(TEST_AUTH_ID), "GET /session must not leak the account Auth ID");

  const sessionByName = await request("/session/admin");
  assert(
    sessionByName.json && sessionByName.json.loggedIn === false,
    "GET /session/<agentId> must prove nothing without a token"
  );

  // Placing a call spends money.
  const callAnon = await request("/api/calls/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: "+15550199999", authId: "attacker", authToken: "attacker" })
  });
  assert(callAnon.status === 401, "POST /api/calls/start must refuse an unauthenticated caller");

  // The REST originate + <Dial><User> design rings the customer into ringback.
  // The softphone is the A leg, so the backend never originates a call.
  const callSigned = await request("/api/calls/start", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ to: "+15550199999" })
  });
  assert(callSigned.status === 409, "POST /api/calls/start does not originate a call, even signed in");
  const originated = (await upstream()).some((r) => r.method === "POST" && /\/Call\/?$/.test(r.url.split("?")[0]));
  assert(!originated, "the backend never POSTed to the Vobiz Call API during the whole suite");

  const softphoneSrc = fs.readFileSync(path.join(__dirname, "..", "clickup-app", "softphone.js"), "utf8");
  assert(!softphoneSrc.includes("/api/calls/start"), "the softphone has no REST-originate fallback");
  const sipSrc = fs.readFileSync(path.join(__dirname, "..", "clickup-app", "vobiz-sip.js"), "utf8");
  const ua = (sipSrc.match(/user_agent:\s*"([^"]+)"/) || [])[1] || "";
  assert(ua && !/\s/.test(ua), "the JsSIP user_agent is set and has no space (a space makes Vobiz block <Dial><User>)");

  const cdrAnon = await request("/sync-recent-cdrs");
  assert(cdrAnon.status === 401, "GET /sync-recent-cdrs must refuse an unauthenticated caller");

  // /health is unauthenticated, so it must describe configuration, not reveal it.
  const healthSec = await request("/health");
  assert(!healthSec.text.includes(TEST_AUTH_ID), "/health must not publish the account Auth ID");
  assert(!healthSec.text.includes("test_sip_user"), "/health must not publish the SIP username");

  // Wildcard CORS let any page on the internet drive this server.
  const corsRes = await request("/health", { headers: { Origin: "https://evil.example" } });
  assert(corsRes.headers.get("access-control-allow-origin") !== "*", "CORS must not be a wildcard");
  assert(
    !corsRes.headers.get("access-control-allow-origin"),
    "an unknown origin must not be echoed back as allowed"
  );

  // A default password in a published file is a published password.
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "backend", "server.js"), "utf8");
  assert(!serverSrc.includes("ClickUpAgent#2026!"), "no hardcoded SIP password may remain in server.js");

  // Summary
  console.log("\n========================================================");
  console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("========================================================\n");

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
