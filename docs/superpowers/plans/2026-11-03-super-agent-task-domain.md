# Super-agent Task Domain Implementation Plan

**Scope:** Phase 1 execution tracking on the existing Session/Harness lifecycle; one Task per Session. No new LLM runtime, frontend, cross-channel routing or autonomous scheduling.

**Design:** `docs/plan/2026-11-03-super-agent-task-domain-technical-design.md`

## Implementation checklist

- [x] Export TaskStage/TaskSource from `shared/contracts/src/task.ts`.
- [x] Add V179 migration for task, trigger and execution tables; unique Session and execution keys.
- [x] Implement transaction-scoped TaskRepository and TaskService with owned Session row locks.
- [x] Register current-user list/detail routes with strict pagination and JWT-only access.
- [x] Bridge existing execution begin/terminal paths, preserving existing execution on storage failure.
- [x] Preserve per-execution source, duplicate terminal idempotency and known old-execution settlement ordering.
- [x] Add service, repository, route and terminal bridge tests.
- [x] Add `mao task list/get`, CLI reference, README and CHANGELOG.

## Validation

Backend focused tests and build, followed by the existing backend test suite with coverage. CLI validation uses local stub HTTP responses and argument checks. Redirect test/build output to `/tmp` and inspect exit status and summaries.

Verified on 2026-11-03:

- Backend build: exit 0 (`/tmp/mao-task-build-final.log`).
- Full backend suite with coverage: 448 files passed, 1 skipped; 5263 tests passed, 13 skipped; exit 0 (`/tmp/mao-task-full-final.log`).
- Task-focused suite: 29 tests passed (`/tmp/mao-task-focused-final.log`).
- CLI local HTTP smoke: list filters, JWT header, detail, help and missing ID passed; Node syntax check passed.
- Existing Flyway discovery: 179 unique versions, latest V179 with three new tables.
- `git diff --check`: passed.

Real MySQL migration and concurrency validation require a test database and remain a deployment prerequisite. No production migration, deployment or historical backfill is part of this change.
