# Immich Organize and Keeper — 0.1.0-alpha.4

Experimental maintenance release based on Immich v3.1.0. Alpha4 carries the alpha3 hidden
Live Photo companion fix and hardens the isolated runtime test against stale reanalysis state.

## Runtime validation fix

The automatic reanalysis test now captures the previous result context marker and requires a
new marker after the new inventory run. It then polls canonical Immich metadata, tags, and album
membership until the application settles. This prevents a previous analyzed revision from
being mistaken for the current run while retaining bounded failure behavior.

## Hidden companion handling

- `visibility=hidden` assets are ineligible for Organizer inventory, analysis, and standalone
  Organizer results. Locked, trashed, offline, and deleted assets remain excluded.
- Timeline and archive assets remain eligible.
- On worker startup, after database migrations and before analysis loops, the worker deletes only
  derived `assets` rows whose stored snapshot has `visibility=hidden`.
- Reconciliation returns/logs only an aggregate count. It does not mutate Immich, original media,
  changes/history, events, owners, or source manifests, and it does not create thumbnails.
- Removing stale derived rows restores available pilot slots. Non-continuous inventory remains
  capped at 200 assets and hidden IDs are not re-enrolled while hidden.

## Current version and provider

Package metadata, image defaults, Compose defaults, `.env.example`, and the MCP client label are
`0.1.0-alpha.4`. Coding Plan text remains `glm-5.3`; Vision remains the bundled pinned Z.AI
MCP over stdio. No provider key is stored in this release.

## Validation and limitations

The real-PostgreSQL worker suite passes 61 tests with one expected isolated-runtime skip when
`RUNTIME_URL` is absent. The updated isolated runtime passed twice against the local synthetic
deployment, with all nine checks passing on each run; those local runs used the existing synthetic
images, so tagged alpha4 image validation remains required. Private-photo quality, the full
real-photo 200-asset pilot, mobile validation, and long-term stability monitoring remain incomplete.
