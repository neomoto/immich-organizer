# Organizer implementation backlog

Updated: 2026-09-05. Public repository: https://github.com/neomoto/immich-organizer

## Agreed product

The organizer lives inside Immich web, uses the existing login, and keeps the official
mobile clients compatible. A small fork supplies UI/server integration; an internal
worker handles analysis. First user: the library owner, with owner isolation throughout.

GLM-5V is used for all reasoning. Analyze photos and sampled video frames, captions,
objects, activities, OCR, date clues, visual geolocation, and event groups. Corroborate
public places/events with web evidence. Automatic changes are enabled after a read-only
200-asset pilot. Preserve credible EXIF and manual edits. Keep imprecise dates as ranges;
approximate map pins are allowed and visibly labelled. Preserve source media and sharing.
Every change needs provenance, a journal, and conflict-aware undo. Default model budget:
5,000 requests/day, two concurrent requests. Source, tests, setup, and release images
must be published on the owner's GitHub.

## Baseline and validation

- [x] Public fork created; branch `organizer`, upstream base `v3.1.0` / `8aa95c6`.
- [x] Initial implementation published as `c033f18`; that commit's CI passed.
- [x] Local server and web compilation passed for the first implementation.
- [x] Initial 17 worker/policy/database tests passed with real PostgreSQL.
- [x] Isolated local runtime test exercised login, connection, analysis via a synthetic
  vision responder, caption/tag application, and caption undo.
- [ ] Revalidate the CURRENT working tree. It contains later uncommitted changes;
  previous passing results do not certify those changes.

## Work ownership

The lead coordinates, reviews, integrates, and publishes. Subagents write code.
All agents share one working tree; preserve existing edits. Do not commit independently.
Coordinate API/schema changes with the relevant owner before changing a shared contract.

### A — Analysis engine and evidence (analysis agent)

Owned files: `organizer/src/{engine,policy,vision,manifest}.mjs`,
`organizer/test/policy.test.mjs`, and new `organizer/test/analysis-*.test.mjs` files.

- [ ] A1: Audit and complete original-metadata/source-context extraction. Source manifests
  must retain Unicode paths, original EXIF, checksums, and duplicate source matches.
  Unsupported files must not abort a complete scan. Model output is never an original anchor.
- [ ] A2: Implement bounded multi-image event reasoning using relevant neighboring photos
  and independent anchors, not only unrelated folder metadata. Distinguish capture from
  depicted dates/places; do not propagate a guess as independent evidence.
- [ ] A3: Improve stable event grouping and date recovery. Split mixed-date folders;
  preserve trustworthy EXIF/manual values. Month/year estimates stay imprecise.
- [ ] A4: Complete geolocation evidence, bounded detail crops where useful, video-frame
  timestamps, and deterministic schema validation. Record web citations and precision.
- [ ] A5: Audit automatic writes and durable retries against backend contracts. Verify
  tags/albums are idempotent, delayed previews retry, storage failures pause application,
  budget is enforced, and concurrent edits cannot be overwritten by stale results.
- [ ] A6: Add meaningful synthetic tests for conflicting anchors, scans, screenshots,
  location precision, Unicode, prompt injection, bounded media processing, and retries.

Acceptance: executable analysis behavior, tested inference limits, no fabricated precision,
no destructive media actions, and a written report of any unfinished requirements.

### B — Worker API, authorization, persistence, and undo (backend agent)

Owned files: `organizer/src/{server,store}.mjs`, `organizer/test/database.test.mjs`,
new `organizer/test/backend-*.test.mjs` files, and the organizer controller/service in
`server/src/{controllers,services}/`, including registration edits if required.

- [ ] B1: Review all current worker/API code and remove correctness/security gaps.
  Reuse Immich sessions, enforce owner isolation, reject public-share access, and avoid
  orphaned provisioned keys or secrets in browser responses/logs.
- [ ] B2: Complete durable analysis runs, leases, revision checks, catch-up scheduling,
  and bounded pilot behavior. A 200-item pilot must never expand automatically to the
  whole library. Pause must stop acquiring new work, including queued discovery runs.
- [ ] B3: Complete resumable undo for metadata and managed memberships. Record undo intent
  before changing Immich; handle interrupted acknowledgments and newer manual edits.
  Restore absent GPS/description correctly and preserve sidecar/lock semantics.
- [ ] B4: Validate facts, locks, settings, source-manifest inputs, pagination, and API
  methods. Provide useful errors and typed server boundary contracts where practical.
- [ ] B5: Test actual database behavior: atomic daily quota, concurrent leases, ownership,
  restart recovery, pilot boundaries, current-revision writes, and interrupted undo.

Acceptance: current API compiles and lints, meaningful real-PostgreSQL tests pass, schema
changes are idempotent, and engine/UI owners receive any contract changes immediately.

### C — Integrated web experience (UI agent)

Owned files: `web/src/lib/components/organizer/`, `web/src/routes/(user)/organize/`,
organizer integration in `DetailPanel.svelte` and `UserSidebar.svelte`, and related new
UI tests. Coordinate worker/API additions through backend owner.

- [ ] C1: Finish responsive Organize views, progress/usage/failures, pause/resume, and
  safe connection/settings flows using the existing Immich login.
- [ ] C2: Finish asset details: evidence, date ranges, estimated map labels, OCR, model
  attribution, manual facts, field locks, and correction/undo affordances.
- [ ] C3: Support individual, selected, and album analysis. Search/filter rich metadata,
  paginate large libraries, and avoid stale request results or duplicate submissions.
- [ ] C4: Surface durable run progress and interrupted undo; provide source-manifest upload.
  Never show successful queuing when disconnected or an operation failed.
- [ ] C5: Add component tests for key behavior and accessibility; run Svelte and TypeScript
  checks and build. Do not call a screenshot or manual visual test complete if not performed.

Acceptance: native-feeling web integration, no separate dashboard/login, explicit uncertainty,
useful empty/error states, and passing relevant UI checks.

### D — Integration, packaging, and publication (lead coordinates; assign code to agent)

- [ ] D1: Integrate agent changes and run worker tests, backend checks/lint, web checks/build,
  and the isolated Immich runtime test on the final commit.
- [ ] D2: Review Docker/Compose and CI. Server release image overlays compiled JS/web
  artifacts onto the pinned upstream runtime; dependencies must stay compatible.
- [ ] D3: Add runtime test coverage to CI and verify final hosted results. Publish only
  synthetic fixtures and generic configuration. Inspect the staged diff for secrets.
- [ ] D4: Publish matching server/worker prerelease images and a GitHub prerelease with
  exact validation and remaining limitations. Verify artifacts exist and are pullable.
- [ ] D5: Update project setup and operational docs with final architecture, API, configuration,
  backup/restore, upgrade, and undo instructions. Keep implementation limits explicit.

### E — Live model pilot and rollout (external input pending)

- [ ] E1: Obtain the PRIVATE LOCAL FILE PATH for the user's Z.ai key and exact endpoint/model.
  A non-blocking question has already been sent. Do not request or print the key in chat.
- [ ] E2: Verify the actual GLM endpoint with a synthetic image; no silent billing fallback.
- [ ] E3: Run a 200-asset pilot with known controls and the archive's uncertain-date cases,
  with canonical metadata writes disabled. Measure results and quota usage.
- [ ] E4: Validate undo/sidecars and mobile compatibility on a separate deployment; then
  deploy the verified release and enable automatic processing as already authorized.

## Local test environment

- Worker unit/integration test DB: container `immich-organizer-test-db`, localhost port
  55439, database `organizer`; synthetic password `organizer-test-only`.
- Runtime Compose: `organizer/compose.test.yaml`, project `immich-organizer-runtime-test`,
  Immich at http://127.0.0.1:18283; only synthetic fixtures and a mock vision service.
- Commands: `npm test --prefix organizer`; set `TEST_DATABASE_URL` for PostgreSQL tests.
  `RUNTIME_URL=http://127.0.0.1:18283 node --test organizer/test/runtime.test.mjs` for runtime.
- Workspace uses pnpm 11.13.1. SDK/plugin SDK are built; dependencies installed.
- Production NAS is not running this fork. Do not alter production services during coding.
