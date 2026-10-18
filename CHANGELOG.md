# Changelog

Notable changes to this integration. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - Unreleased

### Fixed
- **Agent profiles come from the backend.** The panel no longer hard-codes
  `admin` / `agent1`: the agent ID is free text, with the profiles in
  `agents.json` (via the new `GET /api/agent-profiles`, id and name only) as
  suggestions. `agents.json` is optional and no longer committed; copy
  `agents.example.json`. Sign-in requires an agent ID instead of defaulting to
  `admin`.
- **Call tasks are assigned** to the agent's `clickUpUserId` from `agents.json`,
  when there is one; a refused assignee falls back to an unassigned task.
- **Sync CDRs is idempotent.** It skips calls that already have a task (tracked
  in `DATA_DIR/synced-calls.json`, and by call UUID on the list), runs one sync
  per account at a time, and adds the recording link when Vobiz has one.
- **The softphone uses the configured `VOBIZ_REGISTRAR`** for SIP Direct
  registration and for dial targets, instead of a hard-coded host.

### Changed — any Vobiz account can sign in
- **Nothing account-specific is configured on the server.** `VOBIZ_AUTH_ID`,
  `VOBIZ_AUTH_TOKEN`, `VOBIZ_FROM_NUMBER`, `VOBIZ_SIP_USER` and
  `VOBIZ_SIP_PASSWORD` are gone from the code, `.env.example` and the docs. This
  replaces 2.0.1's "bound to the configured account" model.
- **Vobiz account sign-in** checks the Auth ID / Auth Token with Vobiz, then in
  that account finds or creates this integration's application (matched on its
  `answer_url`; others are never repointed), finds or creates one endpoint per
  agent, sets a fresh SIP password per sign-in, and binds the endpoint to the
  application (`{"app_id":"<id>"}`, verified, falling back to
  `{"application": <id>}`). 17-digit app ids stay strings end to end.
- **The Auth Token is held in memory only**, keyed by Auth ID. The
  `account:agent → endpoint` map is kept in `backend/data/endpoints.json`
  (gitignored, 0600), with no secrets.
- **Caller ID** is a dropdown of the account's active, voice-enabled numbers,
  loaded across all pages; the backend refuses anything else.
- **Enable inbound calls** attaches the selected number to the integration's
  application, on request only.
- **SIP Direct** keeps working with zero server config: an existing endpoint's
  SIP credentials, typed in the panel, plus a caller ID. Account-API features
  ask for the account sign-in.
- **Webhooks are multi-tenant.** Outbound is matched by SIP user; inbound by
  `ParentAuthID`, then by the dialled number. No match: a polite hangup.
- **Recording links name their account** inside the HMAC, so one account's
  link cannot fetch another's audio.

### Removed
- The **Transfer** button: it only showed an alert and transferred nothing.
- `scripts/create-vobiz-app-and-endpoint.js` (`npm run provision`) — sign-in
  provisions now.
- `scripts/fetch-cdr.js` and `scripts/test-clickup-sync.js` (`npm run fetch-cdr`,
  `test:*`) — they read account credentials from `.env`. Use **Sync CDRs** in the
  panel, and `npm test`.

### Tests
- The Vobiz stand-in holds two fake accounts with distinct tokens, numbers,
  applications and endpoints, rewrites endpoint usernames, pages the numbers
  list and returns 17-digit app ids as bare JSON numbers. 130 assertions.

## [2.0.1] - Unreleased

### Security
- **Sign-in is bound to the configured account.** Any valid Vobiz account could
  sign in and was then served this server's SIP password; now only
  `VOBIZ_AUTH_ID` / `VOBIZ_AUTH_TOKEN` sign in.
- **SIP-direct sessions no longer reach account data.** `/login-sip` proves only
  knowledge of a DID, which is public. Its sessions can no longer list or stream
  recordings, search ClickUp, sync CDRs or use the call API.
- **The recording webhook no longer returns a signed playback link**, and
  ignores calls this server did not answer.
- Caller IDs from `/select-number` and the softphone's `X-VH-Caller-ID` header
  are checked against the account's numbers.
- Webhook values are stripped of Markdown before they are written to ClickUp.

### Fixed
- **Outbound no longer falls back to REST origination.** When the softphone was
  not registered, `/api/calls/start` rang the customer via `POST /Call/` and
  bridged with `<Dial><User>` — the customer answered into ringback and then an
  "agent offline" message. The softphone is the only A leg.
- **Ready means registered.** The badge read Ready on sign-in, and stayed Ready
  when registration failed. Dialling is enabled only once SIP has registered.
- **Tasks were rejected by default ClickUp lists** because every task was sent
  with status `CONNECTED`. Status is now the list default, or
  `CLICKUP_TASK_STATUS`.
- **One task per call.** The dial result and the recording callback each created
  a task; the recording now updates the first.
- **Sign-in no longer swaps the SIP user.** Endpoint discovery replaced
  `VOBIZ_SIP_USER` with the account's first endpoint while keeping
  `VOBIZ_SIP_PASSWORD`, so registration failed on any account with more than
  one endpoint.
- `npm run provision` binds the endpoint to the application (`application`, not
  `app_id`, which was ignored), attaches `VOBIZ_FROM_NUMBER` through the
  documented `/numbers/{number}/application` route, and no longer re-points the
  account's first number.
- The inbound fallback `<Speak>` used `Polly.Aditi`, which is not a documented
  voice, and told callers the call was "logged to ClickUp".
- "Test Inbound Call" is a UI preview and no longer writes a ClickUp task.
- `ALLOW_MOCK` and `CLICKUP_TEAM_ID` were read but never used, and are removed
  from `.env.example`. The quick start pointed at a page that does not exist.

### Tests
- `npm test` runs against local stand-ins for the Vobiz and ClickUp APIs that
  accept any credentials and record every request, so it can assert that no
  call was originated and that one call makes one task. 92 assertions.

## [2.0.0] - 2026-09-21

First public release.

### Features
- **Outbound calling** from the softphone, with two-way audio in the browser.
- **Inbound calling** on your Vobiz DID, bridged to the agent's softphone, with
  a caller banner, accept and decline.
- **Two ways to sign in** — Vobiz account credentials with a caller-ID dropdown
  of the account's numbers, or a single SIP endpoint's own credentials.
- **A ClickUp task per call**, titled by direction and customer number, tagged
  `vobiz-call`, carrying a Markdown CDR table and a playback link when the call
  was recorded.
- **Task matching** by the customer's phone number, so an existing task surfaces
  in the panel during the call.
- **CDR sync** from the command line (`npm run fetch-cdr`) as well as live.

### Security
- Static files are confined to the panel directory.
- Recording playback is HMAC-signed with a short expiry. The endpoint takes a
  recording id, resolves the media URL server-side, and enforces a host
  allowlist on the first request and after every redirect.
- Sign-in is validated against Vobiz, and a request with no token is not a
  session.
- SIP credentials are served only to a signed-in caller, with no default
  password in the source.
- Placing a call requires a session, and credentials are never read from the
  request body. The SIP-direct caller ID must be a number the account owns.
- CORS is an allowlist. `/health` reports configuration state, not values.

### Notes
- The inbound answer document bridges straight through without a spoken
  greeting, because a `<Speak>` before `<Dial>` delays every call by its length.
- Without a ClickUp token configured, the backend reports the task it would have
  created rather than inventing one that looks real.

### Requirements
- Node 18 or newer. No runtime dependencies — the backend is Node's own `http`,
  and JsSIP is vendored.
- `cloudflared` on your PATH for the local tunnel, or any stable HTTPS hostname.
