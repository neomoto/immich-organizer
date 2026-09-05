# Immich Organize and Keeper — 0.1.0-alpha.2

Experimental fork based on Immich v3.1.0. This prerelease adds a shared-admin Z.AI
Coding Plan provider path while retaining the direct standard OpenAI-compatible mode.

## Provider changes

- Recommended BYOK mode: `AI_PROVIDER=zai-coding-plan`.
- Keeper text/tool reasoning uses `https://api.z.ai/api/coding/paas/v4` and `glm-5.3`.
- Vision uses the bundled `@z_ai/mcp-server@0.1.5` / `zai-mcp-server` binary over
  local stdio. The worker never runs `npx` or downloads a package at runtime.
- The single `Z_AI_API_KEY` is administrator-owned and shared by the worker. It is
  never returned to Immich users or the browser. `VISION_API_KEY` is accepted as a
  backwards-compatible alias when the canonical variable is absent.
- Direct mode uses a separate standard vision endpoint, `VISION_MODEL`, and
  `VISION_API_KEY`; it remains suitable for a metered standard API balance.

Vision MCP receives only bounded `0600` temporary files. Files are confined to a
private temporary directory and removed after success, failure, timeout, or cancel.
Text transcripts, event history, and logs do not contain keys or media bytes. Provider
status reports mode, non-secret labels, and separate missing-key/text/MCP failure states.

## Included

- Evidence-based metadata, OCR, date ranges, visual location candidates, source manifests,
  private event albums, conflict-aware undo, and sidecar-safe writes.
- Persistent Keeper sessions, explicit owner-scoped photo tools, visible tool events,
  daily housekeeping, checkpointed long tasks, stop/resume, and two shared model slots.
- Direct-mode compatibility and Coding Plan text/MCP vision separation.

## Validation

Synthetic worker tests cover Coding Plan configuration, text-only GLM-5.3 payloads,
MCP stdio invocation, private path checks, cleanup on success/failure/timeout, quota,
redaction, and direct-mode regression. Existing worker, UI, server, real ExifTool, and
isolated Immich runtime checks remain part of the release workflow. These checks use
synthetic fixtures and do not measure private-photo model quality.

A live provider smoke used a privately configured Z.AI Coding Plan key without storing
or printing it. Coding Plan `glm-5.3` text returned HTTP 200; direct image content was
rejected by that endpoint; and the general standard vision endpoint was unavailable
without balance. The official bundled Vision MCP `analyze_image` call succeeded. The
project's `ZaiVisionMcpProvider` then returned a fully schema-valid observation for a
public synthetic Immich logo with the expected top-level fields and removed its bounded
temporary media directory.

Branch CI run `33994238629` succeeded. Tagged CI run `33994243613` succeeded with the
full tests, builds, isolated runtime, and both image builds. Public prerelease
`organizer-v0.1.0-alpha.2` includes `SHA256SUMS` plus gzip-tested, Docker-loaded Linux
amd64 archives. The server archive is 882632113 bytes with digest
`sha256:cef90ae5526fdf052c1acae5269e49e690acd017c47204a5ccd09cc16103a438`; the worker
archive is 299340524 bytes with digest
`sha256:bf6700d80bddd3799036aada54dfd0fe4767bec9bad92fa5c5be1578600a440e`.
Labels were verified against commit `88260e1`. Anonymous GHCR manifest requests for
both public images returned HTTP 200.

## Private setup

Copy `organizer/.env.example` to a deployment-only file. Set `ORGANIZER_SECRET`,
`ORGANIZER_DB_PASSWORD`, and the administrator-owned `Z_AI_API_KEY`. Do not use
macOS Keychain or browser storage as an implicit integration: the application does
not read either. Retrieve the key through an approved private secret-management
process and inject it only into the worker environment. Use the direct-mode variables
instead when operating against a standard metered API endpoint.

Follow [the setup guide](https://github.com/neomoto/immich-organizer/blob/organizer/organizer/README.md).
Start with the read-only 200-asset pilot and reliable control photos. Keep a backup of
Immich media, sidecars, databases, and the organizer secret before enabling automatic changes.

## Known limitations

- The live check was a public synthetic-logo provider smoke. It is not a private/real-photo
  200-asset pilot or a production deployment. Physical mobile validation also remains incomplete.
- MCP model selection is controlled by the bundled server; status labels it as the bundled
  MCP model rather than claiming a specific vision model.
- A lost provider acknowledgment can cause an at-least-once retry and an additional quota
  charge. Completed persisted steps are reused where possible; external calls are not exactly once.
- Stop cancels waiting/current work when supported, but an already-started idempotent tool
  operation may finish its current checkpoint. Original media is never deleted by Keeper.
- Event grouping, web corroboration, approximate mobile labels, and video timestamps retain
  the limits documented in the main setup guide.
