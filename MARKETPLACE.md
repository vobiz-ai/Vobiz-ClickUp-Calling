# Distribution on ClickUp

The integration works as a self-hosted install: a backend you run and a
softphone page you open beside ClickUp. Listing it in ClickUp's App Directory is
separate work, and it starts with two things this repository does not have.

---

## Decide first: who hosts the backend

**A listed app cannot ask every customer to run a Node backend on a tunnel.**
The Vobiz `answer_url` must be stable and reachable, and the backend holds Vobiz
account credentials plus a ClickUp token.

Either Vobiz hosts one multi-tenant backend at a permanent domain — which means
real per-account authentication, not the single-account binding this has today —
or it stays a self-hosted integration with published documentation.

Until that is settled, everything below is premature.

---

## What a ClickUp App Directory listing requires

### Not done yet

- [ ] **OAuth 2.0.** ClickUp's directory is built around OAuth apps. This uses a
      `pk_…` personal API token, which carries its owner's full access to every
      space they can see and attributes every call task to them rather than to
      the agent who made the call. OAuth fixes both and is not optional for a
      listing.
- [ ] **An actual ClickUp surface.** Today the softphone is a separate page.
      A listed app is expected to appear inside ClickUp — an app view, a command
      centre entry, or at minimum a documented embed.
- [ ] **A stable public hostname** for the redirect URI and `answer_url`.
- [ ] **Webhook handling for ClickUp events**, if the listing claims two-way
      sync. Today the flow is one-way: calls create tasks; nothing reads task
      changes back.
- [ ] Listing assets: icon, description, screenshots, a short demo video.
- [ ] Terms of Service and Privacy Policy URLs, published — the listing form
      requires both.
- [ ] A test workspace and credentials for ClickUp's reviewers.
- [ ] Support contact: `support@vobiz.ai`, on a page that exists.

### Already true

- [x] Calls create structured tasks with a readable CDR table.
- [x] Recording links are signed and expire, so a task cannot become a permanent
      handle on call audio.
- [x] No credentials in the repository or in the browser's storage.
- [x] The backend reports honestly when ClickUp is unconfigured (`simulated:
      true`) rather than inventing tasks that look real.

---

## Worth resolving before a reviewer sees it

- **Statuses are assumed.** Tasks are created as `CONNECTED`, and the board view
  expects `DIALING`, `VOICEMAIL` and `NOT DIALED` to exist. ClickUp rejects a
  status the target list does not define; a reviewer's fresh workspace will not
  have them.
- **Every call task is created by the token owner**, so the ClickUp activity
  feed attributes the whole team's calls to one person.
- **Call tasks carry the customer's phone number and a recording link** into a
  space that may be shared more widely than the call was. Worth a line in the
  privacy policy, and worth asking whether the list should be private by
  default.
