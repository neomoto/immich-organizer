# Immich Organize

Organize appears inside Immich's sidebar and photo details. It uses a private worker
and a separate PostgreSQL database. There is no additional user-facing port or login.

## Current implementation

- GLM/OpenAI-compatible vision descriptions, tags, OCR, date ranges, and location candidates.
- Photo previews and up to eight frames per video. No audio transcription.
- Optional Wikipedia corroboration with evidence links.
- Automatic private event albums, AI-prefixed tags, empty descriptions, and supported date/GPS corrections.
- Explicit approximate places and dates, field locks, manual facts, and undo history.
- A durable PostgreSQL queue, encrypted Immich credentials, two concurrent requests,
  and an atomic daily request limit (5,000 by default).
- Pilot mode does not apply metadata changes or discover the whole archive automatically.

The code requires live validation with the configured vision endpoint and a separate
Immich deployment before use on an irreplaceable archive. A passing filesystem check
does not replace a backup. Back up both Immich and the organizer database before upgrades.

## Install for a pilot

1. Prepare a separate Immich v3.1.0 deployment using its standard release Compose file.
2. Add `organizer/compose.yaml` as a Compose override. Use a released organizer server
   image and matching worker version, or build both images from the same commit.
3. Copy `.env.example` into the private deployment environment. Generate independent
   random values for `ORGANIZER_SECRET` and `ORGANIZER_DB_PASSWORD`; use at least 32
   characters for the organizer secret. Passwords in the database URL must be URL-safe.
4. Configure `VISION_BASE_URL`, `VISION_MODEL`, and `VISION_API_KEY` for the provider
   access you actually have. General API and subscription endpoints may differ.
   The worker does not change endpoints or silently fall back to another billing mode.
5. Merge and inspect the configuration:

   ```sh
   docker compose --env-file /private/path/deployment.env \
     -f /path/to/immich/docker-compose.yml -f organizer/compose.yaml config --quiet
   ```

6. Start that deployment, log into Immich, and open **Organize → Connect Organize**.
   The server provisions a restricted worker API key for that account; no key is
   returned to the browser. The key can be revoked from Immich's API Keys settings.
7. Run **Analyze pilot · 200**. Check reliable controls and uncertain source dates.
   The pilot disables automatic changes and continuous discovery.
8. After evaluating results and undo, enable automatic changes and analyze the library.

The worker processes previews through your external vision provider. OCR, captions,
and public landmark clues may be included in subsequent analysis. It excludes locked
and trashed assets. Public album permissions are never changed.

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
source paths. Submit it in chunks of at most 1,000 entries through the authenticated
`POST /api/organizer/manifest` endpoint after inventory. Do not commit manifests.

An inferred day is applied only with an independent anchor and evidence of a suspect
existing date. Folder names and model confidence alone do not overwrite EXIF.
Approximate city/venue pins can be enabled; mobile clients may omit the uncertainty label.

## API

All `/api/organizer` routes require an Immich session and are owner-scoped:

| Route | Purpose |
| --- | --- |
| `GET status`, `POST connect` | Connection, queues, provider readiness, and usage |
| `PUT settings` | Analysis, continuous discovery, automatic changes, geolocation, and limits |
| `POST runs` | Inventory all or selected asset IDs; optional reanalysis |
| `GET assets?q=&offset=` | Search results, 50 per page |
| `GET/PUT assets/:id` | Analysis, facts, and locks |
| `POST manifest` | Checksum-matched source provenance |
| `GET events`, `GET history` | Managed albums and change journal |
| `POST undo/:id` | Restore a change and suppress reapplication |

Rich results remain in the organizer database; a compact `organizer.v1` record is
mirrored to Immich custom metadata. Native changes use Immich services and XMP sidecars.

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
docker build -f organizer/Dockerfile -t immich-organizer-worker:test .
docker build -f server/Dockerfile -t immich-organizer-server:test .
```

Without `TEST_DATABASE_URL`, database integration tests are explicitly skipped.
CI supplies PostgreSQL and runs them. Only synthetic fixtures belong in the public repo.

Tag releases `organizer-vVERSION` to build matching server and worker images in GHCR.
Retain upstream tags, rebase the `organizer` branch deliberately, and repeat tests
against each new upstream version. Native mobile organizer UI, speech transcription,
automatic deletion, and cross-owner event inference are deferred.
