# Phase 8 — Audio Library Acceptance

Status: joint Frontend Media Center Audio UI and Legacy Workspace Final Cutover core real-device acceptance confirmed by the user; Release Closeout approved. Formal versions: Frontend v0.51.0 / Server v0.8.0 / Protocol 1.0. Accepted product candidates: Frontend `609268cbcdb5c54093ede674d77b506dc00d2338`, Server `451c9c5ac3326c38e2003af1f27129633e8f8c8b`.

## Scope and architecture

The additive audio.library capability owns music display metadata only. Each authenticated ST user has a separate audio-library-v1/library.sqlite; Asset ID is music identity, so multiple Sources sharing an Asset do not create duplicate tracks. Existing healthy Local Assets appear without import or migration. The library does not own files, change Source/backend state or form an Asset retention lock.

Titles follow user > first valid automatic > unnamed priority. Each Track has at most one flat category and visible/hidden state. Track and Category revisions use CAS; category deletion atomically returns affected tracks to uncategorized. Asset deletion coordinates metadata cleanup, while cleanup failure must not prevent deletion; listing also reconciles interrupted cleanup. Normal playback excludes hidden/unhealthy tracks.

List uses bounded 50-item natural-title pages, stable Asset-ID tie order and snapshot/query-bound cursors, with a 4096-item limit. Frontend separately reads the complete selected logical category; Server stores no Player Session, queue, volume or history. Protocol remains 1.0. Source / Asset / Network / Governance / Business / Localization semantics are unchanged. Back up audio-library-v1 together with audio-assets-v1 and audio-sources-v1 while ST is stopped; code rollback does not restore user data.

## Automated evidence

The committed test/audio-library.test.js and HTTP contracts cover legacy Assets, shared-Asset identity deduplication, title priority and persistence, category creation/rename/delete, visibility/health eligibility, concurrent revision CAS, bounded paging and stale cursor rejection, deletion coordination/reconciliation and cross-user isolation. Candidate CI runs the complete regression and syntax checks; Privacy/Core Checks and audit:privacy validate tracked files and privacy boundaries. Existing Source / Asset / streaming / Network / Governance tests remain in the release gate. These results are automated evidence, not claims that the entire failure matrix was manually tested. The restricted local execution environment denies Linux abstract IPC (EPERM), preventing the unchanged Network process-lock matrix from completing locally; full Candidate CI / Privacy-Core / Release execution on the Linux runner is required. Kernel locks and tests are neither weakened nor skipped for this environment.

## Real-device evidence

Joint validation used SillyTavern 1.19.0 Docker / NAS and the paired Frontend. The user confirmed existing Local Assets appearing as music, metadata UI and Audio playback, Media Center Audio UI, and the final entry cutover: no independent top-level Music, Library / Character Audio / Manage accessible, normal playback, Mini Player controlling the same Session after Center closes, and Server / Remote management entries reaching Media Center.

This aggregate confirmation does not turn all concurrent races, cross-user negatives, crash recovery, SQLite damage or physical touch / keyboard combinations into installed-host Passed. The Frontend TESTING.md preserves detailed automated/browser evidence and manual scope.

## Known non-blocking boundary and release-package smoke

The 200–500-track full-category first-play NAS latency has not been specifically quantified. Library paging currently reuses complete inventory health inspection rather than a new index; this is an existing scale boundary, not a Closeout product change.

Formal GitHub Release package smoke remains a separate user confirmation: load the music library, play one track, close Center and control the same playback through Mini Player, and enter Manage / storage / network. Retain both stage/phase-8-audio-library branches until this smoke passes, then verify each stage is a main ancestor with ahead=0 before deletion. No product changes are included in Release Closeout.
