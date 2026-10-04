# PowerWheel: getting started (no coding needed)

PowerWheel is a private dashboard for tracking options trades (selling cash-secured puts and covered calls). You give it a report downloaded from Robinhood and it builds the charts and stats: premium collected, return on capital, win rate, and the history of each trade.

You will make three free accounts: **Supabase** (stores your data), **Vercel** (runs the website), and a **GitHub** login (Vercel uses it to sign in). Plan on about 30 minutes, plus a wait for Robinhood to produce your report.

> Your data lives in **your own** Supabase project. Nobody else's database is involved, and the site is protected by a password you choose.

---

## 1. Create your database (Supabase)

1. Go to **supabase.com** and sign up (the "Continue with GitHub" button is easiest).
2. Click **New project**. Name it anything (for example `powerwheel`). Choose a database password and **save it somewhere safe**. Pick the region closest to you, then **Create**. It takes about two minutes.

## 2. Create the tables

1. In your project, click **SQL Editor** in the left menu, then **New query**.
2. Open [this file](https://github.com/Kneedham56/powerwheel/blob/main/supabase/new-user-setup.sql), click the **Copy raw file** button, and paste it into the editor.
3. Click **Run**. You should see "Success. No rows returned". Run it **once only**.

## 3. Copy two values from Supabase

Open **Project Settings** (the gear icon) → **API**.

| What | Where |
|---|---|
| **Project URL** | at the top of the API page |
| **service_role key** | **API Keys** tab → **Legacy API keys** → `service_role` → **Reveal**. It starts with `eyJ` |

> ⚠️ The `service_role` key is like a master password for your data. Never post it publicly, never put it in a screenshot, and don't email it. If it ever leaks, you can reset it on that same page.

## 4. Put the website online (Vercel)

Pick one.

**Option A: your own Vercel account (you control everything)**

1. On GitHub, open `github.com/Kneedham56/powerwheel` and click **Fork** (top right) to make your own copy.
2. Go to **vercel.com**, sign up with GitHub, and click **Add New… → Project**. Choose your `powerwheel` fork.
3. Before clicking Deploy, open **Environment Variables** and add these four:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | the Project URL from step 3 |
   | `SUPABASE_SERVICE_ROLE_KEY` | the `service_role` key from step 3 |
   | `APP_PASSWORD` | a long password you'll type to sign in to your site |
   | `AUTH_SECRET` | any long random string (a password generator works) |

4. Click **Deploy**. When it finishes, open the link. You'll see a sign-in page: enter your `APP_PASSWORD`.

**Option B: Kyle hosts it for you**

Send Kyle the Project URL, the `service_role` key, and the sign-in password you want, through a password manager or a private message. He adds them as a separate Vercel project. This works, but it means his Vercel account holds your key, so he could technically see your data. If you want to change that later, reset the key in Supabase and switch to Option A.

*(The site includes a small daily job that keeps your free Supabase project from going to sleep. You don't need to do anything.)*

## 5. Download your report from Robinhood

1. In Robinhood, open **Account → Reports and statements**.
2. Choose **Account activity report**, then **Generate new report**.
3. Pick the account, set the **start date** to the earliest trade you want tracked, and the **end date** to today. Click **Generate report**.
4. It usually takes about 2 hours and can take up to 24. Robinhood tells you when it's ready; download the **CSV** from **Reports**.

One file is one account. If you trade in more than one account, generate one report per account.

## 6. Import it

1. Open your site, sign in, and click **Import** in the top menu.
2. **Account:** pick *My Account* (you can rename it later in **Settings**), or choose **+ New account…** and type a name. Use a separate account for each Robinhood account if you want them apart.
3. **Stream:** a stream is a "bucket" for reports. Leave it on **Automatic** for your first file, or choose **+ New stream…** to give the file its own bucket. To lump several accounts together, pick the same stream for each file.
4. Choose your CSV file and click **Preview**. It shows what's inside without saving anything. Then click **Import**.
5. A year of history takes a few minutes. Keep the tab open until it says **Imported**, then click **Go to Reports**.

## 7. Optional: record your account value

The **Return on capital** number at the top of Reports needs to know how much your account was worth. Without it the card says "Add account snapshots to see this". Everything else works without it.

1. Click **Account value** in the menu.
2. Enter **As of** (a date), **Total value** (your account's total), and optionally **Cash** and **Deposits** (money added or withdrawn since the last entry).
3. Add one entry near your start date, then add a new one now and then (once a week is plenty).

## 8. Keeping it up to date

Whenever you want fresh numbers, download a new activity report (it's fine if the dates overlap with the last one) and import it the same way. Anything already imported is skipped automatically, so you can't double-count.

---

## What to expect (these are estimates, not an audit)

The stats are meant to give you a good picture, not to match every penny.

- **Rolls are guessed.** A report doesn't say which trades were rolls, so PowerWheel infers them from same-day trades. A few may be grouped differently from how Robinhood shows them. Totals aren't affected.
- **Win rate runs a little high.** When a put is assigned, a loss is only counted if the stock closed far below your strike. That needs the stock's price on expiry day, which isn't in your report, so assigned trades are scored by premium only.
- **Not tracked:** interest, margin interest, deposits, and shares you bought yourself. The *Wheel cycles* section only follows shares that came from an assignment.
- **Trades from before your start date.** If the report begins in the middle of a trade, the import shows a "Heads up" note for the pieces it can't match. Pick an earlier start date to avoid this.

## If something goes wrong

| Problem | Fix |
|---|---|
| Site says it can't reach the database | Your free Supabase project may have paused. Open it in Supabase and click **Restore project**. |
| Import says "No stream rule covers this account" | Choose a stream (or **+ New stream…**) instead of Automatic. |
| Import stops partway | Run it again. It picks up where it left off and skips what's already in. |
| The numbers look wrong | Open **Heads up** on the import screen and send Kyle a screenshot. |
| Forgot your site password | In Vercel: Project → Settings → Environment Variables → change `APP_PASSWORD` → redeploy. |

## Keeping it safe

- Only you (and anyone you give the password to) can open the site. Don't share the link and password together.
- Your Supabase `service_role` key and database password never go in chat messages, screenshots, or the code.
- To remove everything, delete the Supabase project and the Vercel project.
