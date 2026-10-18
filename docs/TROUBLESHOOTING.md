# Troubleshooting

Organised by symptom. Several of these fail with a message that names the wrong
cause entirely, so read the whole entry before acting on the error text.

---

## "It worked yesterday and today nothing connects"

The tunnel hostname changed. Two things go stale together:

1. `PUBLIC_BASE_URL` / `TUNNEL_URL` in `backend/.env` — or delete them and let
   `backend/tunnel-url.txt` supply the value, which `npm run tunnel` rewrites
2. each account's Vobiz application `answer_url` — sign in again: the backend
   finds or creates the application for the new URL and rebinds the endpoint.
   Click **Enable inbound calls** again for inbound numbers.

Confirm the first with `curl -s "$BASE/health"`, the second by watching the log
while you call the DID. No `/answer` line means Vobiz is still calling the old
hostname.

---

## The softphone never reads Ready

The status badge is the SIP registration, not the backend connection.

- **Account mode**: `vobiz-sip.js` fetches credentials from `/api/agent-sip`,
  which requires a session. If sign-in failed, registration never starts — look
  for `401` in the browser console.
- **Account mode, "not registered"**: sign out and in again. Each sign-in sets a
  fresh SIP password on the agent's endpoint; a second tab signed in as the same
  agent replaces it, and the first tab's registration then fails.
- **"Signed in to Vobiz, but setting up the softphone failed"** — creating the
  application or endpoint was refused. The log line `[provision] …` gives the
  HTTP status.
- **SIP Direct mode**: the password is proven by the REGISTER itself, so a wrong
  one shows as "not Ready" with no sign-in error.
- Microphone permission must be granted **before** registration, and the page
  must be HTTPS or `localhost` for `getUserMedia` to exist at all.

---

## "Invalid Vobiz Auth ID or Auth Token" when the credentials are right

Sign-in now asks Vobiz. That means it can also fail because Vobiz was
unreachable — a closed egress port, a proxy, or `VOBIZ_API_URL` pointing
somewhere wrong. The log distinguishes them:

```
[backend] Vobiz refused sign-in for <id>: HTTP 401   ← credentials are wrong
[backend] Could not reach Vobiz to check <id>: …     ← the network is wrong (the panel gets a 502)
```

---

## "Sign in first" (HTTP 401) all over the softphone

Expected on `/api/calls/*`, `/recordings`, `/api/numbers`, `/select-number`,
`/sync-recent-cdrs` and the task search when the session has expired — it lasts
24 hours — or after a reload that lost the token.

If it happens immediately after a successful sign-in, the token is not reaching
the backend. Check that the softphone is served from the same origin as the API,
or that the origin is in `ALLOWED_ORIGINS`: a request CORS refuses looks exactly
like a missing session.

---

## HTTP 403 "Forbidden" on a page that should exist

Static serving is confined to `clickup-app/`. A path that resolves outside it —
including anything with `..` — is refused. If a legitimate asset trips this, it
is in the wrong directory.

---

## The customer answers, hears ringback, then "the agent could not be reached"

The classic symptom of the architecture that cannot work: something dialled the
customer first and tried to bridge the agent in with `<Dial><User>`. Routing into
a registered WebRTC endpoint is blocked platform-side. Check that `/answer`
returned `<Dial><Number>` — `RouteType=sip`, or a `From` beginning `sip:`, is
what selects that branch.

---

## Inbound does not ring, or rings the wrong agent

Inbound is routed by the webhook's `ParentAuthID` to that account's signed-in
agents, all of whom ring at once; without it, by the dialled number. Check:

- someone from that account is signed in **since the last backend restart** —
  tokens and routing live in memory, so after a restart inbound calls hang up
  politely (`matches no signed-in account`) until an agent signs in again;
- the number was attached with **Enable inbound calls** (account mode), or by
  hand to the right application (SIP Direct);
- in SIP Direct, the caller ID typed at sign-in is the number being dialled.

## "Sign in again" when playing a recording

Playback uses the credentials of the account the recording belongs to, and those
live in memory. After a restart, a link for an account nobody has signed in to
since answers 409 until someone from that account signs in.

---

## No task appears in ClickUp

1. `CLICKUP_API_TOKEN` and `CLICKUP_LIST_ID` must both be set and not left at
   their `YOUR_…` placeholders. Unconfigured, the backend logs the task and
   returns `simulated: true` — deliberately, rather than pretending.
2. A ClickUp API error is logged with its status and body:
   `[ClickUp] API error (400): …`. If you set `CLICKUP_TASK_STATUS`, it must be
   a status the list defines; leave it unset to use the list's default.
3. The token owner needs access to that list. A personal token carries their
   access, not yours.
4. The task is created when Vobiz posts the `<Dial>` result to `/dial-status`,
   and the recording link is added to the same task when `/recording-ready`
   fires. Both need the tunnel up; a call the backend never answered produces
   neither.

---

## "This playback link is invalid or has expired"

Both halves are real causes:

- **Expired.** `RECORDING_URL_TTL_SECONDS` defaults to 900 seconds, so links in
  older tasks die. That is the trade for links that live in a shared workspace.
- **Invalid.** `SIGNING_SECRET` was not set, so it was regenerated on the last
  restart and every previously issued link is unverifiable.

Re-open the recording from the softphone's history for a fresh link.

---

## `/recording-file` returns HTTP 410

Deliberate: this backend does not proxy a caller-supplied URL, because doing so
with the account credentials attached would hand them to whatever host is named.
Use the signed `/recording-audio/<recordingId>` link.

---

## CORS errors in the browser console

The allowlist is `*.clickup.com`, `localhost`, `127.0.0.1`, and anything in
`ALLOWED_ORIGINS` (comma-separated). The response simply omits the header for an
unknown origin, which the browser reports as a CORS failure with no detail.

---

## Reading the log

```
[backend] 📞 Browser A-leg: Outbound call to 91… via callerId +91…
[backend] DIAL RESULT status=completed cause=NORMAL_CLEARING bleg=abc-123 dur=42
[backend] 🎧 RECORDING READY: call=… id=…
[ClickUp] ✅ Task created successfully! ID: …
```

| Line | Means |
| --- | --- |
| No `/answer` line | Vobiz never reached this server — tunnel or `answer_url` |
| `Browser A-leg` | Outbound branch taken, as it should be |
| `bleg=(none)` | The B leg was never created; the customer was never dialled |
| `cause=NO_ANSWER` / `USER_BUSY` | Reached the customer, who did not answer |
| `[ClickUp] Notice: ClickUp token not set` | The task was simulated, not created |
