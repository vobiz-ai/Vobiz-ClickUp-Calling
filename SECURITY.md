# Security policy

## Reporting a vulnerability

Email `support@vobiz.ai`. Please do not open a public issue.

Include the request that demonstrates it (a `curl` line is ideal), the endpoint
affected, and what you were able to read or do. We aim to acknowledge within one
working day.

---

## What a running backend holds

- **In memory only:** the Vobiz Auth Token of every account signed in to it,
  and each signed-in agent's current SIP password. Neither is written to disk,
  logged, or returned to the browser (the SIP password goes only to the session
  it was made for).
- **In `backend/.env`:** a ClickUp personal API token, which carries that user's
  full ClickUp access, and `SIGNING_SECRET`, which signs recording links. No
  Vobiz credentials go in `.env`.
- **In `DATA_DIR/endpoints.json`** (mode `0600`): which SIP endpoint belongs to
  which account and agent profile. No passwords or tokens.

The backend must be reachable from the internet, because Vobiz calls its
webhooks. Treat every route on it as public.

---

## Guarantees

- **Sign-in is checked with Vobiz.** A request without a valid session token is
  not signed in.
- **Each session reaches only its own account.** Numbers, recordings, call
  records and caller IDs are all limited to the account that signed in, and a
  caller ID must be one of that account's numbers.
- **Recording links are signed, expire, and are bound to one account.** The
  backend looks up the audio by recording ID and fetches it only from Vobiz
  storage hosts, re-checking every redirect. It never fetches a URL supplied by a
  caller.
- **Static files are served only from `clickup-app/`.** No path can reach
  `backend/.env` or anything else outside it.
- **CORS is an allowlist:** `*.clickup.com`, `localhost`, and `ALLOWED_ORIGINS`.
- **Unauthenticated routes reveal nothing about accounts.** `/health` reports
  whether ClickUp is configured, not who is signed in.
- **Vobiz webhook signatures are not verified.** Webhooks only act on calls this
  backend answered, and never return account data.

The test suite checks these, and CI fails if a credential is committed.

---

## Operating it safely

- Serve it over HTTPS only.
- Set `SIGNING_SECRET` explicitly and keep it stable, or recording links break
  at every restart.
- Create the ClickUp token on a dedicated user with access to the call list
  only.
- Keep `backend/.env` out of version control (it is gitignored).
- Remember that call tasks, including customer numbers and recording links, are
  visible to everyone who can see the ClickUp list.
