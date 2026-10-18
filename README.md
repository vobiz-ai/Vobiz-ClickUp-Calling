# Vobiz Calling for ClickUp

Make and take phone calls in your browser, and log every call into ClickUp.
Your agents open the Vobiz softphone next to ClickUp, sign in with your Vobiz
account, and dial. Each call becomes a task in the ClickUp list you choose, with
the call details and a link to the recording. You run the small backend that
connects the softphone, Vobiz and ClickUp.

[Documentation](https://www.vobiz.ai/docs/integrations/clickup) ·
[Quick start](#quick-start) · [Troubleshooting](#troubleshooting)

**Features**

- **Click to call** from a softphone in the browser. Audio runs over WebRTC, so
  agents need no desk phone or desktop app.
- **Inbound calls** ring every signed-in agent on your Vobiz account, with an
  in-panel prompt, a ringtone and a desktop notification.
- **Caller lookup:** during a call the panel shows the matching ClickUp task for
  the customer's number, with a link to open it.
- **Call logging:** one ClickUp task per call, with direction, numbers, agent,
  duration, hangup cause and status.
- **Recordings:** every call is recorded, and the task gets a signed playback
  link. Recent recordings play from the panel.
- **Caller ID choice** from a dropdown of the numbers on your Vobiz account.
- **Multiple agents:** each agent gets their own SIP endpoint in your account.
- **Two ways to sign in:** with your Vobiz account (Auth ID and Auth Token), or
  with an existing SIP endpoint's username and password.
- **Sync CDRs** pulls your account's most recent call records into ClickUp.
- In-call **mute**, **hold** and a **keypad** for tones (DTMF).

---

## How it works

```
 Agent's browser                    Your backend                     Vobiz
 (softphone page)            (https://calling.example.com)
 ─────────────────            ─────────────────────────────          ─────
 Sign in  ─────────────────▶  checks credentials with Vobiz ───────▶ API
                              creates the application + agent endpoint
 Dial     ──SIP over WebRTC─────────────────────────────────────────▶ registrar
                              /answer  ◀─── "what should this call do?"
                              returns <Dial> to the customer ───────▶ customer's phone
                              /dial-status, /recording-ready ◀────── call result, recording
                              creates / updates the ClickUp task ──▶ ClickUp API
```

- The softphone is a web page served by your backend. Agents open it in a
  browser tab next to ClickUp. It is not installed inside ClickUp.
- When an agent signs in, the backend checks the credentials with Vobiz and sets
  up what the softphone needs in your Vobiz account.
- The browser registers with Vobiz as the agent's SIP endpoint and places the
  call itself. Vobiz asks your backend's `/answer` URL what to do, and the
  backend tells it to dial the customer from your chosen caller ID.
- For inbound calls, Vobiz asks the same URL, and the backend rings every agent
  signed in with that account.
- When the call ends, Vobiz reports the result and the recording to your
  backend, which writes the ClickUp task through the ClickUp API.

---

## Requirements

| What | Details |
|---|---|
| Vobiz account | Your **Auth ID** and **Auth Token** (Console → API credentials), at least one active, voice-enabled phone number, and enough balance for calls. |
| ClickUp | Any ClickUp workspace. A ClickUp user who can create and edit tasks in the list you choose, and that user's **personal API token** (`pk_...`, from ClickUp Settings → Apps). No ClickUp admin rights are needed. |
| A public HTTPS URL | Vobiz must reach your backend, and browsers only allow the microphone on HTTPS. For example `https://calling.example.com`. |
| Node.js | Version 18 or newer. There are no npm dependencies to install. |
| Agents | A current Chrome, Edge, Firefox or Safari, a microphone, and permission to use it. |

---

## Quick start

1. **Get the code.**

   ```bash
   git clone https://github.com/vobiz-ai/Vobiz-ClickUp-Calling.git
   cd Vobiz-ClickUp-Calling
   ```

   Nothing to install: the backend uses only Node.js itself, and the SIP library
   ships in `clickup-app/lib/`.

2. **Configure the backend.**

   ```bash
   cp backend/.env.example backend/.env
   ```

   Edit `backend/.env` and set:

   ```bash
   PUBLIC_BASE_URL=https://calling.example.com
   CLICKUP_API_TOKEN=pk_XXXXXXXX_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
   CLICKUP_LIST_ID=901234567890
   SIGNING_SECRET=<a long random string, e.g. the output of: openssl rand -hex 32>
   ```

   The list ID is the number after `/li/` in the list's URL in ClickUp.
   `.env` holds deployment settings only. Your Vobiz credentials do not go here:
   agents type them into the softphone. See
   [Configuration reference](#configuration-reference) for every setting.

3. **Start the backend.**

   ```bash
   npm start
   ```

   It listens on port `8092`.

4. **Make it reachable over HTTPS.** Point `https://calling.example.com` at port
   8092 with your reverse proxy or load balancer.

   For a quick trial without a domain, run `npm run tunnel` in a second terminal.
   It starts a Cloudflare quick tunnel (install `cloudflared` first, for example
   `brew install cloudflared`) and saves the URL in `backend/tunnel-url.txt`. The
   backend uses that URL when `PUBLIC_BASE_URL` is not set. Quick-tunnel URLs
   change every time, so do not use one in production.

5. **Check that Vobiz can reach you.**

   ```bash
   curl -s https://calling.example.com/health
   curl -s "https://calling.example.com/answer?From=%2B15550100111&To=%2B15550100222"
   ```

   The second command must return XML that starts with `<Response>`. With nobody
   signed in, that is a short spoken message and `<Hangup/>`. An HTML page means
   the request is not reaching the backend, and every call will fail.

6. **Open the softphone and sign in.** Open `https://calling.example.com/` in a
   browser tab next to ClickUp, sign in (see below), allow the microphone, and
   wait for the badge to read **READY**. Share the same URL with your agents.

7. **Place a test call.** Type a number and click **Call**. When the call ends, a
   task appears in your ClickUp list.

---

## Sign in

The panel has two tabs. Use **Vobiz account** unless you have a reason not to.

### Vobiz account (recommended)

1. Open the **Vobiz account** tab.
2. Enter your **Auth ID** (`MA_XXXXXXXX`) and **Auth Token** from Console →
   API credentials. The Auth Token is not your Console login password.
3. Pick your **ClickUp Agent Profile** and click **Log in**.

The backend checks the credentials with Vobiz, then sets up your account
automatically:

- **An application named `Vobiz ClickUp Calling`**, with answer URL
  `https://calling.example.com/answer` and hangup URL
  `https://calling.example.com/hangup-callback`. If your account already has an
  application with exactly that answer URL, it is reused. Applications this
  integration did not create are never changed.
- **One SIP endpoint per agent profile**, with the alias `ClickUp-<profile>`,
  attached to that application. The endpoint is reused on later sign-ins, and
  each sign-in gives it a new random SIP password that only that browser session
  receives.

Your numbers then fill the **Choose a caller ID** dropdown.

**Choose a caller ID.** The dropdown lists the active, voice-enabled numbers on
your account. Outgoing calls show the number you pick. The backend refuses any
number that is not on your account.

**Enable inbound calls.** Select a number and click **Enable inbound calls** to
make calls to that number ring the softphone. This attaches the number to the
`Vobiz ClickUp Calling` application. A number can belong to only one
application, so this moves it off the application it is on now. Before anything
changes, the panel tells you which application that is and asks you to confirm.
Signing in never moves a number by itself. You only need to do this once per
number.

### SIP direct

Use this if you want an agent to sign in as an endpoint you already manage,
without entering account credentials in the softphone.

1. Open the **SIP Direct** tab.
2. Enter the endpoint's **SIP Username** and **SIP Password** (Console → Voice →
   Endpoints), and a **Calling From (Caller ID)** number in full international
   format, such as `+91XXXXXXXXXX`. The number must be on the same Vobiz account
   as the endpoint.
3. Click **Connect**.

The browser registers with Vobiz directly. The SIP password is never sent to
your backend. **Remember these** keeps the username and caller ID in this
browser, never the password.

**Before you use SIP direct**, connect the endpoint and the number to an
application whose answer URL is your backend's `/answer`:

1. Console → Voice → Applications: create an application with answer URL
   `https://calling.example.com/answer` (method `POST`) and hangup URL
   `https://calling.example.com/hangup-callback`.
2. Console → Voice → Endpoints: set the endpoint's application to it.
3. Console → Phone numbers: attach the caller ID number to the same application,
   so inbound calls to it ring this agent.

The same steps with the API:

```bash
AUTH_ID=MA_XXXXXXXX
AUTH_TOKEN=your_auth_token

# 1. Create the application. Note the app_id in the response.
curl -X POST "https://api.vobiz.ai/api/v1/Account/$AUTH_ID/Application/" \
  -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"app_name":"Vobiz ClickUp Calling","answer_url":"https://calling.example.com/answer","answer_method":"POST","hangup_url":"https://calling.example.com/hangup-callback","hangup_method":"POST"}'

# 2. Attach the endpoint to it.
curl -X POST "https://api.vobiz.ai/api/v1/Account/$AUTH_ID/Endpoint/<endpoint_id>/" \
  -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"app_id":"<app_id>"}'

# 3. Attach the number (URL-encode the +, as %2B).
curl -X POST "https://api.vobiz.ai/api/v1/Account/$AUTH_ID/numbers/%2B91XXXXXXXXXX/application" \
  -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"application_id":"<app_id>"}'
```

**Not available with SIP direct:** the caller ID dropdown, **Enable inbound
calls**, the recordings list and playback, the ClickUp task lookup during calls,
and **Sync CDRs**. Calls are still logged to ClickUp, without a recording link.

### Agent profiles

The **ClickUp Agent Profile** dropdown decides which SIP endpoint an agent uses
and which name appears on their call tasks. It ships with two profiles,
`admin` and `agent1`. Each agent who is signed in at the same time needs their
own profile: signing in with a profile that is already in use signs the other
browser out.

To add profiles, add an entry to `backend/agents.json`:

```json
{
  "admin":  { "name": "System Administrator" },
  "agent1": { "name": "John Doe" },
  "priya":  { "name": "Priya Sharma" }
}
```

and add a matching option to the `loginAgentSelect` dropdown in
`clickup-app/index.html`:

```html
<option value="priya">Priya Sharma (priya)</option>
```

---

## Using it

### Outbound calls

1. Wait for the badge to read **READY**. The **Call** button stays disabled until
   the softphone has registered with Vobiz.
2. Type the number in international format (for example `+91XXXXXXXXXX`), or use
   the keypad, and click **Call** or press Enter.
3. While the call runs you see a timer and **Mute** and **Hold** buttons. The
   keypad sends tones, for menus.
4. The **ClickUp Task / Contact** card shows the existing task for that number,
   with **Open in ClickUp**, or tells you a new task will be created.

Outgoing calls ring for up to 30 seconds and can last up to 4 hours.

### Inbound calls

After you enable inbound calls on a number, a call to it rings every agent who
is signed in with that Vobiz account and shows **READY**. The panel shows the
caller's number, plays a ringtone, shows a desktop notification if you allowed
them, and looks the caller up in ClickUp. Press **Enter** or click **Accept** to
answer, **Escape** or **Decline** to decline. The first agent to answer gets the
call. If no one answers within 20 seconds, the caller hears "no one is
available" and the call ends.

**Test Inbound Call** shows you the incoming-call prompt, ringtone and shortcuts
without a real call. Nothing is dialled and nothing is written to ClickUp.

### What gets written to ClickUp

Every call your backend answers creates **one task** in the list set by
`CLICKUP_LIST_ID`. This includes calls the customer did not pick up.

| Field | Value |
|---|---|
| Name | `Vobiz Outbound Call - +91XXXXXXXXXX` or `Vobiz Inbound Call - +91XXXXXXXXXX` (the customer's number) |
| Description | A table with the call UUID, direction, from, to, agent name, duration, hangup cause, call status and time, then the recording link |
| Tags | `vobiz-call`, `outbound` or `inbound`, and `cdr` |
| Priority | Normal |
| Status | The list's default status, or `CLICKUP_TASK_STATUS` if you set it |

The task is created when Vobiz reports the call result. When the recording is
ready, the same task is updated with the playback link. Tasks are created by
the ClickUp user who owns the API token, and they are not assigned to anyone.

The caller lookup during a call searches the same list for a task whose name or
description contains the customer's number, so tasks this integration created
are found on the customer's next call.

### Recordings

Every call is recorded in your Vobiz account (MP3, up to one hour). On the task,
**Click to Play Call Recording** streams the audio through your backend. The
link is signed and expires after `RECORDING_URL_TTL_SECONDS` (15 minutes by
default).

In the panel, **Call recordings & CDRs** lists recent recordings on your account
with a **Play** button that always gets a fresh link. The refresh button
reloads the list.

### Sync CDRs

The **Sync CDRs** button (next to refresh in **Call recordings & CDRs**) fetches
the five most recent call records from your Vobiz account and creates a ClickUp
task for each one. Use it to backfill calls made outside the softphone. Each
click creates new tasks, even for calls that are already in ClickUp. These tasks
carry no recording link.

---

## Configuration reference

Set these in `backend/.env` or as environment variables. These are all the
settings the backend reads.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PUBLIC_BASE_URL` | Yes, in production | URL in `backend/tunnel-url.txt`, else the address the browser used | Your backend's public HTTPS address, such as `https://calling.example.com`. It becomes the answer URL of the Vobiz application and the base of recording links. |
| `TUNNEL_URL` | No | none | Used in place of `PUBLIC_BASE_URL` when that is not set. |
| `PORT` | No | `8092` | Port the backend listens on. `npm run tunnel` uses it too. |
| `DATA_DIR` | No | `backend/data` | Folder for `endpoints.json`, the map of agent profiles to SIP endpoints. Holds no passwords or tokens. |
| `CLICKUP_API_TOKEN` | Yes, to log calls | none | Personal API token (`pk_...`) of the ClickUp user that creates the tasks. |
| `CLICKUP_LIST_ID` | Yes, to log calls | none | ID of the ClickUp list that receives call tasks. |
| `CLICKUP_TASK_STATUS` | No | the list's default status | Status for new call tasks. It must be a status the list defines, or ClickUp rejects the task. |
| `CLICKUP_API_URL` | No | `https://api.clickup.com/api/v2` | ClickUp API address. Leave as is. |
| `SIGNING_SECRET` | Yes, in production | random on each start | Secret used to sign recording links. If you leave it unset, every restart breaks the links already in ClickUp. |
| `RECORDING_URL_TTL_SECONDS` | No | `900` | How long a recording link works, in seconds. |
| `ALLOWED_ORIGINS` | No | none | Extra browser origins allowed to call the backend, comma-separated. The softphone page itself, `*.clickup.com` and `localhost` are always allowed. |
| `VOBIZ_API_URL` | No | `https://api.vobiz.ai` | Vobiz API address. Leave as is. |
| `VOBIZ_REGISTRAR` | No | `registrar.vobiz.ai` | Vobiz SIP registrar. Leave as is. |

If `CLICKUP_API_TOKEN` or `CLICKUP_LIST_ID` is missing, calls still work, but no
tasks are created. The backend logs `ClickUp token not set` for each call
instead.

---

## Deploying to production

- **Use a stable HTTPS address** and set `PUBLIC_BASE_URL` to it. Each Vobiz
  account's application is created with this address as its answer URL. If the
  address changes, agents must sign in again, which creates an application for
  the new address, and you must click **Enable inbound calls** again for each
  inbound number.
- **Run exactly one instance.** Sign-ins and in-progress calls are held in the
  backend's memory, so two instances behind a load balancer would each miss the
  other's calls.
- **Keep `DATA_DIR` on persistent storage.** If it is lost, agents' endpoints are
  found again by their `ClickUp-<profile>` alias, so this is not fatal, but a
  persistent folder keeps sign-in fast.
- **Set `SIGNING_SECRET`** to a long random value and keep it the same across
  restarts and deploys.
- **Restart with care.** After a restart, every agent must sign in again. Until
  someone from an account signs in, inbound calls to that account's numbers are
  answered with "this number cannot take calls right now", and its recording
  links do not play.
- **Use a dedicated ClickUp user** for the API token, with access to the call
  list only.
- **Nothing to install in ClickUp.** There is no ClickUp app to package or
  upload. Give agents the softphone URL; for example, put it in a ClickUp Doc
  your team uses.

---

## Security and privacy

- **Your Auth Token never leaves the server and is never stored on disk.** It is
  held in the backend's memory only while the server runs, and it is never
  logged or sent back to the browser.
- **SIP passwords** for account sign-ins are random, new on every sign-in, and
  given only to the signed-in browser session. With SIP direct, the password
  stays in the browser.
- **What is stored on disk:** `DATA_DIR/endpoints.json`, mapping each account
  and agent profile to an endpoint ID and SIP username, with file mode `0600`.
  No passwords, no tokens.
- **What the browser keeps:** a session token (valid for 24 hours), the Auth ID,
  the agent profile and the numbers list, in local storage. With **Remember
  these**, also the SIP username and caller ID.
- **Each session sees only its own account.** Numbers, recordings, call records
  and caller IDs are all limited to the Vobiz account that signed in.
- **Recording links are signed and expire.** Each link names the Vobiz account
  it belongs to and can only play that account's audio. The backend fetches the
  audio from Vobiz itself and only from Vobiz storage hosts.
- **Only known origins** may call the backend from a browser: the softphone page,
  `*.clickup.com`, `localhost`, and anything in `ALLOWED_ORIGINS`.
- **Webhooks:** the backend does not verify Vobiz webhook signatures. It only
  acts on calls it answered itself, and the call webhooks never return account
  data.
- **ClickUp tasks are visible to everyone with access to the list,** including
  customer numbers and recording links. Choose the list accordingly.
- **The ClickUp API token** carries everything its owner can access in ClickUp.
  Use a dedicated user with access to the call list only.

To report a vulnerability, email `support@vobiz.ai`. See [SECURITY.md](SECURITY.md).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/answer` returns an HTML page | The request is not reaching the backend (proxy, firewall or tunnel error page). | Fix the route to port 8092 until the `curl` in [Quick start](#quick-start) step 5 returns `<Response>` XML. |
| "Invalid Vobiz Auth ID or Auth Token." | Vobiz refused the credentials. | Copy both again from Console → API credentials. The Auth Token is not your login password. |
| "Could not reach Vobiz to check those credentials." | The backend cannot reach `api.vobiz.ai`. | Allow outbound HTTPS from the server, and leave `VOBIZ_API_URL` unset. |
| "Signed in to Vobiz, but setting up the softphone failed" | Vobiz refused to create the application or the endpoint. | The backend log line starting `[provision]` gives the reason. Check that the account is active. |
| The badge reads **OFFLINE** and the status line says **Not registered** | The agent profile was signed in from another tab or browser, which replaced this one's SIP password, or (SIP direct) the username or password is wrong. | Sign out and sign in again. Give each agent their own profile. On SIP direct, check the endpoint's credentials. |
| The badge never gets past **REGISTERING** | No microphone access, or the page is not on HTTPS. | Open the softphone at its `https://` address, allow the microphone, and reload. |
| Calls stopped working after the server address changed | Your Vobiz application still points to the old answer URL. | Set `PUBLIC_BASE_URL`, restart, sign in again, and click **Enable inbound calls** again. |
| Calls fail although `/answer` works | `PUBLIC_BASE_URL` was not set when you signed in, so the application was created with the address you opened the page on, such as `http://localhost:8092`. | Set `PUBLIC_BASE_URL`, restart, and sign in again. |
| The agent hears "This phone is not signed in" when dialling | The SIP endpoint placing the call is not signed in on this backend, usually after a restart. | Sign in to the softphone again. |
| The caller hears "This number cannot take calls right now" | No one from that Vobiz account has signed in since the backend started, or (SIP direct) no agent's caller ID matches the dialled number. | Have an agent sign in. |
| Inbound calls do not reach the backend at all | The number is not attached to the integration's application. | Click **Enable inbound calls** for the number (Vobiz account), or attach it in the Console (SIP direct). |
| "This account has no phone number to call from" | The account has no active, voice-enabled number. | Add a number in the Vobiz Console, then sign in again. |
| No task appears in ClickUp | Token or list not set, the token's user cannot write to the list, or `CLICKUP_TASK_STATUS` is not a status of that list. | Check the backend log for `[ClickUp] API error` or `ClickUp token not set`, and fix the setting it names. |
| A recording link in a task says "Invalid or expired playback signature" | The link is older than `RECORDING_URL_TTL_SECONDS`, or `SIGNING_SECRET` changed since it was made. | Play the recording from the softphone's recordings list, which always makes a fresh link. Set a fixed `SIGNING_SECRET`. |
| A recording says "Sign in again, then retry" | The backend restarted and no one from that account has signed in since. | Sign in, then play it again. |
| "Sign in first" errors in the browser | The session expired (after 24 hours) or the backend restarted. | Sign in again. |

---

## Limitations

- **Sign in again after every backend restart.** Sign-ins live in memory. Until
  an agent from an account signs in again, inbound calls to its numbers are
  turned away and its recording links do not play.
- **Run one backend instance.** State is not shared between instances.
- **Recording links in ClickUp expire** after `RECORDING_URL_TTL_SECONDS`
  (15 minutes by default). Older calls play from the softphone.
- **SIP direct** has no caller ID dropdown, inbound enabling, recordings, task
  lookup or CDR sync, and its ClickUp tasks have no recording link.
- **Every call is recorded.** There is no setting to turn recording off.
- **Tasks are created by one ClickUp user** (the token owner) and are not
  assigned to the agent.
- **Task status is fixed:** one status for all call tasks, not one per call
  outcome.
- **The caller lookup** reads the first 100 tasks in the list (open and closed)
  and matches the number's digits in the task name or description.
- **Sync CDRs** imports the five most recent calls and creates duplicate tasks
  if you run it twice.
- **The Transfer button does not transfer calls.** It only asks for a number and
  shows a message.
- **Agent profiles** are defined in `backend/agents.json` and in the dropdown in
  `clickup-app/index.html`, and two browsers cannot share one profile.
- **Not a ClickUp app.** The softphone runs in its own browser tab, not inside
  ClickUp.

---

## Development

```bash
npm test
```

The test suite starts its own backend against local stand-ins for the Vobiz and
ClickUp APIs, so it places no calls and writes nothing. It exits non-zero on any
failure. CI runs it on Node 18, 20 and 22, plus a check that no credential is
committed. There is no separate lint step.

```
backend/
  server.js            the backend: sign-in, Vobiz webhooks, ClickUp tasks, recordings, static files
  .env.example         configuration template
  agents.json          agent profiles (display names)
clickup-app/
  index.html           the softphone page
  softphone.js         sign-in, dialer, call states, ClickUp task card, recordings
  vobiz-sip.js         SIP over WebRTC (wraps JsSIP)
  lib/jssip.min.js     JsSIP, bundled
scripts/
  run-verification.js  test runner (starts the backend and the API stand-ins)
  verify-integration.js the tests
  tunnel.js            `npm run tunnel`: Cloudflare quick tunnel for trials
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request.

---

## Support

- Vobiz documentation: https://www.vobiz.ai/docs
- This integration's guide: https://www.vobiz.ai/docs/integrations/clickup
- Help: `support@vobiz.ai`

## License

MIT. See [LICENSE](LICENSE).
