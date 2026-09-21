# Known issues

Last reviewed **21 September 2026**, after the security rewrite in
[CHANGELOG 2.0.0](CHANGELOG.md).

For symptom-driven debugging see [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

---

## Open

### 1. No live call since the security rewrite

`npm test` covers the HTTP surface, both call directions, the ClickUp task shape
and the security regressions — 63 assertions, against a backend it starts
itself, with the Vobiz API pointed at a closed port so no test can place a call.
What it does not do is place a real one. The rewrite touched authentication on
every route the softphone uses, so **the next thing this repository needs is one
outbound and one inbound call against a live account, with two-way audio
confirmed**, in both sign-in modes.

### 2. It is not a ClickUp app

The softphone is a page served by the backend, opened beside ClickUp. There is
no ClickUp OAuth app, no iframe, no command-centre entry — and ClickUp's App
Directory needs one. See [MARKETPLACE.md](MARKETPLACE.md).

### 3. The ClickUp token is a personal token

`CLICKUP_API_TOKEN` is a `pk_…` personal token carrying its owner's full access.
Tasks are created as that user, so every call is attributed to them rather than
to the agent who made it. OAuth would fix both, and is required for a listing.

### 4. Quick tunnels invalidate two things at once

A restarted `cloudflared` quick tunnel gets a new hostname, and `TUNNEL_URL` and
the Vobiz application's `answer_url` both go stale. Nothing warns you.

### 5. `SIGNING_SECRET` defaults to a per-process random value

Left unset, every restart invalidates every playback link already written into a
ClickUp task. Set it explicitly in production.

### 6. The backend is single-account, and `agentId` is self-asserted

It binds to one Vobiz account through `.env`, and every agent signing in
account-mode shares one SIP endpoint — two agents on one install register as the
same endpoint and race for calls. `agentId` picks a display name, not an
identity.

### 7. Inbound picks the first session it finds

The inbound bridge targets `VOBIZ_SIP_USER`, or the first live session carrying a
SIP username. With more than one agent signed in, which one rings is arbitrary.
There is no routing, queue or presence.

### 8. SIP-direct sign-in does not verify the password

`/login-sip` checks that the caller ID is a number the account owns and issues a
session scoped to SIP-direct mode. The password is proven only when the
softphone REGISTERs, so a wrong one shows as "not Ready" rather than a failed
sign-in. That session deliberately cannot read `/api/agent-sip`.

### 9. Call state is in memory

`callsByUuid`, `callRecordings` and `recentCalls` are capped at 200 and do not
survive a restart. The durable record is the ClickUp task and the CDR in Vobiz.

### 10. Task status names are assumed

Tasks are created with status `CONNECTED`, and the board view expects
`CONNECTED`, `DIALING`, `VOICEMAIL` and `NOT DIALED` to exist in the target
list. ClickUp rejects a status a list does not define, and the failure shows up
as a ClickUp API error in the log rather than in the softphone.

---

## Platform behaviour to know

- **`<Record>` must be a self-closing sibling before `<Dial>`.** Nested,
  FreeSWITCH rejects the document and the caller hears a bogus "Busy".
- **`<Dial>` needs `action` and `redirect="false"`.** Without them Vobiz
  re-executes the answer document and one call dials repeatedly.
- **Inbound `callerId` must be E.164**, or B-leg creation is refused silently.
- **Vobiz posts webhooks form-encoded**, not as JSON.
- **A `<Speak>` before `<Dial>` delays every bridge** by the length of the
  prompt. The inbound greeting was removed for that reason; the "agent offline"
  message after `<Dial>` costs nothing, because it is only reached when the
  bridge failed.
- **A space in the SIP User-Agent string makes Vobiz block its own INVITE.**
