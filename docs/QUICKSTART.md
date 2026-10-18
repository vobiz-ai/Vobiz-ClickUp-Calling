# Quick start

From a clone to a logged call. Node 18+ and `cloudflared` on your PATH.

## 1. Configure

```bash
cp backend/.env.example backend/.env
```

Fill in `CLICKUP_API_TOKEN`, `CLICKUP_LIST_ID` and `SIGNING_SECRET`. That is all:
no Vobiz credentials, numbers or SIP endpoints go in `.env`. Agents sign in from
the panel with their own Vobiz account.

## 2. Start the backend and a tunnel

```bash
npm start          # backend on :8092
npm run tunnel     # second terminal; writes backend/tunnel-url.txt
```

## 3. Check the answer URL

```bash
BASE=$(cat backend/tunnel-url.txt)
curl -s "$BASE/health"
curl -s "$BASE/answer?From=%2B15550100111&To=%2B15550100222"
```

The second must return `<Response>` XML (with nobody signed in, a polite
`<Speak>` and `<Hangup/>`). An HTML page means the tunnel is not reaching the
backend.

## 4. Sign in

Open [http://localhost:8092/](http://localhost:8092/).

- **Vobiz account** tab: type your Auth ID and Auth Token. The backend checks
  them with Vobiz, creates this integration's application in your account
  (answer URL `<tunnel>/answer`) if it is not there yet, creates or reuses your
  SIP endpoint, binds it to the application and sets a fresh SIP password for
  this sign-in. Your numbers fill the caller-ID dropdown.
- **SIP Direct** tab: type an existing endpoint's SIP username and password and a
  caller ID. The endpoint and number must already be attached to an application
  whose answer URL is `<tunnel>/answer` — see the README for the console steps.

Allow the microphone and wait for the badge to read **Ready**.

## 5. Call

Dial a number in E.164. On hangup a task appears in the ClickUp list; the
recording link is added to the same task when Vobiz reports it.

For inbound (account mode), pick the number in the dropdown and click **Enable
inbound calls** once. That attaches the number to the integration's application,
moving it off any other application. Then call it from a phone while the
softphone reads **Ready**, and accept the banner.

## Tests

```bash
npm test
```

Starts its own backend against local stand-ins for the Vobiz and ClickUp APIs,
with two fake accounts, so nothing is called, charged or written.
