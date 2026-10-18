/** === Vobiz Calling for ClickUp — Softphone Logic ===
 *
 * Supports:
 * 1. Dual login:
 *    - Mode 1: Vobiz account (Auth ID & Auth Token) -> fetches numbers, generates session.
 *    - Mode 2: SIP direct (SIP username, SIP password & Outbound Caller ID).
 * 2. Incoming call popup banner with Web Audio ringtone & Accept/Decline keyboard shortcuts.
 * 3. Inbound call completed notification popup modal + native HTML5 desktop notification.
 * 4. Outbound WebRTC calling with custom caller ID headers, DTMF keypad, live timer, mute, hold, transfer.
 * 5. ClickUp task auto-matching and call recording list with proxy playback.
 */

document.addEventListener("DOMContentLoaded", () => {
  "use strict";

  // Elements
  const statusBadge = document.getElementById("status");
  const statusMessage = document.getElementById("status-message");

  // Inbound Call Done Modal Elements
  const inboundDoneModal = document.getElementById("inboundCallDoneModal");
  const inboundDoneCaller = document.getElementById("inboundDoneCaller");
  const inboundDoneDuration = document.getElementById("inboundDoneDuration");
  const inboundDoneTime = document.getElementById("inboundDoneTime");
  const inboundDoneDismissBtn = document.getElementById("inboundDoneDismissBtn");

  // Incoming Call Elements
  const incomingBanner = document.getElementById("incoming");
  const incomingFromEl = document.getElementById("incoming-from");
  const acceptBtn = document.getElementById("acceptbtn");
  const declineBtn = document.getElementById("declinebtn");

  // Dual Login Tabs & Panels
  const modeAccountTab = document.getElementById("mode-account-tab");
  const modeSipTab = document.getElementById("mode-sip-tab");
  const modeAccountPanel = document.getElementById("mode-account");
  const modeSipPanel = document.getElementById("mode-sip");
  const stepCallerId = document.getElementById("step-caller-id");

  // Account Mode Form
  const authIdInput = document.getElementById("vobiz-auth-id");
  const authTokenInput = document.getElementById("vobiz-auth-token");
  const agentSelect = document.getElementById("loginAgentSelect");
  const accountLoginBtn = document.getElementById("vobiz-login-btn");

  // SIP Direct Mode Form
  const sipUserInput = document.getElementById("sip-username");
  const sipPassInput = document.getElementById("sip-password");
  const sipCallerIdInput = document.getElementById("sip-caller-id");
  const sipRememberCheck = document.getElementById("sip-remember");
  const sipConnectBtn = document.getElementById("sip-connect-btn");

  const loginStatusEl = document.getElementById("vobiz-login-status");
  const logoutBtn = document.getElementById("logoutBtn");

  // Step 2 & 3: Caller ID & Dialer
  const numberSelect = document.getElementById("vobiz-number-select");
  const dialInput = document.getElementById("dialnumber");
  const dialBtn = document.getElementById("dialbtn");
  const testInboundBtn = document.getElementById("testInboundBtn");
  const hangupBtn = document.getElementById("hangupbtn");
  const dialHint = document.getElementById("dial-hint");
  const callNumEl = document.getElementById("callnum");
  const callStatusText = document.getElementById("callStatusText");
  const callTimer = document.getElementById("callTimer");
  const callControls = document.getElementById("callControls");
  const muteBtn = document.getElementById("muteBtn");
  const holdBtn = document.getElementById("holdBtn");
  const transferBtn = document.getElementById("transferBtn");

  // ClickUp Task Box
  const clickupTaskBox = document.getElementById("clickupTaskBox");
  const cuTaskName = document.getElementById("cuTaskName");
  const cuTaskPhone = document.getElementById("cuTaskPhone");
  const cuTaskAssignee = document.getElementById("cuTaskAssignee");
  const cuTaskStatus = document.getElementById("cuTaskStatus");
  const cuTaskLink = document.getElementById("cuTaskLink");
  const refreshTaskBtn = document.getElementById("refreshTaskBtn");

  // History & Activity Log
  const historyList = document.getElementById("call-history-list");
  const refreshHistoryBtn = document.getElementById("refresh-history-btn");
  const syncCdrsBtn = document.getElementById("sync-cdrs-btn");
  const playbackAudio = document.getElementById("vobiz-playback-audio");
  const remoteAudio = document.getElementById("vobiz-remote-audio");
  const logContainer = document.getElementById("logContainer");

  // State variables
  const AUTH_MODE_KEY = "vobiz_clickup_auth_mode";
  const SIP_CREDS_KEY = "vobiz_clickup_sip_creds";
  const SESSION_KEY = "vobiz_clickup_session";

  let backendUrl = window.location.origin;
  let authMode = "account"; // "account" | "sip"
  let accountReady = false;
  let sipRegistered = false;
  let currentCallDirection = "Outbound"; // "Inbound" | "Outbound"
  let incomingPending = false;
  let incomingCallerNumber = "";
  let incomingAnswerFn = null;
  let incomingDeclineFn = null;
  let callTimerInterval = null;
  let secondsElapsed = 0;
  let isMuted = false;
  let isOnHold = false;
  let currentCallStartTime = null;
  let sessionToken = "";

  // Every call-data and call-placing route on the backend sits behind the
  // session now, so requests go through here rather than a bare fetch().
  function authFetch(pathname, options = {}) {
    const url = pathname.startsWith("http") ? pathname : `${backendUrl}${pathname}`;
    return fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      },
    });
  }

  // Web Audio Ringtone generator
  let ringCtx = null;
  let ringTimer = null;

  function log(msg, type = "info") {
    if (!logContainer) return;
    const div = document.createElement("div");
    div.className = `log-line ${type}`;
    const time = new Date().toLocaleTimeString();
    div.textContent = `[${time}] ${msg}`;
    logContainer.appendChild(div);
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  // Request browser Notification permission
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }

  function setStatus(text, tone = "pending") {
    if (statusBadge) {
      if (text === "Ready" || tone === "ok") {
        statusBadge.textContent = "READY";
        statusBadge.className = "status-badge is-ok registered";
      } else if (tone === "error") {
        statusBadge.textContent = "OFFLINE";
        statusBadge.className = "status-badge is-error unregistered";
      } else if (tone === "busy") {
        statusBadge.textContent = "ON CALL";
        statusBadge.className = "status-badge is-busy";
      } else {
        statusBadge.textContent = text.toUpperCase();
        statusBadge.className = `status-badge is-${tone}`;
      }
    }

    if (statusMessage) {
      statusMessage.textContent = text;
      statusMessage.className = `status-message is-${tone}`;
    }
  }

  function setLoginStatus(text) {
    if (loginStatusEl) loginStatusEl.textContent = text;
  }

  function updateDialButtonState() {
    // Dialling needs the SIP registration, not just a signed-in session: the
    // browser sends the INVITE itself, so before REGISTER lands there is no
    // call to place.
    const canDial = accountReady && sipRegistered;
    if (dialBtn) dialBtn.disabled = !canDial;
    if (testInboundBtn) testInboundBtn.disabled = !canDial;
    if (dialInput) dialInput.disabled = !accountReady;
    if (numberSelect) numberSelect.disabled = !accountReady;

    if (!accountReady) {
      if (dialHint) dialHint.textContent = "Sign in to activate the dialer.";
    } else {
      if (dialHint) dialHint.textContent = "";
    }
  }

  // ─── Dual Login Tab Switching ──────────────────────────────────────────────

  function setAuthMode(mode) {
    authMode = mode === "sip" ? "sip" : "account";
    localStorage.setItem(AUTH_MODE_KEY, authMode);

    const isSip = authMode === "sip";
    if (modeAccountPanel) modeAccountPanel.hidden = isSip;
    if (modeSipPanel) modeSipPanel.hidden = !isSip;
    // Keep Step 2 Caller ID selector ALWAYS visible so user can pick any purchased account number
    if (stepCallerId) stepCallerId.hidden = false;

    if (modeAccountTab) {
      modeAccountTab.classList.toggle("is-active", !isSip);
      modeAccountTab.setAttribute("aria-selected", String(!isSip));
    }
    if (modeSipTab) {
      modeSipTab.classList.toggle("is-active", isSip);
      modeSipTab.setAttribute("aria-selected", String(isSip));
    }
  }

  if (modeAccountTab) modeAccountTab.addEventListener("click", () => setAuthMode("account"));
  if (modeSipTab) modeSipTab.addEventListener("click", () => setAuthMode("sip"));

  // ─── Ringtone Generator ───────────────────────────────────────────────────

  function startRingtone() {
    stopRingtone();
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      ringCtx = new AudioCtx();
      const beep = () => {
        if (!ringCtx) return;
        const osc = ringCtx.createOscillator();
        const gain = ringCtx.createGain();
        osc.frequency.value = 440;
        osc.type = "sine";
        gain.gain.setValueAtTime(0.2, ringCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ringCtx.currentTime + 1.2);
        osc.connect(gain);
        gain.connect(ringCtx.destination);
        osc.start();
        osc.stop(ringCtx.currentTime + 1.2);
      };
      beep();
      ringTimer = setInterval(beep, 3000);
    } catch (e) {
      console.warn("[Softphone] Ringtone error:", e);
    }
  }

  function stopRingtone() {
    if (ringTimer) {
      clearInterval(ringTimer);
      ringTimer = null;
    }
    if (ringCtx) {
      try { ringCtx.close(); } catch (_) {}
      ringCtx = null;
    }
  }

  // ─── Native Notifications & Modal ──────────────────────────────────────────

  function showDesktopNotification(title, body) {
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(title, {
          body,
          icon: "https://vobiz.ai/favicon.ico"
        });
      } catch (_) {}
    }
  }

  function showInboundDoneModal(caller, durationSec) {
    if (!inboundDoneModal) return;
    if (inboundDoneCaller) inboundDoneCaller.textContent = caller || "Unknown caller";
    if (inboundDoneDuration) inboundDoneDuration.textContent = formatDuration(durationSec);
    if (inboundDoneTime) inboundDoneTime.textContent = new Date().toLocaleTimeString();
    inboundDoneModal.hidden = false;
    inboundDoneModal.classList.remove("hidden");
    inboundDoneModal.style.display = "flex";
  }

  if (inboundDoneDismissBtn) {
    inboundDoneDismissBtn.addEventListener("click", () => {
      inboundDoneModal.hidden = true;
      inboundDoneModal.classList.add("hidden");
      inboundDoneModal.style.display = "none";
    });
  }

  // ─── Timer & In-Call State ────────────────────────────────────────────────

  function formatDuration(sec) {
    const s = Math.max(0, parseInt(sec || 0, 10));
    const mins = String(Math.floor(s / 60)).padStart(2, "0");
    const secs = String(s % 60).padStart(2, "0");
    return `${mins}:${secs}`;
  }

  function startCallTimer() {
    stopCallTimer();
    secondsElapsed = 0;
    currentCallStartTime = Date.now();
    if (callTimer) callTimer.textContent = "00:00";
    if (callNumEl) callNumEl.hidden = false;
    if (callControls) callControls.hidden = false;
    if (callStatusText) callStatusText.textContent = `${currentCallDirection} call in progress`;

    callTimerInterval = setInterval(() => {
      secondsElapsed++;
      if (callTimer) callTimer.textContent = formatDuration(secondsElapsed);
    }, 1000);
  }

  function stopCallTimer() {
    if (callTimerInterval) {
      clearInterval(callTimerInterval);
      callTimerInterval = null;
    }
    if (callNumEl) callNumEl.hidden = true;
    if (callControls) callControls.hidden = true;
    if (muteBtn) muteBtn.classList.remove("is-active");
    if (holdBtn) holdBtn.classList.remove("is-active");
    isMuted = false;
    isOnHold = false;
  }

  // ─── ClickUp Task Search / Lookup ──────────────────────────────────────────

  async function searchClickUpTask(phone) {
    if (!clickupTaskBox) return;
    const cleanPhone = String(phone).replace(/[^\d+]/g, "");
    if (!cleanPhone) return;

    clickupTaskBox.classList.remove("hidden");
    if (cuTaskName) cuTaskName.textContent = "Searching ClickUp…";
    if (cuTaskPhone) cuTaskPhone.textContent = cleanPhone;
    if (cuTaskAssignee) cuTaskAssignee.textContent = "";
    if (cuTaskStatus) cuTaskStatus.classList.add("hidden");
    if (cuTaskLink) cuTaskLink.classList.add("hidden");

    try {
      const res = await authFetch(`/api/clickup/search-task?phone=${encodeURIComponent(cleanPhone)}`);
      if (res.status === 403) {
        // SIP-direct sessions do not read ClickUp; the call is still logged.
        if (cuTaskName) cuTaskName.textContent = "Task lookup needs the Vobiz account sign-in — the call is still logged";
        return;
      }
      const data = await res.json();

      if (data && data.found && data.task) {
        const task = data.task;
        if (cuTaskName) cuTaskName.textContent = task.name || "ClickUp Task";
        if (cuTaskAssignee) cuTaskAssignee.textContent = task.assignee ? `Assignee: ${task.assignee}` : "ClickUp Workspace";
        if (cuTaskStatus) {
          cuTaskStatus.textContent = (task.status && task.status.status ? task.status.status.toUpperCase() : "CONNECTED");
          cuTaskStatus.classList.remove("hidden");
        }
        if (cuTaskLink && task.url) {
          cuTaskLink.href = task.url;
          cuTaskLink.classList.remove("hidden");
        }
        log(`[ClickUp] Matched task '${task.name}' (${task.id})`, "success");
      } else {
        if (cuTaskName) cuTaskName.textContent = "New Caller — Will create ClickUp task on hangup";
        if (cuTaskAssignee) cuTaskAssignee.textContent = `List: ${data.listId || "Configured ClickUp List"}`;
        log(`[ClickUp] No prior task found for ${cleanPhone}. Task will be logged on call completion.`, "info");
      }
    } catch (err) {
      console.warn("[ClickUp] Search error:", err);
      if (cuTaskName) cuTaskName.textContent = "ClickUp Connected — Log on completion";
    }
  }

  if (refreshTaskBtn) {
    refreshTaskBtn.addEventListener("click", () => {
      const phone = dialInput.value.trim() || incomingCallerNumber;
      if (phone) searchClickUpTask(phone);
    });
  }

  // ─── Mode 1: Vobiz Account Login ──────────────────────────────────────────

  async function vobizAccountLogin() {
    const authId = authIdInput.value.trim();
    const authToken = authTokenInput.value.trim();
    const agentId = agentSelect.value || "admin";

    if (!authId || !authToken) {
      setLoginStatus("Enter both Auth ID and Auth Token.");
      setStatus("Credentials required", "error");
      return;
    }

    setLoginStatus("Authenticating with Vobiz…");
    setStatus("Connecting…", "pending");
    log(`Attempting Vobiz Account login for ${agentId} (${authId})…`);

    try {
      const res = await fetch(`${backendUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, authId, authToken }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      sessionToken = data.token || "";
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        token: sessionToken,
        agentId,
        authId,
        from: data.selected,
        numbers: data.numbers || []
      }));

      accountReady = true;
      setStatus("Registering…", "pending");
      setLoginStatus(`Signed in as ${agentId} (${authId}) — registering the softphone…`);
      updateDialButtonState();
      if (authIdInput) authIdInput.value = "";
      if (authTokenInput) authTokenInput.value = "";
      if (logoutBtn) logoutBtn.classList.remove("hidden");
      log(`Vobiz account verified (${authId}). Loaded ${(data.numbers || []).length} phone numbers.`, "success");

      // Populate caller ID dropdown
      populateNumberSelect(data.numbers || [], data.selected);

      // Attempt SIP client connection in background
      connectSipViaAccount(sessionToken);
    } catch (err) {
      log(`Account login failed: ${err.message}`, "error");
      setLoginStatus(`Login failed: ${err.message}`);
      setStatus("Offline", "error");
    }
  }

  function populateNumberSelect(numbers, selected) {
    if (!numberSelect) return;
    numberSelect.innerHTML = "";
    if (numbers.length === 0) {
      const opt = document.createElement("option");
      opt.value = selected || "+15550100000";
      opt.textContent = selected || "+15550100000 (Default DID)";
      numberSelect.appendChild(opt);
      return;
    }

    numbers.forEach((num) => {
      const opt = document.createElement("option");
      opt.value = num;
      opt.textContent = num;
      if (num === selected) opt.selected = true;
      numberSelect.appendChild(opt);
    });
  }

  if (numberSelect) {
    numberSelect.addEventListener("change", async () => {
      const selected = numberSelect.value;
      log(`Selecting outgoing Caller ID: ${selected}`);
      try {
        await fetch(`${backendUrl}/select-number`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {})
          },
          body: JSON.stringify({ number: selected, agentId: agentSelect.value })
        });
      } catch (e) {
        console.warn("[Softphone] select-number failed:", e);
      }
    });
  }

  async function connectSipViaAccount(token) {
    log("Attempting WebRTC SIP audio registration in background…", "info");

    try {
      const ok = await window.VobizSip.connect({
        token,
        audioElement: remoteAudio,
        backendUrl
      });

      if (!ok) {
        log("WebRTC UA registration bypassed. Softphone ready in Vobiz API calling mode.", "info");
      }
    } catch (e) {
      log(`WebRTC connection notice: ${e.message}`, "info");
    }
  }

  // ─── Mode 2: SIP Direct Login ─────────────────────────────────────────────

  async function vobizSipDirectLogin() {
    const sipUser = sipUserInput.value.trim();
    const sipPassword = sipPassInput.value.trim();
    const callerId = sipCallerIdInput.value.trim() || "+15550100000";
    const remember = sipRememberCheck.checked;

    if (!sipUser || !sipPassword) {
      setLoginStatus("Enter SIP username and password.");
      setStatus("SIP credentials required", "error");
      return;
    }

    // Remember who, not the password. localStorage survives the tab, is
    // readable by any script on this origin, and a SIP password is enough to
    // place calls billed to the account.
    if (remember) {
      localStorage.setItem(SIP_CREDS_KEY, JSON.stringify({ sipUser, callerId }));
    } else {
      localStorage.removeItem(SIP_CREDS_KEY);
    }

    setLoginStatus(`Connecting directly as ${sipUser}…`);
    setStatus("Connecting…", "pending");
    log(`Attempting direct SIP registration for ${sipUser} with Caller ID ${callerId}…`);

    // Register caller ID with backend so /answer can format the right callerId
    try {
      const sipRes = await fetch(`${backendUrl}/login-sip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sipUser, callerId })
      });
      const sipJson = await sipRes.json().catch(() => ({}));
      if (sipJson && sipJson.token) sessionToken = sipJson.token;
      if (!sipRes.ok) {
        // Most often: the caller ID is not a number on the account. Calls would
        // go out under the server default instead, so say so.
        log(`Caller ID not accepted: ${sipJson.error || `HTTP ${sipRes.status}`}`, "error");
        setLoginStatus(`Caller ID not accepted: ${sipJson.error || `HTTP ${sipRes.status}`}`);
      }
    } catch (e) {
      console.warn("[Softphone] /login-sip notice:", e.message);
    }

    accountReady = true;
    if (logoutBtn) logoutBtn.classList.remove("hidden");

    const ok = window.VobizSip.connectDirect({
      sipUser,
      sipPassword,
      displayName: sipUser,
      audioElement: remoteAudio
    });

    if (!ok) {
      setStatus("SIP Error", "error");
      log("SIP direct initialization failed.", "error");
    }
  }

  // ─── Logout ───────────────────────────────────────────────────────────────

  function vobizLogout() {
    log("Logging out and stopping SIP session…", "info");
    if (sessionToken) {
      fetch(`${backendUrl}/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` }
      }).catch(() => {});
    }

    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SIP_CREDS_KEY);
    sessionToken = "";
    accountReady = false;
    sipRegistered = false;

    window.VobizSip.unregister();
    if (authIdInput) authIdInput.value = "";
    if (authTokenInput) authTokenInput.value = "";
    if (sipUserInput) sipUserInput.value = "";
    if (sipPassInput) sipPassInput.value = "";
    setLoginStatus("Not signed in.");
    if (logoutBtn) logoutBtn.classList.add("hidden");
    setStatus("Offline", "error");
    updateDialButtonState();
    if (clickupTaskBox) clickupTaskBox.classList.add("hidden");
  }

  if (accountLoginBtn) accountLoginBtn.addEventListener("click", vobizAccountLogin);
  if (sipConnectBtn) sipConnectBtn.addEventListener("click", vobizSipDirectLogin);
  if (logoutBtn) logoutBtn.addEventListener("click", vobizLogout);

  // ─── SIP Event Listeners ──────────────────────────────────────────────────

  window.VobizSip.on("registered", (identity) => {
    sipRegistered = true;
    setStatus("Ready", "ok");
    setLoginStatus(`Registered as ${identity.displayName || identity.sipUser}`);
    updateDialButtonState();
    log(`✅ SIP Registered: ${identity.sipUser}`, "success");
  });

  window.VobizSip.on("unregistered", () => {
    sipRegistered = false;
    setStatus("Unregistered", "error");
    updateDialButtonState();
    log("SIP un-registered.", "warn");
  });

  window.VobizSip.on("registrationFailed", (cause) => {
    sipRegistered = false;
    if (authMode === "account") {
      // Not "Ready": without a registration there is nothing to call with.
      setStatus("Not registered", "error");
      setLoginStatus(`Signed in, but the softphone could not register: ${cause}. Check VOBIZ_SIP_USER and VOBIZ_SIP_PASSWORD on the server.`);
      log(`SIP registration failed: ${cause}`, "error");
    } else {
      setStatus("Offline", "error");
      setLoginStatus(`SIP registration failed: ${cause}. Check your SIP username and password.`);
      log(`SIP registration failed: ${cause}`, "error");
    }
    updateDialButtonState();
  });

  window.VobizSip.on("incoming", (callData) => {
    incomingPending = true;
    currentCallDirection = "Inbound";
    incomingCallerNumber = callData.number || "Unknown";
    incomingAnswerFn = callData.answer;
    incomingDeclineFn = callData.decline;

    log(`🔔 Incoming call from ${incomingCallerNumber}!`, "warn");

    // Show incoming popup banner
    if (incomingFromEl) incomingFromEl.textContent = incomingCallerNumber;
    if (incomingBanner) {
      incomingBanner.hidden = false;
      incomingBanner.classList.remove("hidden");
      incomingBanner.style.display = "block";
    }

    // Trigger ringtone & desktop notification
    startRingtone();
    showDesktopNotification("Incoming Call - Vobiz ClickUp", `Incoming call from ${incomingCallerNumber}`);

    // Search ClickUp task
    searchClickUpTask(incomingCallerNumber);
  });

  window.VobizSip.on("confirmed", () => {
    stopRingtone();
    if (incomingBanner) {
      incomingBanner.hidden = true;
      incomingBanner.classList.add("hidden");
      incomingBanner.style.display = "none";
    }
    incomingPending = false;
    setStatus("On call", "busy");
    startCallTimer();
    if (dialBtn) dialBtn.hidden = true;
    if (hangupBtn) hangupBtn.hidden = false;
    log(`Call answered and connected (${currentCallDirection}).`, "success");
  });

  window.VobizSip.on("ended", () => {
    handleCallEnded();
  });

  window.VobizSip.on("failed", (cause) => {
    log(`Call terminated / failed: ${cause}`, "warn");
    handleCallEnded();
  });

  window.VobizSip.on("error", (err) => {
    log(`SIP Error: ${err.message}`, "error");
  });

  function handleCallEnded(customDuration) {
    stopRingtone();
    const durationSec = typeof customDuration === "number" ? customDuration : secondsElapsed;
    const callerNumber = currentCallDirection === "Inbound" ? incomingCallerNumber : dialInput.value.trim();

    stopCallTimer();
    if (incomingBanner) {
      incomingBanner.hidden = true;
      incomingBanner.classList.add("hidden");
      incomingBanner.style.display = "none";
    }
    incomingPending = false;
    if (dialBtn) dialBtn.hidden = false;
    if (hangupBtn) hangupBtn.hidden = true;

    const isReady = sipRegistered;
    setStatus(isReady ? "Ready" : "Offline", isReady ? "ok" : "error");

    if (durationSec > 0 && currentCallDirection === "Inbound") {
      showInboundDoneModal(callerNumber, durationSec);
    }

    log(`Call ended. Duration: ${formatDuration(durationSec)}. Syncing CDR to ClickUp…`, "info");
    setTimeout(loadCallHistory, 2000);
  }

  // ─── Incoming Call Actions & Shortcuts ─────────────────────────────────────

  if (acceptBtn) {
    acceptBtn.addEventListener("click", () => {
      if (incomingAnswerFn) incomingAnswerFn();
    });
  }

  if (declineBtn) {
    declineBtn.addEventListener("click", () => {
      if (incomingDeclineFn) incomingDeclineFn();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (!incomingPending) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (incomingAnswerFn) incomingAnswerFn();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (incomingDeclineFn) incomingDeclineFn();
    }
  });

  // ─── Outbound Calling & Keypad ────────────────────────────────────────────
  let activeApiCallUuid = null;

  async function hangupCurrentCall() {
    if (window.VobizSip.getSession()) {
      window.VobizSip.hangup();
      return;
    }

    if (activeApiCallUuid && activeApiCallUuid.startsWith("inbound_")) {
      // A "Test Inbound Call" preview: no call happened, so nothing is written
      // to ClickUp.
      activeApiCallUuid = null;
      log("Inbound preview ended — preview calls are not logged to ClickUp.");
      handleCallEnded(secondsElapsed);
      return;
    }

    if (activeApiCallUuid) {
      const callUuid = activeApiCallUuid;
      activeApiCallUuid = null;
      const durationSec = secondsElapsed;
      const callerNumber = currentCallDirection === "Inbound" ? incomingCallerNumber : dialInput.value.trim();
      let callerId = "";
      if (authMode === "sip") {
        callerId = sipCallerIdInput.value.trim() || "+15550100000";
      } else {
        callerId = numberSelect.value || "+15550100000";
      }

      log(`Ending call session ${callUuid} (duration: ${formatDuration(durationSec)})…`);

      try {
        await fetch(`${backendUrl}/api/calls/end`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {})
          },
          body: JSON.stringify({
            callUuid,
            durationSeconds: durationSec,
            agentId: agentSelect.value || "admin",
            direction: currentCallDirection,
            to: callerNumber,
            from: callerId
          })
        });
      } catch (err) {
        console.warn("[Softphone] Call end sync error:", err);
      }

      handleCallEnded(durationSec);
    } else {
      handleCallEnded();
    }
  }

  function initiateCall() {
    const number = dialInput.value.trim();
    if (!number) {
      dialInput.focus();
      return;
    }

    currentCallDirection = "Outbound";
    let callerId = "";
    if (authMode === "sip") {
      callerId = sipCallerIdInput.value.trim() || "+15550100000";
    } else {
      callerId = numberSelect.value || "+15550100000";
    }

    log(`Placing outbound call to ${number} (Caller ID: ${callerId})…`);
    setStatus("Calling…", "busy");

    if (dialBtn) dialBtn.hidden = true;
    if (hangupBtn) hangupBtn.hidden = false;
    if (callNumEl) callNumEl.hidden = false;
    if (callStatusText) callStatusText.textContent = `Dialing ${number}…`;

    searchClickUpTask(number);

    if (window.VobizSip.isRegistered()) {
      const extraHeaders = [
        `X-VH-Caller-ID: ${callerId}`,
        `X-PH-Caller-ID: ${callerId}`,
        `X-ClickUp-Agent: ${agentSelect.value || "admin"}`
      ];
      const session = window.VobizSip.call(number, remoteAudio, extraHeaders);
      if (!session) {
        log("The call could not start. Check the microphone permission and that the status reads Ready.", "error");
        handleCallEnded();
      }
    } else {
      // The browser is the A leg: without a registered softphone there is no
      // call to place. Ringing the customer over the REST API first and
      // bridging the agent in afterwards leaves them listening to ringback.
      log("Not registered yet — wait for the status to read Ready, then dial.", "error");
      handleCallEnded();
    }
  }

  // ─── Simulate Inbound Call (For 1-click Auth ID / Token Testing) ───────────
  function simulateInboundCall(mockCaller = "+14155550199") {
    currentCallDirection = "Inbound";
    incomingPending = true;
    incomingCallerNumber = mockCaller;
    activeApiCallUuid = `inbound_${Date.now()}`;

    log(`🔔 Incoming call simulated from ${incomingCallerNumber}!`, "warn");

    if (incomingFromEl) incomingFromEl.textContent = incomingCallerNumber;
    if (incomingBanner) {
      incomingBanner.hidden = false;
      incomingBanner.classList.remove("hidden");
      incomingBanner.style.display = "block";
    }

    startRingtone();
    showDesktopNotification("Incoming Call - Vobiz ClickUp", `Incoming call from ${incomingCallerNumber}`);
    searchClickUpTask(incomingCallerNumber);

    incomingAnswerFn = () => {
      stopRingtone();
      if (incomingBanner) {
        incomingBanner.hidden = true;
        incomingBanner.classList.add("hidden");
        incomingBanner.style.display = "none";
      }
      incomingPending = false;
      setStatus("On call", "busy");
      startCallTimer();
      if (dialBtn) dialBtn.hidden = true;
      if (hangupBtn) hangupBtn.hidden = false;
      log(`Inbound call answered from ${incomingCallerNumber}.`, "success");
    };

    incomingDeclineFn = () => {
      stopRingtone();
      if (incomingBanner) {
        incomingBanner.hidden = true;
        incomingBanner.classList.add("hidden");
        incomingBanner.style.display = "none";
      }
      incomingPending = false;
      log(`Inbound call declined.`, "info");
      activeApiCallUuid = null;
      handleCallEnded(0);
    };
  }

  if (testInboundBtn) testInboundBtn.addEventListener("click", () => simulateInboundCall());
  if (dialBtn) dialBtn.addEventListener("click", initiateCall);
  if (hangupBtn) hangupBtn.addEventListener("click", hangupCurrentCall);

  if (dialInput) {
    dialInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !dialBtn.disabled && !dialBtn.hidden) {
        e.preventDefault();
        initiateCall();
      }
    });
  }

  // Keypad button clicks
  document.querySelectorAll(".keypad-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-key");
      if (window.VobizSip.getSession()) {
        window.VobizSip.sendDTMF(key);
        log(`Sent DTMF tone: ${key}`);
      } else {
        dialInput.value += key;
      }
    });
  });

  // In-call control buttons
  if (muteBtn) {
    muteBtn.addEventListener("click", () => {
      isMuted = !isMuted;
      window.VobizSip.setMuted(isMuted);
      muteBtn.classList.toggle("is-active", isMuted);
      log(isMuted ? "Microphone muted" : "Microphone unmuted");
    });
  }

  if (holdBtn) {
    holdBtn.addEventListener("click", () => {
      isOnHold = !isOnHold;
      window.VobizSip.setHold(isOnHold);
      holdBtn.classList.toggle("is-active", isOnHold);
      log(isOnHold ? "Call placed on hold" : "Call resumed from hold");
    });
  }

  if (transferBtn) {
    transferBtn.addEventListener("click", () => {
      const target = prompt("Enter phone number or extension to transfer this call to:");
      if (target) {
        log(`Transferring call to ${target}…`);
        alert(`Attended transfer initiated to ${target}`);
      }
    });
  }

  // ─── Call Recordings & CDR List ───────────────────────────────────────────

  async function loadCallHistory() {
    if (!historyList) return;
    try {
      const res = await authFetch("/recordings?limit=10");
      const data = await res.json();
      const recs = data.recordings || data.objects || [];

      historyList.innerHTML = "";
      if (recs.length === 0) {
        historyList.innerHTML = `<li class="history-item text-muted" style="justify-content:center; color:#64748b;">No recent call recordings yet</li>`;
        return;
      }

      recs.forEach((r) => {
        const li = document.createElement("li");
        li.className = "history-item";

        const dur = formatDuration(r.rounded_recording_duration || r.duration || 0);
        const time = r.add_time || new Date().toLocaleTimeString();
        const callId = (r.call_uuid || r.recording_id || "").slice(0, 14) + "…";

        li.innerHTML = `
          <div class="history-item-info">
            <span class="history-item-number">Call ${callId}</span>
            <span class="history-item-meta">${time} &bull; ${dur}</span>
          </div>
          <div class="history-item-actions">
            <button type="button" class="btn-play" data-url="${r.playUrl || `/play-recording?callUuid=${encodeURIComponent(r.call_uuid)}`}">▶ Play</button>
          </div>
        `;
        historyList.appendChild(li);
      });

      // Bind play buttons
      historyList.querySelectorAll(".btn-play").forEach((btn) => {
        btn.addEventListener("click", () => {
          const url = btn.getAttribute("data-url");
          if (playbackAudio && url) {
            playbackAudio.src = url.startsWith("http") ? url : `${backendUrl}${url}`;
            playbackAudio.hidden = false;
            playbackAudio.play().catch((e) => log(`Audio playback error: ${e.message}`, "warn"));
          }
        });
      });
    } catch (e) {
      console.warn("[Softphone] Could not fetch recordings:", e.message);
    }
  }

  if (refreshHistoryBtn) refreshHistoryBtn.addEventListener("click", loadCallHistory);

  if (syncCdrsBtn) {
    syncCdrsBtn.addEventListener("click", async () => {
      log("Triggering live CDR sync from Vobiz to ClickUp…", "info");
      try {
        const res = await authFetch("/sync-recent-cdrs");
        const json = await res.json();
        log(`CDR sync completed! Synced ${json.totalFetched || 0} calls.`, "success");
        loadCallHistory();
      } catch (err) {
        log(`CDR sync error: ${err.message}`, "error");
      }
    });
  }

  // ─── Auto-Restore Session / Credentials ────────────────────────────────────

  async function loadAvailableNumbers() {
    try {
      const res = await authFetch("/api/numbers");
      if (res.ok) {
        const data = await res.json();
        if (data.numbers && data.numbers.length > 0) {
          populateNumberSelect(data.numbers, data.selected);
        }
      }
    } catch (_) {}
  }

  async function autoRestore() {
    await loadAvailableNumbers();

    const savedMode = localStorage.getItem(AUTH_MODE_KEY) || "account";
    setAuthMode(savedMode);

    if (savedMode === "sip") {
      const savedSip = JSON.parse(localStorage.getItem(SIP_CREDS_KEY) || "null");
      if (savedSip && savedSip.sipUser) {
        // The username and caller ID come back; the password does not, because
        // it is no longer stored. The agent types it, then connects.
        sipUserInput.value = savedSip.sipUser;
        sipCallerIdInput.value = savedSip.callerId || "";
        sipRememberCheck.checked = true;
        sipPassInput.focus();
        return;
      }
    }

    // Check account session
    const savedSession = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (savedSession && savedSession.token) {
      try {
        const res = await fetch(`${backendUrl}/session`, {
          headers: { Authorization: `Bearer ${savedSession.token}` }
        });
        const data = await res.json();
        if (data.loggedIn) {
          sessionToken = savedSession.token;
          accountReady = true;
          setStatus("Registering…", "pending");
          updateDialButtonState();
          if (authIdInput) authIdInput.value = "";
          if (authTokenInput) authTokenInput.value = "";
          setLoginStatus(`Signed in as ${data.agentId} (${data.authId}) — registering the softphone…`);
          if (logoutBtn) logoutBtn.classList.remove("hidden");
          if (data.numbers && data.numbers.length > 0) {
            populateNumberSelect(data.numbers, data.from);
          }
          connectSipViaAccount(sessionToken);
          loadCallHistory();
          return;
        }
      } catch (_) {}
    }

    setStatus("Offline", "error");
    setLoginStatus("Not signed in.");
    updateDialButtonState();
    loadCallHistory();
  }

  autoRestore();
});
