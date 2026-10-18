# Contributing

## Setup

Node 18 or newer. There are no runtime dependencies — the backend is Node's own
`http`, and JsSIP is vendored in `clickup-app/lib/`.

```bash
cp backend/.env.example backend/.env    # then fill it in
npm start                               # backend on :8092
npm run tunnel                          # public HTTPS, in a second shell
npm test                                # starts its own backend and asserts
```

`cloudflared` must be on your PATH. The binary is not committed.

---

## Rules that are not style preferences

**Never commit a credential.** `backend/.env` is gitignored. `agents.json` is
committed, so it holds names and SIP usernames only. There is no fallback
password in this codebase, and adding one publishes it.

**Never fetch a caller-supplied URL with credentials attached.** If you need a
new media endpoint, take an id, resolve the URL server-side, and check it
against `MEDIA_HOST_ALLOWLIST` — before the request and again after every
redirect.

**Static paths are normalised and confined.** `url.parse` does not collapse dot
segments. If you touch the static handler, keep the `path.resolve` + prefix
check, and keep the raw-socket test: `fetch()` normalises `/../` away, so a test
written with it passes against a vulnerable server.

**A new route that spends money, changes configuration, or reads call data
starts with `if (!requireSession(req, res)) return;`.** The default is closed.

**A test that cannot fail is worse than no test.** A suite that signs in with a
made-up id and asserts the 200 as a pass makes an authentication bypass look
like correct behaviour. Assert on the thing that would break, and exit
non-zero.

**Do not reintroduce wildcard CORS.** Add the origin to `ORIGIN_ALLOWLIST` or
set `ALLOWED_ORIGINS`.

---

## The architecture, in one line

The browser is the A leg: the softphone sends the INVITE, the backend answers
`<Dial><Number>`. Do not "simplify" this into a backend-originated call bridged
with `<Dial><User>` — routing into a registered WebRTC endpoint is blocked
platform-side, and the symptom is a customer who answers, hears ringback, and is
told the agent could not be reached.

---

## Pull requests

1. Branch from `main`.
2. `npm test` must pass, and new behaviour needs an assertion.
3. Describe what you verified and how — "ran the suite" and "placed a live call
   to +91…, two-way audio, `DialBLegUUID` present" are different claims, and the
   second is the one that matters for anything touching call flow.
4. Update `CHANGELOG.md` for anything user-visible, and the docs if you close
   or discover a limitation.

## Reporting a vulnerability

`support@vobiz.ai`, not a public issue. See [SECURITY.md](SECURITY.md).
