# Phase 3 Media Foundation installed-host acceptance

Candidate: Server `stage/phase-3-media-foundation` against the accepted Phase 2 frontend. Acceptance confirmed by the user on 2026-09-27, before the `v0.3.0` release. The official SillyTavern 1.19.0 Docker installation on NAS is the installed host. Phase 3 adds Server Media Foundation; the frontend's Phase 2 status page discovers `media` and `media.assets`, while a dedicated Media consumer UI belongs to a later phase.

## Core acceptance

| Check | Result | Evidence scope |
| --- | --- | --- |
| Plugin initialization, authenticated discovery and `core`/`network`/`media` readiness | Passed | Installed-host confirmation: all `media.assets` operations available. |
| Raw binary Local Import with Protocol 1.0, ST session CSRF, trusted Origin and PNG Content-Type | Passed after host compatibility fix | Initial installed-host HTTP 400 reproduced and fixed; host middleware regression test and user acceptance of the corrected core flow. |
| Remote Import through Network, proxy failure and recovery without Server restart | Passed | Installed-host core acceptance; automated route regression covers `ready` → `degraded` → successful retry → `ready`. |
| Media identity, deduplication, Original and thumbnail serving, storage/quota, explicit deletion and cleanup | Passed | User-confirmed core acceptance; detailed edge and isolation cases covered by automated tests. |
| MediaRef persistence across restart and cold stopped-host Media Store backup/restore | Passed | Installed-host core acceptance; exact Original image URL was opened after restore. |
| Local Provider and Core/Network independence | Passed | User-confirmed core acceptance and automated isolation checks. |

The table records the user's completion of the core installed-host acceptance. It does not assert that every malformed input, limit, cross-user case or failure branch was separately exercised on NAS; those cases are covered by the automated suite.

## Raw upload installed-host finding

The initial authenticated raw `POST /api/plugins/tavern-toolbox-server/v1/media/import/local` with a valid approximately 16 KiB PNG returned HTTP 400 `INVALID_REQUEST` before deep validation or SQLite persistence. In SillyTavern 1.19.0, global Express 4 JSON/urlencoded body parsers and multer precede the plugin router. For raw `image/png`, the body parser leaves `req.body` as an empty plain object but does not consume the request stream. The earlier route treated every defined non-Buffer `req.body` as invalid.

The fix admits only that exact empty plain placeholder when the stream is still readable, then enforces the same bounded raw read and Media validation. It rejects an already-consumed stream, a populated or non-plain body, empty bytes and a supplied Content-Length mismatch. The host regression test reproduces the pinned Express 4/body-parser/multer order and checks success and fail-closed cases. Protocol, MIME, size limit, authentication, CSRF and Origin requirements stay in force. No SillyTavern change, multipart upload or Base64 path was introduced.

## Code and publication gate

The final `npm run check` covers unit, HTTP and real-middleware tests; `npm run audit:privacy` checks public source and reachable Git metadata. Release `v0.3.0` must run both again from the exact `main` commit before the workflow creates an annotated tag and GitHub Release. Keep real user paths, image URLs, proxy endpoints, cookies and CSRF tokens out of public evidence. A code tag does not restore Media data; take a stopped-host backup of the entire per-user Media Store for rollback.
