const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8092;
const TUNNEL_URL_FILE_BACKEND = path.join(__dirname, "..", "backend", "tunnel-url.txt");
const TUNNEL_URL_FILE_SCRIPTS = path.join(__dirname, "tunnel-url.txt");

const cloudflaredLocations = [
  path.join(__dirname, "..", "backend", "cloudflared.exe"),
  path.join(__dirname, "cloudflared.exe"),
  path.join(process.cwd(), "backend", "cloudflared.exe")
];
const localCloudflared = cloudflaredLocations.find(p => fs.existsSync(p));
const cmd = localCloudflared || "cloudflared";

console.log(`[tunnel] Starting Cloudflare Quick Tunnel using binary: ${cmd}...`);

const tunnel = spawn(cmd, [
  "tunnel",
  "--protocol", "http2",
  "--url", `http://localhost:${PORT}`
]);

let urlFound = false;

function parseOutput(data) {
  const text = data.toString();
  process.stderr.write(data); // Forward cloudflared logs to console

  if (!urlFound) {
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match) {
      const url = match[0];
      urlFound = true;
      console.log(`\n==================================================`);
      console.log(`[tunnel] 🚀 Captured Quick Tunnel Public URL: ${url}`);
      console.log(`[tunnel] Saving active public URL to ${TUNNEL_URL_FILE_BACKEND}...`);
      console.log(`==================================================\n`);
      fs.writeFileSync(TUNNEL_URL_FILE_BACKEND, url, "utf8");
      try { fs.writeFileSync(TUNNEL_URL_FILE_SCRIPTS, url, "utf8"); } catch {}
    }
  }
}

tunnel.stdout.on("data", parseOutput);
tunnel.stderr.on("data", parseOutput);

tunnel.on("error", (err) => {
  if (err.code === "ENOENT") {
    console.error("\n[tunnel] ❌ ERROR: 'cloudflared' command or binary not found.");
    console.error("[tunnel] Please ensure cloudflared.exe is in backend/ or installed on system.");
  } else {
    console.error("[tunnel] Process error:", err);
  }
});

tunnel.on("close", (code) => {
  console.log(`[tunnel] cloudflared process exited with code ${code}`);
  [TUNNEL_URL_FILE_BACKEND, TUNNEL_URL_FILE_SCRIPTS].forEach(f => {
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
        console.log(`[tunnel] Cleaned up ${path.basename(f)}`);
      } catch {}
    }
  });
});

// Clean up process on SIGINT / SIGTERM
process.on("SIGINT", () => {
  tunnel.kill();
  process.exit();
});
process.on("SIGTERM", () => {
  tunnel.kill();
  process.exit();
});
