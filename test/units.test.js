'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, toCsv } = require('../src/csv');
const { computeStudent, validateComponents, letterFor } = require('../src/grades');

test('CSV: quotes, embedded commas/newlines, CRLF, BOM, blank lines', () => {
  const { rows } = parseCsv('﻿a,b,c\r\n1,"x, y","multi\nline"\r\n\r\n2,"say ""hi""",z\n');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].cells, ['a', 'b', 'c']);
  assert.deepEqual(rows[1].cells, ['1', 'x, y', 'multi\nline']);
  assert.deepEqual(rows[2].cells, ['2', 'say "hi"', 'z']);
  assert.equal(rows[2].line, 5, 'line numbers count physical lines, so admins can find the row in Excel');
});

test('CSV: unclosed quote is reported', () => {
  assert.equal(parseCsv('a,b\n1,"oops\n').quotesUnclosed, true);
});

test('CSV export neutralises spreadsheet formulas', () => {
  const out = toCsv(['name'], [['=HYPERLINK("http://evil")'], ['-5'], ['Ann, B']]);
  assert.match(out, /'=HYPERLINK/);
  assert.match(out, /\r\n-5\r\n/);
  assert.match(out, /"Ann, B"/);
});

const comps = [
  { id: 1, name: 'Mid', category: 'internal', weight: 20, max_marks: 40 },
  { id: 2, name: 'Asg', category: 'internal', weight: 20, max_marks: 20 },
  { id: 3, name: 'End', category: 'external', weight: 60, max_marks: 100 },
];

test('Gradebook: weighted total, internal/external split, grade', () => {
  const r = computeStudent(comps, { 1: 30, 2: 15, 3: 80 });
  assert.equal(r.internal, 30);     // 30/40*20 + 15/20*20 = 15 + 15
  assert.equal(r.external, 48);     // 80/100*60
  assert.equal(r.total, 78);
  assert.equal(r.grade, 'A');
  assert.equal(r.result, 'pass');
});

test('Gradebook: failing the external minimum is F even with a passing total', () => {
  const r = computeStudent(comps, { 1: 40, 2: 20, 3: 35 }, 40); // internal 40 + external 21 = 61, but external 35% < 40%
  assert.equal(r.total, 61);
  assert.equal(r.grade, 'F');
  assert.match(r.reason, /below the 40% minimum/);
});

test('Gradebook: missing marks give an incomplete result, not a grade', () => {
  const r = computeStudent(comps, { 1: 30, 3: 80 });
  assert.equal(r.complete, false);
  assert.equal(r.grade, null);
  assert.equal(r.missing, 1);
});

test('Gradebook: boundaries of the 10-point scale', () => {
  assert.equal(letterFor(90).letter, 'O');
  assert.equal(letterFor(89.99).letter, 'A+');
  assert.equal(letterFor(40).letter, 'P');
  assert.equal(letterFor(39.99).letter, 'F');
});

test('Gradebook: weights must total 100', () => {
  assert.equal(validateComponents(comps).ok, true);
  const v = validateComponents([{ name: 'A', category: 'internal', weight: 30, max_marks: 10 }]);
  assert.equal(v.ok, false);
  assert.match(v.problems[0], /add up to 30/);
});
