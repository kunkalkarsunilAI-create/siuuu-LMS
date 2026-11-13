'use strict';
// Database layer. Uses Node's built-in SQLite (node:sqlite, Node >= 22.13),
// so the project has zero npm dependencies and needs no `npm install`.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','faculty','student')),
  roll_no       TEXT UNIQUE,
  department    TEXT,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  semester   TEXT,
  faculty_id INTEGER REFERENCES users(id),
  -- minimum % a student must score in the external component(s) to pass
  min_external_pct REAL NOT NULL DEFAULT 40
);

CREATE TABLE IF NOT EXISTS enrollments (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  batch_id    INTEGER,
  enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, course_id)
);

CREATE TABLE IF NOT EXISTS import_batches (
  id          INTEGER PRIMARY KEY,
  admin_id    INTEGER NOT NULL REFERENCES users(id),
  filename    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  total_rows  INTEGER NOT NULL,
  created     INTEGER NOT NULL,
  enrolled    INTEGER NOT NULL,
  skipped     INTEGER NOT NULL,
  failed      INTEGER NOT NULL,
  report_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS components (
  id        INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  category  TEXT NOT NULL CHECK (category IN ('internal','external')),
  weight    REAL NOT NULL CHECK (weight >= 0 AND weight <= 100),
  max_marks REAL NOT NULL CHECK (max_marks > 0),
  position  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS marks (
  component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  student_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  marks        REAL NOT NULL,
  source       TEXT NOT NULL DEFAULT 'manual',
  updated_by   INTEGER REFERENCES users(id),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (component_id, student_id)
);

CREATE TABLE IF NOT EXISTS exams (
  id           INTEGER PRIMARY KEY,
  course_id    INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  instructions TEXT,
  duration_min INTEGER NOT NULL CHECK (duration_min > 0),
  opens_at     INTEGER NOT NULL,  -- epoch ms
  closes_at    INTEGER NOT NULL,  -- epoch ms; hard stop for everyone
  component_id INTEGER REFERENCES components(id) ON DELETE SET NULL,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id            INTEGER PRIMARY KEY,
  exam_id       INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('mcq','short')),
  prompt        TEXT NOT NULL,
  options_json  TEXT,
  correct_index INTEGER,
  marks         REAL NOT NULL CHECK (marks > 0)
);

CREATE TABLE IF NOT EXISTS attempts (
  id            INTEGER PRIMARY KEY,
  exam_id       INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at    INTEGER NOT NULL,
  deadline      INTEGER NOT NULL,
  submitted_at  INTEGER,
  submit_reason TEXT CHECK (submit_reason IN ('student','timeout')),
  answers_json  TEXT NOT NULL DEFAULT '{}',
  save_seq      INTEGER NOT NULL DEFAULT 0,
  save_count    INTEGER NOT NULL DEFAULT 0,
  last_saved_at INTEGER,
  auto_score    REAL,
  manual_json   TEXT NOT NULL DEFAULT '{}',
  total_score   REAL,
  graded        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (exam_id, student_id)
);
`;

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

// Run fn inside a transaction; roll back on any thrown error.
function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { openDb, tx };
