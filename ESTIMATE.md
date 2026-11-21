# Estimate

**Before starting: 1 day (8 hours).**

| Phase | Estimate | Actual | Notes |
|---|---|---|---|
| System design (requirements, schema, indexes, API, trade-offs) | 2 h | Done the day before (2026-11-20), not timed | Written in Claude Docs; it is the spec the code follows. |
| Implementation (NestJS modules, SQL schema, write path, history, PRs, Docker) | 4 h | ~40 min | Claude Code wrote most of the code from the design doc. My time went into reading and steering it. |
| Tests, benchmarks, fixes | 1 h | ~1 h | Unit + e2e on real PostgreSQL. TDD rules and a mutation runner were added mid-way. The k6 benchmark found the ranged-PR planner issue, fixed test-first. |
| Docs (README, design-doc updates, AI workflow) | 1 h | ~45 min | README, benchmark results written back into the design doc, this file and `AI_WORKFLOW.md`. |
| **Total** | **8 h** | **~2.5 h + design** | |

**Why it took less time than estimated:** the design doc removed almost every open decision before any code was written. The AI could then implement each section directly, so the time went into reviewing and measuring rather than typing.

**What took longer than expected:** benchmarking.

- The first load test ran against a stale container, because `docker compose up --build` rebuilt the image but didn't recreate the container.
- Single runs on a busy laptop gave tail latencies that changed from run to run, so every scenario was run three times.
