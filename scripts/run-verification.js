/**
 * Starts a backend with test configuration, runs verify-integration.js against
 * it, and exits with that suite's status.
 *
 * The suite owns the server it tests, rather than expecting one to have been
 * started by hand — otherwise CI tests whatever happens to be running, or
 * nothing at all.
 *
 * VOBIZ_API_URL points at a closed port on purpose: no test may reach the real
 * Vobiz API, place a call, or spend money.
 */
const { spawn } = require("child_process");
const path = require("path");

const PORT = Number(process.env.TEST_PORT || 8093);
const TEST_ENV = {
  ...process.env,
  PORT: String(PORT),
  VOBIZ_AUTH_ID: "test_auth_id",
  VOBIZ_AUTH_TOKEN: "test_auth_token",
  VOBIZ_FROM_NUMBER: "+15550100000",
  VOBIZ_SIP_USER: "test_sip_user",
  VOBIZ_SIP_PASSWORD: "test_sip_password",
  VOBIZ_API_URL: "http://127.0.0.1:1",
  TUNNEL_URL: `http://127.0.0.1:${PORT}`,
  SIGNING_SECRET: "test_signing_secret",
  CLICKUP_API_TOKEN: "pk_YOUR_CLICKUP_PERSONAL_API_TOKEN",
  CLICKUP_LIST_ID: "YOUR_CLICKUP_LIST_ID",
};

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
