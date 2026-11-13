# Pathwise — HR training & compliance LMS

Pathwise helps a company's HR team make sure every employee completes the training they're required to. It covers onboarding, yearly compliance courses such as POSH and information security, and skills courses. HR can prove who is compliant at any moment.

Three features work end to end:

1. **Employee import and automatic assignment.** HR uploads the staff list exported from their HR or payroll system. New joiners are added, department moves and new managers are updated, and leavers are switched off. Training rules ("everyone in Sales must complete DPDP-01 within 21 days") then assign courses with deadlines automatically.
2. **Courses, quiz and certificate.** Employees work through short lessons, then take a quiz with a pass mark. Answers autosave and survive a dropped connection or a page reload. Passing issues a certificate with a unique code that anyone can verify. Yearly courses expire and must be renewed.
3. **Compliance dashboard.** HR sees who is compliant, overdue, expired or expiring soon, by course and by department, and can drill into a filtered list and export it to CSV. Managers see the same, scoped to their own team.

Sign-in works with **Clerk** (work email or Google), with passwords as a fallback.

---

## Run it

You need **Node.js 22.13 or newer**. There's **nothing to install**: no `npm install`, zero dependencies (it uses Node's built-in SQLite).

```bash
npm start
```

Open <http://localhost:3000>. The first run creates a demo company, **Mandovi Systems** (fictional; it uses reserved `.example` email addresses).

| Role | Email | Password |
|---|---|---|
| HR admin | `neha.kerkar@mandovi.example` | `hr12345` |
| Manager (Engineering, 4 reports) | `rahul.desai@mandovi.example` | `manager123` |
| Employee (new joiner) | `arjun.naik@mandovi.example` | `MS-101` |

The login page has one-click buttons for all three.

| Command | What it does |
|---|---|
| `npm start` | Start on port 3000 (`PORT=4000 npm start` to change) |
| `npm test` | Run the 20 automated tests (about 3 seconds) |
| `npm run reset` | Delete the database; the next start re-creates the demo company |
| `npm run sample` | Regenerate the sample CSV files |

## Five-minute demo

1. **HR.** Sign in as Neha. You land on **Compliance**: 80% compliant, with two overdue and two expired certificates. Click "overdue" to see exactly who. Click a course or department row to filter.
2. **Import.** Go to **Import** and upload *Sample with mistakes* (linked on the page). The preview shows 4 new people, a department move, a leaver and 5 rows with mistakes, each with the reason. Apply it: 14 courses are assigned to the new joiners automatically.
3. **Rules.** Go to **Courses** → *Code review that helps* → add a rule "Engineering, 30 days". Everyone in Engineering who doesn't have it is assigned it immediately.
4. **Employee.** Sign out and sign in as Arjun, a new joiner with four courses to do. Open *Information security essentials*, read the three lessons, start the quiz. Answer one question, press **Simulate a WiFi drop**, answer two more, then **reload the page**. Your answers are still there, and they sync when you reconnect. Submit, pass, and open the certificate.
5. **Verify.** Sign out, click **Check a certificate** on the login page, and enter the code. Anyone can do this without an account.
6. **Manager.** Sign in as Rahul: **My team** and **Compliance** show only his reports. He can assign courses to them and to nobody else.

## How it behaves

### Training status (`src/training.js`)

Each person has exactly one status per course, checked in this order:

| Status | Meaning | Counts as compliant |
|---|---|---|
| Completed | Holds a valid certificate, expiring in more than 30 days (or never) | ✓ |
| Expiring soon | Valid certificate that expires within 30 days, so they can renew early | ✓ |
| Expired | Had a certificate and it has lapsed; must retake. The deadline becomes the expiry date | ✗ |
| Overdue | Never certified and the deadline has passed | ✗ |
| In progress | Started lessons or the quiz | ✗ |
| Not started | — | ✗ |

### Employee import (`src/employees.js`)

| Rule | Behaviour |
|---|---|
| Required columns | `employee_id`, `name`, `email`, `department`. Optional: `job_title`, `manager_email`, `joined_on`, `role`, `status`. Any order, and common HR-system names like "Emp Code", "Reporting Manager" and "Date of Joining" are recognised. |
| Dates | `YYYY-MM-DD`, `DD/MM/YYYY` (day first, as in India), or `1-Apr-2026`. Impossible dates like 31/02 are rejected. |
| Mode | **Partial.** Valid rows are applied in one transaction; rows with mistakes are listed with the line number and reason. *Rows to fix* downloads just those rows. |
| Existing person (same email and ID) | Updated: department, title, manager. Unchanged rows are left alone, so uploading the same file twice changes nothing. |
| `status` = left | Switched off: can't sign in, drops out of compliance, and their reports lose them as manager. |
| Managers | Must be in the file or already in the system, and still employed. Anyone who manages someone becomes a manager. Reporting loops (A → B → A) are rejected. |
| Conflicts | An email or employee ID that belongs to someone else, a duplicate row, or an HR admin account → error, never a silent merge. |
| After import | Training rules run for new and moved people. |
| First password | The employee ID, hashed on first sign-in. With Clerk, people just use their work email. |

### Rules and assignments

- A rule says "*department* (or everyone) must complete *course* within *N* days". It applies to current staff and to everyone imported later.
- **Deadline** = the later of (now, joining date) + N days. Existing deadlines are never moved.
- HR and managers can also assign a course by hand to chosen people. Managers can only assign to their own reports.

### Quiz and certificates

- The quiz unlocks after the last lesson. The pass mark, attempts per cycle and certificate validity are set per course.
- Answers **autosave**. Every save carries a sequence number, so a late save from a reconnecting device never overwrites newer answers. Answers are also kept on the device, so a reload or a WiFi drop loses nothing.
- After a fail, the review shows which answers were wrong but **not the right answers**, so a retake still tests something. After a pass, it shows everything.
- Running out of attempts: HR can allow another go from the person's page.
- Certificate codes look like `PW-7KQM-3XRT`; easily confused characters (0/O, 1/I/L) are left out. The public check shows only name, course and dates. A 12-month certificate issued on 31 January expires on 28/29 February, not 3 March.

### Roles

Checked on the server for every request:

| | Employee | Manager | HR admin |
|---|---|---|---|
| Own training | ✓ | ✓ | ✓ |
| See people and compliance | – | direct reports only | everyone |
| Assign courses by hand | – | to direct reports | to anyone |
| Create and edit courses, rules, import | – | – | ✓ |

## Deploy to Vercel

1. Create a project on [vercel.com](https://vercel.com) from this GitHub repo. Leave every build setting at its default; Vercel detects `server.js`.
2. Optional: add Clerk sign-in (below).
3. Deploy.

On Vercel the app runs in **demo mode**. Vercel has no permanent disk, so the database lives in `/tmp` and is re-created with the demo company when Vercel starts a fresh copy of the app. The login page says so. For real use, run it on a server with a persistent disk (or a college or company machine), where `data/pathwise.db` persists.

## Sign-in with Clerk

Set these environment variables (in Vercel: Project → Settings → Environment Variables → **Project** tab, then redeploy):

| Variable | Value | Type |
|---|---|---|
| `CLERK_PUBLISHABLE_KEY` | `pk_test_…` from the Clerk dashboard → API keys | Config |
| `CLERK_SECRET_KEY` | `sk_test_…` (Clerk shows it once, when you create it) | **Secret, never commit it** |
| `ADMIN_EMAILS` | Your email; becomes an HR admin on first sign-in | Config |
| `CLERK_AUTHORIZED_PARTIES` | Optional: your site URL, to reject tokens made elsewhere | Config |

Clerk proves who someone is; Pathwise decides their role from the employee list. An email that isn't in the list is told so plainly (on a demo site they can look around as a demo employee, manager or HR admin instead). People who have left can't sign in. With Clerk set up, password sign-in is switched off, except on demo sites or with `ALLOW_PASSWORD_LOGIN=1`.

## Project layout

```
server.js            entry point: Node version check, Clerk config, demo data, HTTP
src/app.js           all API routes and permission checks
src/http.js          tiny HTTP framework (routing, JSON, cookies, static files)
src/db.js            SQLite schema
src/training.js      status rules, assignment rules, scoring, certificates
src/employees.js     Feature 1: CSV import
src/auth.js          password hashing, signed-cookie sessions
src/clerk.js         Clerk token verification (no dependencies)
src/csv.js           CSV parser/writer (Excel-safe, formula-injection safe)
src/seed.js          demo company and course content
public/              the web app: index.html, app.js, styles.css, sample CSVs
test/                20 tests: features, roles, Clerk (against a fake Clerk with real keys)
```

## Design

Colours, type and spacing are tokens at the top of `public/styles.css`.

- **Palette:** deep aubergine for structure and actions, a cool grey-white for reading. Each training status has its own colour and **always** a text label too, so colour never carries meaning alone. Every text/background pair meets WCAG AA. Body text is 15.7:1, secondary text 6.4:1, and the status chips and bar segments are all at least 5.4:1.
- **Type:** the device's system font, so nothing downloads on a slow connection, with tabular numbers. The **certificate** is the one ceremonial page: a classic serif inside a double-ruled frame, printable as A4 landscape.
- **Phones:** checked at 360px. Tables become labelled cards, and the course player stacks the lesson list above the lesson.
- **Keyboard:** skip link, visible focus everywhere, focus kept inside dialogs, screen-reader announcements when the connection drops or returns during a quiz.

## Known limits

- No email reminders. The compliance list and its CSV export are how HR chases people today; an email integration is the natural next step.
- No password reset screen. With Clerk, that's handled by Clerk.
- Lessons are text plus an optional video link; no file uploads.
- Courses can be edited but not deleted, to protect certificate history.
- The **Simulate a WiFi drop** button on the quiz page is a demo tool. Remove it before real use (`viewQuiz` in `public/app.js`).
- The company name on certificates ("Mandovi Systems") is set in `public/app.js`, in `viewCertificate`.
