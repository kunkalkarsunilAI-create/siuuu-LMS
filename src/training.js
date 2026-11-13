'use strict';
// Core training rules: who must do what by when, and where each person stands.
const crypto = require('node:crypto');

const DAY = 24 * 60 * 60 * 1000;
const EXPIRING_WINDOW = 30 * DAY;

// One status per (person, course). Exactly one applies, checked in this order:
//   completed  – holds a certificate that is valid for more than 30 more days (or never expires)
//   expiring   – holds a valid certificate that expires within 30 days
//   expired    – had a certificate, it has lapsed; must retake (non-compliant)
//   overdue    – never certified and the due date has passed
//   in_progress– started lessons or the quiz, not yet passed
//   not_started
// "Compliant" = completed or expiring.
const STATUSES = ['completed', 'expiring', 'expired', 'overdue', 'in_progress', 'not_started'];
const STATUS_LABEL = {
  completed: 'Completed', expiring: 'Expiring soon', expired: 'Expired', overdue: 'Overdue',
  in_progress: 'In progress', not_started: 'Not started',
};

function statusOf({ due_at, cert_expires, cert_issued, lessons_done, attempts }, now) {
  if (cert_issued) {
    if (!cert_expires || cert_expires > now) return cert_expires && cert_expires - now <= EXPIRING_WINDOW ? 'expiring' : 'completed';
    return 'expired';
  }
  if (now > due_at) return 'overdue';
  if (lessons_done > 0 || attempts > 0) return 'in_progress';
  return 'not_started';
}
const isCompliant = s => s === 'completed' || s === 'expiring';

function addMonths(ms, months) {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last)); // 31 Jan + 1 month = 28/29 Feb, not 3 Mar
  return d.getTime();
}

const joinedMs = joined_on => (joined_on && /^\d{4}-\d{2}-\d{2}$/.test(joined_on) ? Date.parse(joined_on + 'T00:00:00Z') : 0);

// Create the assignments every rule implies. Never moves an existing due date.
// Due date = (later of: now, the person's joining date) + rule.due_days.
function applyRules(db, now, { userIds = null, ruleIds = null } = {}) {
  const rules = db.prepare('SELECT * FROM rules').all().filter(r => !ruleIds || ruleIds.includes(r.id));
  if (!rules.length) return 0;
  const people = db.prepare('SELECT id, department, joined_on FROM users WHERE active = 1').all()
    .filter(u => !userIds || userIds.includes(u.id));
  const ins = db.prepare(`INSERT INTO assignments (course_id, user_id, assigned_at, due_at, source)
    VALUES (?, ?, ?, ?, 'rule') ON CONFLICT(course_id, user_id) DO NOTHING`);
  let created = 0;
  for (const r of rules) {
    for (const u of people) {
      if (r.department && (u.department || '').toLowerCase() !== r.department.toLowerCase()) continue;
      const base = Math.max(now, joinedMs(u.joined_on));
      created += Number(ins.run(r.course_id, u.id, now, base + r.due_days * DAY).changes);
    }
  }
  return created;
}

// Every assignment with what's needed to work out its status, in one query.
function assignmentRows(db, { userIds = null, courseId = null } = {}) {
  const where = ['u.active = 1'];
  const params = [];
  if (courseId) { where.push('a.course_id = ?'); params.push(courseId); }
  if (userIds) {
    if (!userIds.length) return [];
    where.push(`a.user_id IN (${userIds.map(() => '?').join(',')})`); params.push(...userIds);
  }
  return db.prepare(`
    SELECT a.id, a.course_id, a.user_id, a.due_at, a.assigned_at, a.source,
      u.name, u.email, u.employee_id, u.department, u.job_title, u.manager_id, m.name AS manager_name,
      c.code, c.title, c.category, c.validity_months,
      ce.issued_at AS cert_issued, ce.expires_at AS cert_expires, ce.code AS cert_code, ce.score_pct AS cert_score,
      (SELECT COUNT(*) FROM lessons l WHERE l.course_id = a.course_id) AS lessons_total,
      (SELECT COUNT(*) FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id
        WHERE lp.user_id = a.user_id AND l.course_id = a.course_id) AS lessons_done,
      (SELECT COUNT(*) FROM attempts t WHERE t.user_id = a.user_id AND t.course_id = a.course_id) AS attempts
    FROM assignments a
    JOIN users u ON u.id = a.user_id
    JOIN courses c ON c.id = a.course_id
    LEFT JOIN users m ON m.id = u.manager_id
    LEFT JOIN certificates ce ON ce.id = (
      SELECT id FROM certificates x WHERE x.user_id = a.user_id AND x.course_id = a.course_id ORDER BY x.issued_at DESC LIMIT 1)
    WHERE ${where.join(' AND ')}
    ORDER BY u.name, c.code`).all(...params).map(r => ({ ...r }));
}

function withStatus(rows, now) {
  return rows.map(r => {
    const status = statusOf(r, now);
    // For a lapsed certificate the effective deadline is the day it expired.
    const effective_due = status === 'expired' ? r.cert_expires : r.due_at;
    return { ...r, status, effective_due };
  });
}

// ----- quiz -----
function loadQuestions(db, courseId) {
  return db.prepare('SELECT * FROM questions WHERE course_id = ? ORDER BY position').all(courseId)
    .map(q => ({ id: q.id, position: q.position, prompt: q.prompt, options: JSON.parse(q.options_json), correct_index: q.correct_index }));
}
const publicQuestions = qs => qs.map(({ correct_index, ...q }) => q);

function scoreAnswers(questions, answers) {
  if (!questions.length) return 0;
  const right = questions.filter(q => answers[q.id] !== undefined && Number(answers[q.id]) === q.correct_index).length;
  return Math.round((right / questions.length) * 1000) / 10; // one decimal place
}

// Attempts made since the person's most recent certificate (a renewal starts a new cycle).
function attemptsThisCycle(db, userId, courseId) {
  const last = db.prepare('SELECT MAX(issued_at) AS t FROM certificates WHERE user_id = ? AND course_id = ?').get(userId, courseId).t || 0;
  return db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE user_id = ? AND course_id = ? AND submitted_at IS NOT NULL AND started_at > ?')
    .get(userId, courseId, last).n;
}

function newCertificateCode() {
  // Unambiguous characters (no 0/O, 1/I/L) so a code read aloud or typed is hard to get wrong.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map(b => alphabet[b % alphabet.length]).join('');
  return `PW-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

function issueCertificate(db, { userId, course, attemptId, scorePct, now }) {
  const expires = course.validity_months ? addMonths(now, course.validity_months) : null;
  for (let i = 0; i < 5; i++) {
    const code = newCertificateCode();
    try {
      db.prepare(`INSERT INTO certificates (code, user_id, course_id, attempt_id, issued_at, expires_at, score_pct)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(code, userId, course.id, attemptId, now, expires, scorePct);
      return { code, issued_at: now, expires_at: expires };
    } catch (e) { if (!/UNIQUE/.test(e.message)) throw e; }
  }
  throw new Error('Could not create a unique certificate code.');
}

module.exports = {
  DAY, EXPIRING_WINDOW, STATUSES, STATUS_LABEL, statusOf, isCompliant, addMonths, joinedMs,
  applyRules, assignmentRows, withStatus, loadQuestions, publicQuestions, scoreAnswers,
  attemptsThisCycle, issueCertificate, newCertificateCode,
};
