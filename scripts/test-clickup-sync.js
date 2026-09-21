// Test harness to simulate Vobiz Outbound Calls, Inbound Calls, CDR Logging, and Recording Playback for ClickUp.
// Usage:
//   node backend/test-clickup-sync.js --mock-outbound
//   node backend/test-clickup-sync.js --mock-inbound
//   node backend/test-clickup-sync.js --sync-cdrs
//   node backend/test-clickup-sync.js --test-recording

const fs = require("fs");
const path = require("path");

// Load .env variables from backend/.env or local
const envPaths = [
  path.join(__dirname, "..", "backend", ".env"),
  path.join(__dirname, ".env"),
  path.join(process.cwd(), "backend", ".env")
];
for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
      break;
    } catch {
      const lines = fs.readFileSync(envPath, "utf8").split("\n");
      for (const line of lines) {
        const idx = line.indexOf("=");
        if (idx !== -1 && !line.trim().startsWith("#")) {
          const key = line.slice(0, idx).trim();
          const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
          if (key) process.env[key] = val;
        }
      }
      break;
    }
  }
}

const PORT = process.env.PORT || 8092;
const BASE_URL = `http://localhost:${PORT}`;

// These scripts drive a running backend by hand. The routes they touch now sit
// behind a session, so they sign in first with the account credentials in
// backend/.env — the same ones the softphone would use.
let sessionToken = "";

async function signIn() {
  const authId = process.env.VOBIZ_AUTH_ID;
  const authToken = process.env.VOBIZ_AUTH_TOKEN;
  if (!authId || !authToken) {
    console.error("❌ VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN must be set in backend/.env to run these tests.");
    process.exitCode = 1;
    return false;
  }
  const res = await fetch(`${BASE_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: "admin", authId, authToken })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.token) {
    console.error(`❌ Sign-in failed (HTTP ${res.status}): ${json.error || "no token returned"}`);
    process.exitCode = 1;
    return false;
  }
  sessionToken = json.token;
  return true;
}

function authHeaders(extra = {}) {
  return { ...extra, ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}) };
}

// A failing test has to fail the process, or CI reads it as a pass.
function fail(message) {
  console.error(`\n❌ ${message}`);
  process.exitCode = 1;
}

async function testMockOutbound() {
  console.log(`\n==================================================`);
  console.log(`🧪 Testing Simulated OUTBOUND Call & Recording Sync to ClickUp`);
  console.log(`==================================================`);

  const testTo = process.env.TEST_DESTINATION_NUMBER || process.env.VOBIZ_TEST_NUMBER || "+15550199999";
  const authId = process.env.VOBIZ_AUTH_ID || "demo";
  const mockPayload = {
    direction: "outbound",
    from: process.env.VOBIZ_FROM_NUMBER || "+15550100000",
    to: testTo,
    duration: 45,
    recordingUrl: `https://media.vobiz.ai/v1/Account/${authId}/Recording/sample_recording.mp3`,
    hangupCause: "NORMAL_CLEARING",
    agentId: "admin",
    callUuid: `outbound_test_${Date.now()}`
  };

  console.log("Sending outbound call payload to local server endpoint '/test-simulated-call':");
  console.log(JSON.stringify(mockPayload, null, 2));

  try {
    const res = await fetch(`${BASE_URL}/test-simulated-call`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(mockPayload)
    });

    const json = await res.json();
    console.log("\n--- Server Response ---");
    console.log(JSON.stringify(json, null, 2));

    if (res.ok && json.status === "success") {
      console.log("\n✅ Outbound call test PASSED!");
      if (json.clickUpTask && json.clickUpTask.simulated) {
        console.log("💡 (ClickUp task simulated locally because real CLICKUP_API_TOKEN is not configured)");
      }
    } else {
      fail("Outbound call test FAILED!");
    }
  } catch (err) {
    fail(`Network error connecting to backend server: ${err.message}`);
    console.error("Make sure the backend server is running via 'npm start' or 'node backend/server.js'");
  }
}

async function testMockInbound() {
  console.log(`\n==================================================`);
  console.log(`🧪 Testing Simulated INBOUND Call & Recording Sync to ClickUp`);
  console.log(`==================================================`);

  const testFrom = process.env.TEST_CALLER_NUMBER || "+15550188888";
  const authId = process.env.VOBIZ_AUTH_ID || "demo";
  const mockPayload = {
    direction: "inbound",
    from: testFrom,
    to: process.env.VOBIZ_FROM_NUMBER || "+15550100000",
    duration: 65,
    recordingUrl: `https://media.vobiz.ai/v1/Account/${authId}/Recording/sample_recording.mp3`,
    hangupCause: "NORMAL_CLEARING",
    agentId: "admin",
    callUuid: `inbound_test_${Date.now()}`
  };

  console.log("Sending inbound call payload to local server endpoint '/test-simulated-call':");
  console.log(JSON.stringify(mockPayload, null, 2));

  try {
    const res = await fetch(`${BASE_URL}/test-simulated-call`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(mockPayload)
    });

    const json = await res.json();
    console.log("\n--- Server Response ---");
    console.log(JSON.stringify(json, null, 2));

    if (res.ok && json.status === "success") {
      console.log("\n✅ Inbound call test PASSED!");
      if (json.clickUpTask && json.clickUpTask.simulated) {
        console.log("💡 (ClickUp task simulated locally because real CLICKUP_API_TOKEN is not configured)");
      }
    } else {
      fail("Inbound call test FAILED!");
    }
  } catch (err) {
    fail(`Network error connecting to backend server: ${err.message}`);
    console.error("Make sure the backend server is running via 'npm start' or 'node backend/server.js'");
  }
}

async function testSyncCdrs() {
  console.log(`\n==================================================`);
  console.log(`🧪 Testing Live CDR Sync Endpoint '/sync-recent-cdrs'`);
  console.log(`==================================================`);

  try {
    const res = await fetch(`${BASE_URL}/sync-recent-cdrs`, { headers: authHeaders() });
    const json = await res.json();
    console.log(JSON.stringify(json, null, 2));

    if (res.ok && json.status === "success") {
      console.log(`\n✅ CDR Sync Test PASSED! Total CDRs processed: ${json.totalFetched}`);
    } else {
      fail(`CDR Sync Test FAILED! Status: ${res.status}`);
    }
  } catch (err) {
    fail(`Network error connecting to backend server: ${err.message}`);
  }
}

async function testRecordingProxy() {
  console.log(`\n==================================================`);
  console.log(`🧪 Testing Recording Playback Security`);
  console.log(`==================================================`);

  // The old test pointed a caller-supplied URL at /recording-file and called
  // any 200 a pass — the endpoint it was exercising leaked the account
  // credentials to whatever host it was given. Both properties are checked now:
  // that route is gone, and unsigned playback is refused.
  try {
    const exfil = await fetch(`${BASE_URL}/recording-file?url=${encodeURIComponent("http://127.0.0.1:1/steal")}`);
    if (exfil.status === 410) {
      console.log("✅ /recording-file?url= is gone (HTTP 410).");
    } else {
      fail(`/recording-file?url= answered HTTP ${exfil.status}; it must be removed.`);
    }

    const unsigned = await fetch(`${BASE_URL}/recording-audio/any_recording_id`);
    if (unsigned.status === 403) {
      console.log("✅ Unsigned /recording-audio playback is refused (HTTP 403).");
    } else {
      fail(`/recording-audio without a signature answered HTTP ${unsigned.status}; it must be 403.`);
    }
  } catch (err) {
    fail(`Recording playback security test error: ${err.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  const needsSession =
    args.includes("--mock-outbound") || args.includes("--mock-inbound") || args.includes("--sync-cdrs");
  if (needsSession && !(await signIn())) return;

  if (args.includes("--mock-outbound")) {
    await testMockOutbound();
  } else if (args.includes("--mock-inbound")) {
    await testMockInbound();
  } else if (args.includes("--sync-cdrs")) {
    await testSyncCdrs();
  } else if (args.includes("--test-recording")) {
    await testRecordingProxy();
  } else {
    console.log(`
Vobiz ClickUp Integration Test Runner
-------------------------------------
Usage:
  node scripts/test-clickup-sync.js --mock-outbound   # Run simulated outbound call test
  node scripts/test-clickup-sync.js --mock-inbound    # Run simulated inbound call test
  node scripts/test-clickup-sync.js --sync-cdrs       # Run live CDR & Recording sync test
  node scripts/test-clickup-sync.js --test-recording   # Test secure recording proxy endpoint
`);
  }
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exitCode = 1;
});
