'use strict';
// Feature 3 — Academic gradebook.
//
// A course has components (e.g. "Mid-sem exam", "Assignments", "End-sem exam"),
// each tagged INTERNAL or EXTERNAL, with a weight (% of the final 100) and its own
// maximum marks. Weights must total 100.
//
//   contribution = (marks / max_marks) * weight
//   internal     = Σ contributions of internal components    (out of internal weight)
//   external     = Σ contributions of external components    (out of external weight)
//   total        = internal + external                        (out of 100)
//
// Pass rule: total >= 40 AND external >= min_external_pct % of the external weight
// (default 40%). A student who fails the external minimum gets F whatever the total.
// Grades follow the common 10-point scale used by Indian universities (UGC CBCS style).

const SCALE = [
  { min: 90, letter: 'O',  points: 10, label: 'Outstanding' },
  { min: 80, letter: 'A+', points: 9,  label: 'Excellent' },
  { min: 70, letter: 'A',  points: 8,  label: 'Very good' },
  { min: 60, letter: 'B+', points: 7,  label: 'Good' },
  { min: 50, letter: 'B',  points: 6,  label: 'Above average' },
  { min: 45, letter: 'C',  points: 5,  label: 'Average' },
  { min: 40, letter: 'P',  points: 4,  label: 'Pass' },
  { min: 0,  letter: 'F',  points: 0,  label: 'Fail' },
];

const round2 = n => Math.round(n * 100) / 100;

function letterFor(total) {
  return SCALE.find(s => total >= s.min - 1e-9);
}

function validateComponents(components) {
  const problems = [];
  const sum = components.reduce((a, c) => a + Number(c.weight || 0), 0);
  if (!components.length) problems.push('Add at least one component.');
  else if (Math.abs(sum - 100) > 0.001) problems.push(`Weights add up to ${round2(sum)}, they must add up to 100.`);
  const names = new Set();
  for (const c of components) {
    if (!String(c.name || '').trim()) problems.push('Every component needs a name.');
    if (names.has(String(c.name).trim().toLowerCase())) problems.push(`Two components are called "${c.name}".`);
    names.add(String(c.name).trim().toLowerCase());
    if (!(Number(c.max_marks) > 0)) problems.push(`"${c.name}" needs maximum marks above 0.`);
    if (!(Number(c.weight) >= 0)) problems.push(`"${c.name}" needs a weight of 0 or more.`);
    if (!['internal', 'external'].includes(c.category)) problems.push(`"${c.name}" must be internal or external.`);
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)], weightSum: round2(sum) };
}

// marksByComponent: { [componentId]: number | undefined }
function computeStudent(components, marksByComponent, minExternalPct = 40) {
  let internal = 0, external = 0, internalWeight = 0, externalWeight = 0, missing = 0;
  const parts = components.map(c => {
    const m = marksByComponent[c.id];
    const has = m !== undefined && m !== null && m !== '';
    if (c.category === 'internal') internalWeight += c.weight; else externalWeight += c.weight;
    if (!has) { missing++; return { component_id: c.id, marks: null, contribution: null }; }
    const contribution = (Number(m) / c.max_marks) * c.weight;
    if (c.category === 'internal') internal += contribution; else external += contribution;
    return { component_id: c.id, marks: Number(m), contribution: round2(contribution) };
  });
  const total = internal + external;
  const complete = missing === 0 && components.length > 0;
  const externalPct = externalWeight > 0 ? (external / externalWeight) * 100 : 100;
  let grade = null, result = 'incomplete', reason = null;
  if (complete) {
    const failsExternal = externalWeight > 0 && externalPct + 1e-9 < minExternalPct;
    if (failsExternal) {
      grade = SCALE[SCALE.length - 1];
      reason = `External score ${round2(externalPct)}% is below the ${minExternalPct}% minimum`;
    } else {
      grade = letterFor(total);
    }
    result = grade.letter === 'F' ? 'fail' : 'pass';
  }
  return {
    parts,
    internal: round2(internal), internalWeight: round2(internalWeight),
    external: round2(external), externalWeight: round2(externalWeight),
    total: round2(total),
    missing,
    complete,
    result,
    grade: grade ? grade.letter : null,
    gradePoints: grade ? grade.points : null,
    reason,
  };
}

module.exports = { SCALE, letterFor, validateComponents, computeStudent, round2 };
