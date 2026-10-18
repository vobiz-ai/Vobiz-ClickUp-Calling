/**
 * Starts a backend with test configuration, runs verify-integration.js against
 * it, and exits with that suite's status.
 *
 * The suite owns the server it tests, rather than expecting one to have been
 * started by hand — otherwise CI tests whatever happens to be running, or
 * nothing at all.
 *
 * VOBIZ_API_URL and CLICKUP_API_URL point at a local stand-in, never the real
 * services: no test may place a call, spend money or write to a workspace.
 *
 * The Vobiz stand-in holds two fake accounts, MA_TEST0001 and MA_TEST0002,
 * each with its own token, numbers, applications and endpoints, and behaves the
 * way the documented API does where it matters:
 *   - a wrong token is a 401;
 *   - POST /Endpoint/ rewrites the submitted username, so only a read-back
 *     shows the one that registers;
 *   - app_id is 17 digits and is returned as a bare JSON number, which
 *     JSON.parse would silently round;
 *   - the numbers list pages (page/per_page/total) and carries inactive and
 *     voice-disabled numbers that must not be offered as caller IDs;
 *   - MA_TEST0001 binds an endpoint from {"app_id":"<id>"}; MA_TEST0002 only
 *     from the documented {"application": <int>}, so the fallback is exercised.
 * It records every request so the suite can assert what the backend did not do
 * as well as what it did.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.TEST_PORT || 8093);
const MOCK_PORT = PORT + 100;

const ACCOUNTS = {
  MA_TEST0001: {
    token: "tok-one-SECRET-0001-do-not-leak",
    numbers: [
      { e164: "+910000000001", status: "active", voice_enabled: true, application_id: "11111111111111111" },
      { e164: "+910000000003", status: "inactive", voice_enabled: true },
      { e164: "+910000000004", status: "active", voice_enabled: false },
      // Fillers push the next active number onto page 2.
      ...Array.from({ length: 100 }, (_, i) => ({ e164: `+9100000002${String(i).padStart(2, "0")}`, status: "inactive" })),
      { e164: "+910000000005", status: "active", voice_enabled: true, application_id: null },
    ],
    bindsFrom: "app_id",
    // Someone else's application. The backend must never touch it.
    apps: [{ app_id: "11111111111111111", answer_url: "https://other-integration.example/answer" }],
    nextAppId: "43919358318796814",
    recordings: [{ recording_id: "rec_A1", call_uuid: "cdr_a1", add_time: "2026-01-01 10:00", rounded_recording_duration: 30 }],
  },
  MA_TEST0002: {
    token: "tok-two-SECRET-0002-do-not-leak",
    numbers: [{ e164: "+910000000002", status: "active", voice_enabled: true, application_id: "" }],
    bindsFrom: "application",
    apps: [],
    nextAppId: "43919358318796999",
    recordings: [{ recording_id: "rec_B1", call_uuid: "cdr_b1", add_time: "2026-01-01 11:00", rounded_recording_duration: 40 }],
  },
};
const endpoints = new Map(); // endpointId -> { authId, username, alias, application }
let endpointSeq = 0;
// An endpoint MA_TEST0002 already has for agent1, from an earlier install whose
// data dir is gone: found by its exact alias, not created again.
endpoints.set("69999999", { authId: "MA_TEST0002", username: "cuagent1preexisting", alias: "ClickUp-agent1", application: "" });

const mockRequests = [];
let taskSeq = 0;

function appIdLiteral(id) {
  // A bare number, exactly as text — the shape that breaks JSON.parse.
  return /^\d+$/.test(id) ? id : JSON.stringify(id);
}

/** The app id this account's stand-in honours from a request body, or "". */
function bindFrom(acct, body) {
  if (acct.bindsFrom === "app_id") return (body.match(/"app_id":"(\d+)"/) || [])[1] || "";
  return (body.match(/"application":(\d+)/) || [])[1] || "";
}

function endpointJson(id) {
  const ep = endpoints.get(id);
  const app = ep.application ? `{"app_id":${appIdLiteral(ep.application)},"app_name":"x"}` : "null";
  return `{"endpoint_id":"${id}","username":"${ep.username}","alias":"${ep.alias}","application":${app}}`;
}

function handleVobiz(req, res, body) {
  const m = req.url.match(/^\/api\/v1\/Account\/([^/]+)(\/[^?]*)?(\?.*)?$/);
  if (!m) {
    res.statusCode = 404;
    return res.end("{}");
  }
  const authId = decodeURIComponent(m[1]);
  const sub = m[2] || "/";
  const acct = ACCOUNTS[authId];
  if (!acct || req.headers["x-auth-id"] !== authId || req.headers["x-auth-token"] !== acct.token) {
    res.statusCode = 401;
    return res.end('{"error":"invalid credentials"}');
  }

  if (sub === "/numbers" && req.method === "GET") {
    const q = new URLSearchParams((m[3] || "").slice(1));
    const page = Number(q.get("page") || 1);
    const perPage = Number(q.get("per_page") || 25);
    const items = acct.numbers.slice((page - 1) * perPage, page * perPage);
    return res.end(JSON.stringify({ items, page, per_page: perPage, total: acct.numbers.length }));
  }
  if (sub === "/Endpoint/" && req.method === "GET") {
    const objs = [...endpoints.entries()].filter(([, e]) => e.authId === authId).map(([id]) => endpointJson(id));
    return res.end(`{"meta":{"limit":100,"offset":0,"next":null},"objects":[${objs.join(",")}]}`);
  }
  if (sub === "/Application/" && req.method === "GET") {
    const objs = acct.apps.map((a) => `{"app_id":${appIdLiteral(a.app_id)},"answer_url":${JSON.stringify(a.answer_url)}}`);
    return res.end(`{"meta":{"limit":100,"offset":0,"next":null},"objects":[${objs.join(",")}]}`);
  }
  if (sub === "/Application/" && req.method === "POST") {
    const parsed = JSON.parse(body || "{}");
    const app_id = acct.nextAppId;
    acct.apps.push({ app_id, answer_url: parsed.answer_url });
    res.statusCode = 201;
    return res.end(`{"api_id":"t","app_id":${app_id},"message":"created"}`);
  }
  if (sub === "/Endpoint/" && req.method === "POST") {
    const submitted = (body.match(/"username":"([^"]*)"/) || [])[1] || "";
    const alias = (body.match(/"alias":"([^"]*)"/) || [])[1] || "";
    const application = bindFrom(acct, body);
    const id = String(70000000 + ++endpointSeq);
    // Vobiz rewrites the username it was given.
    endpoints.set(id, { authId, username: `${submitted}1187694299${endpointSeq}`, alias, application });
    res.statusCode = 201;
    return res.end(JSON.stringify({ message: "created", endpoint_id: id, username: submitted }));
  }
  const epm = sub.match(/^\/Endpoint\/(\d+)\/$/);
  if (epm) {
    const ep = endpoints.get(epm[1]);
    if (!ep || ep.authId !== authId) {
      res.statusCode = 404;
      return res.end("");
    }
    if (req.method === "GET") return res.end(endpointJson(epm[1]));
    if (req.method === "POST") {
      const app = bindFrom(acct, body);
      if (app) ep.application = app;
      res.statusCode = 202;
      return res.end("");
    }
  }
  if (/^\/numbers\/[^/]+\/application$/.test(sub) && req.method === "POST") {
    res.statusCode = 202;
    return res.end("{}");
  }
  if (sub === "/Recording/" && req.method === "GET") return res.end(JSON.stringify({ objects: acct.recordings }));
  if (/^\/Recording\/[^/]+\/$/.test(sub)) {
    // Never hand back a media URL: following it would leave the machine.
    res.statusCode = 404;
    return res.end("{}");
  }
  if (sub.startsWith("/cdr/recent")) return res.end(JSON.stringify({ data: [] }));
  if (/\/Call\//.test(sub)) return res.end(JSON.stringify({ request_uuid: "should-never-happen" }));
  return res.end("{}");
}

const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/__requests") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify(mockRequests));
    }
    if (req.url === "/__endpoints") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify([...endpoints.entries()]));
    }
    mockRequests.push({ method: req.method, url: req.url, authId: req.headers["x-auth-id"] || "", body });
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/clickup/")) {
      const parsed = body ? JSON.parse(body) : {};
      const id = req.method === "PUT" ? req.url.split("/").pop() : `task_${++taskSeq}`;
      return res.end(JSON.stringify({ ...parsed, id, url: `https://app.clickup.com/t/${id}` }));
    }
    return handleVobiz(req, res, body);
  });
});

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vobiz-clickup-test-"));

const TEST_ENV = {
  ...process.env,
  PORT: String(PORT),
  VOBIZ_API_URL: `http://127.0.0.1:${MOCK_PORT}`,
  MOCK_URL: `http://127.0.0.1:${MOCK_PORT}`,
  TUNNEL_URL: `http://127.0.0.1:${PORT}`,
  DATA_DIR,
  SIGNING_SECRET: "test_signing_secret",
  CLICKUP_API_TOKEN: "pk_test_token",
  CLICKUP_LIST_ID: "list_1",
  CLICKUP_API_URL: `http://127.0.0.1:${MOCK_PORT}/clickup`,
  TEST_ACCOUNTS: JSON.stringify(Object.fromEntries(Object.entries(ACCOUNTS).map(([id, a]) => [id, { token: a.token }]))),
};
for (const k of ["CLICKUP_TASK_STATUS", "PUBLIC_BASE_URL", "VOBIZ_AUTH_ID", "VOBIZ_AUTH_TOKEN", "VOBIZ_FROM_NUMBER", "VOBIZ_SIP_USER", "VOBIZ_SIP_PASSWORD"]) {
  delete TEST_ENV[k];
}

mock.listen(MOCK_PORT, "127.0.0.1");

let serverLog = "";
const server = spawn("node", [path.join(__dirname, "..", "backend", "server.js")], {
  env: TEST_ENV,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => {
  serverLog += d;
  process.stdout.write(`[server] ${d}`);
});
server.stderr.on("data", (d) => {
  serverLog += d;
  process.stderr.write(`[server] ${d}`);
});

function shutdown(code) {
  try {
    server.kill();
  } catch {
    /* already gone */
  }
  mock.close();
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  process.exit(code);
}

async function waitForServer(attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  if (!(await waitForServer())) {
    console.error("[verify] backend never became healthy");
    shutdown(1);
  }

  const suite = spawn("node", [path.join(__dirname, "verify-integration.js")], {
    env: { ...TEST_ENV, PORT: String(PORT) },
    stdio: "inherit",
  });
  suite.on("close", (code) => {
    // The Auth Tokens must never be logged. The suite cannot see the server's
    // output, so this check lives here.
    const leaked = Object.values(ACCOUNTS).some((a) => serverLog.includes(a.token));
    if (leaked) {
      console.error("  ❌ FAIL: an account Auth Token appeared in the server log");
      return shutdown(1);
    }
    console.log("  ✅ PASS: no account Auth Token appeared in the server log");
    shutdown(code === null ? 1 : code);
  });
})();
