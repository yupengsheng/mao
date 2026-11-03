# Task Execution Center Implementation Plan

**Goal:** Make the existing task records usable through the shared desktop/Web UI.

**Architecture:** Add public task VO contracts, map backend entities at the service boundary, and consume them in an isolated Vue composable and lazy routed view. Keep existing execution and storage semantics.

**Tech Stack:** TypeScript, Nest/Fastify, Vue 3, Vue Router, Vitest, existing CSS theme tokens.

**Spec:** `docs/plan/2026-11-03-task-execution-center-design.md`

## Constraints

- No new dependencies or database migrations.
- Keep existing Session/Harness execution behavior.
- Public unions come from @mao/contracts; use Record for exhaustive labels.
- Redirect test/build output into /tmp logs.
- Do not commit, deploy or change branches.

## Implementation

- [x] Add failing composable tests in `desktop/src/composables/useTaskRecords.test.ts` for stale responses, filters, pagination, errors and disposal. Verify with `npx vitest run src/composables/useTaskRecords.test.ts`.
- [x] Export AgentTaskVO/TaskExecutionVO/TaskTriggerVO/TaskPageVO/TaskDetailVO/TaskListQuery in `shared/contracts/src/task.ts`; map backend service responses and test the public projection.
- [x] Implement `desktop/src/api/task.ts` with `listTasks(query): Promise<TaskPageVO>` and `getTask(id): Promise<TaskDetailVO>`, plus `useTaskRecords()` with isolated list/detail sequence guards.
- [x] Build `ExecutionRecordsView.vue`, exhaustive labels, top navigation entry and lazy route. Add view tests for selection, failed execution, source labels and polling cleanup.
- [x] Sync README, CHANGELOG and mao-cli reference; run relevant backend tests, desktop tests/build and inspect the final diff.

## Interface examples

```ts
const { items, total, page, filters, detail, selectedId, loading, detailLoading,
  error, detailError, selectTask, changePage, refresh } = useTaskRecords()
filters.stage = 'FAILED'
await selectTask(7)
await changePage(2)
```

List responses are `{ items, total, page, size }`; details are `{ task, latestExecution, executions, triggers }`. No local persistent cache or inferred external event deduplication.

## Verification (2026-11-03)

- Backend task suite: 30 passed; full backend coverage suite: 5264 passed, 13 skipped (448 files passed, 1 skipped), exit 0. Logs: `/tmp/mao-task-vo-green.log`, `/tmp/mao-task-center-backend-tests.log`.
- Backend official build: exit 0 (`/tmp/mao-task-center-backend-build.log`).
- Desktop official build (`vue-tsc -b` and Vite): exit 0 (`/tmp/mao-task-center-desktop-build-final.log`).
- Desktop Vitest under Node v22.23.2: 1530 passed, 160 files passed, exit 0 (`/tmp/mao-task-center-desktop-node22.log`). The default npm runtime selected local Node v26.8.1 and failed an unchanged FileViewer test on its global localStorage implementation; the same isolated test passes on Node 22.
- Electron Node test suite: 188 passed, 1 skipped, exit 0 (`/tmp/mao-task-center-electron-final.log`). Run with Node 22, `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null TMPDIR=/private/tmp` to isolate the existing Git identity assumptions and macOS temporary-directory symlinks; no user Git configuration was changed.
- Browser review used a local fixture API: list, combined filters, selection reset, first-vs-current source, multiline failure display and narrow layouts checked. Fixed compressed narrow-screen list height and metadata alignment. No production API was accessed.
- `git diff --check` passed. No new migration beyond phase-one V179; database migration validation remains separate.
