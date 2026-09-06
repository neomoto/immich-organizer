# Immich Organize and Keeper — 0.1.0-alpha.5

Experimental maintenance release based on Immich v3.1.0. Alpha5 carries the hidden Immich
Live Photo companion fix, both deterministic runtime-test race fixes, and a reusable Mac
hot-reload development launcher.

## Hidden Live Photo companions

- `visibility=hidden` assets are ineligible for Organizer inventory, analysis, provider/media
  access, and standalone Organizer results. Timeline and archive assets remain eligible.
- On worker startup, after database migrations and before analysis loops, only derived Organizer
  `assets` rows whose stored snapshot is hidden are deleted. Immich media, originals,
  changes/history, events, owners, and source manifests are not mutated.
- Reconciliation returns/logs only an aggregate count and does not generate thumbnails.
- Non-continuous inventory remains capped at 200 assets. The real-Postgres regression verifies
  hidden rows can be removed and visible assets replenished to exactly 200 without hidden-ID
  enrollment.

## Deterministic runtime checks

- Automatic reanalysis captures the previous result marker and requires a changed marker from
  the new revision before asserting completion.
- Canonical metadata, tags, and album membership are polled to their expected settled state after
  automatic application and undo. Bounded failures still fail the runtime test.
- Alpha3 and alpha4 were tagged but not released because CI exposed these two test races; no
  alpha3/alpha4 images or prereleases are claimed here.

## Mac development launcher

Run `pnpm organizer:dev` for the local synthetic stack. It validates Compose, waits for the
loopback backend, runs Vite on `127.0.0.1:3000`, and opens `/organize` on macOS without rebuilding
images by default. Use `--rebuild-backend` only after server or worker changes. The explicit
`pnpm organizer:dev -- --nas` mode skips local Compose and proxies Vite to the NAS; it warns that
UI actions affect production, never enables Organizer automation, and never connects to PostgreSQL.

## Version and validation

Current package metadata, image defaults, Compose defaults, env example, and MCP client label are
`0.1.0-alpha.5`. The synthetic database healthcheck uses the explicit `postgres` role and
database, avoiding the previous false `root` role failure. Full worker tests and local runtime
checks remain required before publication. Private-photo quality, the real-photo 200-asset pilot,
mobile validation, and long-term stability monitoring remain incomplete.
