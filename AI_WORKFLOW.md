# AI workflow

## Tools and what each was used for

| Tool | Used for |
|---|---|
| **Claude Docs** | The system design ([design doc](https://claude.ai/artifact/Sv5FXFkDRrr7cPFWx52p7z)): requirements, schema, indexes, API, trade-offs. Written before any code, and updated afterwards with measured benchmarks and the query fix. |
| **Claude Code** (Claude Opus) | Implementation from the design doc, tests, debugging, benchmarks (k6, `EXPLAIN ANALYZE`), README. |
| **Testcontainers, k6, a mutation runner** | Checking the AI's output against reality rather than trusting it: a real PostgreSQL for e2e tests, load tests for the performance claims, deliberately broken code to prove the tests can fail. |

## Prompting strategy

- **Full context first.** I gave the agent two inputs: the assignment PDF and my own design doc. The design doc made the decisions: database, schema, indexes, idempotency, time zones, error format. The AI implemented a spec; it didn't pick the architecture.
- **One goal, then steering.** I started with "implement the solution based on the design", then corrected course mid-task instead of front-loading everything. For example, I said "apply TDD to this repo" while it was still benchmarking.
- **Rules files, not repeated instructions.**
  - A global `CLAUDE.md` rule: never add the AI as author or co-author of commits.
  - A repo `CLAUDE.md` (with `AGENTS.md` linked to it): test-first, watch every test fail before making it pass, run the whole suite, never mock the database. Any AI tool working here follows it.
- **Ask for verification, not reassurance.** I asked "are all requirements in the problem solved?" and got back a gap list (missing deliverables, doc–code mismatches), not a yes.

## Where AI output was wrong or suboptimal

**1. A performance bug, implemented exactly as the design specified.**
The design's PR query added `AND performed_on BETWEEN …` to each metric's `ORDER BY … LIMIT 1` read. The AI implemented it as written and the tests passed. The k6 benchmark then showed the month-vs-month comparison at 100–340 ms per call. `EXPLAIN ANALYZE` showed PostgreSQL walking the per-metric index and dropping every row outside the date range, instead of using the range index.
*Fix:* scan the range once into a `MATERIALIZED` CTE, then pick the three winners from it. That brought it from 122 ms to 1.5 ms. The design doc was updated to match.

**2. A regression test that could not fail.**
I asked for that fix to be test-first. The AI's first performance test **passed against the old, slow code**. Its seed data spread heavy lifts evenly over 45 years, so the slow index walk found a match almost at once.
This was only caught because the TDD rule requires watching the test go red first. The seed was rewritten to model the real slow case: a client coming back from injury, whose recent lifts are all light. The test then failed at 95 ms on the old code and passed on the fix.

**3. A mutant that broke the code the wrong way.**
The mutation runner breaks one behavior at a time and checks a test goes red. One mutant meant to bring back the slow query instead dropped the date filter entirely. The resulting code was fast but returned wrong results, so the performance test passed and the mutant "survived" for the wrong reason. I spotted this from the survivor report and corrected the mutant. The same run found a real gap: removing the "ignore bodyweight sets" rule broke no test. A test for it was added.

**4. Dependencies that broke the test runner.**
The AI installed the latest `kysely` and `uuid`, which are ESM-only and fail under Jest's CommonJS mode. Both were pinned to versions that ship CommonJS (`kysely@0.27`, `uuid@11`).

**5. Smaller issues found by checking rather than reading.**
- A custom log serializer dropped the request id from every log line. It was found during a smoke test of the running container.
- The first load test measured a stale container, because `docker compose up --build` rebuilt the image but didn't recreate the container. It was caught when the Postgres slow-query log showed the old SQL.
- A single benchmark run was presented as the result. Tail latency on a busy laptop changed a lot between runs (p99 13–286 ms for the same query), so every scenario was run three times and reported as a range.

## A suggestion I rejected

**AI attribution in git history.** By default the agent ended commit messages with a `Co-Authored-By: Claude` line. GitHub then listed "claude" as a contributor on this repo. I rejected that:

- the first commit was rewritten and force-pushed;
- a global rule now forbids AI author or co-author lines in any repo.

I'm responsible for every line I submit, whoever typed it first.

## How I checked AI-generated code

- **e2e tests against a real PostgreSQL 16** (Testcontainers), never a mocked database. Concurrency claims are tested directly: 20 parallel requests sharing one idempotency key produce exactly one write.
- **`npm run test:mutants`** breaks 13 behaviors on purpose: the Epley divisor, the tie-break order, keyset `<` vs `<=`, idempotency, cursor binding, the time zone, the planner fix. It fails if any break survives the tests.
- **`EXPLAIN ANALYZE` and k6** for every performance claim. The numbers in the README and design doc are measured, including the targets that were missed.
