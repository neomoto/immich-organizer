# Organizer implementation backlog

Updated: 2026-09-05. Public repository: https://github.com/neomoto/immich-organizer

## Agreed product

The organizer lives inside Immich web, uses the existing login, and keeps the official
mobile clients compatible. A small fork supplies UI/server integration; an internal
worker handles analysis. First user: the library owner, with owner isolation throughout.

The direct standard-API mode uses GLM-5V-compatible vision. The recommended shared-admin
Z.AI Coding Plan mode uses GLM-5.3 for text/tool reasoning and the bundled Z.AI Vision
MCP for image/video analysis. Analyze photos and sampled video frames, captions,
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
- [x] Expanded organizer baseline runtime: eight checks passed after fixing v3 album
  membership APIs and XMP null-tag deletion, including pilot boundaries, approximate
  GPS, managed memberships, lost-ack undo recovery, pause, and access restrictions.
- [x] Organizer UI: 12 component tests, TypeScript, Svelte, targeted lint, and production
  build passed before adding the Keeper UI.
- [x] Revalidate the combined implementation locally and publish the matching source.
  Branch and tagged hosted validation are recorded below.

Latest integration checkpoint: current worker tests passed 58 cases (runtime excluded),
UI passed 15 component tests plus TypeScript/Svelte/build, native metadata unit tests
and four real ExifTool tests passed. Coding Plan provider tests pass with synthetic HTTP
and stdio MCP fixtures. The rebuilt isolated runtime passed nine checks,
including Keeper tool calls/image hydration/session controls and organizer undo/access.
Branch CI run `33994238629` succeeded. Tagged CI run `33994243613` succeeded with
the full worker/server/UI tests, builds, isolated runtime, and both image builds.
Public prerelease `organizer-v0.1.0-alpha.2` is published. The release includes
`SHA256SUMS`, a server archive of 882632113 bytes with digest
`sha256:cef90ae5526fdf052c1acae5269e49e690acd017c47204a5ccd09cc16103a438`, and a
worker archive of 299340524 bytes with digest
`sha256:bf6700d80bddd3799036aada54dfd0fe4767bec9bad92fa5c5be1578600a440e`.
Both gzip archives were tested, loaded into Docker, and verified as linux/amd64 with
commit `88260e1` labels. Anonymous GHCR manifest requests for both public images
returned HTTP 200.

Provider validation boundary: a private live smoke authenticated the Coding Plan text
endpoint and local MCP with the configured administrator-owned key, using only a public
synthetic logo. No key value is stored here. The smoke does not cover private-photo
quality, the authorized 200-asset pilot, or a production deployment.

Alpha3 remediation: `visibility=hidden` Live Photo companions are excluded before inventory
and analysis. Worker startup removes legacy hidden rows from the derived `assets` table only;
it preserves media, journals, events, owners, and source manifests. Timeline and archive assets
remain eligible. The read-only pilot must be rerun after this reconciliation.

Alpha3 was tagged but not released: tagged CI run `34002928561` passed the worker, database,
server, and build checks, then exposed a race in the isolated runtime assertion. The assertion
could accept the prior analyzed revision immediately after a reanalysis run was queued. Alpha4
waits for a changed analysis result marker and settled canonical metadata, tags, and album state.

## Work ownership

The lead coordinates, reviews, integrates, and publishes. Subagents write code.
All agents share one working tree; preserve existing edits. Do not commit independently.
Coordinate API/schema changes with the relevant owner before changing a shared contract.

### A — Analysis engine and evidence (analysis agent)

Owned files: `organizer/src/{engine,policy,vision,manifest}.mjs`,
`organizer/test/policy.test.mjs`, and new `organizer/test/analysis-*.test.mjs` files.

- [x] A1: Audit and complete original-metadata/source-context extraction. Source manifests
  must retain Unicode paths, original EXIF, checksums, and duplicate source matches.
  Unsupported files must not abort a complete scan. Model output is never an original anchor.
- [x] A2: Implement bounded multi-image event reasoning using relevant neighboring photos
  and independent anchors, not only unrelated folder metadata. Distinguish capture from
  depicted dates/places; do not propagate a guess as independent evidence.
- [x] A3: Improve stable event grouping and date recovery. Split mixed-date folders;
  preserve trustworthy EXIF/manual values. Month/year estimates stay imprecise.
- [x] A4: Complete geolocation evidence, bounded detail crops where useful, video-frame
  timestamps, and deterministic schema validation. Record web citations and precision.
- [x] A5: Audit automatic writes and durable retries against backend contracts. Verify
  tags/albums are idempotent, delayed previews retry, storage failures pause application,
  budget is enforced, and concurrent edits cannot be overwritten by stale results.
- [x] A6: Add meaningful synthetic tests for conflicting anchors, scans, screenshots,
  location precision, Unicode, prompt injection, bounded media processing, and retries.

Acceptance: executable analysis behavior, tested inference limits, no fabricated precision,
no destructive media actions, and a written report of any unfinished requirements.

### B — Worker API, authorization, persistence, and undo (backend agent)

Owned files: `organizer/src/{server,store}.mjs`, `organizer/test/database.test.mjs`,
new `organizer/test/backend-*.test.mjs` files, and the organizer controller/service in
`server/src/{controllers,services}/`, including registration edits if required.

- [x] B1: Review all current worker/API code and remove correctness/security gaps.
  Reuse Immich sessions, enforce owner isolation, reject public-share access, and avoid
  orphaned provisioned keys or secrets in browser responses/logs.
- [x] B2: Complete durable analysis runs, leases, revision checks, catch-up scheduling,
  and bounded pilot behavior. A 200-item pilot must never expand automatically to the
  whole library. Pause must stop acquiring new work, including queued discovery runs.
- [x] B3: Complete resumable undo for metadata and managed memberships. Record undo intent
  before changing Immich; handle interrupted acknowledgments and newer manual edits.
  Restore absent GPS/description correctly and preserve sidecar/lock semantics.
- [x] B4: Validate facts, locks, settings, source-manifest inputs, pagination, and API
  methods. Provide useful errors and typed server boundary contracts where practical.
- [x] B5: Test actual database behavior: atomic daily quota, concurrent leases, ownership,
  restart recovery, pilot boundaries, current-revision writes, and interrupted undo.

Acceptance: current API compiles and lints, meaningful real-PostgreSQL tests pass, schema
changes are idempotent, and engine/UI owners receive any contract changes immediately.

### C — Integrated web experience (UI agent)

Owned files: `web/src/lib/components/organizer/`, `web/src/routes/(user)/organize/`,
organizer integration in `DetailPanel.svelte` and `UserSidebar.svelte`, and related new
UI tests. Coordinate worker/API additions through backend owner.

- [x] C1: Finish responsive Organize views, progress/usage/failures, pause/resume, and
  safe connection/settings flows using the existing Immich login.
- [x] C2: Finish asset details: evidence, date ranges, estimated map labels, OCR, model
  attribution, manual facts, field locks, and correction/undo affordances.
- [x] C3: Support individual, selected, and album analysis. Search/filter rich metadata,
  paginate large libraries, and avoid stale request results or duplicate submissions.
- [x] C4: Surface durable run progress and interrupted undo; provide source-manifest upload.
  Never show successful queuing when disconnected or an operation failed.
- [x] C5: Add component tests for key behavior and accessibility; run Svelte and TypeScript
  checks and build. Do not call a screenshot or manual visual test complete if not performed.

Acceptance: native-feeling web integration, no separate dashboard/login, explicit uncertainty,
useful empty/error states, and passing relevant UI checks.

### D — Integration, packaging, and publication (lead coordinates; assign code to agent)

- [x] D1: Integrate agent changes and run worker tests, backend checks/lint, web checks/build,
  and the isolated Immich runtime test on the final commit.
- [x] D2: Review Docker/Compose and CI. Server release image overlays compiled JS/web
  artifacts onto the pinned upstream runtime; dependencies must stay compatible.
- [x] D3: Add runtime test coverage to CI and verify final hosted results. Publish only
  synthetic fixtures and generic configuration. Inspect the staged diff for secrets.
- [x] D4: Publish matching server/worker prerelease images and a GitHub prerelease with
  exact validation and remaining limitations. Verify artifacts exist and are pullable.
- [x] D5: Update project setup and operational docs with final architecture, API, configuration,
  backup/restore, upgrade, and undo instructions. Keep implementation limits explicit.

### E — Live model pilot and rollout (external input pending)

- [x] E1: Obtain the provider configuration through the private local secret handoff.
  Never request, print, commit, or expose the key in chat or browser responses.
- [x] E2: Verify the Coding Plan text endpoint and bundled Vision MCP with the public
  synthetic Immich logo; no silent billing fallback.
- [ ] E3: Run a 200-asset pilot with known controls and the archive's uncertain-date cases,
  with canonical metadata writes disabled. Measure results and quota usage.
- [ ] E4: Validate undo/sidecars and mobile compatibility on a separate deployment; then
  deploy the verified release and enable automatic processing as already authorized.

## F — Embedded photo keeper (user-approved addition)

The user requested a pi-style harness inside Immich, with BOTH persistent chat and
scheduled autonomous library housekeeping. This extends the accepted organizer plan.
The lead coordinates; agents implement the harness, tools, and UI.

Latest clarification: pi is inspiration, not a required dependency. Keep the harness
small, minimal, and extensible. Long tasks must continue in the background after the
browser closes and resume after worker restart or quota waits. Bound individual
execution slices and tool operations, not the overall task's wall-clock duration.
Use Luna with max reasoning for all subagents from this point onward.

- [x] F1 — Backend: implement a minimal provider adapter and explicit extensible tool
  registry/loop inspired by pi, persistent sessions and run/event
  history, resumable execution, context management, cancellation, and bounded tool calls.
- [x] F2 — Analysis: expose owner-scoped photo tools for library search, inspecting images
  and original metadata, related-photo evidence, bounded web lookup, analysis runs,
  supported metadata/album operations, and undo. No general shell/filesystem tools.
- [x] F3 — UI: add a Keeper chat view inside Organize, session history, incremental replies,
  tool activity/evidence, stop/retry, and schedule controls with housekeeping reports.
- [x] F4 — Backend: daily autonomous schedule (default 03:00 NAS-local time), shared model
  quota/concurrency, no overlapping runs, missed-run coalescing, and persisted outcomes.
  Use bounded checkpoint slices with durable continuation; scheduled operations preserve
  originals and existing sharing. Overall tasks may run for hours or days.
- [x] F5 — All: test permission boundaries, model/tool failures, cancellation, restart
  recovery, duplicate scheduling, budget exhaustion, evidence integrity, and undo.

Provider release note: `AI_PROVIDER=zai-coding-plan` is the shared-admin BYOK path. The
worker sends text/tool turns to the Coding Plan endpoint with GLM-5.3 and sends bounded
vision files to the pinned local `@z_ai/mcp-server@0.1.5` over stdio. `VISION_API_KEY`
remains a compatibility alias; family accounts never receive provider credentials.
Direct standard API mode remains available. Provider failures, missing keys, and MCP
timeouts are surfaced without returning secrets. Real-provider billing, key handoff,
and photo-quality validation remain in E3-E4.

The live smoke returned HTTP 200 for Coding Plan `glm-5.3` text, rejected direct image
content at that endpoint, and confirmed the general standard vision endpoint had no
available balance. The official Vision MCP and the project's adapter produced a fully
schema-valid observation for a public synthetic Immich logo and cleaned its temporary
media directory. This does not certify private-photo quality, a 200-asset pilot, or
production deployment.

## Local test environment

- Worker unit/integration test DB: container `immich-organizer-test-db`, localhost port
  55439, database `organizer`; synthetic password `organizer-test-only`.
- Runtime Compose: `organizer/compose.test.yaml`, project `immich-organizer-runtime-test`,
  Immich at http://127.0.0.1:18283; only synthetic fixtures and a mock vision service.
- Commands: `npm test --prefix organizer`; set `TEST_DATABASE_URL` for PostgreSQL tests.
  `RUNTIME_URL=http://127.0.0.1:18283 node --test organizer/test/runtime.test.mjs` for runtime.
- Workspace uses pnpm 11.13.1. SDK/plugin SDK are built; dependencies installed.
- Production NAS is not running this fork. Do not alter production services during coding.
