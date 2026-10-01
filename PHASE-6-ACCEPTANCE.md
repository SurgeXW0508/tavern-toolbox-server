# Phase 6 — Media Governance & Asset Manager

Status: development candidate, **installed-host and visual acceptance pending**. Both repositories continue `stage/phase-6-media-governance`; formal versions remain frontend v0.48.0 / Server v0.5.0, Protocol 1.0. Do not merge main, bump versions or publish until the matrix is accepted.

## Code evidence

Reference aggregation includes active/detached Character scopes and Outfit, same-asset multiple consumers, future adapter registration, completeness/failure, stable existing originals, changed-URL offline reuse, cross-user isolation, CAS and explicit Consumer unlink/replace. Broken references remain visible; Original corruption does not change reference state. Both legacy raw HTTP DELETE and batch endpoints recheck references. A genuinely overlapping Business existence check holds the coordinator while deletion waits, then deletion refuses the new reference. Batch missing/protected/safe items return partial outcomes. Origin/session/CSRF/protocol and page-size guards have real HTTP fixtures with pinned ST 1.19.0 middleware.

Frontend tests exercise rendered manager controls, server paging/search, thumbnail-only grid, explicit Original, detail/back scroll, partial-delete single confirmation, unknown deletion disabling, detached/broken UI, current-character change after confirmation, picker slot validation, close/account-switch request cancellation and Blob cleanup. Chat recovery verifies no extra remote fetch; Outfit reuse saves MediaRef with no import and preserves edit CAS.

The final candidate's full frontend `npm run check` passes all 1497 tests and builds successfully. Server privacy audit passes. In this development execution environment Linux abstract IPC returns `EPERM`, blocking eight existing Network policy lock tests (including the timeout of their intentional lock-holder fixture); the policy implementation and assertions are unchanged. A run excluding those unsupported cases passes the remaining 70 Server contracts, including all new Phase 6 cases. Full Server CI/host verification is still required. Chromium is absent; the attempted browser download was not a complete ZIP, so no Phase 6 viewport screenshot/visual pass is claimed.

## Installed-host matrix (SillyTavern 1.19.0 Docker / NAS)

| Case | Expected result | Status |
| --- | --- | --- |
| Existing Phase 3–5 assets/catalog | same IDs/Originals, no reimport or migration | Pending |
| Localize → deny source → re-enter | saved Original renders without source access | Pending |
| Delete card → reimport → detached rebind | explicit current-character recovery with source still offline | Pending |
| Blocked/new URL/Broken Character slot → Picker | existing MediaRef binds, no source request/byte copy | Pending |
| Server Outfit image slot → Picker/save/cancel | reuse on save; cancellation retains old reference; Local behavior unchanged | Pending |
| Shared Character+Outfit asset | one unlink leaves protected; all refs removed becomes unreferenced | Pending |
| Detached Forget / old Binding unlink | reference-only change; media remains reusable | Pending |
| Broken / corrupt asset | separate visible states; reference repair without NAS file editing | Pending |
| Two tabs: query free → new reference → delete | Server rejects stale deletion | Pending |
| Partial batch | one confirmation, per-item retained/deleted reasons | Pending |
| Provider failure | incomplete/unknown, fail-closed delete, normal Media read independent | Pending |
| ST account switch while open | old preview/selection/detail disappear; in-flight results discarded | Pending |
| Desktop / Tablet / Phone | grid/list/detail/filter sheet/picker/confirmation usable in light/dark themes, with long labels/GIF/large/empty/error states | Pending |
| No Server / old Server / Local provider | Local features remain usable; no silent fallback/migration | Pending |
| Network policy regression / kernel locks | full existing suite passes in supported environment | Pending |

Grid loads static derived previews lazily, never falls back to Original. Original is a detail user action. Filtering/sorting/search and all catalog/reference pages remain server bounded. Close stops requests, observers, timers and object URLs. Manager performs no continuous HTTP polling, automatic GC, source URL persistence, Genesis/Worldbook server conversion, video/audio or scope merge. One active ST process per user data volume remains a deployment constraint.
