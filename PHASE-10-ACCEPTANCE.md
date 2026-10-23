# Phase 10 — Worldbook Server Final Acceptance

## Release identity

Frontend **v0.53.0**, Server **v0.10.0**, Protocol **1.0**, Worldbook Storage Schema **3**. Summary wire schemaVersion 1; featureVersion 2; candidateScopes global/column/filtered/folder; reconcileVersion 1; worldbook.core/media 1.0.

Frozen accepted feature candidates: Frontend `19ddd4ccc5b2c02a383c280fba960c24c56840bd`, Server `9b60928e7ac1e047344d12b071b45ab8e1d85a12`. One final Closeout commit per repository updates only version metadata, documentation, release notes and this acceptance record. Its SHA is each formal annotated tag's main merge commit second parent (`v0.53.0^2` / `v0.10.0^2`). Merge commits preserve all original Phase 10 commit SHAs; no squash or rebase.

## Scope

Independent Local/Server Provider boundary; bounded per-user Core Summary/Catalog/Tree/Detail/Facet; stable Material/Source/Binding identity; Companion; Column/Global Presets; Usage; source lifecycle/rebind/migrate; Import/Sync/Reconcile; complete-scope Roll; bounded text-only Discovery with Folder Scope; Native Reader binding verification; Server Cover + Gallery, Reference Provider/Governance; Event-stable Dynamic Preview and post-AI Explore presentation; Large Picker and responsive UI convergence.

## Storage and migration

Schema 3 stores Worldbook business data and reference-only media relations, with independent metadata/Binding/Media revisions. Media bytes/Thumbnail/Original/technical metadata/health remain in Media Domain. ST remains the sole owner of Entry body, keywords, Enabled/Mode. Recognized schema 1/2 upgrades are atomic, preserving IDs/data and rolling back on failure; new stores use 3 directly. Future/unknown/corrupt schema fails closed, without reset or replacement. No Local data migration or full Catalog mirror.

## Automated evidence

Frozen Frontend: **2083/2083** tests and build. Frozen Server: **227/227** tests, syntax gate and privacy audit. Closeout and main Release rerun clean dependency install and the full gates without reducing coverage. Local full-check attempts reproduce the documented abstract Unix socket/EPERM policy-lock restriction and are not reported as a local full-suite pass; the original complete 227-test CI, syntax and privacy gates must pass before merge. Frontend full lockfile audit: zero advisories; Server production audit: zero. Development-only host compatibility fixtures have one low, two moderate, five high package nodes at the 2026-10-24 audit; current scope and triage are in docs/ENGINEERING.md, not hidden by force-updating the fixture.

Store/SQLite/HTTP/source-safety/CAS/uncertain-receipt tests preserve identity, revision and conflict boundaries. Frontend tests cover Discovery text-only payload, complete candidate transport windows, binding double read, current-page-only Media reads, 40-reference cache, deterministic Event selection, Thumbnail retention and release, Viewer isolation, rendering guards and cross-column Companion behavior. Chromium + HTTP/SQLite with synthetic ST/AI verifies multi-size Light/Dark presentation and actual image/URL owners; it is not physical-phone evidence.

Release workflows build from immutable main commits, create annotated tags, publish exact asset inventories and re-download/validate SHA256SUMS. Formal package Smoke is a separate final publication gate; its actual completion and exact release/main/tag identities are recorded in the Closeout result and linked Actions/Release records, not inferred from this pre-merge document.

## Installed-host evidence

The user supplied repeated **SillyTavern 1.19.0 / Docker / NAS** core and UI feedback throughout Phase 10 and explicitly authorized Release Closeout after the final candidate. This covers ordinary Worldbook browsing/detail, Roll/Discovery, media previews/Viewer, Native Content and successive UI corrections at the aggregate user-workflow level. The last Roll density was accepted as usable; no additional redesign was requested for release.

This confirmation does not assert that every specialized failure, race, cross-account, migration, WebKit or physical-phone matrix case was manually executed. Synthetic responsive/browser tests and actual installed-host feedback remain separately described in Frontend TESTING.md.

## Safety invariants

- Protocol 1.0 and Schema 3 are independent of package versions; Material/Source/Binding/Media identity is preserved.
- commandId, entity/structure revision/CAS, explicit uncertain-write verification/retry and guarded reconcile/source migration remain authoritative.
- Native content uses latest Detail → current Worldbook/UID → latest Detail binding verification, with Abort/stale response and focus/Back/Escape ownership.
- Companion and Presets store Material IDs; cross-column selection remains supported. Import remains selected ADD-only, complete-set selection/search, destination validation and bounded 100-item commands.
- Preview is derived presentation, not persistence or identity. AI Candidate/Prompt is media-free; only accepted/current results hydrate bounded media references, lazy Thumbnail and explicit Original.
- Hard delete requires coordinated complete current reference analysis; shared/unknown/incomplete states protect assets. No automatic GC, Local fallback or automatic Local migration.

## Upgrade requirement

Before the first upgrade of existing Phase 10 Candidate data, stop ST writes and consistently back up complete **worldbook-v1 and media-v1**, including applicable SQLite companion files; do not copy only a live SQLite main file. Preserve user volumes and install dependencies for the deployed runtime; Node 24 is the tested release CI baseline. Server Worldbook Backup UI is not provided; an Operator-level consistent backup remains required.

## Rollback requirement

**Code Tag rollback is not Schema 3 data rollback.** Returning to old 10C/10B Server requires stopping writes and restoring the matching pre-upgrade paired backup. Keep historical annotated tags/Releases as immutable code baselines; neither branch retirement nor package rollback restores user data.

## Known unverified boundaries

Complete physical-phone manual matrix, all WebKit combinations, extreme software-keyboard/zoom combinations, large real-NAS Worldbook benchmark, long-session heap profiles and extreme cross-device concurrency remain unclaimed. Native reads may be whole-book; substring/facet/seeded SQL costs grow with scope. Server Random Tag needs a contextual full-scope contract; Server all-disable needs a stable full-scope plan. Video and a Worldbook Backup product are deferred.

## Final acceptance

Phase 10 feature scope is accepted for formal release with the stated evidence boundaries. Release completion additionally requires Server-first and then Frontend merge/release verification, matching pair versions, exact main/tag ancestry, release checksums and formal artifact Smoke. Both unchanged Stage heads may be retired only after these gates; deleting refs does not remove preserved main ancestry. New Worldbook work starts from v0.53.0 / v0.10.0 on a new Stage.
