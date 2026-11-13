'use strict';
// Feature 1 — Employee import (the HR master list) and automatic training assignment.
//
//   Required columns : employee_id, name, email, department
//   Optional columns : job_title, manager_email, joined_on, role (employee|manager), status (active|left)
//   Each row is one person. Re-uploading the latest HR export is the normal way to keep
//   the system in step: new people are added, moves and new managers are updated,
//   people marked "left" are switched off, and unchanged rows are left alone.
//   Mode: PARTIAL — valid rows are applied in one transaction, rows with mistakes are
//   listed with line number and reason and left out. After import, assignment rules run,
//   so new joiners get their onboarding and compliance training straight away.
const { parseCsv } = require('./csv');
const { INITIAL_EMPLOYEE_ID } = require('./auth');
const { tx } = require('./db');
const training = require('./training');

const REQUIRED = ['employee_id', 'name', 'email', 'department'];
const OPTIONAL = ['job_title', 'manager_email', 'joined_on', 'role', 'status'];
const MAX_ROWS = 10000;
const MAX_BYTES = 3 * 1024 * 1024;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[A-Za-z]{2,}$/;
const EMP_RE = /^[A-Za-z0-9][A-Za-z0-9\-\/_.]{1,19}$/;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const ALIASES = {
  'employee id': 'employee_id', 'emp id': 'employee_id', 'emp_id': 'employee_id', 'employee no': 'employee_id',
  'employee number': 'employee_id', 'emp code': 'employee_id', 'employee code': 'employee_id', 'staff id': 'employee_id',
  'full name': 'name', 'employee name': 'name',
  'email address': 'email', 'work email': 'email', 'official email': 'email', 'e-mail': 'email',
  'dept': 'department', 'team': 'department',
  'designation': 'job_title', 'title': 'job_title', 'job title': 'job_title', 'position': 'job_title',
  'manager': 'manager_email', 'manager email': 'manager_email', 'reports to': 'manager_email', 'reporting manager': 'manager_email',
  'date of joining': 'joined_on', 'doj': 'joined_on', 'joining date': 'joined_on', 'joined': 'joined_on', 'start date': 'joined_on',
  'employment status': 'status',
};
const normHeader = h => { const k = String(h).trim().toLowerCase().replace(/\s+/g, ' '); return ALIASES[k] || k.replace(/ /g, '_'); };

class ImportError extends Error {}

// Accepts 2026-04-01, 01/04/2026, 01-04-2026 (day first, as in India) and 1-Apr-2026.
function parseDate(s) {
  s = String(s || '').trim();
  if (!s) return { value: null };
  let y, m, d, mm;
  if ((mm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) [, y, m, d] = mm.map(Number);
  else if ((mm = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(s))) { d = +mm[1]; m = +mm[2]; y = +mm[3]; }
  else if ((mm = /^(\d{1,2})[\s\-]([A-Za-z]{3})[A-Za-z]*[\s\-,]+(\d{4})$/.exec(s)) && MONTHS[mm[2].toLowerCase()]) { d = +mm[1]; m = MONTHS[mm[2].toLowerCase()]; y = +mm[3]; }
  else return { error: `joined_on "${s}" isn't a date we recognise (use YYYY-MM-DD or DD/MM/YYYY)` };
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 1950 || y > 2100) {
    return { error: `joined_on "${s}" isn't a real date` };
  }
  return { value: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

function planImport(db, csvText) {
  if (Buffer.byteLength(String(csvText || ''), 'utf8') > MAX_BYTES) throw new ImportError('This file is larger than 3 MB. Split it and upload the parts one after another.');
  const { rows, quotesUnclosed } = parseCsv(csvText || '');
  if (!rows.length) throw new ImportError('The file is empty. It needs a header row and at least one employee.');
  const header = rows[0].cells.map(normHeader);
  const missing = REQUIRED.filter(c => !header.includes(c));
  if (missing.length) throw new ImportError(`Missing required column(s): ${missing.join(', ')}. The header row must include: ${REQUIRED.join(', ')}.`);
  const dup = header.find((h, i) => h && header.indexOf(h) !== i);
  if (dup) throw new ImportError(`Column "${dup}" appears more than once in the header.`);
  const ignored = header.filter(h => h && !REQUIRED.includes(h) && !OPTIONAL.includes(h));
  const data = rows.slice(1);
  if (!data.length) throw new ImportError('The file has a header row but no employees.');
  if (data.length > MAX_ROWS) throw new ImportError(`The file has ${data.length} rows; the limit is ${MAX_ROWS}.`);
  const col = Object.fromEntries(header.map((h, i) => [h, i]));

  const allUsers = db.prepare('SELECT * FROM users').all();
  const byEmail = new Map(allUsers.map(u => [u.email, u]));
  const byEmp = new Map(allUsers.filter(u => u.employee_id).map(u => [u.employee_id.toUpperCase(), u]));
  const byId = new Map(allUsers.map(u => [u.id, u]));
  const seenEmail = new Map(), seenEmp = new Map();
  const results = [];

  for (const r of data) {
    const get = k => (col[k] === undefined ? '' : String(r.cells[col[k]] ?? '').trim());
    const rec = {
      line: r.line,
      employee_id: get('employee_id').toUpperCase(),
      name: get('name').replace(/\s+/g, ' '),
      email: get('email').toLowerCase(),
      department: get('department').replace(/\s+/g, ' '),
      job_title: get('job_title').replace(/\s+/g, ' '),
      manager_email: get('manager_email').toLowerCase(),
      joined_on: null,
      role: get('role').toLowerCase(),
      leaving: /^(left|inactive|exited|resigned|terminated)$/i.test(get('status')),
    };
    const errors = [];
    if (r.cells.length !== header.length) errors.push(`has ${r.cells.length} columns but the header has ${header.length} (check for a stray comma)`);
    for (const k of REQUIRED) if (!rec[k]) errors.push(`${k} is empty`);
    if (rec.email && !EMAIL_RE.test(rec.email)) errors.push(`"${rec.email}" is not a valid email address`);
    if (rec.employee_id && !EMP_RE.test(rec.employee_id)) errors.push(`employee_id "${rec.employee_id}" must be 2–20 letters, digits, - / _ or .`);
    if (rec.manager_email && !EMAIL_RE.test(rec.manager_email)) errors.push(`manager_email "${rec.manager_email}" is not a valid email address`);
    if (rec.manager_email && rec.manager_email === rec.email) errors.push('someone can\'t be their own manager');
    if (rec.role && !['employee', 'manager'].includes(rec.role)) errors.push(`role must be "employee" or "manager", not "${rec.role}"`);
    const st = get('status');
    if (st && !rec.leaving && !/^(active|current|employed)$/i.test(st)) errors.push(`status must be "active" or "left", not "${st}"`);
    const jd = parseDate(get('joined_on'));
    if (jd.error) errors.push(jd.error); else rec.joined_on = jd.value;
    if (rec.name.length > 120) errors.push('name is longer than 120 characters');

    if (!errors.length) {
      const pe = seenEmail.get(rec.email), pi = seenEmp.get(rec.employee_id);
      if (pe) errors.push(`${rec.email} already appears on line ${pe}`);
      else if (pi) errors.push(`employee_id ${rec.employee_id} already appears on line ${pi}`);
    }
    let existing = null;
    if (!errors.length) {
      existing = byEmail.get(rec.email) || null;
      const empOwner = byEmp.get(rec.employee_id);
      if (existing && existing.role === 'hr_admin') errors.push(`${rec.email} is an HR admin account and can't be changed by import`);
      else if (existing && existing.employee_id && existing.employee_id.toUpperCase() !== rec.employee_id) errors.push(`${rec.email} is already registered as employee ${existing.employee_id}`);
      else if (empOwner && empOwner.email !== rec.email) errors.push(`employee_id ${rec.employee_id} already belongs to ${empOwner.email}`);
    }
    if (errors.length) { results.push({ ...rec, status: 'error', message: errors.join('; ') }); continue; }
    seenEmail.set(rec.email, rec.line);
    seenEmp.set(rec.employee_id, rec.line);
    results.push({ ...rec, existing_id: existing?.id ?? null, status: null, message: '' });
  }

  // Managers must exist (in the file or already in the system) and still work here.
  const inFile = new Map(results.filter(r => r.status !== 'error').map(r => [r.email, r]));
  for (const r of results) {
    if (r.status === 'error' || !r.manager_email) continue;
    const mf = inFile.get(r.manager_email);
    const md = byEmail.get(r.manager_email);
    if (mf ? mf.leaving : !md) r.status = 'error', r.message = mf ? `manager ${r.manager_email} is marked as left in this file` : `manager ${r.manager_email} isn't in this file or in the system`;
    else if (!mf && md && !md.active) r.status = 'error', r.message = `manager ${r.manager_email} has left the company`;
  }
  // No reporting loops (A reports to B who reports to A).
  const managerOf = new Map(allUsers.map(u => [u.email, u.manager_id ? byId.get(u.manager_id)?.email : null]));
  for (const r of results) if (r.status !== 'error') managerOf.set(r.email, r.manager_email || null);
  for (const r of results) {
    if (r.status === 'error') continue;
    const seen = new Set([r.email]);
    let cur = managerOf.get(r.email);
    while (cur) {
      if (seen.has(cur)) { r.status = 'error'; r.message = `reporting line loops back (${[...seen, cur].join(' → ')})`; break; }
      seen.add(cur); cur = managerOf.get(cur);
    }
  }
  // Anyone who manages someone becomes a manager.
  const managers = new Set(results.filter(r => r.status !== 'error' && r.manager_email).map(r => r.manager_email));

  for (const r of results) {
    if (r.status === 'error') continue;
    const ex = r.existing_id ? byId.get(r.existing_id) : null;
    const wantRole = managers.has(r.email) || r.role === 'manager' || ex?.role === 'manager' && r.role !== 'employee' ? 'manager' : 'employee';
    r.final_role = wantRole;
    if (!ex) {
      if (r.leaving) { r.status = 'skip'; r.message = 'marked as left and not in the system — nothing to do'; continue; }
      r.status = 'create';
      r.message = `new ${wantRole === 'manager' ? 'manager' : 'employee'} in ${r.department}`;
      continue;
    }
    if (r.leaving) {
      if (!ex.active) { r.status = 'skip'; r.message = 'already marked as left'; }
      else if ([...managers].includes(r.email)) { r.status = 'error'; r.message = 'is marked as left but still manages people in this file — move their reports first'; }
      else { r.status = 'deactivate'; r.message = 'has left — will be removed from training and compliance'; }
      continue;
    }
    const changes = [];
    const exMgr = ex.manager_id ? byId.get(ex.manager_id)?.email : '';
    if (ex.name !== r.name) changes.push(`name → ${r.name}`);
    if ((ex.department || '') !== r.department) changes.push(`department ${ex.department || '—'} → ${r.department}`);
    if (r.job_title && (ex.job_title || '') !== r.job_title) changes.push(`title → ${r.job_title}`);
    if (col.manager_email !== undefined && (exMgr || '') !== r.manager_email) changes.push(`manager → ${r.manager_email || 'none'}`);
    if (r.joined_on && ex.joined_on !== r.joined_on) changes.push(`joined → ${r.joined_on}`);
    if (ex.role !== wantRole) changes.push(`becomes ${wantRole}`);
    if (!ex.active) changes.push('rejoined');
    if (changes.length) { r.status = 'update'; r.message = changes.join('; '); }
    else { r.status = 'skip'; r.message = 'no changes'; }
  }

  const count = s => results.filter(r => r.status === s).length;
  return {
    results: results.map(({ existing_id, ...r }) => r),
    _internal: results,
    ignoredColumns: ignored,
    managerColumn: col.manager_email !== undefined,
    warnings: quotesUnclosed ? ['A quote (") was opened but never closed — the last rows may be merged together.'] : [],
    summary: { total: results.length, create: count('create'), update: count('update'), deactivate: count('deactivate'), skip: count('skip'), errors: count('error') },
  };
}

function commitImport(db, csvText, adminId, filename, now) {
  const plan = planImport(db, csvText);
  return tx(db, () => {
    const find = db.prepare('SELECT id FROM users WHERE email = ?');
    const touched = [];
    // Pass 1: people. Pass 2: reporting lines (managers may be created in pass 1).
    for (const r of plan._internal) {
      if (r.status === 'create') {
        const res = db.prepare(`INSERT INTO users (email, name, role, employee_id, department, job_title, joined_on, active, password_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(r.email, r.name, r.final_role, r.employee_id, r.department, r.job_title || null, r.joined_on, INITIAL_EMPLOYEE_ID, now);
        touched.push(Number(res.lastInsertRowid));
      } else if (r.status === 'update') {
        db.prepare(`UPDATE users SET name = ?, role = ?, employee_id = ?, department = ?, job_title = COALESCE(?, job_title),
          joined_on = COALESCE(?, joined_on), active = 1 WHERE id = ?`)
          .run(r.name, r.final_role, r.employee_id, r.department, r.job_title || null, r.joined_on, r.existing_id);
        touched.push(r.existing_id);
      } else if (r.status === 'deactivate') {
        db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(r.existing_id);
        db.prepare('UPDATE users SET manager_id = NULL WHERE manager_id = ?').run(r.existing_id);
      }
    }
    if (plan.managerColumn) {
      for (const r of plan._internal) {
        if (r.status !== 'create' && r.status !== 'update') continue;
        const mid = r.manager_email ? find.get(r.manager_email)?.id ?? null : null;
        db.prepare('UPDATE users SET manager_id = ? WHERE email = ?').run(mid, r.email);
      }
    }
    // Department moves can mean new mandatory training.
    const assigned = touched.length ? training.applyRules(db, now, { userIds: touched }) : 0;
    const summary = { ...plan.summary, assignmentsCreated: assigned };
    const report = plan.results.map(({ line, employee_id, name, email, department, manager_email, status, message }) =>
      ({ line, employee_id, name, email, department, manager_email, status, message }));
    const b = db.prepare('INSERT INTO import_batches (admin_id, filename, created_at, summary_json, report_json) VALUES (?, ?, ?, ?, ?)')
      .run(adminId, filename || 'pasted rows', now, JSON.stringify(summary), JSON.stringify(report));
    return { batchId: Number(b.lastInsertRowid), results: plan.results, ignoredColumns: plan.ignoredColumns, warnings: plan.warnings, summary };
  });
}

module.exports = { planImport: (db, csv) => { const p = planImport(db, csv); delete p._internal; return p; }, commitImport, parseDate, ImportError, REQUIRED, OPTIONAL };
