# Phase 6 — Media Governance & Asset Manager

Status: **completed — release candidate accepted**, Server v0.6.0 / Frontend v0.49.0, Protocol 1.0. Phase 6 code review, core logic, automated CI and installed-host core experience are accepted. Tags and Releases must originate from the verified main commits. Release-package smoke remains a separate user action, not a claimed completed test.

## Installed-host Evidence

On 2026-10-02, the user confirmed core use and UI checks in the actual SillyTavern 1.19.0 Docker / NAS environment, with no obvious blocking issue. The reviewed candidate baseline is Frontend `59b702d31f4687a5a5d1df2de3d7acfd1e7c2085` / Server `250f45f06a10e1e3579f936f68da7f273cf1ec76`. This is an aggregate core-experience acceptance, not a per-case manual pass. Specialized cases below retain their own evidence category.

## Automated Evidence

`npm test` runs test files sequentially (`--test-concurrency=1`) so durable Media/Sharp fixtures do not compete with unrelated cold per-user Store health probes. The 48-asset integration test, every assertion, explicit within-test reference/write races and the production Registry's 250 ms health budget remain unchanged. This does not increase timeouts, prewarm the failing health fixture, retry assertions or skip tests in CI. Both Candidate CI and Privacy and Core checks use the same `npm run check` command.

Reference aggregation includes active/detached Character scopes and Outfit, same-asset multiple consumers, future adapter registration, completeness/failure, stable existing originals, changed-URL offline reuse, cross-user isolation, CAS and explicit Consumer unlink/replace. Broken references remain visible; Original corruption does not change reference state. Both legacy raw HTTP DELETE and batch endpoints recheck references. A genuinely overlapping Business existence check holds the coordinator while deletion waits, then deletion refuses the new reference. Batch missing/protected/safe items return partial outcomes. A 48-item batch enumerates each Provider exactly once under one user coordinator; a Consumer queued during deletion cannot bind a subsequently deleted asset. Incomplete analysis retains every existing item. bindExisting HTTP errors preserve MEDIA_NOT_FOUND/404 and MEDIA_CORRUPT/422. Origin/session/CSRF/protocol and page-size guards have real HTTP fixtures with pinned ST 1.19.0 middleware.

Frontend tests exercise rendered manager controls, server paging/search, thumbnail-only grid, lazy paged Group previews, automatic detail Thumbnail with explicit Original and late-preview cancellation, return to the same Group page/scroll, independent compatible Tab state filters, detail/back scroll, partial-delete single confirmation, unknown deletion disabling, detached/broken UI, current-character change after confirmation, picker slot validation, close/account-switch request cancellation and Blob cleanup. Chat recovery verifies no extra remote fetch; Outfit reuse saves MediaRef with no import and preserves edit CAS.

Frontend full check passes 1509 tests and the build. Server full CI passes all 82 tests, privacy and syntax checks without skips. The local development sandbox rejects Linux abstract IPC (`EPERM`), so its eight existing kernel-lock tests cannot provide a local pass; complete supported-runner CI is the evidence for those tests. No timeout, race test or privacy audit was weakened. Chromium rendering covers Desktop / Tablet / Phone and narrow windows, themes, lazy previews, Original failure and navigation; it is not physical-touch or OS-keyboard evidence.

## Final evidence matrix

| Case | Expected result | Evidence status |
| --- | --- | --- |
| Core use and UI in ST 1.19.0 Docker / NAS | no obvious blocking issue | Accepted on installed host — aggregate user report |
| Existing Phase 3–5 assets/catalog | same IDs/Originals, no reimport or migration | Automated evidence; no separate per-case host claim |
| Localize → deny source → re-enter | saved Original without source access | Automated evidence; Phase 5 host baseline retained |
| Deleted identity / detached rebind | explicit current-character recovery; no nonempty Scope merge | Automated evidence |
| Changed URL / Broken Character slot → Picker | exact slot, no source request or byte copy | Automated evidence |
| Server Outfit Picker/save/cancel | save through Business CAS; cancellation retains reference | Automated evidence |
| Shared Character + Outfit references | any remaining reference protects Media | Automated evidence |
| Detached Forget / Binding unlink / Business delete | reference-only change; Media retained | Automated evidence |
| Broken Reference | visible despite missing Media; repair at explicit slot | Automated evidence |
| Artificial Corrupt Original / SQLite damage | separate health/failure; no automatic source recovery | Not specifically exercised on installed host / non-blocking; relevant failure contracts automated |
| Stale or concurrent deletion / 48-item partial batch | complete latest analysis, one batch coordinator, per-item outcome | Automated evidence; high-concurrency host drill not specifically exercised / non-blocking |
| Provider incomplete | Unknown, fail-closed deletion; independent Media reads | Automated evidence |
| Group / Asset navigation and previews | lazy Thumbnail, explicit Original, return to same page/scroll | Automated evidence; aggregate host UI accepted |
| Desktop / Tablet / Phone polish | usable modules, summary, toolbar, filter, details and Picker | Aggregate installed-host UI accepted + Chromium visual evidence; no claim for every theme/material/keyboard combination |
| Account switch / cross-ST-user negatives | discard old state; no foreign Media access/bind | Automated evidence; specialized multi-user host negative not specifically exercised / non-blocking |
| No Server / old Server / Local provider | no silent fallback, migration or Local regression | Automated evidence |
| Network policy / kernel locks | complete existing suite in supported environment | Automated evidence — full CI |
| Official release package sanity | Governance ready, old assets and one Group Thumbnail | Not specifically exercised — user NAS confirmation required after release |

## Compatibility and rollback

Protocol 1.0, Media IDs, Originals and Media / Business / Localization Schema versions are unchanged. No automatic migration or GC. Phase 5 Frontend v0.48.0 / Server v0.5.0 remain code rollback points; tags cannot restore data. A severe problem may require code rollback plus the user's own Server data backup.

Grid loads static derived previews lazily, never falls back to Original. Original is a detail user action. Filtering/sorting/search and all catalog/reference pages remain server bounded. Close stops requests, observers, timers and object URLs. Manager performs no continuous HTTP polling, automatic GC, source URL persistence, Genesis/Worldbook server conversion, video/audio or scope merge. One active ST process per user data volume remains a deployment constraint.
