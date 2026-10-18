/**
 * Starts a backend with test configuration, runs verify-integration.js against
 * it, and exits with that suite's status.
 *
 * The suite owns the server it tests, rather than expecting one to have been
 * started by hand — otherwise CI tests whatever happens to be running, or
 * nothing at all.
 *
 * VOBIZ_API_URL and CLICKUP_API_URL point at a local stand-in, never the real
 * services: no test may place a call, spend money or write to a workspace. The
 * stand-in accepts any Vobiz credentials — the way a stranger's own valid
 * account would — and records every request, so the suite can assert what the
 * backend did not do as well as what it did.
 */
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.TEST_PORT || 8093);
const MOCK_PORT = PORT + 100;

const mockRequests = [];
let taskSeq = 0;
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/__requests") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify(mockRequests));
    }
    mockRequests.push({ method: req.method, url: req.url, authId: req.headers["x-auth-id"] || "", body });
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/clickup/")) {
      const parsed = body ? JSON.parse(body) : {};
      const id = req.method === "PUT" ? req.url.split("/").pop() : `task_${++taskSeq}`;
      return res.end(JSON.stringify({ ...parsed, id, url: `https://app.clickup.com/t/${id}` }));
    }
    if (/\/Endpoint\//.test(req.url)) return res.end(JSON.stringify({ objects: [{ username: "someone_elses_endpoint" }] }));
    if (/\/numbers/.test(req.url)) return res.end(JSON.stringify({ objects: [] }));
    if (/\/Recording\//.test(req.url)) {
      res.statusCode = 404;
      return res.end("{}");
    }
    if (/\/Call\//.test(req.url)) return res.end(JSON.stringify({ request_uuid: "should-never-happen" }));
    return res.end("{}");
  });
});
const TEST_ENV = {
  ...process.env,
  PORT: String(PORT),
  VOBIZ_AUTH_ID: "test_auth_id",
  VOBIZ_AUTH_TOKEN: "test_auth_token",
  VOBIZ_FROM_NUMBER: "+15550100000",
  VOBIZ_SIP_USER: "test_sip_user",
  VOBIZ_SIP_PASSWORD: "test_sip_password",
  VOBIZ_API_URL: `http://127.0.0.1:${MOCK_PORT}`,
  MOCK_URL: `http://127.0.0.1:${MOCK_PORT}`,
  TUNNEL_URL: `http://127.0.0.1:${PORT}`,
  SIGNING_SECRET: "test_signing_secret",
  CLICKUP_API_TOKEN: "pk_test_token",
  CLICKUP_LIST_ID: "list_1",
  CLICKUP_API_URL: `http://127.0.0.1:${MOCK_PORT}/clickup`,
};
delete TEST_ENV.CLICKUP_TASK_STATUS;

mock.listen(MOCK_PORT, "127.0.0.1");

const server = spawn("node", [path.join(__dirname, "..", "backend", "server.js")], {
  env: TEST_ENV,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

function shutdown(code) {
  try {
    server.kill();
  } catch {
    /* already gone */
  }
  mock.close();
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
  suite.on("close", (code) => shutdown(code === null ? 1 : code));
})();
