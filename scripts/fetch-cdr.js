// Run after a test call or for manual testing to pull CDRs + recordings using the real Vobiz APIs.
// Usage: node scripts/fetch-cdr.js [--sync]

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

const { VOBIZ_AUTH_ID, VOBIZ_AUTH_TOKEN, VOBIZ_API_URL = "https://api.vobiz.ai", PORT = 8092 } = process.env;

async function main() {
  console.log(`\n==================================================`);
  console.log(`📡 Fetching Vobiz CDRs & Recordings for ${VOBIZ_AUTH_ID}`);
  console.log(`==================================================`);

  if (!VOBIZ_AUTH_ID || !VOBIZ_AUTH_TOKEN || VOBIZ_AUTH_ID.includes("YOUR_")) {
    console.error("❌ Vobiz API credentials (VOBIZ_AUTH_ID / VOBIZ_AUTH_TOKEN) not configured in backend/.env");
    process.exit(1);
  }

  const headers = {
    "X-Auth-ID": VOBIZ_AUTH_ID,
    "X-Auth-Token": VOBIZ_AUTH_TOKEN,
  };

  console.log(`\n--- Most recent CDRs (Call Detail Records) ---`);
  try {
    const cdrRes = await fetch(
      `${VOBIZ_API_URL}/api/v1/Account/${VOBIZ_AUTH_ID}/cdr/recent?limit=5`,
      { headers }
    );
    const cdrJson = await cdrRes.json();
    if (!cdrRes.ok) {
      console.error("❌ CDR fetch failed:", cdrRes.status, cdrJson);
    } else {
      const cdrs = cdrJson.data || [];
      for (const c of cdrs) {
        console.log(
          `- ${c.start_time} | ${(c.call_direction || "outbound").padEnd(8)} | ${c.caller_id_number} -> ${c.destination_number} | ` +
          `duration=${c.duration}s | hangup=${c.hangup_cause} | uuid=${c.uuid}`
        );
      }
      if (cdrs.length === 0) {
        console.log("(No CDRs found yet. Note: CDRs appear a few seconds after a call completes)");
      }
    }
  } catch (err) {
    console.error("❌ CDR fetch network error:", err.message);
  }

  console.log(`\n--- Most recent Call Recordings ---`);
  try {
    const recRes = await fetch(
      `${VOBIZ_API_URL}/api/v1/Account/${VOBIZ_AUTH_ID}/Recording/?limit=5`,
      { headers }
    );
    const recJson = await recRes.json();
    if (!recRes.ok) {
      console.error("❌ Recording fetch failed:", recRes.status, recJson);
    } else {
      const list = recJson.data || recJson.recordings || [];
      for (const r of list) {
        console.log(`- UUID: ${r.call_uuid || r.uuid || "N/A"} | URL: ${r.record_url || r.recording_url || r.url || "N/A"}`);
      }
      if (list.length === 0) {
        console.log("(No recordings found yet)");
      }
    }
  } catch (err) {
    console.error("❌ Recording fetch network error:", err.message);
  }

  if (process.argv.includes("--sync")) {
    console.log(`\n==================================================`);
    console.log(`🔄 Triggering ClickUp CDR & Recording Synchronization`);
    console.log(`==================================================`);
    try {
      // /sync-recent-cdrs sits behind a session, so sign in with the account
      // this backend is bound to first.
      const login = await fetch(`http://localhost:${PORT}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authId: VOBIZ_AUTH_ID, authToken: VOBIZ_AUTH_TOKEN }),
      });
      const loginJson = await login.json().catch(() => ({}));
      if (!login.ok || !loginJson.token) {
        throw new Error(`sign-in to the backend failed: HTTP ${login.status} ${loginJson.error || ""}`);
      }
      const res = await fetch(`http://localhost:${PORT}/sync-recent-cdrs`, {
        headers: { Authorization: `Bearer ${loginJson.token}` },
      });
      const syncJson = await res.json();
      if (!res.ok) process.exitCode = 1;
      console.log(JSON.stringify(syncJson, null, 2));
    } catch (err) {
      console.error("❌ Sync trigger failed (Is 'npm start' / 'node backend/server.js' running?):", err.message);
    }
  }
}

main().catch((err) => console.error("fetch-cdr failed:", err));
