/**
 * Verification suite for the Vobiz ClickUp Calling integration.
 *
 * Runs against a backend started by run-verification.js, with the Vobiz and
 * ClickUp APIs replaced by a local stand-in holding two fake accounts. Covers:
 *  1. Health
 *  2. Sign-in with any Vobiz account: provisioning, distinct endpoints, refusals
 *  2b. SIP Direct sign-in with zero server config
 *  3. Caller ID selection from the account's own numbers
 *  4. Outbound /answer routed to the right account
 *  5. Inbound /answer routed by ParentAuthID, then by dialled number
 *  6. CDR to ClickUp task
 *  7. Recordings, account-scoped
 *  8. Panel assets
 *  9. Security properties, including "no Auth Token in any HTTP response"
 */

const net = require("net");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8092);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const MOCK_URL = process.env.MOCK_URL || "";
const DATA_DIR = process.env.DATA_DIR || "";
const ACCOUNTS = JSON.parse(process.env.TEST_ACCOUNTS || "{}");

const A = "MA_TEST0001";
const B = "MA_TEST0002";
const TOKEN_A = (ACCOUNTS[A] || {}).token || "";
const TOKEN_B = (ACCOUNTS[B] || {}).token || "";
const NUM_A = "+910000000001";
const NUM_A2 = "+910000000005";
const NUM_B = "+910000000002";
const APP_A = "43919358318796814";
const APP_B = "43919358318796999";

/** Requests the backend made to the stand-in Vobiz and ClickUp APIs. */
async function upstream() {
  if (!MOCK_URL) return [];
  const res = await fetch(`${MOCK_URL}/__requests`);
  return res.json();
}

function form() {
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

// Every response body and header block the suite sees, so the last section can
// assert that no Auth Token ever left the server.
const seenResponses = [];

async function request(pathname, options = {}) {
  const res = await fetch(`${BASE_URL}${pathname}`, { redirect: "manual", ...options });
  const text = await res.text();
  seenResponses.push(text + JSON.stringify([...res.headers.entries()]));
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {}
  return { status: res.status, headers: res.headers, text, json };
}

function post(pathname, body, extraHeaders = {}) {
  return request(pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function postForm(pathname, params) {
  return request(pathname, { method: "POST", headers: form(), body: new URLSearchParams(params).toString() });
}

/**
 * Send a request line verbatim, without letting a client library normalise it.
 * fetch() collapses "/../" before the request leaves, so it cannot exercise a
 * path traversal.
 */
function rawRequest(rawPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, "127.0.0.1", () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\n\r\n`);
    });
    let buf = "";
    socket.on("data", (d) => (buf += d.toString()));
    socket.on("end", () => {
      seenResponses.push(buf);
      const status = Number((buf.match(/^HTTP\/1\.\d (\d{3})/) || [])[1] || 0);
      resolve({ status, text: buf });
    });
    socket.on("error", reject);
  });
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const sipUserOf = (agentSip) => String((agentSip.json && agentSip.json.sipUser) || "").split("@")[0];

async function runTests() {
  console.log("\n========================================================");
  console.log("🧪 RUNNING VOBIZ CLICKUP INTEGRATION TEST SUITE");
  console.log("========================================================\n");

  // 1. Health
  console.log("[1/9] Server health...");
  const health = await request("/health");
  assert(health.status === 200, "GET /health returns HTTP 200");
  assert(health.json && health.json.service === "vobiz-clickup-calling", "Service identifier is 'vobiz-clickup-calling'");

  // 2. Sign-in with any Vobiz account
  console.log("\n[2/9] Sign-in with any Vobiz account...");

  const wrongToken = await post("/login", { agentId: "admin", authId: A, authToken: "not-the-token" });
  assert(wrongToken.status === 401, "a wrong Auth Token for a real account is refused with 401");
  assert(!(wrongToken.json && wrongToken.json.token), "a refused sign-in issues no session token");
  assert(/invalid/i.test((wrongToken.json && wrongToken.json.error) || ""), "the refusal says the credentials are invalid");

  const unknown = await post("/login", { agentId: "admin", authId: "MA_NOBODY00", authToken: "x" });
  assert(unknown.status === 401, "an account Vobiz does not know is refused");

  const missing = await post("/login", { agentId: "admin", authId: A });
  assert(missing.status === 400, "sign-in without an Auth Token is a 400");

  const loginA = await post("/login", { agentId: "admin", authId: A, authToken: TOKEN_A });
  assert(loginA.status === 200 && loginA.json && loginA.json.token, "account A signs in");
  const loginB = await post("/login", { agentId: "admin", authId: B, authToken: TOKEN_B });
  assert(loginB.status === 200 && loginB.json && loginB.json.token, "account B, a different account, also signs in");
  const tokA = loginA.json.token;
  const tokB = loginB.json.token;

  assert(
    JSON.stringify(loginA.json.numbers) === JSON.stringify([NUM_A, NUM_A2]),
    "A's caller IDs are every active, voice-enabled number across all pages, and nothing else"
  );
  assert(loginA.json.selected === NUM_A, "the default caller ID is the account's first number");
  assert(JSON.stringify(loginB.json.numbers) === JSON.stringify([NUM_B]), "B's caller IDs are B's own numbers");
  const detailA = (loginA.json.numberDetails || []).find((n) => n.e164 === NUM_A) || {};
  assert(detailA.applicationId === "11111111111111111", "each number carries the application it is attached to now");
  assert(loginA.json.appId === APP_A, "the integration's 17-digit app id comes back intact, as a string");

  const sipA = await request("/api/agent-sip", { headers: bearer(tokA) });
  const sipB = await request("/api/agent-sip", { headers: bearer(tokB) });
  const userA = sipUserOf(sipA);
  const userB = sipUserOf(sipB);
  assert(sipA.status === 200 && sipA.json.sipPassword && sipA.json.registrarUrl.startsWith("wss://"), "A gets SIP credentials for its softphone");
  assert(userA && userB && userA !== userB, "the two accounts get distinct endpoints");
  assert(/^[A-Za-z0-9]+$/.test(userA) && userA.includes("1187694299"), "the SIP user is the stored (rewritten) username, read back from Vobiz");

  let up = await upstream();
  const createdApps = up.filter((r) => r.method === "POST" && /\/Application\/$/.test(r.url));
  assert(createdApps.length === 2, "each account gets this integration's application created once");
  assert(
    createdApps.every((r) => JSON.parse(r.body).answer_url === `${BASE_URL}/answer` && JSON.parse(r.body).answer_method === "POST"),
    "the application's answer_url is this backend's /answer, POST"
  );
  assert(!up.some((r) => /\/Application\/11111111111111111/.test(r.url)), "an application the integration did not create is never touched");

  const bindA = up.find((r) => r.method === "POST" && r.authId === A && /\/Endpoint\/\d+\/$/.test(r.url) && r.body.includes("app_id"));
  assert(Boolean(bindA) && bindA.body === `{"app_id":"${APP_A}"}`, `the bind body carries the 17-digit app id exactly: {"app_id":"${APP_A}"}`);
  const bindB = up.filter((r) => r.method === "POST" && r.authId === B && /\/Endpoint\/\d+\/$/.test(r.url));
  assert(
    bindB.some((r) => r.body === `{"application":${APP_B}}`),
    `when {"app_id"} does not take, the retry is {"application":${APP_B}} — the integer, not rounded`
  );
  const endpointsNow = MOCK_URL ? await (await fetch(`${MOCK_URL}/__endpoints`)).json() : [];
  const boundA = endpointsNow.find(([, e]) => e.username === userA);
  const boundB = endpointsNow.find(([, e]) => e.username === userB);
  assert(boundA && boundA[1].application === APP_A && boundB && boundB[1].application === APP_B, "both endpoints end up bound to their own account's application");
  assert(!up.some((r) => /\/numbers\/[^/]+\/application/.test(r.url)), "signing in never attaches a number for inbound");

  // Same agent signs in again: same endpoint, fresh password, old session gone.
  const createsBefore = up.filter((r) => r.method === "POST" && /\/Endpoint\/$/.test(r.url)).length;
  const loginA2 = await post("/login", { agentId: "admin", authId: A, authToken: TOKEN_A });
  const tokA2 = loginA2.json && loginA2.json.token;
  const sipA2 = await request("/api/agent-sip", { headers: bearer(tokA2) });
  up = await upstream();
  assert(up.filter((r) => r.method === "POST" && /\/Endpoint\/$/.test(r.url)).length === createsBefore, "signing in again reuses the agent's endpoint");
  assert(sipUserOf(sipA2) === userA && sipA2.json.sipPassword !== sipA.json.sipPassword, "each sign-in sets a fresh SIP password");
  const oldSession = await request("/session", { headers: bearer(tokA) });
  assert(oldSession.json && oldSession.json.loggedIn === false, "the previous session for that agent ends");
  const pwdSet = up.filter((r) => r.authId === A && /\/Endpoint\/\d+\/$/.test(r.url) && r.body.includes('"password"'));
  assert(pwdSet.length >= 1, "the new password is set with POST /Endpoint/{id}/");

  const loginA1 = await post("/login", { agentId: "agent1", authId: A, authToken: TOKEN_A });
  const tokA1 = loginA1.json && loginA1.json.token;
  const userA1 = sipUserOf(await request("/api/agent-sip", { headers: bearer(tokA1) }));
  assert(userA1 && userA1 !== userA, "a second agent on the same account gets its own endpoint");

  const loginB1 = await post("/login", { agentId: "agent1", authId: B, authToken: TOKEN_B });
  const tokB1 = loginB1.json && loginB1.json.token;
  const userB1 = sipUserOf(await request("/api/agent-sip", { headers: bearer(tokB1) }));
  up = await upstream();
  assert(userB1 === "cuagent1preexisting", "an endpoint with the agent's exact alias is found and reused");
  assert(
    !up.some((r) => r.method === "POST" && r.authId === B && /\/Endpoint\/$/.test(r.url) && r.body.includes("agent1")),
    "no duplicate endpoint is created for it"
  );

  if (DATA_DIR) {
    const file = path.join(DATA_DIR, "endpoints.json");
    const stat = fs.statSync(file);
    const stored = fs.readFileSync(file, "utf8");
    assert((stat.mode & 0o777) === 0o600, "endpoints.json is mode 0600");
    assert(stored.includes(`${A}:admin`) && stored.includes(`${B}:admin`), "the endpoint map is keyed by account:agent");
    assert(!stored.includes(TOKEN_A) && !stored.includes(TOKEN_B) && !/password/i.test(stored), "no token or password is written to disk");
  }

  const sessionA = await request("/session", { headers: bearer(tokA2) });
  assert(sessionA.json && sessionA.json.loggedIn === true && sessionA.json.authId === A, "GET /session validates the session token");

  // 2b. SIP Direct
  console.log("\n[2b/9] SIP Direct sign-in...");
  const sipDirect = await post("/login-sip", { sipUser: "directagent01", callerId: "+91 00000 00009" });
  assert(sipDirect.status === 200 && sipDirect.json.token, "SIP Direct signs in with no account configured on the server");
  assert(sipDirect.json.callerId === "+910000000009", "the typed caller ID is normalised to E.164");
  const tokSip = sipDirect.json.token;
  const badCid = await post("/login-sip", { sipUser: "directagent02", callerId: "call me" });
  assert(badCid.status === 400, "SIP Direct refuses a caller ID that is not a phone number");
  const hijack = await post("/login-sip", { sipUser: userA, callerId: "+910000000008" });
  assert(hijack.status === 409, "SIP Direct cannot take over an endpoint an account sign-in provisioned");
  const dupDid = await post("/login-sip", { sipUser: "directagent03", callerId: "+910000000009" });
  assert(dupDid.status === 409, "two SIP Direct agents cannot claim the same inbound number");
  for (const [p, name] of [
    ["/recordings", "recordings"],
    ["/api/numbers", "the number list"],
    ["/sync-recent-cdrs", "CDR sync"],
    ["/api/clickup/search-task?phone=15550188888", "ClickUp task search"],
  ]) {
    const r = await request(p, { headers: bearer(tokSip) });
    assert(r.status === 403 && /Vobiz account/.test(r.text), `SIP Direct is told to sign in with the account for ${name}`);
  }
  const sipEnable = await post("/api/inbound/enable", { number: "+910000000009" }, bearer(tokSip));
  assert(sipEnable.status === 403, "SIP Direct cannot attach numbers");
  const sipAgentSip = await request("/api/agent-sip", { headers: bearer(tokSip) });
  assert(sipAgentSip.status === 403 && !sipAgentSip.text.includes("sipPassword"), "SIP Direct is never served a SIP password");

  // 3. Caller ID selection
  console.log("\n[3/9] Caller ID selection...");
  const selectAnon = await post("/select-number", { number: NUM_A });
  assert(selectAnon.status === 401, "POST /select-number refuses an unauthenticated caller");
  const select2 = await post("/select-number", { number: NUM_A2 }, bearer(tokA2));
  assert(select2.status === 200 && select2.json.selected === NUM_A2, "an agent can pick another of the account's numbers");
  const selectOther = await post("/select-number", { number: NUM_B }, bearer(tokA2));
  assert(selectOther.status === 400, "another account's number is refused as a caller ID");
  const selectInactive = await post("/select-number", { number: "+910000000003" }, bearer(tokA2));
  assert(selectInactive.status === 400, "an inactive number on the account is refused");
  const selectNoVoice = await post("/select-number", { number: "+910000000004" }, bearer(tokA2));
  assert(selectNoVoice.status === 400, "a number with voice disabled is refused");
  const numbersA = await request("/api/numbers", { headers: bearer(tokA2) });
  assert(numbersA.json && numbersA.json.selected === NUM_A2, "the agent's last pick is remembered for the session");
  await post("/select-number", { number: NUM_A }, bearer(tokA2));

  // 4. Outbound
  console.log("\n[4/9] Outbound /answer, routed by SIP user...");
  const outA = await postForm("/answer", { From: `sip:${userA}@registrar.vobiz.ai`, To: "+15550199999", CallUUID: "out_a", Direction: "outbound" });
  assert(outA.headers.get("content-type").includes("xml"), "/answer returns XML");
  assert(outA.text.includes(`callerId="${NUM_A}"`) && outA.text.includes("<Number>+15550199999</Number>"), "A's call goes out from A's chosen number");
  assert(/<Record[^>]*\/>\s*<Dial/.test(outA.text), "<Record> is a self-closing sibling before <Dial>");
  assert(/<Dial[^>]*action="[^"]+\/dial-status"[^>]*redirect="false"/.test(outA.text), "<Dial> carries action and redirect=\"false\"");
  const outB = await postForm("/answer", { From: `sip:${userB}@registrar.vobiz.ai`, To: "+15550199998", CallUUID: "out_b" });
  assert(outB.text.includes(`callerId="${NUM_B}"`), "B's call goes out from B's number");
  const outHdr = await postForm("/answer", { From: `sip:${userA}@registrar.vobiz.ai`, To: "+15550199997", CallUUID: "out_hdr", "X-VH-Caller-ID": NUM_A2 });
  assert(outHdr.text.includes(`callerId="${NUM_A2}"`), "an X-VH-Caller-ID header naming one of the account's numbers is used");
  const outSpoof = await postForm("/answer", {
    From: `sip:${userA}@registrar.vobiz.ai`,
    To: "+15550177777",
    CallUUID: "out_spoof",
    "SIPHeader_X-VH-Caller-ID": NUM_B,
  });
  assert(outSpoof.text.includes(`callerId="${NUM_A}"`) && !outSpoof.text.includes(NUM_B), "another account's number in the header is ignored");
  assert(!outSpoof.text.includes("<User>"), "an outbound call from the browser never bridges with <Dial><User>");
  const outStranger = await postForm("/answer", { From: "sip:nobodyhere@registrar.vobiz.ai", To: "+15550199999", CallUUID: "out_x" });
  assert(outStranger.text.includes("<Hangup") && !outStranger.text.includes("<Dial"), "an unknown SIP user gets a polite hangup, not a call");
  const outSip = await postForm("/answer", { From: "sip:directagent01@registrar.vobiz.ai", To: "+15550199990", CallUUID: "out_sip" });
  assert(outSip.text.includes('callerId="+910000000009"'), "a SIP Direct agent's call goes out from the caller ID it typed");

  // 5. Inbound
  console.log("\n[5/9] Inbound /answer, routed to the right account...");
  const inParent = await postForm("/answer", { From: "+15550188888", To: "910000000001", CallUUID: "in_a", Direction: "inbound", ParentAuthID: A });
  assert(inParent.text.includes(`<User>sip:${userA}@`) && inParent.text.includes(`<User>sip:${userA1}@`), "ParentAuthID A rings every signed-in agent of A");
  assert(!inParent.text.includes(userB) && !inParent.text.includes(userB1), "and none of B's");
  assert(inParent.text.includes(`callerId="${NUM_A}"`), "inbound <Dial> callerId is the dialled DID in E.164");
  const inLocal = await postForm("/answer", { From: "+15550188889", To: "09100000000", CallUUID: "in_local", Direction: "inbound", ParentAuthID: A });
  assert(inLocal.text.includes('callerId="+919100000000"'), "a 0-prefixed 11-digit To is normalised to +91…");
  const inByDid = await postForm("/answer", { From: "+15550188887", To: NUM_B, CallUUID: "in_b", Direction: "inbound" });
  assert(inByDid.text.includes(`<User>sip:${userB}@`) && !inByDid.text.includes(userA), "without ParentAuthID, the dialled number finds account B");
  const inSip = await postForm("/answer", { From: "+15550188886", To: "+910000000009", CallUUID: "in_sip", Direction: "inbound" });
  assert(inSip.text.includes("<User>sip:directagent01@"), "a SIP Direct agent's number rings that agent");
  const inNobody = await postForm("/answer", { From: "+15550188885", To: "+910000000077", CallUUID: "in_none", Direction: "inbound" });
  assert(inNobody.text.includes("<Hangup") && !inNobody.text.includes("<Dial"), "a number no signed-in account owns gets a polite hangup");
  assert(!inNobody.text.includes("Polly."), "inbound XML uses no voice outside the documented <Speak> set");

  // 5b. Enable inbound calls
  const enableAnon = await post("/api/inbound/enable", { number: NUM_A });
  assert(enableAnon.status === 401, "Enable inbound refuses an unauthenticated caller");
  const enableOther = await post("/api/inbound/enable", { number: NUM_B }, bearer(tokA2));
  assert(enableOther.status === 400, "Enable inbound refuses another account's number");
  const enable = await post("/api/inbound/enable", { number: NUM_A }, bearer(tokA2));
  up = await upstream();
  const attach = up.find((r) => r.method === "POST" && /\/numbers\/%2B910000000001\/application$/.test(r.url));
  assert(enable.status === 200 && attach && attach.authId === A, "Enable inbound attaches the number in A's account");
  assert(attach && attach.body === `{"application_id":"${APP_A}"}`, "with the integration's app id as a string");

  // 6. CDR to ClickUp
  console.log("\n[6/9] CDR to ClickUp task...");
  const dialStatus = await postForm("/dial-status", {
    CallUUID: "out_a",
    DialStatus: "completed",
    DialHangupCause: "NORMAL_CLEARING",
    DialBLegUUID: "bleg_uuid_555",
    DialBLegDuration: "52",
  });
  assert(dialStatus.status === 200, "POST /dial-status (form-encoded) is acknowledged");
  const created = (await upstream()).find((r) => r.method === "POST" && r.url === "/clickup/list/list_1/task" && r.body.includes("out_a"));
  assert(Boolean(created), "the dial result creates a ClickUp task in CLICKUP_LIST_ID");
  const createdBody = created ? JSON.parse(created.body) : {};
  assert(createdBody.name === "Vobiz Outbound Call - +15550199999", "task title is direction and customer number");
  assert(String(createdBody.description || "").includes("(52s)"), "task carries the B-leg duration");
  assert(String(createdBody.description || "").includes(NUM_A), "task records A's caller ID");
  assert(!("status" in createdBody), "no hardcoded status is sent");

  const simCall = await post("/test-simulated-call", { direction: "inbound", from: "+15550188888", duration: 64 }, bearer(tokA2));
  assert(simCall.status === 200 && simCall.json.clickUpTask.description.includes("Call Detail Record"), "POST /test-simulated-call logs a structured CDR");

  // 7. Recordings
  console.log("\n[7/9] Recordings, account-scoped...");
  const recCallback = await postForm("/recording-ready", {
    CallUUID: "out_a",
    RecordingID: "rec_998877",
    RecordUrl: "https://media.vobiz.ai/v1/Account/x/Recording/sample.mp3",
    RecordingDuration: "52",
  });
  assert(recCallback.status === 200 && !recCallback.text.includes("sig="), "the recording webhook is acknowledged without echoing a link");
  const forCall = (await upstream()).filter((r) => r.url.startsWith("/clickup/") && r.body.includes("out_a"));
  assert(forCall.filter((r) => r.method === "POST").length === 1, "one call produces one ClickUp task");
  const update = forCall.find((r) => r.method === "PUT");
  assert(Boolean(update) && update.body.includes(`/recording-audio/rec_998877?a=${A}&exp=`), "the task gets a playback link naming A's account");

  const stray = await postForm("/recording-ready", { CallUUID: "never_answered_here", RecordingID: "rec_x" });
  const strayTask = (await upstream()).some((r) => r.url.startsWith("/clickup/") && r.body.includes("never_answered_here"));
  assert(stray.status === 200 && !strayTask, "a recording webhook for a call this server never answered creates no task");

  const recAnon = await request("/recordings");
  assert(recAnon.status === 401, "GET /recordings refuses an unauthenticated caller");
  const recA = await request("/recordings", { headers: bearer(tokA2) });
  const recB = await request("/recordings", { headers: bearer(tokB) });
  const idsA = (recA.json.recordings || []).map((r) => r.recording_id);
  const idsB = (recB.json.recordings || []).map((r) => r.recording_id);
  assert(idsA.join() === "rec_A1" && idsB.join() === "rec_B1", "each account sees only its own recordings");
  up = await upstream();
  assert(
    up.some((r) => r.authId === A && /\/Account\/MA_TEST0001\/Recording\/\?/.test(r.url)) &&
      up.some((r) => r.authId === B && /\/Account\/MA_TEST0002\/Recording\/\?/.test(r.url)),
    "each list is fetched with that account's own credentials"
  );
  const linkA = recA.json.recordings[0].playUrl;
  assert(linkA.includes(`a=${A}`) && linkA.includes("sig="), "playback links are signed and name their account");

  const pathA = linkA.slice(linkA.indexOf("/recording-audio/"));
  const goodA = await request(pathA);
  const fetchedWithA = (await upstream()).some((r) => r.authId === A && /\/Account\/MA_TEST0001\/Recording\/rec_A1\/$/.test(r.url));
  assert(goodA.status !== 403 && fetchedWithA, "a valid link for A fetches A's recording with A's credentials");
  const swapped = await request(pathA.replace(`a=${A}`, `a=${B}`));
  assert(swapped.status === 403, "the same link with the account swapped to B is refused");
  const crossViewer = await request(`/recording-audio/rec_A1?a=${A}`, { headers: bearer(tokB) });
  assert(crossViewer.status === 403, "B's session cannot play A's recording unsigned");

  // 8. Panel
  console.log("\n[8/9] Panel assets...");
  const indexHtml = await request("/clickup-app/index.html");
  assert(indexHtml.status === 200, "GET /clickup-app/index.html returns HTTP 200");
  assert(indexHtml.text.includes('id="inboundCallDoneModal"') && indexHtml.text.includes('id="incoming"'), "index.html has the inbound popups");
  assert(indexHtml.text.includes('id="mode-account-tab"') && indexHtml.text.includes('id="mode-sip-tab"'), "index.html offers both sign-in tabs");
  assert(indexHtml.text.includes('id="enable-inbound-btn"'), "index.html has Enable inbound calls");
  assert(/<select id="vobiz-number-select"/.test(indexHtml.text), "the account-mode caller ID is a dropdown, not free text");
  assert(indexHtml.text.includes('class="keypad-grid"') && indexHtml.text.includes('id="clickupTaskBox"'), "index.html has the keypad and task card");

  const jssip = await request("/clickup-app/lib/jssip.min.js");
  assert(jssip.status === 200 && jssip.text.includes("JsSIP"), "serves the JsSIP library");
  const vobizSip = await request("/clickup-app/vobiz-sip.js");
  assert(vobizSip.status === 200 && vobizSip.text.includes("connectDirect"), "serves the SIP layer with both connect modes");
  const softphone = await request("/clickup-app/softphone.js");
  assert(softphone.status === 200 && softphone.text.includes("inboundCallDoneModal"), "serves the softphone controller");
  const css = await request("/clickup-app/style.css");
  assert(css.status === 200 && css.text.includes(".call-done-modal-backdrop"), "serves the stylesheet");

  // 9. Security properties
  console.log("\n[9/9] Security properties...");
  const traversal = await rawRequest("/../backend/.env.example");
  assert(traversal.status === 403 || traversal.status === 404, "static serving refuses ../ traversal");
  assert(!traversal.text.includes("SIGNING_SECRET"), "traversal never returns backend files");
  const traversalNested = await rawRequest("/clickup-app/../backend/agents.json");
  assert(traversalNested.status === 403 || traversalNested.status === 404, "static serving refuses traversal through a valid prefix");
  assert(!traversalNested.text.includes("clickUpUserId"), "traversal never returns agents.json");
  const traversalDeep = await rawRequest("/../../../../etc/passwd");
  assert(traversalDeep.status === 403 || traversalDeep.status === 404, "static serving refuses absolute escapes");
  assert(!traversalDeep.text.includes("root:"), "traversal never reaches files outside the repo");

  const exfil = await request(`/recording-file?url=${encodeURIComponent("http://127.0.0.1:1/steal")}`);
  assert(exfil.status === 410, "/recording-file?url= is not implemented, not merely guarded");
  const unsigned = await request("/recording-audio/rec_123");
  assert(unsigned.status === 403, "/recording-audio verifies the playback signature");
  const forged = await request(`/recording-audio/rec_123?a=${A}&exp=99999999999&sig=deadbeef`);
  assert(forged.status === 403, "/recording-audio rejects a forged signature");

  const anonSession = await request("/session");
  assert(anonSession.json && anonSession.json.loggedIn === false, "GET /session without a token is not logged in");
  const sessionByName = await request("/session/admin");
  assert(sessionByName.json && sessionByName.json.loggedIn === false, "GET /session/<agentId> proves nothing without a token");
  const agentAnon = await request("/agent/anyone");
  assert(agentAnon.status === 401 && !agentAnon.text.includes("sipPassword"), "an unauthenticated caller is never shown a SIP password");

  const callAnon = await post("/api/calls/start", { to: "+15550199999", authId: "attacker", authToken: "attacker" });
  assert(callAnon.status === 401, "POST /api/calls/start refuses an unauthenticated caller");
  const callSigned = await post("/api/calls/start", { to: "+15550199999" }, bearer(tokA2));
  assert(callSigned.status === 409, "POST /api/calls/start does not originate a call, even signed in");
  const originated = (await upstream()).some((r) => r.method === "POST" && /\/Call\/?$/.test(r.url.split("?")[0]));
  assert(!originated, "the backend never POSTed to the Vobiz Call API during the whole suite");

  const cdrAnon = await request("/sync-recent-cdrs");
  assert(cdrAnon.status === 401, "GET /sync-recent-cdrs refuses an unauthenticated caller");

  const healthSec = await request("/health");
  assert(!healthSec.text.includes(A) && !healthSec.text.includes(userA), "/health names no account and no SIP user");

  const corsRes = await request("/health", { headers: { Origin: "https://evil.example" } });
  assert(corsRes.headers.get("access-control-allow-origin") !== "*", "CORS is not a wildcard");
  assert(!corsRes.headers.get("access-control-allow-origin"), "an unknown origin is not echoed back as allowed");

  const root = path.join(__dirname, "..");
  const softphoneSrc = fs.readFileSync(path.join(root, "clickup-app", "softphone.js"), "utf8");
  const indexSrc = fs.readFileSync(path.join(root, "clickup-app", "index.html"), "utf8");
  const serverSrc = fs.readFileSync(path.join(root, "backend", "server.js"), "utf8");
  const envExample = fs.readFileSync(path.join(root, "backend", ".env.example"), "utf8");
  assert(!softphoneSrc.includes("/api/calls/start"), "the softphone has no REST-originate fallback");
  // The only number allowed is the "Test Inbound Call" preview's fictional 555-01xx caller.
  const hardNumbers = (softphoneSrc.match(/\+\d{8,15}/g) || []).filter((n) => !/5550\d{3}$/.test(n) && !/55501\d\d/.test(n));
  assert(hardNumbers.length === 0, "the softphone hard-codes no real phone number or default caller ID");
  assert(!/value="\+\d|placeholder="\+\d{6,}/.test(indexSrc), "the panel hard-codes no caller ID");
  assert(!/VOBIZ_(AUTH_ID|AUTH_TOKEN|FROM_NUMBER|SIP_USER|SIP_PASSWORD)/.test(serverSrc), "server.js reads no Vobiz account credentials from env");
  assert(!/VOBIZ_(AUTH_ID|AUTH_TOKEN|FROM_NUMBER|SIP_USER|SIP_PASSWORD)/.test(envExample), ".env.example asks for no Vobiz account credentials");
  assert(!serverSrc.includes("ClickUpAgent#2026!"), "no hardcoded SIP password remains in server.js");
  const sipSrc = fs.readFileSync(path.join(root, "clickup-app", "vobiz-sip.js"), "utf8");
  const ua = (sipSrc.match(/user_agent:\s*"([^"]+)"/) || [])[1] || "";
  assert(ua && !/\s/.test(ua), "the JsSIP user_agent is set and has no space");

  // Last: nothing the server sent, to anyone, carried an Auth Token.
  const leaked = seenResponses.some((t) => (TOKEN_A && t.includes(TOKEN_A)) || (TOKEN_B && t.includes(TOKEN_B)));
  assert(TOKEN_A && TOKEN_B && !leaked, `no Auth Token appeared in any of the ${seenResponses.length} HTTP responses`);

  console.log("\n========================================================");
  console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("========================================================\n");
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
