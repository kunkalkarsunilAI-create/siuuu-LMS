'use strict';
const path = require('node:path');
const { openDb, tx } = require('./db');
const auth = require('./auth');
const employees = require('./employees');
const training = require('./training');
const { toCsv } = require('./csv');
const { ClerkError } = require('./clerk');
const { createRouter, createServer, fail } = require('./http');

const ROLE_NAME = { hr_admin: 'HR admin', manager: 'Manager', employee: 'Employee' };

function createApp({
  dbPath = path.join(__dirname, '..', 'data', 'pathwise.db'),
  now = () => Date.now(),
  demoMode = false,
  clerk = null, clerkError = null, adminEmails = [],
  allowPasswordLogin,
} = {}) {
  const db = openDb(dbPath);
  const passwordLogin = allowPasswordLogin ?? (!clerk || demoMode);
  adminEmails = adminEmails.map(e => String(e).trim().toLowerCase()).filter(Boolean);
  const { routes, route } = createRouter();

  // ---------- helpers ----------
  const requireRole = (...roles) => ctx => {
    if (!ctx.user) fail(401, 'Please sign in.');
    if (roles.length && !roles.includes(ctx.user.role)) fail(403, 'You don\'t have permission to do that.');
  };
  const signedIn = requireRole();
  const hrOnly = requireRole('hr_admin');
  const leads = requireRole('hr_admin', 'manager');
  const intParam = (v, what = 'id') => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) fail(400, `Invalid ${what}.`); return n; };
  const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, employee_id: u.employee_id, department: u.department, job_title: u.job_title });

  // Whose training records can this person see? null = everyone.
  function scope(user) {
    if (user.role === 'hr_admin') return null;
    if (user.role === 'manager') return db.prepare('SELECT id FROM users WHERE manager_id = ? AND active = 1').all(user.id).map(r => r.id);
    return [user.id];
  }
  function getCourse(id) {
    const c = db.prepare('SELECT * FROM courses WHERE id = ?').get(intParam(id, 'course'));
    if (!c) fail(404, 'Course not found.');
    return { ...c };
  }
  const lessonsOf = cid => db.prepare('SELECT * FROM lessons WHERE course_id = ? ORDER BY position').all(cid).map(l => ({ ...l }));
  const assignmentOf = (uid, cid) => db.prepare('SELECT * FROM assignments WHERE user_id = ? AND course_id = ?').get(uid, cid);
  const latestCert = (uid, cid) => db.prepare('SELECT * FROM certificates WHERE user_id = ? AND course_id = ? ORDER BY issued_at DESC LIMIT 1').get(uid, cid);

  function counts(rows) {
    const c = Object.fromEntries(training.STATUSES.map(s => [s, 0]));
    for (const r of rows) c[r.status]++;
    const total = rows.length;
    const compliant = c.completed + c.expiring;
    return { ...c, total, compliant, compliantPct: total ? Math.round((compliant / total) * 1000) / 10 : null };
  }

  // ---------- auth ----------
  const DEMO_PERSONAS = { employee: 'arjun.naik@mandovi.example', manager: 'rahul.desai@mandovi.example', hr_admin: 'neha.kerkar@mandovi.example' };
  route('POST', '/api/login', ctx => {
    if (!passwordLogin) fail(403, 'Sign in with your work account using the sign-in box.');
    const { email, password } = ctx.body || {};
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
    if (!u || !auth.checkLogin(db, u, password || '')) fail(401, 'That email and password don\'t match. Check for typos, or ask HR to reset your access.');
    if (!u.active) fail(403, 'This account has been switched off because the person has left. Contact HR if that\'s a mistake.');
    ctx.setCookie(auth.createSession(db, u.id, now()));
    return { user: publicUser(u) };
  });
  route('POST', '/api/logout', ctx => { ctx.setCookie(''); return { ok: true }; });
  route('GET', '/api/me', signedIn, ctx => ({ user: publicUser(ctx.user), reports: ctx.user.role === 'manager' ? scope(ctx.user).length : undefined, serverNow: now() }));
  route('GET', '/api/time', () => ({ serverNow: now() }));
  route('GET', '/api/config', () => ({
    demoMode, passwordLogin, clerkError,
    clerk: clerk ? { publishableKey: clerk.publishableKey, frontendApi: clerk.frontendApi } : null,
  }));

  route('POST', '/api/auth/clerk', async ctx => {
    if (!clerk) fail(404, 'Clerk sign-in is not set up on this server.');
    let who;
    try { who = await clerk.getUser((await clerk.verifyToken(ctx.body?.token)).sub); }
    catch (e) { if (e instanceof ClerkError) fail(e.status, e.message, { code: e.code }); throw e; }
    if (!who.email) fail(403, 'Your Clerk account has no email address. Add one, then sign in again.', { code: 'no_email' });
    if (!who.verified) fail(403, `Verify ${who.email} with Clerk first, then sign in again.`, { code: 'unverified' });
    let u = db.prepare('SELECT * FROM users WHERE email = ?').get(who.email);
    if (u && !u.active) fail(403, `${who.email} belongs to someone who has left the company. Contact HR if that's a mistake.`, { code: 'inactive' });
    if (!u && adminEmails.includes(who.email)) {
      db.prepare(`INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, ?, 'hr_admin', ?, ?)`)
        .run(who.email, who.name || who.email.split('@')[0], auth.CLERK_ONLY, now());
      u = db.prepare('SELECT * FROM users WHERE email = ?').get(who.email);
    }
    if (!u) {
      const role = ctx.body?.demoRole;
      if (demoMode && DEMO_PERSONAS[role]) u = db.prepare('SELECT * FROM users WHERE email = ?').get(DEMO_PERSONAS[role]);
      if (!u) fail(403, `You're signed in as ${who.email}, but that email isn't in the employee list. Ask HR to add you, or sign in with your work email.`,
        { code: 'not_on_roster', email: who.email, demoRoles: demoMode ? Object.keys(DEMO_PERSONAS) : [] });
    }
    ctx.setCookie(auth.createSession(db, u.id, now()));
    return { user: publicUser(u), clerkEmail: who.email, asDemo: u.email !== who.email };
  });

  // ---------- Feature 1: employee import & assignment rules ----------
  const importError = e => { if (e instanceof employees.ImportError) fail(422, e.message); throw e; };
  route('POST', '/api/import/preview', hrOnly, ctx => { try { return employees.planImport(db, ctx.body?.csv); } catch (e) { importError(e); } });
  route('POST', '/api/import/commit', hrOnly, ctx => {
    try { return employees.commitImport(db, ctx.body?.csv, ctx.user.id, String(ctx.body?.filename || '').slice(0, 200), now()); } catch (e) { importError(e); }
  });
  route('GET', '/api/import/batches', hrOnly, () => ({
    batches: db.prepare(`SELECT b.id, b.filename, b.created_at, b.summary_json, u.name AS admin_name FROM import_batches b
      JOIN users u ON u.id = b.admin_id ORDER BY b.id DESC LIMIT 30`).all().map(b => ({ ...b, summary: JSON.parse(b.summary_json), summary_json: undefined })),
  }));
  route('GET', '/api/import/batches/:id/report.csv', hrOnly, ctx => {
    const b = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(intParam(ctx.params.id));
    if (!b) fail(404, 'Import not found.');
    const errorsOnly = ctx.query.get('errors') === '1';
    const rows = JSON.parse(b.report_json).filter(r => !errorsOnly || r.status === 'error');
    return { __file: { name: `import-${b.id}${errorsOnly ? '-to-fix' : ''}.csv`, type: 'text/csv; charset=utf-8', body: errorsOnly
      ? toCsv(['employee_id', 'name', 'email', 'department', 'manager_email', 'problem (delete this column before re-uploading)'], rows.map(r => [r.employee_id, r.name, r.email, r.department, r.manager_email, `line ${r.line}: ${r.message}`]))
      : toCsv(['line', 'employee_id', 'name', 'email', 'department', 'manager_email', 'result', 'details'], rows.map(r => [r.line, r.employee_id, r.name, r.email, r.department, r.manager_email, r.status, r.message])) } };
  });

  route('GET', '/api/departments', leads, () => ({
    departments: db.prepare("SELECT department AS name, COUNT(*) AS people FROM users WHERE active = 1 AND department IS NOT NULL AND department <> '' GROUP BY department ORDER BY department").all(),
  }));

  route('GET', '/api/people', leads, ctx => {
    const ids = scope(ctx.user);
    const q = (ctx.query.get('q') || '').trim().toLowerCase();
    const dept = ctx.query.get('department') || '';
    const showLeft = ctx.user.role === 'hr_admin' && ctx.query.get('left') === '1';
    let people = db.prepare(`SELECT u.id, u.name, u.email, u.employee_id, u.department, u.job_title, u.role, u.joined_on, u.active, m.name AS manager_name
      FROM users u LEFT JOIN users m ON m.id = u.manager_id WHERE u.role <> 'hr_admin' AND u.active = ? ORDER BY u.name`).all(showLeft ? 0 : 1);
    if (ids) people = people.filter(p => ids.includes(p.id));
    if (dept) people = people.filter(p => p.department === dept);
    if (q) people = people.filter(p => [p.name, p.email, p.employee_id, p.job_title].some(v => (v || '').toLowerCase().includes(q)));
    const t = now();
    const rows = training.withStatus(training.assignmentRows(db, { userIds: people.map(p => p.id) }), t);
    const byUser = new Map();
    for (const r of rows) (byUser.get(r.user_id) || byUser.set(r.user_id, []).get(r.user_id)).push(r);
    const total = people.length;
    return { total, people: people.slice(0, 300).map(p => ({ ...p, training: counts(byUser.get(p.id) || []) })) };
  });

  route('GET', '/api/people/:id', leads, ctx => {
    const id = intParam(ctx.params.id);
    const ids = scope(ctx.user);
    if (ids && !ids.includes(id)) fail(404, 'Person not found.');
    const p = db.prepare(`SELECT u.id, u.name, u.email, u.employee_id, u.department, u.job_title, u.role, u.joined_on, u.active, m.name AS manager_name
      FROM users u LEFT JOIN users m ON m.id = u.manager_id WHERE u.id = ?`).get(id);
    if (!p) fail(404, 'Person not found.');
    const t = now();
    return { person: p, assignments: training.withStatus(training.assignmentRows(db, { userIds: [id] }), t), serverNow: t };
  });

  // ---------- courses ----------
  function courseStats(courseId, ids, t) {
    return counts(training.withStatus(training.assignmentRows(db, { courseId, userIds: ids }), t));
  }
  route('GET', '/api/courses', leads, ctx => {
    const ids = scope(ctx.user); const t = now();
    const list = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) AS lesson_count,
      (SELECT COUNT(*) FROM questions q WHERE q.course_id = c.id) AS question_count FROM courses c ORDER BY c.category, c.title`).all();
    return { courses: list.map(c => ({ ...c, stats: courseStats(c.id, ids, t), rules: db.prepare('SELECT * FROM rules WHERE course_id = ?').all(c.id) })) };
  });

  route('GET', '/api/courses/:id', leads, ctx => {
    const c = getCourse(ctx.params.id); const t = now();
    const qs = training.loadQuestions(db, c.id);
    return { course: c, lessons: lessonsOf(c.id), questions: ctx.user.role === 'hr_admin' ? qs : training.publicQuestions(qs),
      rules: db.prepare('SELECT * FROM rules WHERE course_id = ? ORDER BY department').all(c.id), stats: courseStats(c.id, scope(ctx.user), t) };
  });

  function validateCourse(b) {
    const p = [];
    const code = String(b.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9\-]{1,15}$/.test(code)) p.push('Code must be 2–16 letters, digits or dashes, e.g. POSH-01.');
    if (!String(b.title || '').trim()) p.push('Give the course a title.');
    if (!['Compliance', 'Onboarding', 'Skills'].includes(b.category)) p.push('Pick a category.');
    const pass = Number(b.pass_mark);
    if (!(Number.isInteger(pass) && pass >= 1 && pass <= 100)) p.push('Pass mark must be a whole number from 1 to 100.');
    const val = b.validity_months === null || b.validity_months === '' || b.validity_months === undefined ? null : Number(b.validity_months);
    if (val !== null && !(Number.isInteger(val) && val >= 1 && val <= 120)) p.push('Certificate validity must be 1–120 months, or blank for "never expires".');
    const maxA = b.max_attempts === null || b.max_attempts === '' || b.max_attempts === undefined ? null : Number(b.max_attempts);
    if (maxA !== null && !(Number.isInteger(maxA) && maxA >= 1 && maxA <= 20)) p.push('Attempts allowed must be 1–20, or blank for unlimited.');
    const est = Number(b.est_minutes || 15);
    const lessons = (Array.isArray(b.lessons) ? b.lessons : []).map(l => ({ title: String(l.title || '').trim(), body: String(l.body || '').trim(), video_url: String(l.video_url || '').trim() || null }));
    const questions = (Array.isArray(b.questions) ? b.questions : []).map(q => ({ prompt: String(q.prompt || '').trim(), options: (q.options || []).map(o => String(o).trim()), correct_index: q.correct_index }));
    if (!lessons.length) p.push('Add at least one lesson.');
    lessons.forEach((l, i) => {
      if (!l.title) p.push(`Lesson ${i + 1} needs a title.`);
      if (!l.body) p.push(`Lesson ${i + 1} has no content.`);
      if (l.video_url && !/^https:\/\/\S+$/.test(l.video_url)) p.push(`Lesson ${i + 1}: the video link must start with https://`);
    });
    if (!questions.length) p.push('Add at least one quiz question.');
    questions.forEach((q, i) => {
      // Drop blank options, keeping the correct answer pointing at the same option.
      const kept = q.options.map((o, j) => [o, j]).filter(([o]) => o);
      const ci = kept.findIndex(([, j]) => j === Number(q.correct_index));
      q.options = kept.map(([o]) => o);
      q.correct_index = ci;
      if (!q.prompt) p.push(`Question ${i + 1} has no text.`);
      if (q.options.length < 2) p.push(`Question ${i + 1} needs at least two options.`);
      else if (ci < 0) p.push(`Question ${i + 1}: mark which option is correct.`);
    });
    if (p.length) fail(422, p[0], { problems: p });
    return { code, title: String(b.title).trim().slice(0, 150), summary: String(b.summary || '').trim().slice(0, 1000) || null, category: b.category,
      est_minutes: Number.isFinite(est) && est > 0 ? Math.round(est) : 15, pass_mark: pass, validity_months: val, max_attempts: maxA, lessons, questions };
  }
  function writeContent(courseId, c) {
    // Lessons are matched by position so progress on unchanged lessons is kept when a course is edited.
    const old = lessonsOf(courseId);
    c.lessons.forEach((l, i) => {
      if (old[i]) db.prepare('UPDATE lessons SET title = ?, body = ?, video_url = ?, position = ? WHERE id = ?').run(l.title, l.body, l.video_url, i + 1, old[i].id);
      else db.prepare('INSERT INTO lessons (course_id, position, title, body, video_url) VALUES (?, ?, ?, ?, ?)').run(courseId, i + 1, l.title, l.body, l.video_url);
    });
    for (const l of old.slice(c.lessons.length)) db.prepare('DELETE FROM lessons WHERE id = ?').run(l.id);
    db.prepare('DELETE FROM questions WHERE course_id = ?').run(courseId);
    c.questions.forEach((q, i) => db.prepare('INSERT INTO questions (course_id, position, prompt, options_json, correct_index) VALUES (?, ?, ?, ?, ?)')
      .run(courseId, i + 1, q.prompt, JSON.stringify(q.options), q.correct_index));
  }
  route('POST', '/api/courses', hrOnly, ctx => {
    const c = validateCourse(ctx.body || {});
    if (db.prepare('SELECT 1 FROM courses WHERE code = ?').get(c.code)) fail(422, `A course with code ${c.code} already exists.`);
    const id = tx(db, () => {
      const r = db.prepare(`INSERT INTO courses (code, title, summary, category, est_minutes, pass_mark, validity_months, max_attempts, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.code, c.title, c.summary, c.category, c.est_minutes, c.pass_mark, c.validity_months, c.max_attempts, ctx.user.id, now());
      writeContent(Number(r.lastInsertRowid), c);
      return Number(r.lastInsertRowid);
    });
    return { id };
  });
  route('PUT', '/api/courses/:id', hrOnly, ctx => {
    const existing = getCourse(ctx.params.id);
    const c = validateCourse(ctx.body || {});
    const clash = db.prepare('SELECT id FROM courses WHERE code = ?').get(c.code);
    if (clash && clash.id !== existing.id) fail(422, `A course with code ${c.code} already exists.`);
    tx(db, () => {
      db.prepare(`UPDATE courses SET code=?, title=?, summary=?, category=?, est_minutes=?, pass_mark=?, validity_months=?, max_attempts=? WHERE id=?`)
        .run(c.code, c.title, c.summary, c.category, c.est_minutes, c.pass_mark, c.validity_months, c.max_attempts, existing.id);
      writeContent(existing.id, c);
    });
    return { id: existing.id };
  });

  route('POST', '/api/courses/:id/rules', hrOnly, ctx => {
    const c = getCourse(ctx.params.id);
    const dept = String(ctx.body?.department || '').trim() || null;
    const days = Number(ctx.body?.due_days);
    if (!(Number.isInteger(days) && days >= 1 && days <= 365)) fail(422, 'Give people between 1 and 365 days to finish.');
    if (dept && !db.prepare('SELECT 1 FROM users WHERE department = ? AND active = 1').get(dept)) fail(422, `Nobody currently works in "${dept}".`);
    const dupe = db.prepare('SELECT 1 FROM rules WHERE course_id = ? AND department IS ?').get(c.id, dept);
    if (dupe) fail(422, dept ? `${c.code} is already required for ${dept}.` : `${c.code} is already required for everyone.`);
    const r = db.prepare('INSERT INTO rules (course_id, department, due_days, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(c.id, dept, days, ctx.user.id, now());
    const created = training.applyRules(db, now(), { ruleIds: [Number(r.lastInsertRowid)] });
    return { ruleId: Number(r.lastInsertRowid), assignmentsCreated: created };
  });
  route('DELETE', '/api/rules/:id', hrOnly, ctx => {
    const r = db.prepare('DELETE FROM rules WHERE id = ?').run(intParam(ctx.params.id));
    if (!r.changes) fail(404, 'Rule not found.');
    return { ok: true, note: 'People already assigned keep the course; new joiners won\'t get it automatically.' };
  });

  // Assign a course to chosen people. Managers may only assign to their own team.
  route('POST', '/api/courses/:id/assign', leads, ctx => {
    const c = getCourse(ctx.params.id);
    const ids = [...new Set((ctx.body?.user_ids || []).map(Number))].filter(Number.isInteger);
    const days = Number(ctx.body?.due_days);
    if (!ids.length) fail(422, 'Pick at least one person.');
    if (!(Number.isInteger(days) && days >= 1 && days <= 365)) fail(422, 'Give people between 1 and 365 days to finish.');
    const allowed = scope(ctx.user);
    if (allowed && ids.some(i => !allowed.includes(i))) fail(403, 'You can only assign training to people who report to you.');
    const t = now();
    const valid = db.prepare(`SELECT id FROM users WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(r => r.id);
    let created = 0, already = 0;
    tx(db, () => {
      for (const uid of valid) {
        const r = db.prepare(`INSERT INTO assignments (course_id, user_id, assigned_at, due_at, source, assigned_by) VALUES (?, ?, ?, ?, 'manual', ?)
          ON CONFLICT(course_id, user_id) DO NOTHING`).run(c.id, uid, t, t + days * training.DAY, ctx.user.id);
        if (r.changes) created++; else already++;
      }
    });
    return { created, alreadyAssigned: already };
  });

  // ---------- Feature 2: learning, quiz, certificates ----------
  route('GET', '/api/my', signedIn, ctx => {
    const t = now();
    const rows = training.withStatus(training.assignmentRows(db, { userIds: [ctx.user.id] }), t);
    const certs = db.prepare(`SELECT ce.code, ce.issued_at, ce.expires_at, ce.score_pct, c.title, c.code AS course_code FROM certificates ce
      JOIN courses c ON c.id = ce.course_id WHERE ce.user_id = ? ORDER BY ce.issued_at DESC`).all(ctx.user.id);
    return { assignments: rows, certificates: certs, serverNow: t };
  });

  function learnerCourse(ctx) {
    const c = getCourse(ctx.params.id);
    const a = assignmentOf(ctx.user.id, c.id);
    if (!a) fail(404, 'This course hasn\'t been assigned to you. Ask your manager or HR if you need it.');
    return { c, a };
  }
  function learnState(user, c, a, t) {
    const lessons = lessonsOf(c.id);
    const done = new Set(db.prepare('SELECT lesson_id FROM lesson_progress WHERE user_id = ?').all(user.id).map(r => r.lesson_id));
    const cert = latestCert(user.id, c.id);
    const row = training.withStatus(training.assignmentRows(db, { userIds: [user.id], courseId: c.id }), t)[0];
    const used = training.attemptsThisCycle(db, user.id, c.id);
    const open = db.prepare('SELECT id FROM attempts WHERE user_id = ? AND course_id = ? AND submitted_at IS NULL').get(user.id, c.id);
    const last = db.prepare('SELECT score_pct, passed, submitted_at FROM attempts WHERE user_id = ? AND course_id = ? AND submitted_at IS NOT NULL ORDER BY submitted_at DESC LIMIT 1').get(user.id, c.id);
    const lessonsComplete = lessons.every(l => done.has(l.id));
    const certValid = cert && (!cert.expires_at || cert.expires_at > t);
    return {
      course: c, status: row?.status, due_at: row?.effective_due ?? a.due_at,
      lessons: lessons.map(l => ({ ...l, done: done.has(l.id) })),
      quiz: {
        questions: db.prepare('SELECT COUNT(*) AS n FROM questions WHERE course_id = ?').get(c.id).n,
        unlocked: lessonsComplete, attemptsUsed: used, attemptsLeft: c.max_attempts ? Math.max(0, c.max_attempts - used) : null,
        openAttemptId: open?.id ?? null, last: last || null,
        // A valid certificate that is about to expire can be renewed early.
        canTake: lessonsComplete && (!c.max_attempts || used < c.max_attempts) && (!certValid || row?.status === 'expiring'),
      },
      certificate: cert ? { code: cert.code, issued_at: cert.issued_at, expires_at: cert.expires_at, score_pct: cert.score_pct, valid: !!certValid } : null,
      serverNow: t,
    };
  }
  route('GET', '/api/learn/:id', signedIn, ctx => { const { c, a } = learnerCourse(ctx); return learnState(ctx.user, c, a, now()); });

  route('POST', '/api/learn/:id/lessons/:lessonId/complete', signedIn, ctx => {
    const { c } = learnerCourse(ctx);
    const l = db.prepare('SELECT id FROM lessons WHERE id = ? AND course_id = ?').get(intParam(ctx.params.lessonId, 'lesson'), c.id);
    if (!l) fail(404, 'Lesson not found.');
    db.prepare('INSERT INTO lesson_progress (user_id, lesson_id, completed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(ctx.user.id, l.id, now());
    return { ok: true };
  });

  route('POST', '/api/learn/:id/attempts', signedIn, ctx => {
    const { c, a } = learnerCourse(ctx);
    const t = now();
    const s = learnState(ctx.user, c, a, t);
    const qs = training.loadQuestions(db, c.id);
    let attempt = s.quiz.openAttemptId ? db.prepare('SELECT * FROM attempts WHERE id = ?').get(s.quiz.openAttemptId) : null;
    if (!attempt) {
      if (!s.quiz.unlocked) fail(409, 'Finish all the lessons first — the quiz opens after the last one.');
      if (s.quiz.attemptsLeft === 0) fail(409, `You've used all ${c.max_attempts} attempts. HR can give you another go.`);
      if (!s.quiz.canTake) fail(409, 'You already hold a valid certificate for this course.');
      const r = db.prepare('INSERT INTO attempts (course_id, user_id, started_at) VALUES (?, ?, ?)').run(c.id, ctx.user.id, t);
      attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(r.lastInsertRowid);
    }
    return { attempt: { id: attempt.id, started_at: attempt.started_at, answers: JSON.parse(attempt.answers_json), save_seq: attempt.save_seq },
      questions: training.publicQuestions(qs), pass_mark: c.pass_mark, course: { id: c.id, code: c.code, title: c.title } };
  });

  function ownOpenAttempt(ctx) {
    const at = db.prepare('SELECT * FROM attempts WHERE id = ?').get(intParam(ctx.params.id));
    if (!at || at.user_id !== ctx.user.id) fail(404, 'Quiz attempt not found.');
    return at;
  }
  function cleanAnswers(qs, answers) {
    const out = {};
    for (const q of qs) {
      const v = answers?.[q.id];
      if (v === undefined || v === null || v === '') continue;
      const n = Number(v);
      if (Number.isInteger(n) && n >= 0 && n < q.options.length) out[q.id] = n;
    }
    return out;
  }
  // Autosave. Sequence numbers stop a late, out-of-order save (e.g. after reconnecting) from overwriting newer answers.
  route('PUT', '/api/attempts/:id/answers', signedIn, ctx => {
    const at = ownOpenAttempt(ctx);
    if (at.submitted_at) fail(409, 'This quiz has already been submitted.', { code: 'submitted' });
    const seq = Number(ctx.body?.seq);
    if (!Number.isInteger(seq) || seq < 1) fail(400, 'Missing save sequence number.');
    if (seq <= at.save_seq) return { ok: true, stale: true, seq: at.save_seq };
    const answers = cleanAnswers(training.loadQuestions(db, at.course_id), ctx.body?.answers);
    db.prepare('UPDATE attempts SET answers_json = ?, save_seq = ? WHERE id = ? AND submitted_at IS NULL AND save_seq < ?').run(JSON.stringify(answers), seq, at.id, seq);
    return { ok: true, seq, savedAt: now() };
  });

  route('POST', '/api/attempts/:id/submit', signedIn, ctx => {
    const at = ownOpenAttempt(ctx);
    const c = getCourse(at.course_id);
    const qs = training.loadQuestions(db, c.id);
    if (at.submitted_at) fail(409, 'This quiz has already been submitted.', { code: 'submitted' });
    const t = now();
    const answers = ctx.body?.answers ? cleanAnswers(qs, ctx.body.answers) : JSON.parse(at.answers_json);
    const unanswered = qs.filter(q => answers[q.id] === undefined).length;
    if (unanswered && !ctx.body?.allowBlank) fail(422, `${unanswered} question${unanswered === 1 ? ' is' : 's are'} unanswered.`, { code: 'unanswered', unanswered });
    const score = training.scoreAnswers(qs, answers);
    const passed = score >= c.pass_mark;
    const result = tx(db, () => {
      db.prepare('UPDATE attempts SET answers_json = ?, submitted_at = ?, score_pct = ?, passed = ? WHERE id = ?').run(JSON.stringify(answers), t, score, passed ? 1 : 0, at.id);
      return passed ? training.issueCertificate(db, { userId: ctx.user.id, course: c, attemptId: at.id, scorePct: score, now: t }) : null;
    });
    const used = training.attemptsThisCycle(db, ctx.user.id, c.id);
    return {
      score_pct: score, passed, pass_mark: c.pass_mark, certificate: result,
      attemptsLeft: passed ? null : (c.max_attempts ? Math.max(0, c.max_attempts - used) : null),
      // Show which answers were wrong. Reveal the right answers only after a pass, so retakes still test something.
      review: qs.map(q => ({ id: q.id, prompt: q.prompt, chosen: answers[q.id] ?? null, correct: answers[q.id] === q.correct_index,
        options: q.options, answer: passed ? q.correct_index : undefined })),
    };
  });

  // HR can give someone who ran out of attempts another go.
  route('POST', '/api/people/:id/courses/:courseId/reset-attempts', hrOnly, ctx => {
    const uid = intParam(ctx.params.id), c = getCourse(ctx.params.courseId);
    const r = db.prepare('UPDATE attempts SET started_at = 0 WHERE user_id = ? AND course_id = ? AND submitted_at IS NOT NULL AND passed = 0 AND started_at > COALESCE((SELECT MAX(issued_at) FROM certificates WHERE user_id = ? AND course_id = ?), 0)')
      .run(uid, c.id, uid, c.id);
    return { reset: Number(r.changes) };
  });

  // Public certificate check: anyone with the code can confirm it's genuine. Shows only name, course and dates.
  route('GET', '/api/certificates/:code', ctx => {
    const code = String(ctx.params.code || '').trim().toUpperCase();
    const ce = db.prepare(`SELECT ce.*, u.name, c.title, c.code AS course_code, c.category FROM certificates ce
      JOIN users u ON u.id = ce.user_id JOIN courses c ON c.id = ce.course_id WHERE ce.code = ?`).get(code);
    if (!ce) fail(404, `No certificate has the code ${code}. Check it was typed exactly as printed.`);
    const t = now();
    return { certificate: { code: ce.code, name: ce.name, course: ce.title, course_code: ce.course_code, category: ce.category,
      issued_at: ce.issued_at, expires_at: ce.expires_at, score_pct: ce.score_pct, valid: !ce.expires_at || ce.expires_at > t }, serverNow: t };
  });

  // ---------- Feature 3: compliance ----------
  function complianceRows(ctx) {
    const t = now();
    let rows = training.withStatus(training.assignmentRows(db, { userIds: scope(ctx.user) }), t);
    const course = ctx.query.get('course'), dept = ctx.query.get('department'), status = ctx.query.get('status'), q = (ctx.query.get('q') || '').toLowerCase().trim();
    if (course) rows = rows.filter(r => r.course_id === Number(course));
    if (dept) rows = rows.filter(r => r.department === dept);
    if (status === 'noncompliant') rows = rows.filter(r => !training.isCompliant(r.status));
    else if (status) rows = rows.filter(r => r.status === status);
    if (q) rows = rows.filter(r => [r.name, r.email, r.employee_id].some(v => (v || '').toLowerCase().includes(q)));
    return { rows, t };
  }
  route('GET', '/api/compliance/summary', leads, ctx => {
    const t = now();
    const all = training.withStatus(training.assignmentRows(db, { userIds: scope(ctx.user) }), t);
    const group = key => {
      const m = new Map();
      for (const r of all) { const k = key(r); (m.get(k) || m.set(k, []).get(k)).push(r); }
      return m;
    };
    const courses = [...group(r => r.course_id)].map(([id, rows]) => ({ id, code: rows[0].code, title: rows[0].title, category: rows[0].category, ...counts(rows) }))
      .sort((a, b) => (a.compliantPct ?? 101) - (b.compliantPct ?? 101));
    const departments = [...group(r => r.department || 'No department')].map(([name, rows]) => ({ name, people: new Set(rows.map(r => r.user_id)).size, ...counts(rows) }))
      .sort((a, b) => (a.compliantPct ?? 101) - (b.compliantPct ?? 101));
    const soon = all.filter(r => (r.status === 'not_started' || r.status === 'in_progress') && r.due_at - t <= 7 * training.DAY).length;
    return { totals: counts(all), dueThisWeek: soon, courses, departments, people: new Set(all.map(r => r.user_id)).size, serverNow: t };
  });
  route('GET', '/api/compliance/rows', leads, ctx => {
    const { rows, t } = complianceRows(ctx);
    const order = { overdue: 0, expired: 1, expiring: 2, in_progress: 3, not_started: 4, completed: 5 };
    rows.sort((a, b) => order[a.status] - order[b.status] || a.effective_due - b.effective_due);
    return { total: rows.length, rows: rows.slice(0, 500), serverNow: t };
  });
  route('GET', '/api/compliance.csv', leads, ctx => {
    const { rows } = complianceRows(ctx);
    const d = ms => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
    return { __file: { name: `compliance-${new Date(now()).toISOString().slice(0, 10)}.csv`, type: 'text/csv; charset=utf-8',
      body: toCsv(['employee_id', 'name', 'email', 'department', 'manager', 'course_code', 'course', 'status', 'due_date', 'lessons_done', 'certificate', 'certified_on', 'expires_on'],
        rows.map(r => [r.employee_id, r.name, r.email, r.department, r.manager_name, r.code, r.title, training.STATUS_LABEL[r.status], d(r.effective_due),
          `${r.lessons_done}/${r.lessons_total}`, r.cert_code, d(r.cert_issued), d(r.cert_expires)])) } };
  });

  const server = createServer({ routes, getUser: token => auth.userFromToken(db, token, now()) });
  return { server, db };
}

module.exports = { createApp, ROLE_NAME };
