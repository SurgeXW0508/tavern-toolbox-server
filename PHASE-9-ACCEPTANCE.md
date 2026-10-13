# Phase 9 — Image Domain Acceptance

Status: Phase 9 desktop core accepted by the user on 2026-10-13; released as Frontend v0.52.0 / Server v0.9.0 / Protocol 1.0. This is a final evidence record, not a development plan.

## Feature candidate and release identities

- Accepted Frontend feature candidate: `ce933a3ec38b78fd618bafb55fec1116c5c0a29e`.
- Accepted Server feature candidate: `156dc5bc6d91ffe17e04ae39cb62876e2ec532a1`.
- Release Prep: final stage commits titled `chore(release): prepare Phase 9 frontend v0.52.0` and `chore(release): prepare Phase 9 server v0.9.0`. They update versions and release documentation without new product behavior.
- Immutable release commits: Frontend annotated tag `v0.52.0`, Server annotated tag `v0.9.0`. Each tag points to its main merge commit; its second parent (`v0.52.0^2` / `v0.9.0^2`) identifies the corresponding Release Prep commit. Git history and published release workflows resolve the exact SHAs; feature candidates and release commits are distinct.

## Automated evidence

The accepted Frontend passed 1,753 tests and build, with Frontend CI success. Server Candidate CI and Privacy/Core checks succeeded with the original full regression gates. Release Prep and main publication repeat dependency installation, complete checks and privacy validation; both release workflows build from their immutable release commits and download assets again to verify SHA-256 checksums.

Source/CSS Chromium fixtures cover desktop, short height, tablet, tablet landscape, phone Compact and phone landscape, plus earlier small-viewport/dark-theme cases. Targeted tests cover empty Active browse/count exclusion, 49 populated Groups mixed with 49 empty scopes (24/24/1 paging), retained empty Detached rebind/removal, unavailable Provider health, Avatar success/fallback structure, technical-field wrapping and Audio style isolation. Store/SQLite/HTTP/concurrency regressions cover CAS, identity, shared assets, missing resources and fail-closed deletion.

The local execution environment restricts Linux abstract IPC, so the unchanged Network policy-lock matrix cannot fully pass locally. Full Candidate CI, Privacy/Core and Release run these tests on the Linux runner; no production locks or tests are weakened or skipped in those gates.

## Installed-host evidence

Environment: SillyTavern 1.19.0, Docker / NAS, Desktop. The user confirmed Phase 9 core acceptance, including Image Library, Sort/Filter presentation, Original/GIF Viewer, Detail, Picker confirmation, Consumer Overview/Collection, Character Avatar and Outfit type labels, Group single-image display, Reference Replace/Unlink, Detached record removal/cleanup/Rebind, Group maintenance and shared/reference-safe cleanup, Governance Hard Delete, Manage and Remote Image/Network. No obvious issue remained after the final tiny polish.

This aggregate desktop confirmation does not claim manual execution of every failure, race, cross-account or corruption scenario.

## Explicit limits and compatibility

- No complete physical-phone manual matrix was rerun. Compact/Tablet/landscape evidence is automated Chromium fixture evidence, not all WebKit or touch/keyboard combinations.
- No large real-NAS image catalog benchmark was performed. Governance still uses full Catalog/reference analysis; UI paging is not indexed query cost.
- No Video Domain or Worldbook Media Integration. Worldbook Cover keeps its existing storage path.
- No persistent schema migration, Character/Asset identity change or automatic GC. Existing Media Assets, MediaRefs and Character/Outfit records remain compatible in place.
- Hard Delete remains Governance-owned and requires complete current Reference Analysis. Detached records continue protecting referenced assets.
- Audio and Image data planes remain independent. Public Media Center presentation may support a future Domain without introducing a shared Image/Video business model.

The Phase 9 stage branches are retired after verified releases and ancestry/unchanged-head checks. Subsequent work starts from latest main on a new branch.
