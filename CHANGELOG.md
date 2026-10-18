# Changelog

Notable changes to this integration. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
