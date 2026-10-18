# Vobiz Calling for ClickUp

A WebRTC softphone that logs calls into ClickUp. Agents dial from the softphone,
talk in the browser, and each completed call becomes a ClickUp task carrying the
CDR and a playable recording link.

[Docs](https://docs.vobiz.ai/integrations/clickup) · [Quick start](docs/QUICKSTART.md) · [Architecture](#the-one-thing-to-understand-first) · [Troubleshooting](docs/TROUBLESHOOTING.md)

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

The softphone is a web page served by this backend, opened in a tab beside
ClickUp. It is not a ClickUp app: nothing appears inside ClickUp, and there is
no OAuth. Tasks are written through ClickUp's REST API with one personal API
token, so every task is created as that token's owner, whichever agent made the
call.

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

This service holds your Vobiz Auth Token, a SIP endpoint password and a ClickUp
API token, and it is reachable from the internet because Vobiz has to call its
webhooks. It is built accordingly.

- **Static files are confined to `clickup-app/`**, so no request can reach a
  path outside it.
- **Recording playback is HMAC-signed with a short expiry**, takes a recording
  *id*, resolves the media URL server-side, and refuses any host off an
  allowlist. Never add a caller-supplied URL here: with account credentials
  attached, that hands them to whatever host is named.
- **Sign-in proves the credentials** against Vobiz, and a request with no token
  is not a session.
- **SIP credentials are session-gated**, with no default password anywhere in
  the source.
- **Placing a call requires a session**, and credentials are never read from the
  request body.
- **CORS is an allowlist** — `*.clickup.com`, localhost, `ALLOWED_ORIGINS`.

Two things to get right before you go live: set `SIGNING_SECRET` explicitly, or
playback links in ClickUp tasks stop working at every restart, and give the
integration a ClickUp user with access to the call list only — a personal token
carries everything its owner can reach.

Found a problem? `support@vobiz.ai` — see [SECURITY.md](SECURITY.md).

---

## Tests

```bash
npm test                 # starts its own backend, exits non-zero on failure
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
