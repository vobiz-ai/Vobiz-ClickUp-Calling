# Changelog

All notable changes to the Vobiz ClickUp Calling & Telephony Integration project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-09-21

Security rewrite. Every item below was reproduced against the running server
before it was fixed, and each now has a permanent test — `npm test` fails if any
of them starts working again.

### Security
- **Static serving can no longer leave `clickup-app/`.** `url.parse` does not
  normalise dot segments, so `GET /../backend/.env` arrived intact and was
  served: over the tunnel, every credential this service holds. Paths are
  normalised and confined to the static root. The regression test uses a raw
  socket, because `fetch()` collapses `/../` before sending and therefore cannot
  catch this.
- **Removed `GET /recording-file?url=`.** It fetched any URL a caller named with
  `X-Auth-ID` and `X-Auth-Token` attached; pointed at a listener, it delivered
  both. Stripping headers on redirects was no defence — the first request
  already carried them wherever it was told. Playback goes through the signed
  `/recording-audio/<recordingId>`, which resolves the media URL server-side and
  enforces a host allowlist on the first request and after every redirect.
- **`/login` proves the credentials.** It issued a session for any string: the
  numbers lookup was the only call made and its failure was swallowed.
- **A request without a token is no longer a session.** `/session` answered
  `loggedIn: true` with the account Auth ID whenever the server had credentials
  configured, and `/session/<agentId>` answered from any live session — between
  them the panel was effectively unauthenticated.
- **SIP credentials are session-gated.** `GET /agent/<anything>` returned the
  password in plaintext, falling back to `ClickUpAgent#2026!` hardcoded in
  `server.js`. Both the route and the fallback are fixed.
- **Placing a call requires a session**, and `authId`/`authToken` are no longer
  read from the request body — which let an unauthenticated caller place calls
  billed to the account.
- **Session guards** on calls, CDR sync, recordings, numbers, agent listing and
  the ClickUp task search.
- **CORS is an allowlist** — `*.clickup.com`, localhost, `ALLOWED_ORIGINS`.
- **`/health` reports configuration state, not values.**
- **`/login-sip` validates the caller ID** against the account's own numbers;
  any string was accepted, which is caller-ID spoofing. It now returns a session
  scoped to SIP-direct mode, which `/api/agent-sip` deliberately refuses.
- **The SIP password is no longer kept in `localStorage`.**

### Changed
- The inbound `<Speak>` greeting ran before `<Dial>`, delaying every bridge by
  its length. Removed; the "agent offline" message after `<Dial>` stays, because
  it is only reached when the bridge failed.
- `backend/cloudflared.exe` (54 MB, Windows-only) is no longer committed.

### Tests
- `npm test` starts its own backend instead of requiring one to be running by
  hand, points the Vobiz API at a closed port so no test can place a call, and
  carries 63 assertions. It previously signed in as `MA_TEST_AUTH_ID` and
  asserted the 200 as a pass, codifying the authentication bypass as correct.
- `test:outbound`, `test:inbound`, `test:sync` sign in and exit non-zero on
  failure; `test:recording` now checks that the exfiltration route is gone and
  unsigned playback refused, rather than calling any 200 from it a success.

### Docs
- README, SECURITY, ISSUES, CONTRIBUTING and MARKETPLACE rewritten for the
  public repository, with a new `docs/TROUBLESHOOTING.md`. The previous copy
  described the credential-leaking proxy as "Secure Recording Playback" and
  claimed zero hardcoded secrets while a password sat in `server.js`.

## [1.0.0] - 2026-09-17

### Added
- **Dynamic Vobiz Authentication**: Interactive in-browser login using Auth ID and Auth Token with automatic phone number fetching and session persistence.
- **Outbound Calling**: PSTN dialer with real-time audio bridging, call timer, and active session control (mute, hold, hangup).
- **Inbound Calling**: Webhook-driven XML call control (`/answer`) bridging incoming PSTN calls directly to agent softphone extensions.
- **Automated CDR Logging**: Automatic creation of rich Markdown task cards in ClickUp Lists with call metadata, duration, direction, and status.
- **Secure Recording Playback**: Built-in audio streaming proxy (`/recording-file`) supporting S3 redirect header sanitization for instant playback inside ClickUp.
- **ClickUp Board View Alignment**: Dynamic task categorization under `CONNECTED`, `DIALING`, `VOICEMAIL`, and `NOT DIALED` status columns.
- **Structured Project Architecture**: Standard enterprise directory layout with `.github/`, `backend/`, `docs/`, `scripts/`, and `clickup-app/`.
