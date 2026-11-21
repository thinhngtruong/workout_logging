# Workout Logging API: working rules

## Test-driven development (required)

No production code without a failing test first.

1. **Red:** write one test for one behavior. Run it and watch it fail for the expected reason (the feature is missing, not a typo or setup error).
2. **Green:** write the least code that makes it pass.
3. **Refactor:** clean up with the suite green.

- Bug fix: first write a test that reproduces the bug and fails, then fix it.
- Before calling work done, run the whole suite (`npm test`), not just the new test.
- A test that passes the first time it runs proves nothing. Break the code on purpose (`npm run test:mutants`) and confirm the test goes red.
- Where tests go:
  - Pure logic (units, dates, cursors): unit tests in `src/**/*.spec.ts`.
  - Anything that touches SQL, HTTP, concurrency or the query planner: `test/*.e2e-spec.ts`, run against real PostgreSQL through Testcontainers. Never mock the database.

## Commands

Use Node 22 (`.nvmrc`). Docker must be running for e2e tests.

| Command | What it does |
|---|---|
| `npm run test:unit` | Unit tests, fast, no Docker |
| `npm run test:e2e` | API tests on a PostgreSQL 16 container |
| `npm test` | Everything |
| `npm run test:mutants` | Breaks key behaviors one at a time; each must turn a test red |
| `npm run typecheck` | `tsc --noEmit` |
