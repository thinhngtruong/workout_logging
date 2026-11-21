#!/usr/bin/env node
// Proves the tests can fail: each mutant breaks one behavior, and the named tests must go red.
// A mutant that survives means that behavior is untested. Usage: npm run test:mutants [-- <name filter>]
const { readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

const MUTANTS = [
  {
    name: 'lb factor drifts',
    file: 'src/units/unit-registry.ts',
    find: "kgPerUnit: '0.45359237'",
    replace: "kgPerUnit: '0.4536'",
    tests: ['src/units'],
  },
  {
    name: '"today" ignores the client time zone',
    file: 'src/common/dates.ts',
    find: "{ timeZone, year: 'numeric'",
    replace: "{ timeZone: 'UTC', year: 'numeric'",
    tests: ['src/common/dates'],
  },
  {
    name: 'weeks start on Sunday',
    file: 'src/common/dates.ts',
    find: '(toUtc(today).getUTCDay() + 6) % 7',
    replace: 'toUtc(today).getUTCDay()',
    tests: ['src/common/dates'],
  },
  {
    name: 'cursor not bound to its filters',
    file: 'src/common/cursor.ts',
    find: 'if (parsed.f !== filterHash(filters))',
    replace: 'if (false)',
    tests: ['src/common/cursor', 'test', '-t', 'cursor reused'],
  },
  {
    name: 'keyset includes the last row of the previous page',
    file: 'src/workouts/history.service.ts',
    find: '(performed_on, id) < (',
    replace: '(performed_on, id) <= (',
    tests: ['test', '-t', 'pages through history'],
  },
  {
    name: 'PR ties go to the latest date',
    file: 'src/records/records.service.ts',
    find: 'maxWeight: sql`weight_kg DESC, reps DESC, performed_on, id`',
    replace: 'maxWeight: sql`weight_kg DESC, reps DESC, performed_on DESC, id`',
    tests: ['test', '-t', 'breaks ties'],
  },
  {
    name: 'bodyweight sets count as PRs',
    file: 'src/records/records.service.ts',
    find: 'AND weight_kg > 0`',
    replace: '`',
    tests: ['test', '-t', 'personal-records'],
  },
  {
    name: 'Epley divisor wrong',
    file: 'migrations/001_init.sql',
    find: 'reps::numeric / 30',
    replace: 'reps::numeric / 40',
    tests: ['test', '-t', 'Epley'],
  },
  {
    name: 'idempotency key ignored',
    file: 'src/workouts/workouts.service.ts',
    find: '      if (idempotencyKey) {\n        // Insert, or take over',
    replace: '      if (false as boolean) {\n        // Insert, or take over',
    tests: ['test', '-t', 'Idempotency-Key'],
  },
  {
    name: 'idempotency key reused with another body is replayed',
    file: 'src/workouts/workouts.service.ts',
    find: 'if (stored.request_hash !== requestHash)',
    replace: 'if (false)',
    tests: ['test', '-t', 'replays a retried request'],
  },
  {
    name: 'custom exercise not re-read after a conflicting insert',
    file: 'src/exercises/exercise-catalog.ts',
    find: '        .execute();\n      collect(await lookup());',
    replace: '        .execute();',
    tests: ['test', '-t', 'logs the same exercise concurrently'],
  },
  {
    name: 'negative weight accepted',
    file: 'src/workouts/workouts.schemas.ts',
    find: ".min(0, 'weight must not be negative')",
    replace: '',
    tests: ['test', '-t', 'reports every validation error'],
  },
  {
    name: 'ranged PRs walk the per-metric index (performance regression)',
    file: 'src/records/records.service.ts',
    find: 'if (r.from || r.to) {',
    // the pre-fix query: same rows, filtered inline, so the planner may walk the per-metric index
    replace: 'if (r.from || r.to) { source = sql`workout_sets WHERE ${scope} AND performed_on BETWEEN ${r.from ?? "-infinity"}::date AND ${r.to ?? "infinity"}::date`; } if (false as boolean) {',
    tests: ['test', '-t', 'compares one month vs the previous'],
  },
];

const filter = process.argv[2];
const survivors = [];
for (const m of MUTANTS.filter((x) => !filter || x.name.includes(filter))) {
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.find)) {
    survivors.push(`${m.name} (pattern not found: update the mutant)`);
    continue;
  }
  writeFileSync(m.file, original.replace(m.find, m.replace));
  try {
    const run = spawnSync('npx', ['jest', '--runInBand', ...m.tests], { encoding: 'utf8' });
    const killed = run.status !== 0 && /Tests:.*\d+ failed/.test(run.stderr);
    console.log(`${killed ? 'killed  ' : 'SURVIVED'}  ${m.name}`);
    if (!killed) survivors.push(m.name);
  } finally {
    writeFileSync(m.file, original);
  }
}
if (survivors.length) {
  console.error(`\n${survivors.length} mutant(s) survived, so these behaviors are untested:\n- ${survivors.join('\n- ')}`);
  process.exit(1);
}
console.log('\nAll mutants killed.');
