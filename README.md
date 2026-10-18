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
| `backend/server.js` | Answers Vobiz webhooks for every signed-in account, provisions each agent's endpoint at sign-in, serves the softphone, creates ClickUp tasks |
| `backend/data/endpoints.json` | Created at runtime (gitignored, mode 0600): `account:agent → endpoint id, username`. No passwords, no tokens |
| `scripts/tunnel.js` | Starts a Cloudflare quick tunnel and records its hostname |

The softphone is a web page served by this backend, opened in a tab beside
ClickUp. It is not a ClickUp app: nothing appears inside ClickUp, and there is
no OAuth. Tasks are written through ClickUp's REST API with one personal API
token, so every task is created as that token's owner, whichever agent made the
call.

---

## Quick start

```bash
cp backend/.env.example backend/.env    # ClickUp token + list, SIGNING_SECRET
npm start                               # backend on :8092
npm run tunnel                          # public HTTPS, in a second shell
```

`backend/.env` holds deployment settings only — port, public URL, data dir,
`SIGNING_SECRET` and the ClickUp token and list. **No Vobiz Auth ID, Auth Token,
number or SIP endpoint goes in it**: agents sign in with their own account.

`cloudflared` must be on your PATH (`brew install cloudflared`,
`winget install --id Cloudflare.cloudflared -e`). The binary is deliberately not
committed.

Then **verify before opening the softphone**:

```bash
BASE=$(cat backend/tunnel-url.txt)

curl -s "$BASE/health"
curl -s "$BASE/answer?From=%2B15550100111&To=%2B15550100222"
```

The second must return `<Response>` XML — with nobody signed in, a polite
`<Speak>` and `<Hangup/>`. Anything else — a tunnel error page, an ngrok
interstitial — and every call dies silently.

Open `http://localhost:8092/` for the softphone.

**If the tunnel hostname changed**, `PUBLIC_BASE_URL`/`TUNNEL_URL` and each
account's Vobiz application `answer_url` go stale. The next sign-in creates a
fresh application for the new URL; inbound numbers need **Enable inbound calls**
again. Nothing warns you; calls simply stop.

---

## Signing in — any Vobiz account

The panel has two tabs. Neither needs anything configured on the server.

### Vobiz account (Auth ID + Auth Token)

The agent types their account's Auth ID and Auth Token. The backend:

1. checks the pair with `GET /v1/Account/{auth_id}/numbers` — anything but 2xx
   is refused with 401;
2. loads the caller-ID list from that same API, every page, keeping numbers that
   are `active` and voice-enabled;
3. finds this integration's Application in **that** account — the one whose
   `answer_url` is exactly `<public base>/answer` — or creates it. An application
   it did not create is never repointed;
4. finds or creates one SIP endpoint for this agent (alias `ClickUp-<agent>`),
   sets a fresh random SIP password on it, and binds it to the application
   (`{"app_id":"<id>"}`, verified by reading the endpoint back, with the
   documented `{"application": <id>}` as the fallback). The password goes only to
   this browser session.

The Auth Token stays in the backend's memory, keyed by Auth ID. It is never
written to disk, logged, or sent back to the browser.

The caller ID is a dropdown of the account's own numbers; the backend refuses any
other. **Enable inbound calls** attaches the selected number to the
integration's application (`POST /numbers/{number}/application`) — explicit,
because it moves the number off whatever application it is on now.

### SIP Direct (existing endpoint)

The agent types an existing endpoint's SIP username and password plus a caller
ID. The browser registers with those directly; the password never reaches the
backend, which only records `SIP user → caller ID` so `/answer` can route that
agent's calls, and rings the agent when that number is dialled. The caller ID is
format-checked only — Vobiz itself refuses a caller ID the account does not own.

For this to work, in the Vobiz console:

1. **Voice → Applications**: create an application with answer URL
   `<public base>/answer` (POST) and hangup URL `<public base>/hangup-callback`.
2. **Voice → Endpoints**: set the endpoint's application to it.
3. **Numbers**: attach the caller-ID number to the same application, for inbound.

API equivalent:

```bash
curl -X POST "https://api.vobiz.ai/api/v1/Account/$AUTH_ID/Application/" \
  -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"app_name":"Vobiz ClickUp Calling","answer_url":"<public base>/answer","answer_method":"POST"}'
curl -X POST "https://api.vobiz.ai/api/v1/Account/$AUTH_ID/Endpoint/$ENDPOINT_ID/" \
  -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"app_id":"<app_id>"}'
curl -X POST "https://api.vobiz.ai/api/v1/Account/$AUTH_ID/numbers/%2B<digits>/application" \
  -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"application_id":"<app_id>"}'
```

Recordings, the number list, CDR sync, task lookup and Enable inbound need the
account API, so in SIP Direct they say "sign in with your Vobiz account". Calls
are still logged to ClickUp, without a recording link.

### How webhooks find the account

- **Outbound** (`From=sip:<user>@…`): the SIP user maps to the agent who signed
  in with it, and so to their account and chosen caller ID. An `X-VH-Caller-ID`
  header can name another of that account's numbers. An unknown SIP user gets a
  polite hangup.
- **Inbound**: the webhook's `ParentAuthID` names the account; all of that
  account's signed-in agents ring. Without it, the dialled number is looked up
  among the signed-in accounts' numbers, then among SIP Direct caller IDs. No
  match: a polite hangup and a log line. `<Dial callerId>` is the dialled number
  in E.164.

**After a backend restart** the in-memory state is gone: agents sign in again
(their endpoints are reused). Until someone from an account signs in again,
inbound calls to its numbers hang up politely and playback links for its
recordings answer "sign in again".

---

## Making a call

Sign in first (above). Allow the microphone and **wait for the status to read
Ready**: that is the SIP registration landing, and dialling before it rings the
customer into silence.

Dial a number, or let the ClickUp task card find an existing task by the
customer's phone number. On hangup the backend creates the call task.

**Inbound**: click **Enable inbound calls** once for the number, then call it.
Every signed-in agent of that account rings and sees the caller; the completed
call is logged the same way.

---

## What lands in ClickUp

One task per call, in `CLICKUP_LIST_ID`, titled
`Vobiz <Direction> Call - <customer number>`, tagged `vobiz-call`, the direction,
and `cdr`. The description is a Markdown table: call UUID, direction, from, to,
agent, duration, hangup cause, status, timestamp — and a playback link when the
call was recorded.

**The playback link is HMAC-signed, names its account, and expires**
(`RECORDING_URL_TTL_SECONDS`, 900 by default). The account is inside the
signature, so a link for one account can never fetch another's audio. A task read later shows a dead link rather than a permanent
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

This service holds, in memory, the Auth Token of every account signed in to it,
plus a ClickUp API token, and it is reachable from the internet because Vobiz
has to call its webhooks. It is built accordingly.

- **Static files are confined to `clickup-app/`**, so no request can reach a
  path outside it.
- **Recording playback is HMAC-signed with a short expiry**, takes a recording
  *id*, resolves the media URL server-side, and refuses any host off an
  allowlist. Never add a caller-supplied URL here: with account credentials
  attached, that hands them to whatever host is named.
- **Sign-in proves the credentials** against Vobiz, and a request with no token
  is not a session. **Auth Tokens live in memory only** — never on disk, in a
  log line or in a response.
- **Each session sees only its own account**: numbers, recordings, CDRs and
  caller IDs are all scoped to the account that signed in.
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
```

The suite runs the backend against a local stand-in for Vobiz holding two fake
accounts (`MA_TEST0001`, `MA_TEST0002`) and for ClickUp. It covers both accounts
signing in with distinct endpoints, wrong tokens refused, outbound and inbound
routing to the right account, the exact 17-digit app id in the bind request,
account-scoped recording links, SIP Direct, and that no Auth Token appears in any
HTTP response or log line. Nothing real is called, charged or written.

---

## Licence

MIT — see [LICENSE](LICENSE).
