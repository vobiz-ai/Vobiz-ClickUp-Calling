# Quick start

From a clone to a logged call. Node 18+ and `cloudflared` on your PATH.

## 1. Configure

```bash
cp backend/.env.example backend/.env
```

Fill in `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`, `VOBIZ_FROM_NUMBER` (a number on the
account), `CLICKUP_API_TOKEN`, `CLICKUP_LIST_ID` and `SIGNING_SECRET`.

## 2. Start the backend and a tunnel

```bash
npm start          # backend on :8092
npm run tunnel     # second terminal; writes backend/tunnel-url.txt
```

## 3. Provision Vobiz

```bash
npm run provision
```

This creates a Voice Application pointing at `<tunnel>/answer`, a SIP endpoint
bound to it, attaches `VOBIZ_FROM_NUMBER` to the application for inbound, and
writes `VOBIZ_SIP_USER` / `VOBIZ_SIP_PASSWORD` into `backend/.env`. Restart
`npm start` afterwards so it picks them up.

## 4. Check the answer URL

```bash
BASE=$(cat backend/tunnel-url.txt)
curl -s "$BASE/health"
curl -s "$BASE/answer?From=sip:x@registrar.vobiz.ai&To=%2B91XXXXXXXXXX&RouteType=sip"
```

The second must return XML containing `<Dial …><Number>`.

## 5. Call

Open [http://localhost:8092/](http://localhost:8092/), sign in with the Auth ID and
Auth Token, allow the microphone, and wait for the badge to read **Ready** — that
is the SIP registration. Dial a number in E.164. On hangup a task appears in the
ClickUp list; the recording link is added to the same task when Vobiz reports it.

For inbound, call `VOBIZ_FROM_NUMBER` from a phone while the softphone reads
**Ready**, and accept the banner.

## Tests

```bash
npm test
```

Starts its own backend against local stand-ins for the Vobiz and ClickUp APIs,
so nothing is called, charged or written.
