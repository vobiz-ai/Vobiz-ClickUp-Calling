# Quick Start Guide: Vobiz ClickUp Integration

Get the Vobiz and ClickUp integration running and tested in simple steps!

---

## Step 1: Start the Backend Server

Open a terminal window in the project directory and run:

```bash
npm start
```

*The server will start on `http://localhost:8092`.*

---

## Step 2: Run Automated Mock Tests

In a second terminal window, run the automated integration tests:

### Outbound Call & Recording Test:
```bash
npm run test:outbound
```

### Inbound Call & Recording Test:
```bash
npm run test:inbound
```

### Recording Audio Proxy Test:
```bash
npm run test:recording
```

---

## Step 3: Open the Agent Softphone UI

Open your browser and navigate to:
[http://localhost:8092/agent-phone/index.html](http://localhost:8092/agent-phone/index.html)

- Select your Agent profile (**System Administrator** or **John Doe**).
- Enter a phone number and click **Call via Vobiz**.
- Experience active call controls and click **Play MP3** to listen to the proxied call recording!

---

## Step 4: Enable Live Webhooks (Optional for PSTN Calls)

To receive live webhooks from Vobiz for real PSTN calls:

```bash
npm run tunnel
```

Copy the generated Quick Tunnel URL (`https://xxxx.trycloudflare.com`) and paste it as your callback URL in your Vobiz Voice Application settings.

For full technical documentation, see [VOBIZ_CLICKUP_CDR_RECORDING_TESTING_GUIDE.md](VOBIZ_CLICKUP_CDR_RECORDING_TESTING_GUIDE.md).
