'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb, tx } = require('./db');
const auth = require('./auth');
const roster = require('./roster');
const exams = require('./exams');
const grades = require('./grades');
const { toCsv } = require('./csv');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.csv': 'text/csv; charset=utf-8',
  '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2',
};
const MAX_BODY = 3 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

function createApp({ dbPath = path.join(__dirname, '..', 'data', 'dempo.db'), now = () => Date.now(), demoMode = false } = {}) {
  const db = openDb(dbPath);
  const routes = [];
  const route = (method, pattern, ...handlers) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handlers });
  };

  // ---------- helpers ----------
  const requireRole = (...roles) => ctx => {
    if (!ctx.user) fail(401, 'Please sign in.');
    if (roles.length && !roles.includes(ctx.user.role)) fail(403, 'You do not have permission to do that.');
  };
  const signedIn = requireRole();
  const intParam = (v, name = 'id') => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) fail(400, `Invalid ${name}.`);
    return n;
  };

  function getCourse(id) {
    const c = db.prepare(`SELECT c.*, u.name AS faculty_name FROM courses c
      LEFT JOIN users u ON u.id = c.faculty_id WHERE c.id = ?`).get(id);
    if (!c) fail(404, 'Course not found.');
    return c;
  }
  // Who may see / manage a course.
  function courseAccess(user, course) {
    if (user.role === 'admin') return 'manage';
    if (user.role === 'faculty') return course.faculty_id === user.id ? 'manage' : null;
    const e = db.prepare('SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?').get(user.id, course.id);
    return e ? 'view' : null;
  }
  function courseFor(ctx, id, need = 'view') {
    const course = getCourse(intParam(id));
    const access = courseAccess(ctx.user, course);
    if (!access) fail(404, 'Course not found.'); // don't reveal courses you can't see
    if (need === 'manage' && access !== 'manage') fail(403, 'Only the course faculty can do that.');
    return { course, access };
  }
  function examFor(ctx, id, need = 'view') {
    const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(intParam(id));
    if (!exam) fail(404, 'Exam not found.');
    const { course, access } = courseFor(ctx, exam.course_id, need);
    return { exam, course, access };
  }
  const componentsOf = courseId =>
    db.prepare('SELECT * FROM components WHERE course_id = ? ORDER BY position, id').all(courseId);
  const studentsOf = courseId => db.prepare(`SELECT u.id, u.name, u.email, u.roll_no, u.department
    FROM enrollments e JOIN users u ON u.id = e.user_id
    WHERE e.course_id = ? AND u.role = 'student' ORDER BY u.roll_no, u.name`).all(courseId);

  function gradebook(course, onlyStudentId) {
    const comps = componentsOf(course.id);
    const validation = grades.validateComponents(comps);
    let students = studentsOf(course.id);
    if (onlyStudentId) students = students.filter(s => s.id === onlyStudentId);
    const markRows = db.prepare(`SELECT m.* FROM marks m JOIN components c ON c.id = m.component_id
      WHERE c.course_id = ?`).all(course.id);
    const marks = {};
    for (const m of markRows) (marks[m.student_id] ||= {})[m.component_id] = m;
    const rows = students.map(s => {
      const mine = marks[s.id] || {};
      const byComp = Object.fromEntries(Object.entries(mine).map(([k, v]) => [k, v.marks]));
      const result = grades.computeStudent(comps, byComp, course.min_external_pct);
      result.parts.forEach(p => { p.source = mine[p.component_id]?.source || null; });
      return { student: s, ...result };
    });
    const complete = rows.filter(r => r.complete);
    const stats = {
      students: rows.length,
      complete: complete.length,
      passed: complete.filter(r => r.result === 'pass').length,
      average: complete.length ? grades.round2(complete.reduce((a, r) => a + r.total, 0) / complete.length) : null,
      distribution: Object.fromEntries(grades.SCALE.map(s => [s.letter, complete.filter(r => r.grade === s.letter).length])),
    };
    return { course: { id: course.id, code: course.code, title: course.title, min_external_pct: course.min_external_pct },
      components: comps, validation, rows, stats, scale: grades.SCALE };
  }

  // ---------- auth ----------
  route('POST', '/api/login', ctx => {
    const { email, password } = ctx.body || {};
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
    if (!u || !auth.checkLogin(db, u, password || '')) {
      fail(401, 'That email and password do not match. Check for typos, or ask your admin to reset your password.');
    }
    const token = auth.createSession(db, u.id, now());
    ctx.setCookie(token);
    return { user: { id: u.id, email: u.email, name: u.name, role: u.role, roll_no: u.roll_no } };
  });
  route('POST', '/api/logout', ctx => { auth.destroySession(db, ctx.token); ctx.setCookie(''); return { ok: true }; });
  route('GET', '/api/me', signedIn, ctx => ({ user: ctx.user, serverNow: now() }));
  route('GET', '/api/time', () => ({ serverNow: now() }));
  route('GET', '/api/config', () => ({ demoMode }));

  // ---------- courses ----------
  route('GET', '/api/courses', signedIn, ctx => {
    const base = `SELECT c.*, u.name AS faculty_name,
      (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id) AS student_count,
      (SELECT COUNT(*) FROM exams x WHERE x.course_id = c.id) AS exam_count
      FROM courses c LEFT JOIN users u ON u.id = c.faculty_id`;
    if (ctx.user.role === 'admin') return { courses: db.prepare(base + ' ORDER BY c.code').all() };
    if (ctx.user.role === 'faculty') return { courses: db.prepare(base + ' WHERE c.faculty_id = ? ORDER BY c.code').all(ctx.user.id) };
    return { courses: db.prepare(base + ' JOIN enrollments en ON en.course_id = c.id WHERE en.user_id = ? ORDER BY c.code').all(ctx.user.id) };
  });
  route('GET', '/api/courses/:id', signedIn, ctx => {
    const { course, access } = courseFor(ctx, ctx.params.id);
    return { course, access, students: access === 'manage' ? studentsOf(course.id) : undefined };
  });

  // ---------- Feature 1: roster import ----------
  route('POST', '/api/roster/preview', requireRole('admin'), ctx => {
    try { return roster.planImport(db, ctx.body?.csv); }
    catch (e) { if (e instanceof roster.ImportError) fail(422, e.message); throw e; }
  });
  route('POST', '/api/roster/import', requireRole('admin'), ctx => {
    try { return roster.commitImport(db, ctx.body?.csv, ctx.user.id, String(ctx.body?.filename || '').slice(0, 200)); }
    catch (e) { if (e instanceof roster.ImportError) fail(422, e.message); throw e; }
  });
  route('GET', '/api/roster/batches', requireRole('admin'), () => ({
    batches: db.prepare(`SELECT b.id, b.filename, b.created_at, b.total_rows, b.created, b.enrolled, b.skipped, b.failed,
      u.name AS admin_name FROM import_batches b JOIN users u ON u.id = b.admin_id ORDER BY b.id DESC LIMIT 50`).all(),
  }));
  route('GET', '/api/roster/batches/:id/report.csv', requireRole('admin'), ctx => {
    const b = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(intParam(ctx.params.id));
    if (!b) fail(404, 'Import not found.');
    const onlyErrors = ctx.query.get('errors') === '1';
    const rows = JSON.parse(b.report_json).filter(r => !onlyErrors || r.status === 'error');
    const header = onlyErrors ? ['roll_no', 'name', 'email', 'course_code', 'error (delete this column before re-uploading)']
      : ['line', 'roll_no', 'name', 'email', 'course_code', 'status', 'message'];
    const body = onlyErrors ? rows.map(r => [r.roll_no, r.name, r.email, r.course_code, `line ${r.line}: ${r.message}`])
      : rows.map(r => [r.line, r.roll_no, r.name, r.email, r.course_code, r.status, r.message]);
    return { __file: { name: `import-${b.id}${onlyErrors ? '-errors' : ''}.csv`, type: 'text/csv; charset=utf-8', body: toCsv(header, body) } };
  });
  route('GET', '/api/students', requireRole('admin'), ctx => {
    const q = `%${(ctx.query.get('q') || '').trim()}%`;
    const total = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'student'").get().n;
    const students = db.prepare(`SELECT u.id, u.name, u.email, u.roll_no, u.department,
      (SELECT GROUP_CONCAT(c.code, ', ') FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.user_id = u.id) AS courses
      FROM users u WHERE u.role = 'student' AND (u.name LIKE ? OR u.email LIKE ? OR u.roll_no LIKE ?)
      ORDER BY u.roll_no LIMIT 200`).all(q, q, q);
    return { total, students };
  });

  // ---------- Feature 2: exams ----------
  route('GET', '/api/courses/:id/exams', signedIn, ctx => {
    const { course, access } = courseFor(ctx, ctx.params.id);
    exams.sweepExpired(db, now());
    const list = db.prepare(`SELECT x.*, (SELECT COUNT(*) FROM questions q WHERE q.exam_id = x.id) AS question_count,
      (SELECT COALESCE(SUM(q.marks),0) FROM questions q WHERE q.exam_id = x.id) AS max_marks,
      (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = x.id) AS attempt_count,
      (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = x.id AND a.submitted_at IS NOT NULL AND a.graded = 0) AS to_grade,
      c.name AS component_name
      FROM exams x LEFT JOIN components c ON c.id = x.component_id WHERE x.course_id = ? ORDER BY x.opens_at DESC`).all(course.id);
    if (access !== 'manage') {
      const mine = db.prepare('SELECT * FROM attempts WHERE student_id = ? AND exam_id = ?');
      for (const x of list) {
        const a = mine.get(ctx.user.id, x.id);
        x.my_attempt = a ? { status: a.submitted_at ? 'submitted' : 'in_progress', deadline: a.deadline,
          total_score: a.total_score, graded: a.graded, submit_reason: a.submit_reason } : null;
        delete x.attempt_count; delete x.to_grade;
      }
    }
    return { exams: list, serverNow: now() };
  });

  route('POST', '/api/courses/:id/exams', requireRole('faculty', 'admin'), ctx => {
    const { course } = courseFor(ctx, ctx.params.id, 'manage');
    const b = ctx.body || {};
    const title = String(b.title || '').trim();
    const duration = Number(b.duration_min);
    const opens = Number(b.opens_at), closes = Number(b.closes_at);
    const qs = Array.isArray(b.questions) ? b.questions : [];
    const problems = [];
    if (!title) problems.push('Give the exam a title.');
    if (!Number.isInteger(duration) || duration < 1 || duration > 600) problems.push('Duration must be between 1 and 600 minutes.');
    if (!Number.isFinite(opens) || !Number.isFinite(closes)) problems.push('Set when the exam opens and closes.');
    else if (closes <= opens) problems.push('The closing time must be after the opening time.');
    if (!qs.length) problems.push('Add at least one question.');
    qs.forEach((q, i) => {
      const n = i + 1;
      if (!String(q.prompt || '').trim()) problems.push(`Question ${n} has no text.`);
      if (!(Number(q.marks) > 0)) problems.push(`Question ${n} needs marks above 0.`);
      if (q.type === 'mcq') {
        const opts = (q.options || []).map(o => String(o).trim()).filter(Boolean);
        if (opts.length < 2) problems.push(`Question ${n} needs at least two options.`);
        if (!(Number.isInteger(Number(q.correct_index)) && Number(q.correct_index) >= 0 && Number(q.correct_index) < opts.length)) {
          problems.push(`Question ${n}: mark which option is correct.`);
        }
      } else if (q.type !== 'short') problems.push(`Question ${n} has an unknown type.`);
    });
    let componentId = b.component_id ? Number(b.component_id) : null;
    if (componentId && !db.prepare('SELECT 1 FROM components WHERE id = ? AND course_id = ?').get(componentId, course.id)) {
      problems.push('The gradebook column you picked does not belong to this course.');
    }
    if (problems.length) fail(422, problems[0], { problems });
    const id = tx(db, () => {
      const r = db.prepare(`INSERT INTO exams (course_id, title, instructions, duration_min, opens_at, closes_at, component_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(course.id, title, String(b.instructions || '').slice(0, 2000) || null,
        duration, opens, closes, componentId, ctx.user.id);
      const ins = db.prepare(`INSERT INTO questions (exam_id, position, type, prompt, options_json, correct_index, marks)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      qs.forEach((q, i) => {
        const opts = q.type === 'mcq' ? (q.options || []).map(o => String(o).trim()).filter(Boolean) : null;
        ins.run(r.lastInsertRowid, i + 1, q.type, String(q.prompt).trim(), opts ? JSON.stringify(opts) : null,
          q.type === 'mcq' ? Number(q.correct_index) : null, Number(q.marks));
      });
      return Number(r.lastInsertRowid);
    });
    return { id };
  });

  route('GET', '/api/exams/:id', signedIn, ctx => {
    const { exam, course, access } = examFor(ctx, ctx.params.id);
    const questions = exams.loadQuestions(db, exam.id);
    return { exam, course: { id: course.id, code: course.code, title: course.title }, access,
      questions: access === 'manage' ? questions : undefined,
      question_count: questions.length, max_marks: exams.maxMarks(questions), serverNow: now() };
  });

  // Student: start (or resume) an attempt.
  route('POST', '/api/exams/:id/start', requireRole('student'), ctx => {
    const { exam } = examFor(ctx, ctx.params.id);
    const t = now();
    exams.sweepExpired(db, t, exam.id);
    const r = exams.startAttempt(db, exam, ctx.user.id, t);
    if (r.error) fail(r.status, r.error);
    return { attemptId: r.attempt.id, resumed: r.resumed };
  });

  // Student: the live attempt. Returns deadline + server time so the client can correct for its own clock.
  route('GET', '/api/exams/:id/attempt', requireRole('student'), ctx => {
    const { exam, course } = examFor(ctx, ctx.params.id);
    const t = now();
    exams.sweepExpired(db, t, exam.id);
    const a = db.prepare('SELECT * FROM attempts WHERE exam_id = ? AND student_id = ?').get(exam.id, ctx.user.id);
    if (!a) fail(404, 'You have not started this exam yet.');
    const questions = exams.loadQuestions(db, exam.id);
    return {
      exam: { id: exam.id, title: exam.title, instructions: exam.instructions, duration_min: exam.duration_min },
      course: { id: course.id, code: course.code, title: course.title },
      attempt: { id: a.id, started_at: a.started_at, deadline: a.deadline, submitted_at: a.submitted_at,
        submit_reason: a.submit_reason, save_seq: a.save_seq, last_saved_at: a.last_saved_at,
        answers: JSON.parse(a.answers_json), total_score: a.graded ? a.total_score : null, graded: a.graded,
        answered: Object.keys(JSON.parse(a.answers_json)).length },
      questions: exams.publicQuestions(questions),
      max_marks: exams.maxMarks(questions),
      graceMs: exams.GRACE_MS,
      serverNow: t,
    };
  });

  function ownAttempt(ctx) {
    const a = db.prepare('SELECT * FROM attempts WHERE id = ?').get(intParam(ctx.params.id));
    if (!a || a.student_id !== ctx.user.id) fail(404, 'Attempt not found.');
    return a;
  }

  route('PUT', '/api/attempts/:id/answers', requireRole('student'), ctx => {
    const t = now();
    let a = ownAttempt(ctx);
    if (!a.submitted_at && t > a.deadline + exams.GRACE_MS) a = exams.finalise(db, a.id, 'timeout', t);
    const r = exams.saveAnswers(db, a, exams.loadQuestions(db, a.exam_id), ctx.body?.answers, Number(ctx.body?.seq), t);
    if (r.error) fail(r.status, r.error, { code: r.code });
    return { ...r, deadline: a.deadline, serverNow: t };
  });

  route('POST', '/api/attempts/:id/submit', requireRole('student'), ctx => {
    const t = now();
    let a = ownAttempt(ctx);
    if (a.submitted_at) return { ok: true, already: true, submit_reason: a.submit_reason };
    // Final answers may ride along with the submit so nothing typed in the last seconds is lost.
    if (ctx.body?.answers && Number(ctx.body?.seq)) {
      exams.saveAnswers(db, a, exams.loadQuestions(db, a.exam_id), ctx.body.answers, Number(ctx.body.seq), t);
    }
    const late = t > a.deadline + exams.GRACE_MS;
    a = exams.finalise(db, a.id, late ? 'timeout' : 'student', t);
    return { ok: true, submit_reason: a.submit_reason };
  });

  // Faculty: all attempts for an exam.
  route('GET', '/api/exams/:id/attempts', requireRole('faculty', 'admin'), ctx => {
    const { exam, course } = examFor(ctx, ctx.params.id, 'manage');
    const t = now();
    exams.sweepExpired(db, t, exam.id);
    const questions = exams.loadQuestions(db, exam.id);
    const attempts = db.prepare(`SELECT a.*, u.name, u.roll_no, u.email FROM attempts a JOIN users u ON u.id = a.student_id
      WHERE a.exam_id = ? ORDER BY u.roll_no`).all(exam.id).map(a => ({
      id: a.id, student: { id: a.student_id, name: a.name, roll_no: a.roll_no, email: a.email },
      started_at: a.started_at, deadline: a.deadline, submitted_at: a.submitted_at, submit_reason: a.submit_reason,
      last_saved_at: a.last_saved_at, save_count: a.save_count,
      answers: JSON.parse(a.answers_json), manual: JSON.parse(a.manual_json),
      auto_score: a.auto_score, total_score: a.total_score, graded: !!a.graded,
    }));
    const enrolled = studentsOf(course.id);
    const started = new Set(attempts.map(a => a.student.id));
    return { exam, course: { id: course.id, code: course.code, title: course.title }, questions,
      max_marks: exams.maxMarks(questions), attempts, not_started: enrolled.filter(s => !started.has(s.id)), serverNow: t };
  });

  // Faculty: mark short answers.
  route('PUT', '/api/attempts/:id/grade', requireRole('faculty', 'admin'), ctx => {
    const a = db.prepare('SELECT * FROM attempts WHERE id = ?').get(intParam(ctx.params.id));
    if (!a) fail(404, 'Attempt not found.');
    const { exam } = examFor(ctx, a.exam_id, 'manage');
    if (!a.submitted_at) fail(409, 'This attempt is still in progress.');
    const questions = exams.loadQuestions(db, exam.id);
    const manual = {};
    for (const q of questions.filter(q => q.type === 'short')) {
      const v = ctx.body?.marks?.[q.id];
      if (v === undefined || v === null || v === '') fail(422, `Enter marks for question ${q.position}.`);
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > q.marks) fail(422, `Question ${q.position} must be between 0 and ${q.marks}.`);
      manual[q.id] = n;
    }
    const total = (a.auto_score || 0) + Object.values(manual).reduce((x, y) => x + y, 0);
    tx(db, () => {
      db.prepare('UPDATE attempts SET manual_json = ?, total_score = ?, graded = 1 WHERE id = ?').run(JSON.stringify(manual), total, a.id);
      exams.syncToGradebook(db, exam, { ...a, total_score: total }, questions, ctx.user.id);
    });
    return { ok: true, total_score: total };
  });

  // ---------- Feature 3: gradebook ----------
  route('GET', '/api/courses/:id/gradebook', signedIn, ctx => {
    const { course, access } = courseFor(ctx, ctx.params.id);
    exams.sweepExpired(db, now());
    return { ...gradebook(course, access === 'manage' ? null : ctx.user.id), access };
  });

  route('PUT', '/api/courses/:id/components', requireRole('faculty', 'admin'), ctx => {
    const { course } = courseFor(ctx, ctx.params.id, 'manage');
    const list = (Array.isArray(ctx.body?.components) ? ctx.body.components : []).map((c, i) => ({
      id: c.id ? Number(c.id) : null, name: String(c.name || '').trim().slice(0, 80), category: c.category,
      weight: Number(c.weight), max_marks: Number(c.max_marks), position: i,
    }));
    const v = grades.validateComponents(list);
    if (!v.ok) fail(422, v.problems[0], { problems: v.problems });
    const minExt = ctx.body?.min_external_pct;
    if (minExt !== undefined && !(Number(minExt) >= 0 && Number(minExt) <= 100)) fail(422, 'Minimum external % must be between 0 and 100.');
    tx(db, () => {
      const existing = componentsOf(course.id);
      const keep = new Set(list.filter(c => c.id).map(c => c.id));
      for (const e of existing) if (!keep.has(e.id)) db.prepare('DELETE FROM components WHERE id = ?').run(e.id);
      for (const c of list) {
        if (c.id && existing.some(e => e.id === c.id)) {
          db.prepare('UPDATE components SET name=?, category=?, weight=?, max_marks=?, position=? WHERE id=?')
            .run(c.name, c.category, c.weight, c.max_marks, c.position, c.id);
        } else {
          db.prepare('INSERT INTO components (course_id, name, category, weight, max_marks, position) VALUES (?,?,?,?,?,?)')
            .run(course.id, c.name, c.category, c.weight, c.max_marks, c.position);
        }
      }
      if (minExt !== undefined) db.prepare('UPDATE courses SET min_external_pct = ? WHERE id = ?').run(Number(minExt), course.id);
    });
    return gradebook(getCourse(course.id));
  });

  route('PUT', '/api/courses/:id/marks', requireRole('faculty', 'admin'), ctx => {
    const { course } = courseFor(ctx, ctx.params.id, 'manage');
    const comps = new Map(componentsOf(course.id).map(c => [c.id, c]));
    const enrolled = new Set(studentsOf(course.id).map(s => s.id));
    const entries = Array.isArray(ctx.body?.entries) ? ctx.body.entries : [];
    const errors = [];
    const clean = [];
    for (const e of entries) {
      const comp = comps.get(Number(e.component_id));
      const sid = Number(e.student_id);
      if (!comp || !enrolled.has(sid)) { errors.push('A mark refers to a column or student not in this course.'); continue; }
      if (e.marks === null || e.marks === '') { clean.push({ comp, sid, marks: null }); continue; }
      const n = Number(e.marks);
      if (!Number.isFinite(n) || n < 0 || n > comp.max_marks) {
        errors.push(`${comp.name}: marks must be between 0 and ${comp.max_marks}.`);
        continue;
      }
      clean.push({ comp, sid, marks: n });
    }
    if (errors.length) fail(422, errors[0], { problems: [...new Set(errors)] });
    tx(db, () => {
      for (const { comp, sid, marks } of clean) {
        if (marks === null) db.prepare('DELETE FROM marks WHERE component_id = ? AND student_id = ?').run(comp.id, sid);
        else db.prepare(`INSERT INTO marks (component_id, student_id, marks, source, updated_by, updated_at)
          VALUES (?, ?, ?, 'manual', ?, datetime('now')) ON CONFLICT(component_id, student_id)
          DO UPDATE SET marks = excluded.marks, source = 'manual', updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
          .run(comp.id, sid, marks, ctx.user.id);
      }
    });
    return { saved: clean.length, ...gradebook(course) };
  });

  route('GET', '/api/courses/:id/gradebook.csv', requireRole('faculty', 'admin'), ctx => {
    const { course } = courseFor(ctx, ctx.params.id, 'manage');
    const gb = gradebook(course);
    const header = ['roll_no', 'name', 'email',
      ...gb.components.map(c => `${c.name} (${c.category}, /${c.max_marks}, ${c.weight}%)`),
      `internal (/${gb.rows[0]?.internalWeight ?? ''})`, `external (/${gb.rows[0]?.externalWeight ?? ''})`,
      'total (/100)', 'grade', 'grade_points', 'result', 'note'];
    const body = gb.rows.map(r => [r.student.roll_no, r.student.name, r.student.email,
      ...r.parts.map(p => p.marks ?? ''), r.internal, r.external, r.total, r.grade ?? '', r.gradePoints ?? '',
      r.result, r.reason || (r.missing ? `${r.missing} mark(s) missing` : '')]);
    return { __file: { name: `${course.code}-gradebook.csv`, type: 'text/csv; charset=utf-8', body: toCsv(header, body) } };
  });

  // ---------- HTTP plumbing ----------
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size > MAX_BODY) { reject(new HttpError(413, 'That upload is too large (limit 3 MB).')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new HttpError(400, 'The request was not valid JSON.')); }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      }).end(data);
    });
  }

  function parseCookies(header) {
    return Object.fromEntries(String(header || '').split(';').map(p => p.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      return serveStatic(req, res, url.pathname);
    }
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    const cookies = [];
    try {
      const match = routes.find(r => r.method === req.method && r.re.test(url.pathname));
      if (!match) fail(404, 'Not found.');
      // Basic CSRF defence: state-changing requests must be JSON (browsers can't send that cross-site without CORS).
      if (req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) {
        fail(415, 'Requests must be sent as JSON.');
      }
      const m = url.pathname.match(match.re);
      const token = parseCookies(req.headers.cookie).dl_session || null;
      const ctx = {
        params: Object.fromEntries(match.keys.map((k, i) => [k, m[i + 1]])),
        query: url.searchParams,
        body: req.method === 'GET' ? null : await readBody(req),
        token,
        user: auth.userFromToken(db, token, now()),
        setCookie: v => cookies.push(`dl_session=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${v ? 43200 : 0}`),
      };
      let out;
      for (const h of match.handlers) out = await h(ctx);
      if (cookies.length) headers['set-cookie'] = cookies;
      if (out && out.__file) {
        res.writeHead(200, { ...headers, 'content-type': out.__file.type,
          'content-disposition': `attachment; filename="${out.__file.name.replace(/[^\w.\-]/g, '_')}"` });
        res.end('﻿' + out.__file.body); // BOM so Excel opens UTF-8 names correctly
        return;
      }
      res.writeHead(200, headers).end(JSON.stringify(out ?? { ok: true }));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      const body = { error: status === 500 ? 'Something went wrong on our side. Your work is safe — please try again in a moment.' : e.message, ...(e.extra || {}) };
      res.writeHead(status, headers).end(JSON.stringify(body));
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  return { server, db };
}

module.exports = { createApp };
