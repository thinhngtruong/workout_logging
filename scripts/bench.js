// k6 load test for the design's benchmark scenarios. Needs scripts/seed-bench.sql loaded first.
// Run: k6 run scripts/bench.js   (BASE_URL defaults to http://localhost:3000)
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const ok = (r) => check(r, { 'status 2xx': (x) => x.status >= 200 && x.status < 300 });

const scenario = (exec, rate) => ({
  executor: 'constant-arrival-rate', exec, rate, timeUnit: '1s', duration: '30s', preAllocatedVUs: 50, maxVUs: 200,
});

// Each scenario has its own target, so run one at a time: k6 run -e SCENARIO=history scripts/bench.js
const all = {
  history: scenario('history', 200),
  allTimePr: scenario('allTimePr', 100),
  comparePr: scenario('comparePr', 100),
  bulkLog: scenario('bulkLog', 50),
};
const only = __ENV.SCENARIO;
const scenarios = {};
Object.keys(all).forEach((k) => { if (!only || k === only) scenarios[k] = all[k]; });

export const options = {
  scenarios,
  thresholds: {
    'http_req_duration{scenario:history}': ['p(99)<200'],
    'http_req_duration{scenario:allTimePr}': ['p(99)<50'],
    'http_req_duration{scenario:comparePr}': ['p(99)<100'],
    'http_req_duration{scenario:bulkLog}': ['p(99)<300'],
    http_req_failed: ['rate<0.001'],
  },
};

// Cursors for page 1 and ~page 500, fetched once.
export function setup() {
  let cursor = null;
  const deep = [];
  for (let page = 1; page <= 500; page++) {
    const r = http.get(`${BASE}/users/bench-spread/workouts?limit=20${cursor ? `&cursor=${cursor}` : ''}`).json();
    cursor = r.page.nextCursor;
    if (page >= 495) deep.push(cursor);
  }
  return { deep };
}

export function history(data) {
  const deep = Math.random() < 0.5;
  const cursor = deep ? `&cursor=${data.deep[Math.floor(Math.random() * data.deep.length)]}` : '';
  ok(http.get(`${BASE}/users/bench-spread/workouts?limit=20&unit=lb${cursor}`, { tags: { name: deep ? 'history-deep' : 'history-page1' } }));
}

export function allTimePr() {
  ok(http.get(`${BASE}/users/bench-single/personal-records?exercise=Bench%20Press`));
}

export function comparePr() {
  ok(http.get(`${BASE}/users/bench-single/personal-records/compare?exercise=Bench%20Press&currentFrom=2026-11-01&currentTo=2026-11-30&previousFrom=2026-10-01&previousTo=2026-10-31`));
}

const exercises = ['Bench Press', 'Back Squat', 'Deadlift', 'Overhead Press', 'Barbell Row'];
export function bulkLog() {
  const entries = Array.from({ length: 50 }, (_, i) => ({
    exerciseName: exercises[i % exercises.length],
    date: '2026-11-21',
    sets: Array.from({ length: 5 }, (_, s) => ({ reps: 5, weight: 60 + s * 5, unit: s % 2 ? 'lb' : 'kg' })),
  }));
  ok(http.post(`${BASE}/users/bench-writer-${__VU}/workouts`, JSON.stringify({ entries }), { headers: { 'Content-Type': 'application/json' } }));
}
