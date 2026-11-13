'use strict';
// Demo company so a new visitor sees a working system. Fictional: "Mandovi Systems",
// with reserved .example email addresses. Runs when the database has no users.
const { hashPassword } = require('./auth');
const { tx } = require('./db');
const training = require('./training');

const DAY = training.DAY;
const iso = ms => new Date(ms).toISOString().slice(0, 10);

const COURSES = [
  {
    code: 'POSH-01', title: 'Preventing sexual harassment at work (POSH)', category: 'Compliance', est_minutes: 20,
    pass_mark: 80, validity_months: 12, max_attempts: 3,
    summary: 'What India\'s POSH Act requires, what counts as sexual harassment, and how to raise or handle a complaint. Required for everyone, every year.',
    lessons: [
      ['What the law says', 'India\'s Sexual Harassment of Women at Workplace (Prevention, Prohibition and Redressal) Act, 2013 — usually called the POSH Act — requires every employer with 10 or more employees to set up an Internal Committee (IC) to receive and inquire into complaints.\n\nThe IC is chaired by a senior woman employee, at least half of its members must be women, and it includes an external member from an NGO or with relevant experience.\n\nAt Mandovi Systems, the IC\'s names and contact details are on the HR page of the intranet and on the notice board on every floor.'],
      ['What counts as sexual harassment', 'Under the Act, sexual harassment includes any one or more of these unwelcome acts or behaviour, directly or by implication:\n\n• physical contact and advances\n• a demand or request for sexual favours\n• sexually coloured remarks\n• showing pornography\n• any other unwelcome physical, verbal or non-verbal conduct of a sexual nature\n\nWhat matters is how the behaviour is received, not what was intended. It applies at the office, at client sites, on work trips, at work events, and in work chats and calls.'],
      ['Raising and handling a complaint', 'A complaint is made in writing to the Internal Committee, normally within three months of the incident (or of the last incident in a series). The IC can extend this by a further three months if there was a good reason for the delay, and can help someone put their complaint in writing.\n\nThe IC must complete its inquiry within 90 days. The identity of the people involved and the details of the case are confidential.\n\nRetaliating against anyone who complains or gives evidence is itself misconduct. If a colleague confides in you, listen, don\'t investigate yourself, and point them to the IC.'],
    ],
    questions: [
      ['Which employers must set up an Internal Committee under the POSH Act?', ['Only companies with 100+ employees', 'Every employer with 10 or more employees', 'Only government offices', 'Only companies with a women\'s cell'], 1],
      ['What decides whether conduct counts as sexual harassment?', ['Whether the person meant it as a joke', 'Whether it happened inside the office', 'Whether it was unwelcome to the person receiving it', 'Whether a manager was involved'], 2],
      ['Within how many days must the Internal Committee complete its inquiry?', ['30 days', '60 days', '90 days', '1 year'], 2],
      ['A colleague tells you about an incident. What should you do?', ['Investigate it yourself first', 'Tell the rest of the team so they are careful', 'Listen, keep it confidential, and point them to the Internal Committee', 'Ignore it unless they put it in writing'], 2],
      ['Does the POSH policy apply at an evening event organised by the company?', ['No, only during office hours', 'Yes, work events are covered', 'Only if it happens on company premises', 'Only if alcohol is not served'], 1],
    ],
  },
  {
    code: 'INFOSEC-01', title: 'Information security essentials', category: 'Compliance', est_minutes: 15,
    pass_mark: 70, validity_months: 12, max_attempts: null,
    summary: 'Spotting phishing, keeping accounts safe, and handling company data. Required for everyone, every year.',
    lessons: [
      ['Spotting phishing', 'Most break-ins start with an email or message that tricks someone into clicking a link, opening an attachment or sharing a code.\n\nWarning signs: urgency ("your account closes today"), a sender address that doesn\'t quite match, requests for passwords or one-time codes, and unexpected invoices or "shared documents".\n\nNever share a one-time password (OTP) — no genuine colleague, bank or IT team will ask for it. If unsure, report the message with the "Report phishing" button instead of replying.'],
      ['Passwords and two-step sign-in', 'Use a long passphrase that you don\'t use anywhere else, and keep it in the company password manager.\n\nTwo-step sign-in (an app prompt or code as well as your password) is switched on for every work account. Approve a prompt only when you have just tried to sign in yourself — an unexpected prompt means someone else has your password: deny it and tell IT.'],
      ['Handling company data', 'Keep work files in company storage, not on personal drives or personal email. Lock your screen when you step away (Windows key + L, or Ctrl + Cmd + Q on a Mac).\n\nShare documents with named people rather than "anyone with the link". If you lose a laptop or phone with work data on it, report it to IT straight away — the sooner it is reported, the sooner it can be locked.'],
    ],
    questions: [
      ['Someone calling from "the bank" asks for the OTP you just received. What do you do?', ['Read it out, they called you', 'Never share it — hang up and report it', 'Share it only if they know your name', 'Email it instead of saying it'], 1],
      ['You get a sign-in approval prompt you didn\'t expect. What does it mean?', ['A routine check by IT', 'Someone else may have your password — deny it and tell IT', 'Your phone needs an update', 'Nothing, approve it to make it go away'], 1],
      ['What is the safest way to share a file with two colleagues?', ['Anyone-with-the-link', 'Email it to their personal addresses', 'Share it with those two named people', 'Put it on a USB stick'], 2],
      ['You lost your work laptop on the train. When should you tell IT?', ['After searching for a week', 'Straight away', 'Only if it had client data', 'At your next one-to-one'], 1],
      ['Which is the strongest password?', ['Mandovi@2026', 'P@ssw0rd!', 'a long passphrase used only for this account', 'your phone number'], 2],
    ],
  },
  {
    code: 'ONB-01', title: 'Welcome to Mandovi Systems', category: 'Onboarding', est_minutes: 10,
    pass_mark: 60, validity_months: null, max_attempts: null,
    summary: 'Who we are, how your first 30 days work, and where to find help. For every new joiner in their first week.',
    lessons: [
      ['Who we are', 'Mandovi Systems builds billing and payments software for hospitals and clinics across India. We have teams in Engineering, Sales, Customer Support, Finance and HR.\n\nThree habits we hire for: say what you know and what you don\'t, write things down, and finish what you start.'],
      ['Your first 30 days', 'Week 1: set up your laptop and accounts, meet your manager and buddy, and finish this course plus Information Security and POSH.\n\nBy day 30 you and your manager agree three goals for your first quarter. Your buddy is your go-to for "where is…" questions — no question is too small.'],
      ['Where to get help', 'IT problems: the #it-help channel or extension 2200. Payroll and leave: the HR portal or hr@mandovi.example. Something feels wrong at work: your manager, HR, or the Internal Committee — whichever you are most comfortable with.'],
    ],
    questions: [
      ['Which trainings should you finish in your first week?', ['None, training starts after probation', 'Onboarding, Information Security and POSH', 'Only the course for your department', 'Whatever your buddy recommends'], 1],
      ['Who is your go-to for small "where is…" questions?', ['The CEO', 'Your buddy', 'The Internal Committee', 'Nobody, look it up yourself'], 1],
      ['When do you agree your first-quarter goals?', ['On day 1', 'By day 30, with your manager', 'At the annual review', 'Never'], 1],
      ['Where do you go with a payroll question?', ['The HR portal or the HR email', '#it-help', 'Your buddy', 'The finance team\'s WhatsApp group'], 0],
    ],
  },
  {
    code: 'DPDP-01', title: 'Handling customer personal data (DPDP Act)', category: 'Compliance', est_minutes: 20,
    pass_mark: 80, validity_months: 12, max_attempts: 3,
    summary: 'Your responsibilities under India\'s Digital Personal Data Protection Act, 2023 when you work with customer and patient data. Required for Sales and Customer Support.',
    lessons: [
      ['The basics of the DPDP Act', 'The Digital Personal Data Protection Act, 2023 governs how organisations handle digital personal data — any data about an identifiable person.\n\nThe Act calls the person the data is about the Data Principal, and the organisation that decides why and how it is processed the Data Fiduciary. For our customers\' data, Mandovi Systems is responsible for handling it lawfully.'],
      ['Consent and purpose', 'Personal data may be processed for a lawful purpose with the person\'s consent (or for certain "legitimate uses" the Act lists). Consent must be free, specific, informed, unconditional and unambiguous, and can be withdrawn as easily as it was given.\n\nIn practice: collect only what you need for the stated purpose, don\'t reuse data for something else (such as a marketing list) without consent, and don\'t keep it longer than needed.'],
      ['People\'s rights and data breaches', 'Data Principals have the right to get information about their data, to have it corrected or erased, to have grievances addressed, and to nominate someone to act for them. Pass any such request to the privacy team the same day.\n\nIf personal data is lost, sent to the wrong person or accessed without permission, that is a personal data breach. The Act requires the Data Fiduciary to inform the Data Protection Board of India and each affected person. Report any suspected breach to the privacy team immediately — never try to quietly fix it yourself.'],
    ],
    questions: [
      ['Under the DPDP Act, what is a "Data Principal"?', ['The company\'s data officer', 'The person the personal data is about', 'The cloud provider', 'The government regulator'], 1],
      ['A customer gave their number for a support ticket. Can Sales add it to a promotions list?', ['Yes, we already have it', 'Only if the manager approves', 'No — not without consent for that purpose', 'Yes, if we delete it later'], 2],
      ['A customer asks us to correct their address on file. What do you do?', ['Ignore it — it\'s not your job', 'Pass it to the privacy team the same day', 'Ask them to email again next month', 'Delete their whole record'], 1],
      ['You emailed a patient report to the wrong clinic. What now?', ['Ask them to delete it and say nothing', 'Report it to the privacy team immediately', 'Wait to see if anyone complains', 'Send a correction to everyone'], 1],
      ['Which describes valid consent under the Act?', ['A pre-ticked box', 'Free, specific, informed, unconditional and unambiguous', 'Implied by using the service', 'Given once, permanently'], 1],
    ],
  },
  {
    code: 'CODE-REV', title: 'Code review that helps', category: 'Skills', est_minutes: 15,
    pass_mark: 60, validity_months: null, max_attempts: null,
    summary: 'How to review code so it gets better and people keep learning. Assigned by engineering managers.',
    lessons: [
      ['What a review is for', 'A review catches problems, shares knowledge and keeps the codebase consistent. It is not a test the author passes or fails.\n\nRead the description first: you can\'t review a change if you don\'t know what it is meant to do.'],
      ['Writing useful comments', 'Say what you see and why it matters: "this loop runs once per patient, so 10,000 patients means 10,000 queries" beats "slow". Mark which comments must be fixed and which are suggestions. Ask questions when you\'re not sure — you might be the one who\'s missing something.'],
    ],
    questions: [
      ['What should you read before the code itself?', ['The commit history of the whole repo', 'The change\'s description of what it is meant to do', 'The author\'s past reviews', 'Nothing'], 1],
      ['Which comment is most useful?', ['"Slow."', '"Rewrite this."', '"This runs one query per patient — 10,000 patients means 10,000 queries."', '"I would never do it this way."'], 2],
      ['You\'re unsure whether something is a bug. What do you do?', ['Block the change', 'Ask a question in the review', 'Say nothing', 'Fix it yourself without telling anyone'], 1],
    ],
  },
];

// [employee_id, name, email-local, department, job_title, manager-local, joined days ago, role]
const PEOPLE = [
  ['MS-001', 'Neha Kerkar', 'neha.kerkar', 'HR', 'Head of People', null, 1400, 'hr_admin'],
  ['MS-010', 'Rahul Desai', 'rahul.desai', 'Engineering', 'Engineering Manager', null, 1100, 'manager'],
  ['MS-011', 'Sonia Fernandes', 'sonia.fernandes', 'Sales', 'Sales Manager', null, 900, 'manager'],
  ['MS-012', 'Imran Shaikh', 'imran.shaikh', 'Customer Support', 'Support Lead', null, 800, 'manager'],
  ['MS-013', 'Priya Kamat', 'priya.kamat', 'Finance', 'Finance Manager', null, 1000, 'manager'],
  ['MS-101', 'Arjun Naik', 'arjun.naik', 'Engineering', 'Software Engineer', 'rahul.desai', 5, 'employee'],
  ['MS-102', 'Kavya Prabhu', 'kavya.prabhu', 'Engineering', 'Senior Software Engineer', 'rahul.desai', 700, 'employee'],
  ['MS-103', 'Joel D\'Souza', 'joel.dsouza', 'Engineering', 'Software Engineer', 'rahul.desai', 500, 'employee'],
  ['MS-104', 'Tejas Gaonkar', 'tejas.gaonkar', 'Engineering', 'QA Engineer', 'rahul.desai', 420, 'employee'],
  ['MS-201', 'Ananya Sawant', 'ananya.sawant', 'Sales', 'Account Executive', 'sonia.fernandes', 600, 'employee'],
  ['MS-202', 'Rohan Pai', 'rohan.pai', 'Sales', 'Account Executive', 'sonia.fernandes', 450, 'employee'],
  ['MS-203', 'Meera Borkar', 'meera.borkar', 'Sales', 'Sales Development Rep', 'sonia.fernandes', 380, 'employee'],
  ['MS-301', 'Sana Khan', 'sana.khan', 'Customer Support', 'Support Specialist', 'imran.shaikh', 650, 'employee'],
  ['MS-302', 'Clint Rodrigues', 'clint.rodrigues', 'Customer Support', 'Support Specialist', 'imran.shaikh', 400, 'employee'],
  ['MS-401', 'Gauri Parab', 'gauri.parab', 'Finance', 'Accountant', 'priya.kamat', 900, 'employee'],
  ['MS-402', 'Omkar Velip', 'omkar.velip', 'Finance', 'Accounts Associate', 'priya.kamat', 390, 'employee'],
];
const DOMAIN = 'mandovi.example';

// What each person has done. cert: days ago certified. due: days from now (negative = overdue). lessons: lessons finished.
const STATE = {
  'kavya.prabhu': { 'POSH-01': { cert: 350 }, 'INFOSEC-01': { cert: 90 }, 'ONB-01': { cert: 690 }, 'CODE-REV': { cert: 20 } },
  'joel.dsouza': { 'POSH-01': { cert: 390 }, 'INFOSEC-01': { cert: 120 }, 'ONB-01': { cert: 490 }, 'CODE-REV': { lessons: 1, due: 9 } },
  'tejas.gaonkar': { 'POSH-01': { cert: 60 }, 'INFOSEC-01': { due: -5, lessons: 1 }, 'ONB-01': { cert: 410 } },
  'ananya.sawant': { 'POSH-01': { cert: 100 }, 'INFOSEC-01': { cert: 100 }, 'ONB-01': { cert: 590 }, 'DPDP-01': { cert: 80 } },
  'rohan.pai': { 'POSH-01': { cert: 140 }, 'INFOSEC-01': { cert: 140 }, 'ONB-01': { cert: 440 }, 'DPDP-01': { lessons: 2, due: 6 } },
  'meera.borkar': { 'POSH-01': { cert: 200 }, 'INFOSEC-01': { cert: 200 }, 'ONB-01': { cert: 370 }, 'DPDP-01': { due: -12 } },
  'sana.khan': { 'POSH-01': { cert: 30 }, 'INFOSEC-01': { cert: 30 }, 'ONB-01': { cert: 640 }, 'DPDP-01': { cert: 30 } },
  'clint.rodrigues': { 'POSH-01': { cert: 345 }, 'INFOSEC-01': { cert: 160 }, 'ONB-01': { cert: 390 }, 'DPDP-01': { due: 10 } },
  'gauri.parab': { 'POSH-01': { cert: 75 }, 'INFOSEC-01': { cert: 75 }, 'ONB-01': { cert: 890 } },
  'omkar.velip': { 'POSH-01': { cert: 180 }, 'INFOSEC-01': { lessons: 2, due: 3 }, 'ONB-01': { cert: 380 } },
  'rahul.desai': { 'POSH-01': { cert: 45 }, 'INFOSEC-01': { cert: 45 }, 'ONB-01': { cert: 1090 } },
  'sonia.fernandes': { 'POSH-01': { cert: 210 }, 'INFOSEC-01': { cert: 400 }, 'ONB-01': { cert: 890 }, 'DPDP-01': { cert: 210 } },
  'imran.shaikh': { 'POSH-01': { cert: 300 }, 'INFOSEC-01': { cert: 300 }, 'ONB-01': { cert: 790 }, 'DPDP-01': { cert: 300 } },
  'priya.kamat': { 'POSH-01': { cert: 15 }, 'INFOSEC-01': { cert: 15 }, 'ONB-01': { cert: 990 } },
  'neha.kerkar': { 'POSH-01': { cert: 60 }, 'INFOSEC-01': { cert: 60 }, 'ONB-01': { cert: 1390 } },
  'arjun.naik': { 'ONB-01': { lessons: 1 } }, // new joiner: everything else freshly assigned by the rules
};

function seed(db, now = Date.now()) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return false;
  tx(db, () => {
    const uid = {};
    for (const [emp, name, local, dept, title, , joinedAgo, role] of PEOPLE) {
      const pw = role === 'hr_admin' ? 'hr12345' : role === 'manager' ? 'manager123' : emp; // demo passwords
      const r = db.prepare(`INSERT INTO users (email, name, role, employee_id, department, job_title, joined_on, active, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(`${local}@${DOMAIN}`, name, role, emp, dept, title, iso(now - joinedAgo * DAY), hashPassword(pw), now);
      uid[local] = Number(r.lastInsertRowid);
    }
    for (const p of PEOPLE) if (p[5]) db.prepare('UPDATE users SET manager_id = ? WHERE id = ?').run(uid[p[5]], uid[p[2]]);

    const cid = {};
    for (const c of COURSES) {
      const r = db.prepare(`INSERT INTO courses (code, title, summary, category, est_minutes, pass_mark, validity_months, max_attempts, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.code, c.title, c.summary, c.category, c.est_minutes, c.pass_mark, c.validity_months, c.max_attempts, uid['neha.kerkar'], now - 1500 * DAY);
      cid[c.code] = Number(r.lastInsertRowid);
      c.lessons.forEach(([t, b], i) => db.prepare('INSERT INTO lessons (course_id, position, title, body) VALUES (?, ?, ?, ?)').run(cid[c.code], i + 1, t, b));
      c.questions.forEach(([p, o, k], i) => db.prepare('INSERT INTO questions (course_id, position, prompt, options_json, correct_index) VALUES (?, ?, ?, ?, ?)')
        .run(cid[c.code], i + 1, p, JSON.stringify(o), k));
    }
    const rule = (code, dept, days) => db.prepare('INSERT INTO rules (course_id, department, due_days, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(cid[code], dept, days, uid['neha.kerkar'], now - 1400 * DAY);
    rule('ONB-01', null, 7); rule('INFOSEC-01', null, 14); rule('POSH-01', null, 30);
    rule('DPDP-01', 'Sales', 21); rule('DPDP-01', 'Customer Support', 21);
    training.applyRules(db, now);
    // Engineering manager assigned the code review course to two people.
    for (const who of ['kavya.prabhu', 'joel.dsouza']) {
      db.prepare(`INSERT INTO assignments (course_id, user_id, assigned_at, due_at, source, assigned_by) VALUES (?, ?, ?, ?, 'manual', ?)`)
        .run(cid['CODE-REV'], uid[who], now - 30 * DAY, now + 14 * DAY, uid['rahul.desai']);
    }

    // Recreate everyone's history.
    for (const [local, courses] of Object.entries(STATE)) {
      for (const [code, s] of Object.entries(courses)) {
        const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(cid[code]);
        const lessons = db.prepare('SELECT id FROM lessons WHERE course_id = ? ORDER BY position').all(cid[code]);
        if (s.due !== undefined) db.prepare('UPDATE assignments SET due_at = ?, assigned_at = ? WHERE user_id = ? AND course_id = ?').run(now + s.due * DAY, now + (s.due - 21) * DAY, uid[local], cid[code]);
        if (s.cert !== undefined) {
          const at = now - s.cert * DAY;
          db.prepare('UPDATE assignments SET assigned_at = ?, due_at = ? WHERE user_id = ? AND course_id = ?').run(at - 10 * DAY, at + 5 * DAY, uid[local], cid[code]);
          for (const l of lessons) db.prepare('INSERT OR IGNORE INTO lesson_progress (user_id, lesson_id, completed_at) VALUES (?, ?, ?)').run(uid[local], l.id, at - 600000);
          const qs = training.loadQuestions(db, cid[code]);
          const answers = Object.fromEntries(qs.map(q => [q.id, q.correct_index]));
          const r = db.prepare('INSERT INTO attempts (course_id, user_id, started_at, submitted_at, answers_json, save_seq, score_pct, passed) VALUES (?, ?, ?, ?, ?, 4, 100, 1)')
            .run(cid[code], uid[local], at - 300000, at, JSON.stringify(answers));
          training.issueCertificate(db, { userId: uid[local], course, attemptId: Number(r.lastInsertRowid), scorePct: 100, now: at });
        }
        for (const l of lessons.slice(0, s.lessons || 0)) db.prepare('INSERT OR IGNORE INTO lesson_progress (user_id, lesson_id, completed_at) VALUES (?, ?, ?)').run(uid[local], l.id, now - DAY);
      }
    }
  });
  return true;
}

module.exports = { seed, COURSES, PEOPLE, DOMAIN };
