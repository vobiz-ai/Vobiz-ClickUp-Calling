# Troubleshooting

Organised by symptom. Several of these fail with a message that names the wrong
cause entirely, so read the whole entry before acting on the error text.

---

## "It worked yesterday and today nothing connects"

The tunnel hostname changed. Two things go stale together:

1. `TUNNEL_URL` in `backend/.env` — or delete it and let
   `backend/tunnel-url.txt` supply the value, which `npm run tunnel` rewrites
2. the Vobiz application's `answer_url` — re-run `npm run provision`

Confirm the first with `curl -s "$BASE/health"`, the second by watching the log
while you call the DID. No `/answer` line means Vobiz is still calling the old
hostname.

---

## The softphone never reads Ready

The status badge is the SIP registration, not the backend connection.

- **Account mode**: `vobiz-sip.js` fetches credentials from `/api/agent-sip`,
  which requires a session. If sign-in failed, registration never starts — look
  for `401` in the browser console.
- **`VOBIZ_SIP_USER / VOBIZ_SIP_PASSWORD are not configured on this server`** —
  exactly what it says. The backend will not invent a password, because a
  default password in a published file is a published password.
- **SIP-direct mode**: the password is proven by the REGISTER itself, so a wrong
  one shows as "not Ready" with no sign-in error.
- Microphone permission must be granted **before** registration, and the page
  must be HTTPS or `localhost` for `getUserMedia` to exist at all.

---

## "Invalid Vobiz Auth ID or Auth Token" when the credentials are right

Sign-in now asks Vobiz. That means it can also fail because Vobiz was
unreachable — a closed egress port, a proxy, or `VOBIZ_API_URL` pointing
somewhere wrong. The log distinguishes them:

```
[backend] Vobiz rejected <id>: HTTP 401          ← credentials are wrong
[backend] Could not reach Vobiz to validate: …   ← the network is wrong
```

A server bound to an account through `.env` short-circuits this: matching
`VOBIZ_AUTH_ID` and `VOBIZ_AUTH_TOKEN` exactly is accepted without a round trip.

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

## Inbound rings the wrong agent

The inbound bridge targets `VOBIZ_SIP_USER`, or else the first live session
carrying a SIP username. With more than one agent signed in, which one rings is
arbitrary. There is no routing or presence.

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
