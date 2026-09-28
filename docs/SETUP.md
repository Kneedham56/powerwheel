# Setting up your own PowerWheel

This guide gets a new person from zero to their own private PowerWheel: their own database, their own Robinhood data, their own deployed site. It's written so **Claude Code can do most of it**. Start a Claude Code session in an empty folder and say:

> Set up PowerWheel for me by following docs/SETUP.md in https://github.com/Kneedham56/powerwheel. Do the automated steps yourself and walk me through the manual ones.

Steps marked 🧑 need a human (account sign-ups, copying secrets, clicking Authorize). Steps marked 🤖 Claude can do. Claude should never ask the human to paste secrets into the chat. The human pastes them into files or dashboards directly.

---

## 0. Accounts you'll need 🧑

| Service | What for | Cost |
|---|---|---|
| GitHub | your copy of the code | free |
| Supabase | the database | free tier is plenty |
| Vercel | hosting the site | free (Hobby) |
| Claude (Pro or Max) | Claude Code + the Robinhood connector | subscription |
| Node.js 20+ and Git on your computer | running things locally | free |

In claude.ai → **Settings → Connectors**, connect **Robinhood**. It needs read access to your accounts. PowerWheel only ever reads; it never places orders.

## 1. Get the code 🤖

```bash
gh repo fork Kneedham56/powerwheel --clone --remote
cd powerwheel
npm install
```

If `gh` isn't signed in, the human runs `gh auth login --web` first. You can also skip the fork and use `git clone`, but a fork makes deploying to Vercel easier.

## 2. Create the database 🧑 then 🤖

1. 🧑 In Supabase, create a new project. Any name works; choose a strong database password and save it.
2. 🤖 Copy the template: `cp .env.example .env.local`.
3. 🧑 Fill in `.env.local` from the Supabase dashboard:
   - `NEXT_PUBLIC_SUPABASE_URL`: Project Settings → API → Project URL
   - `SUPABASE_SERVICE_ROLE_KEY`: Project Settings → API Keys → *Legacy API keys* → `service_role` (the `eyJ…` one)
   - `DIRECT_URL`: the **Connect** button → *Direct connection* string, with your database password filled in
4. 🤖 Create the tables:
   ```bash
   for f in supabase/migrations/*.sql; do npm run sql -- -f "$f"; done
   ```

## 3. Your accounts and streams 🤖 (ask the human)

The first migration seeds Kyle's setup: accounts **Individual** and **Joint**, and streams **Individual Wheel**, **Joint Wheel** and **Tesla CC** (TSLA calls in Joint). Adjust it to the new user:

1. With the Robinhood connector, call `get_accounts`. Show the human their accounts, with numbers masked to the last 4 digits, and ask which ones to track.
2. Rename or add accounts, and set each one's Robinhood number, for example:
   ```bash
   npm run sql -- "update accounts set broker_account_ref='<number>' where name='Individual'"
   ```
3. Ask which **streams** they want. A stream is a reporting bucket: "the wheel in my IRA", "covered calls on my NVDA shares".
   - Most people only need one wheel stream per account.
   - Delete the Tesla CC stream and its rules if they don't need them.
   - Stream rules auto-assign positions: account, ticker, and put/call/stock. Everything is editable later on the Settings page.

## 4. Import history 🤖

Follow **docs/SYNC.md**, with two changes for a first import:

- `created_at_gte` = how far back to go, e.g. `2025-01-01`. Follow every `next` cursor. Large pages are saved to files, so list those under `order_files`.
- `get_pnl_trade_history` with `span="all"` (follow `next_cursor`), so expirations and assignments settle correctly.

Then run `npm run sync -- status`. It should report **0** open options past expiration. Spot-check a few recent trades against Robinhood.

Take one account snapshot: `get_portfolio` for each account, in the import file.

## 5. Try it locally 🤖

```bash
npm run dev
```

Open http://localhost:3000. Locally there's no login.

## 6. Deploy to Vercel 🧑

1. vercel.com → **Add New… → Project** → import your GitHub fork. The framework is detected as Next.js.
2. Before the first deploy, open **Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | from `.env.local` |
   | `SUPABASE_SERVICE_ROLE_KEY` | from `.env.local` |
   | `APP_PASSWORD` | a long password: this is your site login |
   | `AUTH_SECRET` | any long random string (e.g. from a password generator) |

3. Click **Deploy**. Open the URL, and you'll get a sign-in page. Enter `APP_PASSWORD`.

Every push to `main` redeploys automatically.

## 7. Automatic updates 🤖 + 🧑

The sync runs as a Claude Code **cloud routine** under the new user's own Claude account.

1. 🧑 At claude.ai/code, open the environment selector (the cloud button above the message box) → gear icon on **Default**:
   - **Environment variables:** `NEXT_PUBLIC_SUPABASE_URL=…` and `SUPABASE_SERVICE_ROLE_KEY=…`
   - **Network access:** Custom → allowed domain `<project-ref>.supabase.co`, and tick "also include default package managers"
2. 🧑 Connect GitHub to Claude (claude.ai/code prompts for it), so routines can clone the fork.
3. 🤖 Create the routines with `/schedule`, for example Monday after market close and Saturday morning.
   - Prompt: *"Sync Robinhood option activity into the PowerWheel database. Follow docs/SYNC.md exactly, steps 1–5. Use only read-only Robinhood tools. Do not edit code, commit or push."*
   - Attach only the Robinhood connector, limited to `get_option_orders`, `get_pnl_trade_history`, `get_portfolio` and `get_accounts`.
4. 🤖 Trigger one run manually and read its log to confirm it works.

## Notes

- **Security:** the site is protected by `APP_PASSWORD`. The database is only reachable with the service key, which lives on the server (Vercel) and never reaches the browser.
- **Robinhood:** only read tools are used. Routines should only have read tools attached.
- **Updating:** pull new versions of the code with `git pull upstream main` (the fork step added `upstream`). New migrations need to be run once: `npm run sql -- -f supabase/migrations/<new file>`.
