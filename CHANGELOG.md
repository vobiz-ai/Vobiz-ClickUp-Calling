# Changelog

Notable changes to this integration. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
  request body. Caller ID must be a number the account owns.
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
