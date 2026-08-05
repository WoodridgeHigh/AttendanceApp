# Attendance Register (Supabase edition)

Same app, faster free-tier backend. Teachers mark daily attendance for their
own class; admins see which classes have marked attendance, pull an absentee
list for any day, and message parents via WhatsApp — still zero paid hosting
or database, but backed by real Postgres instead of a spreadsheet.

**Stack:** Supabase (Postgres database + Auth + Edge Functions, all free
tier) · manual username/password login (Supabase's own secure auth under the
hood — see "How the login works" below) · plain HTML/CSS/JS on GitHub Pages
· `wa.me` links for WhatsApp.

**Why this instead of the Google Sheets version:** no cold starts, real
indexed queries instead of scanning a whole sheet, real concurrent-write
handling, and no dependency on a Google Workspace domain's sharing policies
(which caused random failures in the Sheets version for school accounts).

---

## 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) → sign up (a personal account,
   not tied to your school's Google Workspace, is the simplest path) → **New
   project**. Pick any name/region, set a database password (you won't need
   it day-to-day — Supabase manages connections for you).
2. Wait a minute or two for the project to finish provisioning.

## 2. Run the database schema

1. In your Supabase project, open the **SQL Editor** (left sidebar).
2. Open `supabase/schema.sql` from this repo, copy its entire contents,
   paste into a new query, and click **Run**.
3. This creates all four tables (`profiles`, `students`, `attendance`,
   `attendance_log`), turns on Row Level Security, and creates the
   `submit_attendance`, `get_roster`, `get_dashboard`, and `get_absentees`
   functions that the app calls.

## 3. Turn off email confirmation

Since usernames are mapped to fake `@attendance.local` addresses (nobody can
receive mail there), Supabase must not require confirming them.

1. **Authentication → Sign In / Providers → Email**.
2. Turn **Confirm email** OFF.

## 4. Deploy the Edge Function

This function creates teacher accounts and resets passwords — the only two
operations that need elevated access, so they run here instead of in the
browser. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`
are provided automatically inside every Edge Function — no manual secrets to
configure.

**Using the Supabase CLI** (recommended):
```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF   # found in Project Settings → General
supabase functions deploy admin-actions
```

**Or from the dashboard** (no CLI): **Edge Functions → Create a function**,
name it `admin-actions`, and paste in the contents of
`supabase/functions/admin-actions/index.ts`.

## 5. Create your first admin account

There's no self-service sign-up, so the very first account is created
directly in the Supabase dashboard:

1. **Authentication → Users → Add user**. Email: `admin@attendance.local`
   (or any username you want + `@attendance.local`), set a password,
   and make sure **Auto Confirm User** is checked. Create it.
2. Copy that user's **UUID** from the users list.
3. **Table Editor → profiles → Insert row**: `id` = the UUID you copied,
   `username` = `admin` (or whatever you used before the `@`), `name` =
   your name, `role` = `admin`, leave `grade`/`section` empty. Save.
4. You can now sign in on the site with username `admin` and that password.
   Use the **Teachers** tab from there to add everyone else — the Edge
   Function handles account creation properly from that point on.

## 6. Configure the frontend

Find your **Project URL** and **anon public key** under **Project Settings
→ API**, then edit `docs/js/config.js`:

```js
const CONFIG = {
  SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...',
  SCHOOL_NAME: 'Your School Name'
};
```

The anon key is safe to expose in frontend code — that's how Supabase is
designed to work. Row Level Security (defined in `schema.sql`) is what
actually restricts what each signed-in user can read or write, not secrecy
of this key.

## 7. Deploy to GitHub Pages

Same as before — the site lives in `docs/` because GitHub Pages can only
serve the repo root or a `/docs` folder.

1. Push this repo to GitHub (see below if you're new to that).
2. Repo **Settings → Pages** → Source: **Deploy from a branch** → Branch:
   `main`, folder: `/docs` → **Save**.
3. Live at `https://yourusername.github.io/repo-name/` within a minute.

### If you've never pushed a repo to GitHub before

**No terminal:** [github.com/new](https://github.com/new) → create repo →
**uploading an existing file** → drag the whole extracted folder in →
**Commit changes**.

**With git:**
```bash
cd path/to/school-attendance-supabase
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/yourusername/attendance-register.git
git push -u origin main
```

## 8. Roster setup

1. Sign in as admin.
2. **Teachers** tab → register each teacher with a username, initial
   password, and Grade/Section (21 accounts for 3 grades × 7 sections).
   There's a "Change password" button in the top bar for self-service later.
3. **Students** tab → CSV import (see `sample-data/students_template.csv`)
   or add one at a time.
4. Teachers sign in and see only their own class.

---

## How the login works

Supabase Auth requires an email-shaped identifier, so each username is
mapped to `username@attendance.local` behind the scenes — a fake, never-sent
address, purely so Supabase's login system has something in the right shape
to work with. From there, everything is Supabase's real, production-grade
auth: passwords are hashed with bcrypt, sessions are proper signed JWTs that
refresh automatically, and none of that is something this app implements or
could get wrong. Compared to the Sheets version's hand-rolled salted-hash
approach, this is meaningfully more robust, and there's no session table to
maintain or clean up — Supabase handles expiry itself.

## How access control works

Every table has Row Level Security turned on. A teacher's Postgres queries
are automatically filtered to their own grade/section by policies that check
their `profiles` row — there's no server-side "resolve the caller's class"
step to trust, because Postgres itself enforces it on every single query,
including ones this app doesn't even make. Admin-only actions (dashboard,
absentee list, creating accounts) are enforced the same way, either in RLS
policies or inside the `security definer` functions.

---

## Suggested enhancements

1. **Consecutive-absence flag** — extend `get_absentees` to also check the
   last N days and flag students absent 3+ days running.
2. **CSV export of a date range** — a Postgres function that returns
   `attendance` rows for a date range, for term-end attendance percentages.
3. **"Sent" tracking for WhatsApp messages** — a `messages_sent` table
   written to when the admin clicks Send, so refreshing doesn't lose track
   of who's already been messaged.
4. **Substitute teacher access** — a `substitute_access` table (teacher id,
   grade, section, valid_until) checked as an extra OR clause in the RLS
   policies, for temporary one-day access without a permanent account.
5. **Login attempt throttling** — Supabase has built-in rate limiting on
   auth endpoints, but you can tighten it further in **Authentication →
   Rate Limits** if you want stricter brute-force protection.

---

## Repo structure

```
supabase/schema.sql                 Tables, RLS policies, RPC functions — run once in SQL Editor
supabase/functions/admin-actions/   Edge Function: create teacher accounts, reset passwords
docs/index.html                     Login page (username/password)
docs/teacher.html + js              Daily attendance marking (own class only)
docs/admin.html + js                Dashboard, absentees/WhatsApp, roster management
docs/css/styles.css                 Shared styles
sample-data/                        CSV template for bulk student import
```
