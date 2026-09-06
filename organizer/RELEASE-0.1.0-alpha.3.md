# Immich Organize and Keeper — 0.1.0-alpha.3

Experimental alpha3 maintenance release based on Immich v3.1.0. This release keeps the
shared-admin Z.AI Coding Plan provider and direct standard API mode from alpha2, and fixes
hidden Immich Live Photo companion enrollment.

## Hidden companion handling

- `visibility=hidden` assets are ineligible for Organizer inventory, analysis, and standalone
  Organizer results. Locked, trashed, offline, and deleted assets remain excluded.
- Timeline and archive assets remain eligible.
- On worker startup, after database migrations and before analysis loops, the worker deletes
  only derived `assets` rows whose stored snapshot has `visibility=hidden`.
- The reconciliation returns/logs only an aggregate row count. It does not mutate Immich,
  original media, changes/history, events, owners, or source manifests, and it does not create
  thumbnails or modify hidden Live Photo files.
- Removing stale derived rows restores available pilot slots. The non-continuous inventory cap
  remains 200 assets and hidden IDs are not re-enrolled while they remain hidden.

## Provider/version maintenance

- Current package, image defaults, Compose defaults, `.env.example`, and MCP client label are
  `0.1.0-alpha.3`.
- Coding Plan text remains `glm-5.3` through the Coding endpoint. Vision remains the bundled
  pinned Z.AI MCP over stdio. No provider key is stored in this release.

## Validation

Focused policy and engine tests cover hidden IMAGE/VIDEO exclusion and prove hidden rows do not
reach provider or media access. The real-PostgreSQL reconciliation test covers all four queue
statuses, retained journals/events/manifests, visible timeline/archive retention, exact 200-item
replenishment, cap enforcement, and hidden-ID exclusion.

Alpha2 provider, UI, native server, ExifTool, and isolated runtime validation remains applicable
to the unchanged portions of this maintenance release. Private-photo quality, a full real-photo
200-asset pilot, mobile validation, and long-term stability monitoring remain incomplete.
