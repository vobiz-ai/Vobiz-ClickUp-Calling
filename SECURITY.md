# Security policy

## Reporting a vulnerability

Email `support@vobiz.ai`. Please do not open a public issue.

Include the request that demonstrates it — a `curl` line is ideal — the endpoint
affected, and what you were able to read or do. We aim to acknowledge within one
working day.

---

## What this service holds

A running instance holds, in `backend/.env`:

- a Vobiz **Auth ID and Auth Token** — enough to place calls billed to the
  account and read every recording on it
- a Vobiz **SIP endpoint password** — enough to register as the agent
- a **ClickUp personal API token** — which carries that user's full access to
  every space they can see, not just the call list

It is normally exposed to the internet through a tunnel, because Vobiz has to
reach `/answer`. Treat any endpoint on it as internet-facing, because it is.

---

## Rules this codebase follows

These are not aspirations. Each one replaced a defect that was reproduced
against the running server; the test suite fails if any is undone.

**Static serving cannot leave `clickup-app/`.** Paths are normalised and the
resolved path is required to stay inside the static root. `url.parse` does not
collapse dot segments, so `GET /../backend/.env` used to arrive intact and be
served — the whole `.env`, over the public tunnel. Note that `fetch()`
normalises `/../` before sending, so a test written with it cannot catch this;
the suite uses a raw socket.

**No credential ever leaves on a caller's instruction.** The recording proxy
takes a recording *id*, resolves the media URL server-side, and refuses any host
off an allowlist — checked before the first request and again after every
redirect, dropping our headers on the way, because a presigned storage URL
carries its own authorisation. Stripping headers only on redirects is not a
defence: the first request already carries them wherever it is told to go.

**Credentials are proven, not assumed.** Sign-in validates against Vobiz, and a
request without a token is not a session — not even when the server has
credentials configured.

**Secrets are served only to a session.** SIP credentials come from the
environment and go only to a signed-in caller. There is no default password in
the source; `agents.json` is committed, so it holds names and usernames only.

**Anything that spends money is authenticated**, and credentials never come from
the request body.

**Unauthenticated endpoints describe, they do not reveal.** `/health` reports
whether things are configured, not what they are.

**CORS is an allowlist.** `*.clickup.com`, localhost, and `ALLOWED_ORIGINS`.

---

## Operating one safely

- Set `SIGNING_SECRET` explicitly. Left unset it is random per process, so
  playback links in ClickUp tasks stop working whenever the server restarts.
- Scope the ClickUp token. A personal token carries everything its owner can
  reach; a dedicated integration user with access to only the call list is the
  smaller blast radius.
- Keep `backend/.env` out of git. It is gitignored; check before you force-add.
- Rotate the Vobiz Auth Token, the SIP password and the ClickUp token if this
  service has ever run a version older than 2.0.0 on a public tunnel. The
  defects above were remotely exploitable without authentication.
- Remember that call tasks are readable by everyone in the ClickUp space,
  including the customer's number and the recording link.
