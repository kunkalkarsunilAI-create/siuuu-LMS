'use strict';
// Feature 1 — Bulk roster import.
//
// Spec (also in README):
//   Required columns : roll_no, name, email, course_code   (any order, case-insensitive)
//   Optional columns : department
//   One row = one student in one course. To enrol a student in 3 courses, use 3 rows.
//   Mode             : PARTIAL. Valid rows are imported; invalid rows are reported with
//                      their line number and reason and can be fixed and re-uploaded.
//                      Re-uploading the same file is safe (idempotent).
//   Duplicates       : same email + same course twice in the file -> later row skipped.
//                      same email with a different roll_no/name in the file -> error.
//                      email already in the system with the same roll_no -> reuse account.
//                      email or roll_no already belongs to someone else -> error.
//                      already enrolled in that course -> skipped, not an error.
//   Limits           : 5,000 data rows, 2 MB.
const { parseCsv } = require('./csv');
const { INITIAL_ROLL_NO } = require('./auth');
const { tx } = require('./db');

const REQUIRED = ['roll_no', 'name', 'email', 'course_code'];
const OPTIONAL = ['department'];
const MAX_ROWS = 5000;
const MAX_BYTES = 2 * 1024 * 1024;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[A-Za-z]{2,}$/;
const ROLL_RE = /^[A-Za-z0-9][A-Za-z0-9\-\/]{2,19}$/;

const HEADER_ALIASES = {
  'roll no': 'roll_no', 'roll number': 'roll_no', 'rollno': 'roll_no', 'roll': 'roll_no',
  'student name': 'name', 'full name': 'name',
  'email address': 'email', 'e-mail': 'email', 'mail': 'email',
  'course': 'course_code', 'course code': 'course_code', 'coursecode': 'course_code',
  'dept': 'department',
};

function normaliseHeader(h) {
  const k = String(h).trim().toLowerCase().replace(/\s+/g, ' ');
  return HEADER_ALIASES[k] || k.replace(/ /g, '_');
}

class ImportError extends Error {}

// Validate a CSV and work out what *would* happen to every row.
// Pure with respect to the DB (reads only), so it powers both Preview and Import.
function planImport(db, csvText) {
  if (Buffer.byteLength(String(csvText || ''), 'utf8') > MAX_BYTES) {
    throw new ImportError('This file is larger than 2 MB. Split it into smaller files and upload them one at a time.');
  }
  const { rows, quotesUnclosed } = parseCsv(csvText || '');
  if (!rows.length) throw new ImportError('The file is empty. It needs a header row and at least one student.');

  const header = rows[0].cells.map(normaliseHeader);
  const missing = REQUIRED.filter(c => !header.includes(c));
  if (missing.length) {
    throw new ImportError(`Missing required column(s): ${missing.join(', ')}. The header row must include: ${REQUIRED.join(', ')}.`);
  }
  const dupHeaders = header.filter((h, i) => h && header.indexOf(h) !== i);
  if (dupHeaders.length) throw new ImportError(`Column "${dupHeaders[0]}" appears more than once in the header.`);
  const ignored = header.filter(h => h && !REQUIRED.includes(h) && !OPTIONAL.includes(h));

  const data = rows.slice(1);
  if (!data.length) throw new ImportError('The file has a header row but no students.');
  if (data.length > MAX_ROWS) throw new ImportError(`The file has ${data.length} rows; the limit is ${MAX_ROWS}. Split it and upload in parts.`);

  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const courses = new Map(db.prepare('SELECT id, code, title FROM courses').all().map(c => [c.code.toUpperCase(), c]));
  const userByEmail = db.prepare('SELECT id, email, name, role, roll_no FROM users WHERE email = ?');
  const userByRoll = db.prepare('SELECT id, email, roll_no FROM users WHERE roll_no = ? COLLATE NOCASE');
  const isEnrolled = db.prepare('SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?');

  const seenInFile = new Map();   // email -> { roll_no, name, line }
  const rollInFile = new Map();   // roll_no(upper) -> email
  const pairInFile = new Set();   // email|courseId
  const results = [];

  for (const r of data) {
    const get = k => (col[k] === undefined ? '' : String(r.cells[col[k]] ?? '').trim());
    const rec = {
      line: r.line,
      roll_no: get('roll_no'),
      name: get('name').replace(/\s+/g, ' '),
      email: get('email').toLowerCase(),
      course_code: get('course_code').toUpperCase(),
      department: get('department'),
    };
    const errors = [];
    if (r.cells.length !== header.length) {
      errors.push(`has ${r.cells.length} columns but the header has ${header.length} (check for a stray comma)`);
    }
    for (const k of REQUIRED) if (!rec[k]) errors.push(`${k} is empty`);
    if (rec.email && !EMAIL_RE.test(rec.email)) errors.push(`"${rec.email}" is not a valid email address`);
    if (rec.roll_no && !ROLL_RE.test(rec.roll_no)) errors.push(`roll_no "${rec.roll_no}" must be 3–20 letters, digits, - or /`);
    if (rec.name.length > 100) errors.push('name is longer than 100 characters');
    const course = rec.course_code ? courses.get(rec.course_code) : null;
    if (rec.course_code && !course) errors.push(`course_code "${rec.course_code}" does not exist`);

    let action = null;
    let note = '';
    if (!errors.length) {
      // Consistency inside the file.
      const prev = seenInFile.get(rec.email);
      if (prev && prev.roll_no.toUpperCase() !== rec.roll_no.toUpperCase()) {
        errors.push(`${rec.email} has roll_no ${prev.roll_no} on line ${prev.line} but ${rec.roll_no} here`);
      } else if (prev && prev.name.toLowerCase() !== rec.name.toLowerCase()) {
        errors.push(`${rec.email} is named "${prev.name}" on line ${prev.line} but "${rec.name}" here`);
      }
      const rollOwner = rollInFile.get(rec.roll_no.toUpperCase());
      if (!errors.length && rollOwner && rollOwner !== rec.email) {
        errors.push(`roll_no ${rec.roll_no} is already used by ${rollOwner} earlier in this file`);
      }
    }
    if (!errors.length) {
      // Consistency with what's already in the system.
      const existing = userByEmail.get(rec.email);
      const rollUser = userByRoll.get(rec.roll_no);
      if (existing && existing.role !== 'student') {
        errors.push(`${rec.email} belongs to a ${existing.role} account, not a student`);
      } else if (existing && existing.roll_no && existing.roll_no.toUpperCase() !== rec.roll_no.toUpperCase()) {
        errors.push(`${rec.email} is already registered with roll_no ${existing.roll_no}`);
      } else if (rollUser && rollUser.email !== rec.email) {
        errors.push(`roll_no ${rec.roll_no} already belongs to ${rollUser.email}`);
      } else if (pairInFile.has(`${rec.email}|${course.id}`)) {
        action = 'skip';
        note = `duplicate of an earlier row in this file (${rec.email} → ${course.code})`;
      } else if (existing && isEnrolled.get(existing.id, course.id)) {
        action = 'skip';
        note = `already enrolled in ${course.code}`;
      } else if (existing || seenInFile.has(rec.email)) {
        action = 'enrol';
        note = existing ? `existing student, enrol in ${course.code}` : `enrol in ${course.code}`;
      } else {
        action = 'create';
        note = `new student, enrol in ${course.code}`;
      }
    }

    if (errors.length) {
      results.push({ ...rec, status: 'error', message: errors.join('; ') });
      continue;
    }
    if (!seenInFile.has(rec.email)) seenInFile.set(rec.email, { roll_no: rec.roll_no, name: rec.name, line: rec.line });
    rollInFile.set(rec.roll_no.toUpperCase(), rec.email);
    pairInFile.add(`${rec.email}|${course.id}`);
    results.push({ ...rec, course_id: course.id, status: action, message: note });
  }

  const count = s => results.filter(r => r.status === s).length;
  return {
    results,
    ignoredColumns: ignored,
    warnings: quotesUnclosed ? ['A quote (") was opened but never closed — the last row may be merged with others.'] : [],
    summary: {
      total: results.length,
      newStudents: new Set(results.filter(r => r.status === 'create').map(r => r.email)).size,
      enrolments: count('create') + count('enrol'),
      skipped: count('skip'),
      errors: count('error'),
    },
  };
}

// Apply the plan. Valid rows go in one transaction; error rows are left out.
function commitImport(db, csvText, adminId, filename) {
  const plan = planImport(db, csvText);
  return tx(db, () => {
    const batch = db.prepare(`INSERT INTO import_batches
      (admin_id, filename, total_rows, created, enrolled, skipped, failed, report_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, '[]')`).run(
      adminId, filename || 'pasted.csv', plan.summary.total, plan.summary.newStudents,
      plan.summary.enrolments, plan.summary.skipped, plan.summary.errors);
    const batchId = Number(batch.lastInsertRowid);

    const insUser = db.prepare(`INSERT INTO users (email, name, role, roll_no, department, password_hash)
      VALUES (?, ?, 'student', ?, ?, ?)`);
    const findUser = db.prepare('SELECT id FROM users WHERE email = ?');
    const enrol = db.prepare('INSERT OR IGNORE INTO enrollments (user_id, course_id, batch_id) VALUES (?, ?, ?)');

    for (const r of plan.results) {
      if (r.status !== 'create' && r.status !== 'enrol') continue;
      let user = findUser.get(r.email);
      if (!user) {
        // First password = roll number. Hashing 2,000 passwords with scrypt here would take ~100s,
        // so we store a marker and hash on first sign-in instead (see auth.INITIAL_ROLL_NO).
        // A production build would email each student an invite link instead.
        insUser.run(r.email, r.name, r.roll_no.toUpperCase(), r.department || null, INITIAL_ROLL_NO);
        user = findUser.get(r.email);
      }
      enrol.run(user.id, r.course_id, batchId);
    }
    const report = plan.results.map(({ line, roll_no, name, email, course_code, status, message }) =>
      ({ line, roll_no, name, email, course_code, status, message }));
    db.prepare('UPDATE import_batches SET report_json = ? WHERE id = ?').run(JSON.stringify(report), batchId);
    return { batchId, ...plan };
  });
}

module.exports = { planImport, commitImport, ImportError, REQUIRED, OPTIONAL, MAX_ROWS };
