# Dempo Learn

A learning platform for a college of about 2,000 students. It does three things Google Classroom does not, and all three work end to end:

1. **Bulk roster import.** Bring the whole semester's students in from one CSV file, with a preview of what will happen to every row. Rows with mistakes are reported and left out, not silently dropped or merged.
2. **Exams that survive bad WiFi.** The server keeps the clock, answers auto-save every few seconds, work done offline is kept on the device and sent on reconnect, and a student who never comes back is submitted automatically at the deadline.
3. **A real academic gradebook.** Internal and external components with weights, the external-minimum pass rule, a 10-point letter grade, and CSV export for the university.

Each one traces back to a reason a college would pay instead of using a free tool: **exam-grade reliability**, **an academic gradebook**, and **ownership of the college's own data** (it runs on the college's own server with a single SQLite file).

---

## Run it

You need **Node.js 22.13 or newer** ([nodejs.org](https://nodejs.org), pick the LTS). Nothing else, and **no `npm install`**: the project has zero dependencies.

```bash
npm start            # or: node server.js
```

Open <http://localhost:3000>. On first run it creates a demo database in `data/dempo.db`.

| Role | Email | Password |
|---|---|---|
| Exam office (admin) | `admin@dempo.edu` | `admin123` |
| Faculty (teaches CS201, CS202) | `priya.naik@dempo.edu` | `faculty123` |
| Faculty (teaches MA201, EC201) | `rahul.kamat@dempo.edu` | `faculty123` |
| Student | `aisha.dsouza@dempo.edu` | `23CS001` |

The login page also has one-click buttons for these.

| Command | What it does |
|---|---|
| `npm start` | Start the server on port 3000 (`PORT=4000 npm start` to change it) |
| `npm run dev` | Start and restart automatically when files change |
| `npm test` | Run the 33 automated tests (in-memory database, about 2 seconds) |
| `npm run reset` | Delete the database; the next start re-creates the demo data |
| `npm run sample` | Regenerate the sample CSV files in `public/samples/` |

**If it fails to start:** `Dempo Learn needs Node.js 22.13 or newer` means exactly that. Check with `node -v`. The app uses the built-in `node:sqlite` module, which older versions don't have. A warning about `ExperimentalWarning: SQLite` is harmless; `npm start` hides it.

## Deploy to Vercel (demo mode)

Vercel detects `server.js` and runs it with no configuration file.

1. On [vercel.com](https://vercel.com) → **Add New… → Project** → import this GitHub repo. Leave every build setting at its default.
2. Under **Environment Variables**, add `SESSION_SECRET` with a long random value (any 40+ random characters). This keeps people signed in when Vercel moves them between copies of the app. **Never commit it to the repo.**
3. Click **Deploy**.

**What "demo mode" means:** Vercel has no permanent disk, so the database lives in `/tmp` and is recreated with the demo data whenever Vercel starts a fresh copy of the app (after a few minutes idle, on each redeploy, or under load). The demo accounts and sample courses are always there; anything you add may disappear. The login page says so. For real use with saved data, run it on a normal server (Render, Railway, a college machine) where `data/dempo.db` persists, or move the database to hosted Postgres.

## Sign-in with Clerk

[Clerk](https://clerk.com) handles sign-in (email codes, Google, and so on). **Dempo Learn still decides the role**: after Clerk proves who you are, the server matches your verified email against the users table. Students come from the roster import, teachers from the seed data, and the exam office from `ADMIN_EMAILS`.

Set these environment variables (in Vercel: Project → Settings → Environment Variables, then redeploy):

| Variable | Where to find it | Secret? |
|---|---|---|
| `CLERK_PUBLISHABLE_KEY` | Clerk Dashboard → API keys (`pk_test_…`) | No |
| `CLERK_SECRET_KEY` | Clerk Dashboard → API keys (`sk_test_…`) | **Yes, never commit it or paste it anywhere else** |
| `ADMIN_EMAILS` | Comma-separated emails that become exam-office accounts on first sign-in | No |
| `CLERK_AUTHORIZED_PARTIES` | Optional. Your site URL, e.g. `https://siuuu-lms.vercel.app`; rejects tokens made on other sites | No |
| `CLERK_JWT_KEY` | Optional. Clerk's PEM public key, to verify without fetching Clerk's key list | No |

How it behaves:

- **Email on the roster:** signed in with that account's role.
- **Email not on the roster:** told so plainly. On a demo site they can instead look around as the demo student, teacher or exam office.
- **Unverified email in Clerk:** refused until verified.
- **Password sign-in:** off once Clerk is set up, except on a demo site (`DEMO_MODE`), or if you set `ALLOW_PASSWORD_LOGIN=1`. If the Clerk keys are wrong, the site keeps password sign-in on and the login page says what's wrong, so nobody is locked out.
- **Sign out:** ends both the Dempo Learn session and the Clerk session.

Under the hood (`src/clerk.js`, no dependencies): the browser sends Clerk's session token to `POST /api/auth/clerk`. The server checks its RS256 signature against Clerk's public keys, its expiry and its issuer, then asks Clerk's Backend API for the verified email. Tests in `test/clerk.test.js` use a fake Clerk with real keys: forged, expired, wrong-app and wrong-site tokens are all rejected.

## A five-minute demo

1. **Roster.** Sign in as the exam office → *Import students* → *Sample with mistakes*. Upload it. The preview shows 14 rows: new students, existing students being enrolled in another course, duplicates skipped, and 8 mistakes, each with the line number and the reason. Import, then download *Rows to fix*. Now upload *Sample with 2,000 students*; it imports in under a second.
2. **Exam.** Sign in as Aisha → *Quiz 1* → Start. Answer a question and watch the badge change to *Saved*. Press **Simulate WiFi drop** at the bottom, answer two more questions, then **reload the page**. The answers are still there, and the timer did not reset. Reconnect and they sync. Submit.
3. **Gradebook.** Sign in as Dr. Priya Naik → CS201 → *Gradebook*. Aisha's quiz score arrived on its own (marked *from online exam*). Type a mark above a column's maximum and it's flagged. Fatima has a passing total (43.6) but gets **F** because her external score is below 40%. Export CSV.
4. **Marking.** Still as faculty → *Exams* → *Practice test* → Mark Sneha's written answer.

## How each feature behaves

### 1. Bulk roster import — `src/roster.js`

| Rule | Behaviour |
|---|---|
| Required columns | `roll_no`, `name`, `email`, `course_code`. Optional: `department`. Any order, any case; common variants like "Roll No" and "Email Address" are understood. Other columns are ignored and listed. |
| One row = | one student in one course. Repeat the student for more courses. |
| Mode | **Partial.** Valid rows go in (one transaction); rows with mistakes are left out and listed. Never all-or-nothing, because one typo in 2,000 rows shouldn't block a semester. |
| Preview | Always shown first and writes nothing. |
| Exact duplicate row | Skipped. |
| Same email, different roll no or name in one file | Error on the later row, naming the earlier line. |
| Email already registered with the same roll no | Reused; enrolled in the new course. Name is **not** overwritten. |
| Email or roll no belongs to someone else | Error. Never a silent merge. |
| Email belongs to faculty or admin | Error. |
| Already enrolled | Skipped. Uploading the same file twice is safe. |
| Malformed row | Bad email, empty field, unknown course, wrong column count (stray comma), bad roll format: error with line number. |
| Limits | 5,000 rows, 2 MB. Handles Excel's UTF-8 BOM, quoted fields and CRLF. |
| Afterwards | A summary, a filterable table, an import history, a full CSV report, and a *Rows to fix* CSV that can be corrected and re-uploaded. |
| First password | The student's roll number. It is hashed on first sign-in, because hashing 2,000 passwords during the import took over 20 seconds. |

### 2. Exam robustness — `src/exams.js`, exam runner in `public/app.js`

- **Server-side timer.** Pressing Start records `started_at` on the server and fixes `deadline = min(start + duration, exam closes_at)`. Reloading, switching device or changing the laptop's clock changes nothing. The page measures the difference between its clock and the server's and corrects for it.
- **Auto-save.** Saves 0.15s after a choice and 1.2s after typing stops. Each save carries an increasing sequence number, and the server keeps only the newest, so a queue flushed late after reconnecting can't overwrite newer answers.
- **WiFi drop.** Answers are written to the browser's storage on every change. Offline, the student keeps working and sees *Offline · kept on device*. Retries back off from 2s to 15s and fire immediately when the browser reports it is online again. Reloading while offline reopens the exam from the cached copy.
- **Time up.** At zero the page locks and submits. Saves arriving up to 15 seconds late are accepted (requests in flight). After that, the server refuses them and finalises the attempt with the last answers it received, stamped at the deadline, even if the student never reconnects.
- **Marking.** Multiple-choice questions are marked on submit. Short answers wait for faculty. If the exam is linked to a gradebook column, the score is scaled to that column's maximum and written in automatically.
- The answer key is never sent to students.

### 3. Gradebook — `src/grades.js`

```
contribution = marks / max_marks × weight
internal     = Σ internal contributions          total = internal + external  (out of 100)
```

- Weights must total exactly 100. Saving is refused otherwise, and the editor shows the running sum.
- **Pass** = total ≥ 40 **and** external ≥ the course's minimum external % (default 40%). Below the external minimum is F whatever the total.
- 10-point scale: O ≥ 90 (10), A+ ≥ 80 (9), A ≥ 70 (8), B+ ≥ 60 (7), B ≥ 50 (6), C ≥ 45 (5), P ≥ 40 (4), F (0).
- A student with any mark missing shows **Incomplete**, not a misleading grade.
- Faculty see the grid; totals update as they type, Enter moves down a row, and out-of-range marks are flagged in red with a text message. Students see only their own marks, with what each component contributed and what's still missing.
- CSV export (Excel-safe UTF-8, formula injection neutralised).

### Roles and permissions

Checked on the server for every request, not just hidden in the interface. Students see only their enrolled courses and their own marks. Faculty manage only courses they teach. Asking for someone else's course returns *not found*, so course IDs don't leak. Tests in `test/api.test.js` cover each of these.

## Project layout

```
server.js            entry point: checks Node version, seeds demo data, starts HTTP
src/app.js           HTTP routing and every API endpoint, with permission checks
src/db.js            SQLite schema (node:sqlite)
src/auth.js          scrypt password hashing, signed-cookie sessions (HttpOnly)
src/clerk.js         Clerk sign-in: token verification + Backend API lookup
src/roster.js        Feature 1: CSV validation + import
src/exams.js         Feature 2: timer, saves, finalising, auto-marking
src/grades.js        Feature 3: weighted totals and grades
src/csv.js           CSV parser/writer
src/seed.js          demo data
public/              the web app: index.html, app.js, styles.css, sample CSVs
test/                node:test suites (unit + end-to-end API with a fake clock)
```

## Design

Colours, type and spacing are tokens at the top of `public/styles.css`; change them there, not per screen.

- **Palette:** deep backwater green for structure and actions, cool off-white for reading, and saffron used **only for time** (the exam timer strip and deadlines), so the eye learns that saffron = clock. Every text/background pair meets WCAG AA. Body text is 14.8:1, muted text 6.2:1, and white on primary buttons 8.4:1. Status is never colour alone: errors carry text, invalid inputs get a written reason, and grades are letters.
- **Type:** the device's own system font. Nothing to download on weak campus WiFi, and it renders well on cheap Android phones. Tabular numbers keep marks aligned.
- **Phones:** checked at 360px wide. Tables turn into labelled cards; the exam timer collapses to one row so the questions keep the screen.
- **Keyboard:** skip link, visible focus ring on everything, focus kept inside dialogs, screen-reader announcements at 5 and 1 minutes left and when the connection drops or returns.

## Known limits (deliberately not built)

- No password change or reset screen yet; students keep their roll number as the password. Before real use, add password change, or invite links sent by email.
- No course or faculty management screens; courses come from the seed data (`src/seed.js`) or the database.
- No anti-cheating controls (tab-switch detection, lockdown browser). The server timer stops time-cheating, not open-book cheating.
- Content delivery, assignments with file uploads and announcements are not built. They overlap with what Google Classroom already does for free.
- Single server and a single SQLite file. That is fine for one college of 2,000 (writes are small and serialised), but back up `data/dempo.db` daily. For multiple colleges, move to Postgres.
- The *Simulate WiFi drop* button is a demo tool. Remove it from `viewTake` in `public/app.js` before a real exam.

## Ground rules followed

No `.env`, keys or secrets exist or are needed. `.gitignore` excludes `data/` (the database) and `.env*`.
