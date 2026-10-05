# Server engineering and sustainable growth

This is the current cross-module engineering guide. README owns installation and operator policy; protocol/README.md owns public contracts; the domain guides own data semantics. PHASE-*-ACCEPTANCE.md files preserve historical evidence, not active branch instructions or permanent prohibitions on future features. Current executable code and reproducible host behavior take precedence over historical prose.

## Reviewed baseline and assessment

2026-10-06: Server v0.8.0 main `72fa6d7d756a49c70d4e6c4da4e58ba27a9e3127`, paired with Frontend v0.51.0 main `406fa290eff0824a94ec413801712e69b6137e5b`, Protocol 1.0. This review changes documentation only. Its checkpoint continues the retained `stage/phase-8-audio-library` branch; after this additional commit, do not delete that branch based on an earlier ancestry check. Review and integrate the documentation before checking complete main coverage again. No version, schema or product code change is implied.

The Server is a reasonably separated modular monolith for one ST process and its authenticated users. Core composes capability modules; Network owns transport/policy; Media and Audio own independent file/metadata stores; Business/Localization own image references; Governance obtains references through providers; Audio Library owns product metadata, not file retention. These boundaries should be preserved. The review does not justify a rewrite, microservices or distributed storage.

Local Audio streaming uses a bounded 64 KiB buffer, backpressure and cancellation, without a Network dependency or whole-file buffering. Remote transport and localization have explicit size/concurrency/time/lease limits. Source identity, Asset digest, metadata and playback Session are separate. Revision checks, shared per-user coordinators, staged commit/recovery and fail-closed deletion remain important existing protections.

## Concrete growth risks

| Area | Current behavior | Next-change constraint |
| --- | --- | --- |
| Audio Library paging | Every list page reads all Library metadata and `AudioAssetStore.inventory()`, checks every ready file with quick/lstat, filters/sorts and hashes the selected snapshot, then slices 50 results | Bounded response size is not bounded backend work. Avoid repeating the whole inventory for each page while preserving natural order, current eligibility, snapshot consistency and exact user isolation |
| Audio Asset management | `AudioAssetStore.list()` recomputes whole-library health/reference summary before producing each page | Separate cost of summary, page and explicit health checks; any cache needs identity/revision/invalidation and filesystem-change semantics. Do not silently turn stale health into deletion/playback authority |
| Lock duration | Library enumeration and sequential file checks run inside the same per-user Audio coordinator used for bindings/deletion | Measure queue wait and critical-section duration. Do not simply remove/move locking and reopen the reference/delete race. Prefer less work per coherent snapshot; cancellation and queue bounds also need review when concurrency grows |
| Synchronous work | SQLite calls, JSON validation/serialization, metadata scans and sorting execute in the ST process; image Governance also scans full catalogs/providers before paging | Measure event-loop delay and rows/files touched with realistic data. Async filesystem APIs alone do not make the whole path cheap. Adopt SQL indexes/queries or bounded snapshot reuse only with evidence and compatible contracts |
| Resource lifetime | User stores initialize lazily and Maps retain them until shutdown; jobs/streams have explicit cleanup | Suitable for current small-user deployment; many-user growth needs open-DB/file-descriptor and memory measurements. If adding idle eviction, protect in-flight operations and persist durable state first |
| Composition | `src/core.js` composes modules but still contains substantial Image/Business/Localization/Governance routing; Audio routes are already extracted | New business routes belong to domain route modules, sharing authentication/protocol/error helpers. Do not add another independent security gate or a generic arbitrary-KV endpoint |

Frontend whole-document media scans, all-at-once JS/CSS and exceptional bootstrap cleanup are separate issues; moving more features to the Server does not automatically solve browser cost. Frontend ARCHITECTURE.md / HANDOFF.md own their findings and priority.

## Long-term development rules

1. Define each module's public contract, state owner, dependencies, user scope, storage schema, failure isolation and shutdown behavior before extending it. Core is the composition root, not the owner of all business decisions. Share proven stable behavior through narrow interfaces; do not merge Image/Audio schemas to obtain superficial reuse.
2. Make work bounded end to end: input bytes, records, response size, concurrent requests/streams/jobs, retries, time, queueing and retained caches. Do not raise a capacity ceiling without measuring the operation at that ceiling. A paginated response, async function or smaller source file is not performance evidence.
3. Keep slow Network transfer outside reference-critical sections. All authoritative binding writes and external hard deletes still share the appropriate per-user coordinator. Design multi-store partial failure and restart recovery explicitly; do not claim an atomic transaction across independent stores or ST plugins.
4. Resource ownership includes failed initialization, request disconnect, cancellation, shutdown and cleanup failures. One failing module cleanup must not prevent attempts to release independent modules. Timers, listeners, buffers, streams, staging files, DB handles and user-scoped caches need an owner and finite lifetime. Do not keep a whole large file in memory to simplify code.
5. New caches require user/boot/snapshot identity, bounds, invalidation and an observable failure mode. Cached or incomplete reference/health data must not authorize deletion or bypass validation. Measure duplicate work before introducing caches.
6. Keep durable user data outside the code directory. Schema versions, public protocol versions and package versions are independent. Unknown newer/corrupt schemas fail closed without reset. Migrations preserve backups and interrupted-operation recovery; code rollback alone cannot restore data. No silent history pruning, automatic orphan deletion or fallback from corrupt Local to Remote.
7. Use capability negotiation rather than hard-coded package-version gates. Additive optional operations should preserve old clients and unavailable-module behavior. Breaking changes require an explicit migration and acceptance plan; do not increase the global Protocol version for an unrelated implementation refactor.
8. Preserve trusted ST user roots, Origin/CSRF/context checks, DNS/redirect/proxy controls and size/MIME policy when optimizing. Do not create a download or direct-network bypass. Privacy requirements remain in PRIVACY-AND-SECURITY.md, including author/committer metadata and public artifacts.
9. Tests should exercise observable behavior and cost: request counts, inventory/file checks, lock overlap, stream backpressure, cleanup, late results and failure recovery. Source-text assertions can guard structure but cannot prove runtime behavior. Keep existing safe failure/compatibility tests when splitting modules.
10. Keep current facts in current guides and historical evidence in acceptance records. Retire stale 'future/not implemented/this branch' instructions when a capability ships. Record remaining risk, not an ever-growing sequence of candidate reports. Review documentation together with the affected module.

## Review evidence and remaining gates

The local runtime was Node v24.19.0. An attempted complete `npm run check` encountered Linux abstract Unix socket `listen EPERM`; Network policy mutation correctly failed closed. A separate minimal abstract-socket probe reproduced EPERM. The full run was stopped when lock-related tests could not complete. Production locks and test expectations were not weakened to make this environment pass.

A separate diagnostic run selected the 119 tests unrelated to the eight process-lock-dependent cases: 119 passed, 0 failed. Node's selection excludes those eight before its reported count; this is not a 127-test full-suite pass. The excluded cases are the policy HTTP mutation test in core.test.js and seven network-policy cases covering successful mutation, concurrent edits, input/DNS checks after mutation, persistence failures, legacy artifact, killed/paused lock ownership and independent managers. They still belong to the unmodified full CI gate.

The already-published baseline's [Privacy and Core checks](https://github.com/SurgeXW0508/tavern-toolbox-server/actions/runs/37342752395) at the exact main SHA above completed successfully. That is baseline CI evidence, not proof of NAS performance, and not a replacement for checking subsequent code changes. This documentation checkpoint retains the same runtime code/tests. Publication privacy checks remain required before synchronization.

The review used real Source/Asset/Library stores, distinct temporary user roots and real SQLite/files for a read-amplification experiment. Each synthetic file was 64 bytes; it exercises enumeration/stat, not audio decode, HTTP or NAS I/O. Wrapping the original quick method counted calls without modifying production source:

| Assets N | First-page quick checks | Full-library pages P | Full-library quick checks | One local sample: first / full read |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 50 | 1 | 50 | 7.0 / 4.9 ms |
| 200 | 200 | 4 | 800 | 21.2 / 100.2 ms |
| 500 | 500 | 10 | 5,000 | 33.6 / 336.1 ms |
| 1,000 | 1,000 | 20 | 20,000 | 84.2 / 2,703.1 ms |

The deterministic finding is N×P repeated health checks for a full selected library. These single timings are not a benchmark SLA: warm filesystem caches and concurrent machine load affect them. Before materially expanding the music library, measure actual NAS 200–500-track first-play latency, page/summary cost, concurrent control latency and lock waiting; preserve all 4096-item bounds, snapshot/health guarantees and Source/Asset identity during optimization. Raising limits or only changing the UI page size is insufficient.

For future lifecycle/performance changes compare a pinned baseline and candidate with the same dataset/runtime. Include cold and warm reads; cancel, disconnect, restart, quota failure and unknown/corrupt schema; count live streams/jobs/handles before and after repeated operations. Establish device-specific latency budgets from measurements; use operation counts and finite resource bounds as deterministic regression gates. Long-session heap/event-loop behavior and installed-NAS performance were not measured in this review.
