# Vobiz Calling for ClickUp

A WebRTC softphone that logs calls into ClickUp. Agents dial from the softphone,
talk in the browser, and each completed call becomes a ClickUp task carrying the
CDR and a playable recording link.

[Quick start](docs/QUICKSTART.md) · [Architecture](#the-one-thing-to-understand-first) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Issues](ISSUES.md) · [Listing](MARKETPLACE.md)

**Status.** `npm test` starts its own backend and runs 63 assertions across the
call flows, the ClickUp task shape and a security-regression group that holds
the fixes in [CHANGELOG 2.0.0](CHANGELOG.md) in place. A live call against a
production Vobiz account has not been run since those fixes; see
[ISSUES.md](ISSUES.md#1-no-live-call-since-the-security-rewrite).

---

## The one thing to understand first

**The browser is the A leg.** The softphone sends the SIP INVITE itself; the
backend answers `<Dial><Number>` to reach the customer.

```
softphone ──SIP INVITE──▶ Vobiz ──answer_url──▶ backend /answer
                                                     │
                                              <Dial><Number> ──▶ customer
```

The intuitive design — backend dials the customer over the REST API, then
bridges the agent in with `<Dial><User>` — **cannot work**. Routing *into* a
registered WebRTC endpoint is blocked platform-side: Vobiz builds a gateway URI
it cannot itself parse and drops its own INVITE. The customer answers, hears
ringback, then "the agent could not be reached".

Inbound is the exception: `<Dial><User>` is the only way to reach a registered
endpoint, and it works.

---

## What talks to what

| Piece | Role |
| --- | --- |
| `clickup-app/` | The softphone. `vobiz-sip.js` is the JsSIP layer, `softphone.js` the dialer, call states and ClickUp task card |
| `backend/server.js` | Answers Vobiz webhooks, serves the softphone, holds credentials, creates ClickUp tasks |
| `scripts/tunnel.js` | Starts a Cloudflare quick tunnel and records its hostname |
| `scripts/create-vobiz-app-and-endpoint.js` | Provisions the Vobiz application and SIP endpoint |
| `scripts/fetch-cdr.js` | Pulls recent CDRs and syncs them to ClickUp from the command line |

ClickUp is written through its REST API with a personal token — there is no
OAuth app and no iframe integration. The softphone is a page you open beside
ClickUp, not a ClickUp extension. That is the single biggest gap between this
and a listable app; see [MARKETPLACE.md](MARKETPLACE.md).

---

## Quick start

```bash
cp backend/.env.example backend/.env    # then fill it in
npm start                               # backend on :8092
npm run tunnel                          # public HTTPS, in a second shell
```

`cloudflared` must be on your PATH (`brew install cloudflared`,
`winget install --id Cloudflare.cloudflared -e`). The binary is deliberately not
committed.

Then **verify before opening the softphone**:

```bash
BASE=$(cat backend/tunnel-url.txt)

curl -s "$BASE/health"
curl -s "$BASE/answer?From=sip:x@registrar.vobiz.ai&To=91XXXXXXXXXX&RouteType=sip"
```

The second must return `<Response>` containing `<Dial …><Number>`. Anything else
— a tunnel error page, an ngrok interstitial — and every call dies silently.

Open `http://localhost:8092/` for the softphone.

**If the tunnel hostname changed**, `TUNNEL_URL` and the Vobiz application's
`answer_url` both go stale. Nothing warns you; calls simply stop.

---

## Making a call

Sign in first — either with the Vobiz Auth ID and Auth Token, or with a SIP
endpoint username, password and a caller ID the account owns. Allow the
microphone and **wait for the status to read Ready**: that is the SIP
registration landing, and dialling before it rings the customer into silence.

Dial a number, or let the ClickUp task card find an existing task by the
customer's phone number. On hangup the backend creates the call task.

**Inbound**: call the DID bound to the Vobiz application. The softphone rings
and shows the caller; the completed call is logged the same way.

---

## What lands in ClickUp

One task per call, in `CLICKUP_LIST_ID`, titled
`Vobiz <Direction> Call - <customer number>`, tagged `vobiz-call`, the direction,
and `cdr`. The description is a Markdown table: call UUID, direction, from, to,
agent, duration, hangup cause, status, timestamp — and a playback link when the
call was recorded.

**The playback link is HMAC-signed and expires** (`RECORDING_URL_TTL_SECONDS`,
900 by default). A task read later shows a dead link rather than a permanent
one, which is deliberate: these tasks are readable by everyone in the ClickUp
space.

Without `CLICKUP_API_TOKEN` the backend logs the task it *would* have created
and returns `simulated: true`. It never pretends the write happened.

---

## Reading the logs

```
[backend] 📞 Browser A-leg: Outbound call to 91… via callerId +91…
[backend] DIAL RESULT status=completed cause=NORMAL_CLEARING bleg=abc-123 dur=42
[backend] 🎧 RECORDING READY: call=… id=…
[ClickUp] ✅ Task created successfully! ID: …
```

**`DialBLegUUID` is the single most useful field in this stack.** Present means
the call connected. Empty means no B leg was ever created, whatever the UI said.

---

## Security

Every item below was a live, reproduced defect in this repository before 2.0.0.
Do not reintroduce them.

- **Static files are confined to `clickup-app/`.** `GET /../backend/.env` used
  to return the file — over a tunnel, every credential this service holds.
- **Recording playback is HMAC-signed with a short expiry**, takes a recording
  *id*, resolves the media URL server-side, and refuses any host off an
  allowlist. Never reintroduce a caller-supplied URL here: with account
  credentials attached, that is a credential-exfiltration primitive.
- **Sign-in proves the credentials** against Vobiz. It used to issue a session
  for any string typed into the form.
- **A request without a token is not a session.** `/session` used to answer
  `loggedIn: true` with the account Auth ID whenever the server was configured.
- **SIP credentials are session-gated**, and there is no hardcoded fallback
  password in the source.
- **Placing a call requires a session**, and credentials are never read from the
  request body.
- **CORS is an allowlist** — `*.clickup.com`, localhost, `ALLOWED_ORIGINS`.

Report a vulnerability to `support@vobiz.ai` — see [SECURITY.md](SECURITY.md).

---

## Tests

```bash
npm test                 # starts its own backend, 63 assertions, exits non-zero on failure
npm run test:outbound    # drives a simulated outbound call into ClickUp
npm run test:inbound
npm run test:sync        # CDR sync
npm run test:recording   # playback security
```

The `test:*` scripts drive a backend you started, sign in with the credentials
in `backend/.env`, and fail the process when something is wrong.

---

## Licence

MIT — see [LICENSE](LICENSE).
