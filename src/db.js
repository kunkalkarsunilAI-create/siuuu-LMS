'use strict';
// Database layer: Node's built-in SQLite (node:sqlite, Node >= 22.13). Zero npm dependencies.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Everyone who signs in. HR admins run the system, managers see their direct reports.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('hr_admin','manager','employee')),
  employee_id   TEXT UNIQUE,
  department    TEXT,
  job_title     TEXT,
  manager_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  joined_on     TEXT,                       -- YYYY-MM-DD
  active        INTEGER NOT NULL DEFAULT 1, -- 0 = has left; excluded from compliance
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_manager ON users(manager_id);
CREATE INDEX IF NOT EXISTS users_dept ON users(department);

CREATE TABLE IF NOT EXISTS courses (
  id              INTEGER PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  summary         TEXT,
  category        TEXT NOT NULL CHECK (category IN ('Compliance','Onboarding','Skills')),
  est_minutes     INTEGER NOT NULL DEFAULT 15,
  pass_mark       INTEGER NOT NULL CHECK (pass_mark BETWEEN 1 AND 100),  -- percent
  validity_months INTEGER CHECK (validity_months IS NULL OR validity_months > 0), -- NULL = never expires
  max_attempts    INTEGER CHECK (max_attempts IS NULL OR max_attempts > 0),       -- per certification cycle
  created_by      INTEGER REFERENCES users(id),
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lessons (
  id        INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  title     TEXT NOT NULL,
  body      TEXT NOT NULL,
  video_url TEXT
);

CREATE TABLE IF NOT EXISTS questions (
  id            INTEGER PRIMARY KEY,
  course_id     INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  prompt        TEXT NOT NULL,
  options_json  TEXT NOT NULL,
  correct_index INTEGER NOT NULL
);

-- "Everyone in <department> (or everyone) must complete <course> within <due_days> days."
-- Rules apply to current staff and to everyone imported later.
CREATE TABLE IF NOT EXISTS rules (
  id         INTEGER PRIMARY KEY,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  department TEXT,               -- NULL = all departments
  due_days   INTEGER NOT NULL CHECK (due_days > 0),
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE (course_id, department)
);

CREATE TABLE IF NOT EXISTS assignments (
  id          INTEGER PRIMARY KEY,
  course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at INTEGER NOT NULL,
  due_at      INTEGER NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('rule','manual')),
  assigned_by INTEGER REFERENCES users(id),
  UNIQUE (course_id, user_id)
);
CREATE INDEX IF NOT EXISTS assignments_user ON assignments(user_id);

CREATE TABLE IF NOT EXISTS lesson_progress (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id    INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, lesson_id)
);

CREATE TABLE IF NOT EXISTS attempts (
  id           INTEGER PRIMARY KEY,
  course_id    INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at   INTEGER NOT NULL,
  submitted_at INTEGER,
  answers_json TEXT NOT NULL DEFAULT '{}',
  save_seq     INTEGER NOT NULL DEFAULT 0,
  score_pct    REAL,
  passed       INTEGER
);
CREATE INDEX IF NOT EXISTS attempts_user_course ON attempts(user_id, course_id);

CREATE TABLE IF NOT EXISTS certificates (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  attempt_id  INTEGER REFERENCES attempts(id) ON DELETE SET NULL,
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER,
  score_pct   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS certificates_user_course ON certificates(user_id, course_id, issued_at);

CREATE TABLE IF NOT EXISTS import_batches (
  id          INTEGER PRIMARY KEY,
  admin_id    INTEGER NOT NULL REFERENCES users(id),
  filename    TEXT,
  created_at  INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  report_json TEXT NOT NULL
);
`;

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { openDb, tx };
