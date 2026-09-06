# Immich Organize

Organize appears inside Immich's sidebar and photo details. It uses a private worker
and a separate PostgreSQL database. There is no additional user-facing port or login.

## Current implementation

- GLM/OpenAI-compatible vision descriptions, tags, OCR, date ranges, and location candidates.
- Photo previews, detail crops, and up to eight frames per video. No audio transcription.
- Optional Wikipedia corroboration with evidence links.
- Automatic private event albums, AI-prefixed tags, empty descriptions, and supported date/GPS corrections.
- Explicit approximate places and dates, field locks, manual facts, and undo history.
- A durable PostgreSQL queue, encrypted Immich credentials, two concurrent requests,
  and an atomic daily request limit (5,000 by default).
- An embedded Keeper with persistent sessions, visible tool activity, resumable
  background runs, and optional daily housekeeping at 03:00 in the NAS timezone.
- A shared-admin Z.AI Coding Plan mode. Keeper text uses `glm-5.3` at the Coding
  Plan endpoint; vision uses the bundled `@z_ai/mcp-server` 0.1.5 over stdio.
- Pilot mode does not apply metadata changes or discover the whole archive automatically.

The code requires live validation with the configured vision endpoint and a separate
Immich deployment before use on an irreplaceable archive. A passing filesystem check
does not replace a backup. Back up both Immich and the organizer database before upgrades.

This prerelease is `0.1.0-alpha.3`. Live GLM quality, production rollout, and physical
mobile compatibility checks remain incomplete. Local synthetic tests do not measure model quality.

Immich Live Photo companion assets with `visibility=hidden` are not eligible Organizer items.
They are excluded from inventory, provider/media analysis, and standalone Organizer results;
timeline and archive assets remain eligible. At worker startup, alpha3 removes legacy hidden
rows from the derived Organizer `assets` table only. It does not mutate Immich media, originals,
changes/history, events, owners, or source manifests, and it does not generate thumbnails.

Neighbor reasoning requires source groups from a manifest. Event identifiers include the
normalized scene label and place evidence. Distinct scenes or places can split events within one folder and day.
Equivalent event descriptions can still create separate groups because semantic alias reconciliation is incomplete.

Detail crops use original images up to 32 MiB and 60 megapixels, with timeouts.
Oversize, unavailable, or unsupported originals use a labelled preview fallback with less detail.
Video timestamps are approximate. Web corroboration currently uses Wikipedia only.

## Install for a pilot

1. Prepare a separate Immich v3.1.0 deployment using its standard release Compose file.
2. Add `organizer/compose.yaml` as a Compose override. Use a released organizer server
   image and matching worker version, or build both images from the same commit.
   Release jobs also attach Linux amd64 `organizer-image-server.tar.gz` and
   `organizer-image-worker.tar.gz` files. Download the matching pair from the GitHub
   release when you prefer an offline install and run `docker load < organizer-image-worker.tar.gz`
   and `docker load < organizer-image-server.tar.gz` before starting Compose. The archives
   carry the same source, revision, and version labels.
3. Copy `.env.example` into the private deployment environment. Generate independent
   random values for `ORGANIZER_SECRET` and `ORGANIZER_DB_PASSWORD`.
   Use at least 32 characters for the organizer secret. Passwords in the database URL must be URL-safe.
4. Recommended: use shared-admin Z.AI Coding Plan BYOK. Set
   `AI_PROVIDER=zai-coding-plan` and set `Z_AI_API_KEY` once in the private worker
   environment. Keeper text defaults to `KEEPER_BASE_URL=https://api.z.ai/api/coding/paas/v4`
   and `KEEPER_MODEL=glm-5.3`. The bundled `zai-mcp-server` binary handles bounded
   vision calls; it is installed in the worker image and never downloaded at runtime.
   Family accounts do not set, view, or receive this administrator-owned key.
5. Direct standard-API mode remains available for a metered balance. Set
   `AI_PROVIDER=direct`, `VISION_BASE_URL=https://api.z.ai/api/paas/v4`,
   `VISION_MODEL=glm-5v-turbo`, and `VISION_API_KEY`. Keep this endpoint separate
   from `KEEPER_BASE_URL`: the Coding Plan text endpoint rejects image message content.
   `VISION_API_KEY` is accepted only as a backwards-compatible key alias for Coding
   Plan mode when `Z_AI_API_KEY` is absent.
6. Merge and inspect the configuration:

   ```sh
   docker compose --env-file /private/path/deployment.env \
     -f /path/to/immich/docker-compose.yml -f organizer/compose.yaml config --quiet
   ```

7. Start that deployment, log into Immich, and open **Organize → Connect Organize**.
   The server provisions a restricted worker API key for that account. No key is
   returned to the browser. The key can be revoked from Immich's API Keys settings.
8. Run **Analyze pilot · 200**. Check reliable controls and uncertain source dates.
   The pilot disables automatic changes and continuous discovery.
9. After evaluating results and undo, enable automatic changes and analyze the library.

The worker processes previews through the configured provider. In Coding Plan mode,
the private worker writes a bounded `0600` temporary file and sends it only to the
local MCP child; the file is removed after each call. In direct mode, bounded image
content is sent to the configured standard endpoint. OCR, captions, and public
landmark clues may be included in subsequent analysis. It excludes locked and trashed
assets. Public album permissions are never changed.

The application does not read macOS Keychain, browser cookies, or another password
store. To use an administrator-owned key, retrieve it through your approved private
secret-management process, place it in a deployment-only environment file or secret,
set `Z_AI_API_KEY` for the worker, and protect that file. Do not paste the key into
chat, commit it, put it in a browser setting, or configure it per user. Status reports
only the selected mode, endpoint label, model label, and non-secret failure state.
Missing-key status, Coding Plan text failures, and Vision MCP failures are reported
separately; provider response bodies and credentials are not returned.

## Provider smoke validation

The alpha2 validation used a privately configured Z.AI Coding Plan key without storing
or printing it. The Coding Plan `glm-5.3` text request returned HTTP 200. The same
endpoint correctly rejected direct image message content, while the general standard
vision endpoint was unavailable without balance. The official bundled Vision MCP
`analyze_image` call succeeded, and the project's `ZaiVisionMcpProvider` returned a
schema-valid observation for a public synthetic Immich logo with all expected top-level
fields. Its bounded temporary media directory was removed after the call.

This is a synthetic-logo provider smoke only. It does not validate private-photo quality,
the authorized 200-asset pilot, or a production deployment.

Keeper is intentionally a small extensible harness, not a general-purpose shell agent.
Only code-registered photo tools can run. Keeper sends bounded owner-authorized previews
to GLM in memory after rechecking asset visibility; image bytes, local paths, credentials,
and hidden reasoning are not stored in Keeper messages or events. A task is split into
bounded slices (10 model turns, 20 tool calls, and 100 changed assets by default), with
durable checkpoints between slices. The overall task may continue for hours or days,
including after the browser closes. Quota waits and transient failures remain visible.
Provider acknowledgment loss can cause an at-least-once retry and an additional counted
request; the worker does not claim exactly-once external model delivery. Stop cancels a
waiting or active request when the provider honors cancellation, while an already started
idempotent tool operation may finish its current checkpoint.

Do not expose the worker or its database through router forwarding. Back up
`ORGANIZER_SECRET` securely: it encrypts the worker's stored Immich credentials.

## Source context

Source paths are not inferred from Immich's internal storage layout. Generate a private
manifest from retained import folders using Node 22 and ExifTool:

```sh
cd organizer
npm ci
npm run manifest -- /path/to/source /private/path/source.private.json
```

The manifest records original EXIF, camera identity, checksums, modification times, and
source paths. Unicode paths and duplicate source matches remain in the manifest.
Unsupported source files produce scan warnings without stopping the complete scan.

Upload the JSON through **Organize → Settings → Import a private source manifest**.
The worker retains manifests for matching during future inventory and updates matching assets already in the queue.
The interface accepts files up to 20 MB and sends batches of at most 1,000 records.
If a batch fails, the interface reports the completed batches. Uploading the same file again is safe.
The authenticated `POST /api/organizer/manifest` endpoint also accepts batches. Do not commit private manifests.

An inferred day is applied only with an independent anchor and evidence of a suspect
existing date. Folder names and model confidence alone do not overwrite EXIF.
Approximate city/venue pins can be enabled. Mobile clients can omit the uncertainty label.

## API

All `/api/organizer` routes require an Immich session and are owner-scoped:

| Route | Purpose |
| --- | --- |
| `GET status`, `POST connect` | Connection, queues, provider readiness, and usage |
| `PUT settings` | Analysis, continuous discovery, automatic changes, geolocation, and limits |
| `POST runs` | Durable inventory for a library, album, or selected asset IDs, with optional reanalysis |
| `GET assets?q=&offset=` | Search results, 50 per page, with status/category/datePrecision/locationPrecision filters |
| `GET/PUT assets/:id` | Analysis, facts, and locks |
| `POST manifest` | Checksum-matched source provenance |
| `GET events`, `GET history?offset=` | Managed albums and change journal (200 changes per page) |
| `POST undo/:id` | Restore a change or resume interrupted undo, then suppress reapplication |
| `GET/POST keeper/sessions` | List or create persistent Keeper chats |
| `GET/POST keeper/sessions/:id/messages` | Read history or enqueue a visible user message |
| `GET keeper/sessions/:id/runs` | List durable chat and scheduled runs |
| `GET keeper/runs/:id`, `GET keeper/runs/:id/events?cursor=` | Read run status and incremental visible events |
| `POST keeper/runs/:id/stop`, `POST keeper/runs/:id/resume` | Stop or resume from a checkpoint |
| `GET/PUT keeper/schedule` | Read or configure daily NAS-local housekeeping |

Rich results remain in the organizer database. A compact `organizer.v1` record is
mirrored to Immich custom metadata. Native changes use Immich services and XMP sidecars.

## Runs and corrections

The pilot disables automatic changes and continuous discovery. **Analyze library** enables
continuous discovery. Album and selected runs use the current settings.
Paused runs wait in PostgreSQL. **Resume analysis** starts waiting work.
Pause stops new work acquisition. Requests already in progress can finish.

The recent runs list shows discovery progress and errors. A complete discovery run means
inventory finished. The asset counts show analysis progress separately.
Search covers filenames and analysis metadata, including OCR. Filters apply before pagination.

The photo details panel shows capture versus depicted date estimates. Month, year, and range
estimates do not represent exact capture timestamps. Approximate map locations have explicit labels.
Known capture days and context notes become manual evidence. Clearing the day removes that fact.
Date, location, and description locks protect individual fields. The all-changes lock suppresses automatic application.

In **History**, select **Undo and suppress reapplication** for a completed change.
If undo stops before acknowledgment, select **Resume undo** on the same journal entry.
Undo preserves newer manual edits and reports conflicts. The journal remains available after a worker restart.
An undo action does not delete source media.

Keeper analysis status reports inventory completion separately from per-asset analysis.
An `analysis.queued` event means discovery is queued; it is not a claim that every asset
has been analyzed. Scheduled work coalesces missed days and never overlaps another
scheduled run. The worker shares the two model slots and daily request quota with the
original Organizer analysis queue.

To add a Keeper operation, register a bounded function in `organizer/src/keeper/tools.mjs`
through `ToolRegistry`. The function receives an owner-scoped context with cancellation,
event, checkpoint, and mutation-budget helpers. Keep operations idempotent, use existing
Organizer CAS/journal guards, and return visible text plus references or evidence. Do not
add shell, filesystem, arbitrary URL, code-installation, sharing, deletion, or manual-fact
promotion tools.

## Backup and upgrade

1. Pause analysis before a deployment backup.
2. Back up the Immich database, media, sidecars, and organizer database together.
3. Store `ORGANIZER_SECRET` with the private backup credentials.
4. Restore the backup into a separate deployment before an upgrade.
5. Check the restored login, results, locks, source context, and undo journal.
6. Install matching server and worker images from one release.
7. Check the release tests and a synthetic undo before you resume analysis.

The organizer applies additive schema changes at startup. An older image might not support a newer schema.
A rollback requires compatible images and a matched database backup. The organizer database also holds the daily quota and work leases.

## Development and validation

```sh
npm ci --prefix organizer
TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/organizer npm test --prefix organizer
npx pnpm@11.13.1 install --frozen-lockfile --filter immich... --filter immich-web...
npx pnpm@11.13.1 --filter @immich/sdk --filter @immich/plugin-sdk build
npx pnpm@11.13.1 --filter immich check
npx pnpm@11.13.1 --filter immich-web prepare
npx pnpm@11.13.1 --filter immich-web check:typescript
npx pnpm@11.13.1 --filter immich-web check:svelte
npx pnpm@11.13.1 --filter immich-web exec vitest run src/lib/components/organizer 'src/routes/(user)/organize'
npx pnpm@11.13.1 --filter immich build
npx pnpm@11.13.1 --filter immich-web build
docker build -f organizer/Dockerfile -t immich-organizer-worker:test .
docker build -f organizer/server.Dockerfile -t immich-organizer-server:test .
docker compose -f organizer/compose.test.yaml up -d
RUNTIME_URL=http://127.0.0.1:18283 node --test organizer/test/runtime.test.mjs
docker compose -f organizer/compose.test.yaml down
```

Without `TEST_DATABASE_URL`, database integration tests are explicitly skipped.
CI supplies PostgreSQL and runs them. Install FFmpeg before the worker tests.
The runtime deployment binds only to `127.0.0.1:18283` and uses synthetic credentials and fixtures.
Only synthetic fixtures belong in the public repo.

The server image overlays compiled server and web files on the pinned upstream v3.1.0 image.
It retains upstream runtime dependencies and native tools. Rebuild both artifacts from the same commit before the image build.
This packaging method requires compatible dependencies. A dependency change requires another runtime compatibility check.

Tag releases `organizer-vVERSION` to build matching server and worker images in GHCR.
CI checks the worker with PostgreSQL, server types and organizer lint, web types, Svelte, component tests, and the isolated runtime.
The release image job starts only after those checks pass. Both images carry source, revision, and version labels.
The alpha2 prerelease and both GHCR images are public. Tagged CI run `33994243613`
verified the full tests, builds, isolated runtime, and matching image builds. Anonymous
GHCR manifest requests for both images returned HTTP 200. The release also contains
gzip-tested, Docker-loaded Linux amd64 archives and `SHA256SUMS`: the server archive is
882632113 bytes with digest `sha256:cef90ae5526fdf052c1acae5269e49e690acd017c47204a5ccd09cc16103a438`,
and the worker archive is 299340524 bytes with digest
`sha256:bf6700d80bddd3799036aada54dfd0fe4767bec9bad92fa5c5be1578600a440e`.
Archive labels identify commit `88260e1`. Source labels do not contain deployment secrets.
Retain upstream tags, rebase the `organizer` branch deliberately, and repeat tests
against each new upstream version. Native mobile organizer UI, speech transcription,
automatic deletion, and cross-owner event inference are deferred.
