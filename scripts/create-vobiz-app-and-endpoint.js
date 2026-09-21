#!/usr/bin/env node
/**
 * Automated provisioning script for Vobiz Voice Application & SIP Endpoint.
 *
 * Performs:
 * 1. Creates a Vobiz Voice Application with /answer and /hangup-callback webhooks.
 * 2. Creates a Vobiz SIP Endpoint bound to this application for WebRTC calling.
 * 3. Links your Vobiz DID phone number to the new Application for inbound routing.
 * 4. Automatically updates backend/.env with the generated credentials.
 *
 * Usage:
 *   node scripts/create-vobiz-app-and-endpoint.js
 *   node scripts/create-vobiz-app-and-endpoint.js --auth-id=MA_XXX --auth-token=YYY --tunnel-url=https://xxx.trycloudflare.com
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ENV_FILE = path.join(__dirname, "..", "backend", ".env");
const TUNNEL_URL_FILE = path.join(__dirname, "..", "backend", "tunnel-url.txt");

// Parse command line arguments (--key=val)
const args = {};
process.argv.slice(2).forEach((arg) => {
  if (arg.startsWith("--")) {
    const [k, v] = arg.slice(2).split("=");
    args[k] = v || true;
  }
});

// Load existing .env if present
const envVars = {};
if (fs.existsSync(ENV_FILE)) {
  const content = fs.readFileSync(ENV_FILE, "utf8");
  content.split("\n").forEach((line) => {
    const idx = line.indexOf("=");
    if (idx !== -1 && !line.trim().startsWith("#")) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      if (k) envVars[k] = v;
    }
  });
}

// Determine parameters
const AUTH_ID = args["auth-id"] || envVars.VOBIZ_AUTH_ID || "";
const AUTH_TOKEN = args["auth-token"] || envVars.VOBIZ_AUTH_TOKEN || "";
const API_URL = (args["api-url"] || envVars.VOBIZ_API_URL || "https://api.vobiz.ai").replace(/\/+$/, "");

let tunnelUrl = args["tunnel-url"] || envVars.TUNNEL_URL || "";
if (!tunnelUrl && fs.existsSync(TUNNEL_URL_FILE)) {
  try {
    tunnelUrl = fs.readFileSync(TUNNEL_URL_FILE, "utf8").trim();
  } catch (_) {}
}

const endpointPrefix = args["username"] || "clickupagent";
const endpointPassword = args["password"] || crypto.randomBytes(10).toString("hex") + "Aa1!";
const endpointAlias = args["alias"] || "ClickUp Softphone Agent";

async function main() {
  console.log("\n========================================================");
  console.log("🛠️  VOBIZ APPLICATION & SIP ENDPOINT PROVISIONING");
  console.log("========================================================\n");

  if (!AUTH_ID || !AUTH_TOKEN || AUTH_ID.includes("YOUR_")) {
    console.error("❌ Missing Vobiz Auth ID or Auth Token.");
    console.error("Please ensure VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN are set in backend/.env");
    console.error("Or pass them via: node scripts/create-vobiz-app-and-endpoint.js --auth-id=MA_XXX --auth-token=YYY\n");
    process.exit(1);
  }

  if (!tunnelUrl) {
    console.warn("⚠️  Warning: No public tunnel URL provided.");
    console.warn("Vobiz webhooks require a public HTTPS URL (e.g. from Cloudflare tunnel).");
    console.warn("You can start a tunnel using: npm run tunnel in a separate terminal.");
    console.warn("Using placeholder 'https://your-tunnel.trycloudflare.com' for now.\n");
    tunnelUrl = "https://your-tunnel.trycloudflare.com";
  }

  const cleanTunnel = tunnelUrl.replace(/\/+$/, "");
  console.log(`• Vobiz Auth ID:       ${AUTH_ID}`);
  console.log(`• Webhook Base URL:    ${cleanTunnel}`);
  console.log(`• Desired Endpoint:    ${endpointPrefix}`);

  const authHeaders = {
    "X-Auth-ID": AUTH_ID,
    "X-Auth-Token": AUTH_TOKEN,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // ─── Step 1: Create Vobiz Voice Application ──────────────────────────────
  console.log("\n[1/3] Creating Vobiz Voice Application...");
  const appPayload = {
    app_name: `ClickUp Calling App (${new Date().toISOString().slice(0, 10)})`,
    answer_url: `${cleanTunnel}/answer`,
    answer_method: "POST",
    hangup_url: `${cleanTunnel}/hangup-callback`,
    hangup_method: "POST",
    fallback_answer_url: `${cleanTunnel}/fallback`,
    fallback_method: "POST",
  };

  let appId = "";
  try {
    const appRes = await fetch(`${API_URL}/api/v1/Account/${AUTH_ID}/Application/`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(appPayload),
    });

    const appText = await appRes.text();
    let appJson;
    try { appJson = JSON.parse(appText); } catch { appJson = { raw: appText }; }

    if (!appRes.ok && appRes.status !== 201 && appRes.status !== 200 && appRes.status !== 202) {
      throw new Error(`HTTP ${appRes.status}: ${appText}`);
    }

    appId = appJson.app_id || appJson.id || (appJson.data && appJson.data.app_id) || "";
    console.log(`✅ Voice Application created successfully! Application ID: ${appId}`);
  } catch (err) {
    console.error(`❌ Failed to create Application: ${err.message}`);
    console.log("Continuing with endpoint creation without app binding...");
  }

  // ─── Step 2: Create Vobiz SIP Endpoint ──────────────────────────────────
  console.log("\n[2/3] Creating Vobiz SIP Endpoint...");
  const endpointPayload = {
    username: endpointPrefix,
    password: endpointPassword,
    alias: endpointAlias,
    ...(appId ? { app_id: appId } : {}),
  };

  let finalSipUsername = "";
  try {
    const endRes = await fetch(`${API_URL}/api/v1/Account/${AUTH_ID}/Endpoint/`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(endpointPayload),
    });

    const endText = await endRes.text();
    let endJson;
    try { endJson = JSON.parse(endText); } catch { endJson = { raw: endText }; }

    if (!endRes.ok && endRes.status !== 201 && endRes.status !== 200 && endRes.status !== 202) {
      throw new Error(`HTTP ${endRes.status}: ${endText}`);
    }

    finalSipUsername = endJson.username || endJson.sip_username || (endJson.data && endJson.data.username) || endpointPrefix;
    console.log(`✅ SIP Endpoint created successfully!`);
    console.log(`• Stored SIP Username: ${finalSipUsername}`);
    console.log(`• SIP Password:        ${endpointPassword}`);
    console.log(`• Registrar:           registrar.vobiz.ai`);
  } catch (err) {
    console.error(`❌ Failed to create SIP Endpoint: ${err.message}`);
  }

  // ─── Step 3: Link Account Phone Number to Application ───────────────────
  console.log("\n[3/3] Checking Account Numbers to Link...");
  let attachedNumber = envVars.VOBIZ_FROM_NUMBER || "";
  try {
    const numRes = await fetch(`${API_URL}/api/v1/Account/${AUTH_ID}/numbers`, {
      headers: authHeaders,
    });
    if (numRes.ok) {
      const numJson = await numRes.json();
      const numbers = (numJson.objects || numJson.items || []).map((n) => n.e164 || n.number).filter(Boolean);
      if (numbers.length > 0) {
        attachedNumber = numbers[0];
        console.log(`Found ${numbers.length} account number(s). Primary number: ${attachedNumber}`);

        if (appId) {
          console.log(`Linking number ${attachedNumber} to Application ${appId}...`);
          const encodedNum = encodeURIComponent(attachedNumber);
          const linkRes = await fetch(`${API_URL}/api/v1/Account/${AUTH_ID}/Number/${encodedNum}/application/`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({ app_id: appId }),
          });
          if (linkRes.ok) {
            console.log(`✅ Number ${attachedNumber} linked to Application!`);
          } else {
            console.log(`ℹ️ Number attachment returned HTTP ${linkRes.status} (May be linked via Vobiz Console).`);
          }
        }
      } else {
        console.log("ℹ️ No numbers currently found on account. You can purchase or link a DID in Vobiz Console.");
      }
    }
  } catch (e) {
    console.warn("Could not check numbers:", e.message);
  }

  // ─── Step 4: Update backend/.env ─────────────────────────────────────────
  if (finalSipUsername) {
    console.log("\n[4/4] Updating backend/.env with new credentials...");
    let envContent = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";

    const updates = {
      VOBIZ_AUTH_ID: AUTH_ID,
      VOBIZ_AUTH_TOKEN: AUTH_TOKEN,
      VOBIZ_SIP_USER: finalSipUsername,
      VOBIZ_SIP_PASSWORD: endpointPassword,
      VOBIZ_REGISTRAR: "registrar.vobiz.ai",
      VOBIZ_FROM_NUMBER: attachedNumber || "+15550100000",
      ...(appId ? { VOBIZ_APP_ID: appId } : {}),
      ...(cleanTunnel && !cleanTunnel.includes("your-tunnel") ? { TUNNEL_URL: cleanTunnel } : {}),
    };

    for (const [k, v] of Object.entries(updates)) {
      const regex = new RegExp(`^${k}=.*$`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${k}=${v}`);
      } else {
        envContent += `\n${k}=${v}`;
      }
    }

    fs.writeFileSync(ENV_FILE, envContent.trim() + "\n", "utf8");
    console.log("✅ backend/.env updated successfully!");
  }

  console.log("\n========================================================");
  console.log("🎉 PROVISIONING SUMMARY");
  console.log("========================================================");
  console.log(`Application ID:  ${appId || "Manual setup in console needed"}`);
  console.log(`SIP Username:    ${finalSipUsername || endpointPrefix}`);
  console.log(`SIP Password:    ${endpointPassword}`);
  console.log(`Registrar:       wss://registrar.vobiz.ai:5063/`);
  console.log(`Caller DID:      ${attachedNumber || "+15550100000"}`);
  console.log(`Answer URL:      ${cleanTunnel}/answer`);
  console.log(`Hangup URL:      ${cleanTunnel}/hangup-callback`);
  console.log("========================================================\n");
}

main().catch((err) => {
  console.error("Fatal error during provisioning:", err);
  process.exit(1);
});
