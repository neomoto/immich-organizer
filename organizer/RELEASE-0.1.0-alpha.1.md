# Immich Organize and Keeper — 0.1.0-alpha.1

Experimental fork based on Immich v3.1.0, adding organization and a photo keeper
inside the existing Immich web interface and login.

## Included

- Rich vision metadata, captions, OCR, date ranges, visual location candidates,
  source-file evidence, and private event albums.
- Bounded related-photo context and detail crops, with labelled precision/fallbacks.
- Automatic supported metadata changes, field locks, a durable journal, and undo.
- Persistent Keeper chat with explicit owner-scoped photo tools. No general shell
  or filesystem tools, and no dependency on pi or another coding-agent harness.
- Daily housekeeping and long background tasks with checkpoint continuation,
  quota waits, event history, stop/resume, and bounded execution slices.
- A shared two-request provider pool and a 5,000-request daily default limit.
- Matching server/worker images and a separate organizer PostgreSQL database.

## Validation

Synthetic tests cover model/tool protocols, in-memory image hydration, owner and
visibility boundaries, quota/lease behavior, pilot limits, checkpoint recovery,
and metadata/tag/album operations. The isolated Immich runtime verifies login,
Keeper execution, scheduling controls, undo, and recovery after lost acknowledgment.
Real ExifTool tests cover GPS/date deletion and empty textual metadata.

See the repository's Organizer workflow for the release commit's hosted results.

## Install and evaluate

Follow [the setup guide](https://github.com/neomoto/immich-organizer/blob/organizer/organizer/README.md).
Configure your own compatible vision endpoint and key in the private deployment
environment. Begin with the read-only 200-asset pilot and reliable control photos.

Registry images:

- `ghcr.io/neomoto/immich-organizer-server:0.1.0-alpha.1`
- `ghcr.io/neomoto/immich-organizer-worker:0.1.0-alpha.1`

GitHub may initially mark new container packages private. The release's compressed
Linux amd64 image archives provide a public `docker load` fallback when attached.
They contain application images, not deployment secrets or user data.

## Current limits

- Actual GLM inference quality and a real-photo pilot remain unverified by synthetic tests.
- Context grouping relies on source manifests; semantic event aliases can still split albums.
- Web corroboration currently uses Wikipedia, and video sampling timestamps are approximate.
- Approximate pins can appear without uncertainty labels in official mobile apps.
- Cancellation stops future work; committed changes require undo.
- Completed persisted steps are reused, but a lost provider acknowledgment can require
  a repeated, quota-counted model request. External calls are not guaranteed exactly once.

Keep original media and verified backups while evaluating this prerelease.
