# Server engineering and sustainable growth

This is the current cross-module engineering guide. README owns installation and operator policy; protocol/README.md owns public contracts; the domain guides own data semantics. PHASE-*-ACCEPTANCE.md files preserve historical evidence, not active branch instructions or permanent prohibitions on future features. Current executable code and reproducible host behavior take precedence over historical prose.

## Reviewed baseline and assessment

2026-10-06: Server v0.8.0 main `72fa6d7d756a49c70d4e6c4da4e58ba27a9e3127`, paired with Frontend v0.51.0 main `406fa290eff0824a94ec413801712e69b6137e5b`, Protocol 1.0. The initial review changed documentation only; the retained branch now also implements the bounded Audio read and dependency hardening below. Its checkpoint continues the retained `stage/phase-8-audio-library` branch; after this additional commit, do not delete that branch based on an earlier ancestry check. Review and integrate the documentation before checking complete main coverage again. Package version, Protocol 1.0 and persisted schemas remain unchanged; product changes require candidate validation before release.

The Server is a reasonably separated modular monolith for one ST process and its authenticated users. Core composes capability modules; Network owns transport/policy; Media and Audio own independent file/metadata stores; Business/Localization own image references; Governance obtains references through providers; Audio Library owns product metadata, not file retention. These boundaries should be preserved. The review does not justify a rewrite, microservices or distributed storage.

Local Audio streaming uses a bounded 64 KiB buffer, backpressure and cancellation, without a Network dependency or whole-file buffering. Remote transport and localization have explicit size/concurrency/time/lease limits. Source identity, Asset digest, metadata and playback Session are separate. Revision checks, shared per-user coordinators, staged commit/recovery and fail-closed deletion remain important existing protections.

## Concrete growth risks

| Area | Current behavior | Next-change constraint |
| --- | --- | --- |
| Audio Library paging | Negotiated browse captures validated metadata under the Audio coordinator, scans matching files outside it, then validates again; continuation checks only its page | 60-second bounded presentation snapshots, explicit conflict/refresh. Legacy list remains fresh full-scan compatible. Metadata validation is still O(N); no claim of indexed paging |
| Audio Asset management | Negotiated browse calculates health/reference summary once per scan and rechecks page health; legacy list avoids its former duplicate page health checks | Summary describes scan time. Bindings/deletion never trust it; reference capture still validates the Source registry on each request |
| Lock duration | Browse/playbackPool file checks run outside the per-user write coordinator; capture/final validation remain inside | 4 file checks/read; 1 read/user and 4 globally. Writes can finish during enumeration; stale reads fail. Explicit full integrity checks and legacy list still hold their original locks; measure before redesigning those contracts |
| Synchronous work | SQLite calls, JSON validation/serialization, metadata scans and sorting execute in the ST process; image Governance also scans full catalogs/providers before paging | Measure event-loop delay and rows/files touched with realistic data. Async filesystem APIs alone do not make the whole path cheap. Adopt SQL indexes/queries or bounded snapshot reuse only with evidence and compatible contracts |
| Resource lifetime | User stores initialize lazily and Maps retain them until shutdown; jobs/streams have explicit cleanup | Suitable for current small-user deployment; many-user growth needs open-DB/file-descriptor and memory measurements. If adding idle eviction, protect in-flight operations and persist durable state first |
| Composition | `src/core.js` composes modules but still contains substantial Image/Business/Localization/Governance routing; Audio routes are already extracted | New business routes belong to domain route modules, sharing authentication/protocol/error helpers. Do not add another independent security gate or a generic arbitrary-KV endpoint |

Frontend incremental media observation and owned bootstrap cleanup are now implemented on the paired candidate. All-at-once JS/CSS remains a separate issue; moving more features to the Server does not automatically solve browser cost. Frontend ARCHITECTURE.md / HANDOFF.md own their findings and priority.

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

## Development check coverage

`npm run check` retains the complete unit/HTTP test gate, then runs `npm run check:syntax`. `scripts/check-syntax.mjs` resolves the project from its own location, recursively discovers every regular `.js` file under `src/`, adds the required `index.js`, sorts the source paths and invokes the current Node executable with `--check` for each. Missing files/directories, source symlinks or failed syntax checks fail the command; imports and plugin initialization are not executed. Do not maintain another handwritten source allowlist when adding modules.

The current gate covers 35 files; the former 28-file list omitted Audio scan/errors/read sessions, Governance index/coordination and Network index/destination. This count is evidence of the corrected coverage, not a fixed future target. Temporary-project tests verify a new unimported nested file with spaces in its name is checked, execution from another working directory works without executing imports/entry code, and a missing required entry fails. These development checks do not change runtime capabilities or schemas and cannot establish installed-host performance.

## Review evidence and remaining gates

The local runtime was Node v24.19.0. An attempted complete `npm run check` encountered Linux abstract Unix socket `listen EPERM`; Network policy mutation correctly failed closed. A separate minimal abstract-socket probe reproduced EPERM. The full run was stopped when lock-related tests could not complete. Production locks and test expectations were not weakened to make this environment pass.

A separate diagnostic run selected the 119 tests unrelated to the eight process-lock-dependent cases: 119 passed, 0 failed. Node's selection excludes those eight before its reported count; this is not a 127-test full-suite pass. The excluded cases are the policy HTTP mutation test in core.test.js and seven network-policy cases covering successful mutation, concurrent edits, input/DNS checks after mutation, persistence failures, legacy artifact, killed/paused lock ownership and independent managers. They still belong to the unmodified full CI gate.

The already-published baseline's [Privacy and Core checks](https://github.com/SurgeXW0508/tavern-toolbox-server/actions/runs/37342752395) at the exact main SHA above completed successfully. That is baseline CI evidence, not proof of NAS performance, and not a replacement for checking subsequent code changes. The initial documentation checkpoint retained the same runtime code/tests. Publication privacy checks remain required before synchronization.

The review used real Source/Asset/Library stores, distinct temporary user roots and real SQLite/files for a read-amplification experiment. Each synthetic file was 64 bytes; it exercises enumeration/stat, not audio decode, HTTP or NAS I/O. Wrapping the original quick method counted calls without modifying production source:

| Assets N | First-page quick checks | Full-library pages P | Full-library quick checks | One local sample: first / full read |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 50 | 1 | 50 | 7.0 / 4.9 ms |
| 200 | 200 | 4 | 800 | 21.2 / 100.2 ms |
| 500 | 500 | 10 | 5,000 | 33.6 / 336.1 ms |
| 1,000 | 1,000 | 20 | 20,000 | 84.2 / 2,703.1 ms |

The deterministic finding is N×P repeated health checks for a full selected library. These single timings are not a benchmark SLA: warm filesystem caches and concurrent machine load affect them. Before materially expanding the music library, measure actual NAS 200–500-track first-play latency, page/summary cost, concurrent control latency and lock waiting; preserve all 4096-item bounds, snapshot/health guarantees and Source/Asset identity during optimization. Raising limits or only changing the UI page size is insufficient.

For future lifecycle/performance changes compare a pinned baseline and candidate with the same dataset/runtime. Include cold and warm reads; cancel, disconnect, restart, quota failure and unknown/corrupt schema; count live streams/jobs/handles before and after repeated operations. Establish device-specific latency budgets from measurements; use operation counts and finite resource bounds as deterministic regression gates. Long-session heap/event-loop behavior and installed-NAS performance were not measured in this review.

## CI follow-up at this review checkpoint

At documentation commit `de01009a13197f384a4929ca9fe4afd38d93561b`, [Privacy and Core checks](https://github.com/SurgeXW0508/tavern-toolbox-server/actions/runs/37349335345) passed. The first [Candidate CI attempt](https://github.com/SurgeXW0508/tavern-toolbox-server/actions/runs/37349335269/attempts/1) passed 126 of 127 tests; the shared-reference deletion case in `test/audio-assets.test.js` stopped with `localization did not finish`. All eight locally blocked policy/lock cases passed there. One rerun of the unchanged commit passed `npm run check`; this indicates an intermittent test failure, not a demonstrated product regression or a completed fix. That checkpoint's fixture waited at most 10,000 `setImmediate` iterations. The current helper uses a 5-second elapsed-time deadline and reports terminal state/code on timeout; do not hide repeated failures through retries or weaken deletion/reference assertions.

Dependency triage is now recorded below. The earlier CI install summary is historical evidence, not the current runtime audit result.

## Product dependencies and host fixtures

On 2026-10-07, the product runtime dependency `sharp` was updated from 0.35.4 to exact 0.35.5, with matching platform packages and libvips packages in the lockfile. This resolves the affected dependency version in [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w); existing JPEG/PNG/WebP/GIF signature checks still reject SVG before Sharp. No format-policy workaround or schema change was introduced. The paired Frontend locks `source-map-js` 1.2.2 for [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).

Both repositories passed `npm ci --ignore-scripts`. The actual Linux Sharp load reports sharp 0.35.5 / vips 8.18.7 / rsvg 2.63.2; PNG encode/read and the existing Media/HTTP/Governance regressions pass locally. Frontend's complete `npm audit` and Server's `npm audit --omit=dev` report zero advisories at this checkpoint. This result is scoped to these lockfiles and the audit database at that time; it does not assess the installed ST host or prove future versions safe.

Server's complete development audit still reports seven affected package nodes (one low, one moderate, five high). They are development-only host compatibility fixtures, absent from an `--omit=dev` plugin installation:

| Fixture path | Current advisory scope | Maintenance direction |
| --- | --- | --- |
| `body-parser` 1.20.4 | Low: invalid limit configuration may disable enforcement | Retain the pinned ST middleware baseline; fixture configuration uses an explicit valid limit. Upgrade the host baseline in a separate compatibility change |
| `multer` 2.1.1 | High: multipart parsing, aborted upload cleanup and limit handling | Preserve the real raw-upload fixture for the reviewed host; a future baseline update must retain malformed/aborted upload and multipart-stream regressions |
| `qs` 6.14.2 via host middleware | Moderate: parsing/stringification DoS advisories | Review with the middleware dependency tree when updating the compatibility baseline |
| `proxy-agent` → `pac-proxy-agent` → `get-uri` → `basic-ftp` | Four high package nodes from the same FTP-listing parser advisory | Do not accept audit's proposed major downgrade to proxy-agent 5 merely to remove warnings. Validate the actual ST proxy stack and HTTPS/CONNECT behavior before changing this chain |

The fixture uses SillyTavern 1.19.0's proxy initialization at commit `7e8663cd9c184a550b37238218bdd32c6efc68e9` and pinned middleware versions within that host's dependency ranges. Keeping this baseline preserves compatibility evidence; it does not declare those libraries safe. Do not expose test fixtures as a server, copy these dev pins into product runtime, or use `npm audit fix --force` as an acceptance criterion. Host-owned middleware/proxy upgrades require host-level validation and cannot be achieved by changing the plugin's devDependencies alone.

## Implemented Audio read hardening (candidate)

The optional `audio.library/playbackPool` still returns a complete category-only pool, bounded by 4096 Assets / 4 MiB. It always scans fresh health and never reuses browse results. New clients negotiate `browse` for ordinary Library and Asset pages; legacy `list` remains available without changing cursor semantics. No schema, Source/Asset identity, stream validation, reference/deletion authority or Network policy changes are involved.

`AudioReadSessions` is one Audio-owned transient read/snapshot budget shared by Library and Assets. Capture/final validation use the existing per-user coordinator; filesystem checks run outside it. Metadata, category, Asset change stamps and relevant Source reference counts invalidate old results. Off-page external filesystem changes become visible on refresh; continuation pages recheck their own files. Snapshot summary is explicitly an observation, never deletion authority. Full limits, error codes and cancellation semantics are specified once in protocol/README.md. Close cancels reads, drains workers and clears snapshots before store closure; the Library drains only its own operations, allowing its independent restart.

The 1000-file real-Store regression compares identical ordering/content: legacy Library traversal 20,000 quick checks; negotiated browse traversal 1,950 (1000 first scan + 950 returned continuation rows); complete fresh playbackPool 1000. Query filtering happens before filesystem checks. Asset summaries scan once and continuation checks exactly its page. Synchronous metadata/reference capture and hashing remain O(N) per page; this is a reduction in expensive file I/O and write-lock occupancy, not a claim of O(pageSize) total work.

Suspended-file-I/O tests prove deletion can complete during Library browse, playbackPool and Asset browse; resumed reads reject rather than publish pre-delete data. Other regressions cover current-page file damage, metadata edits, user/context/query isolation, 60-second expiry, 2/user and 8/global eviction, 1/user and 4/global active budgets, output isolation, 4-worker cancellation/draining, shutdown, and cached orphan data refusing deletion after a new binding. HTTP checks preserve authentication, context, protocol and fixed response budgets. Actual NAS 200–500-track latency, long integrity-check lock duration and mobile responsiveness remain real-device gates.

Current local validation after adding the syntax-gate regressions: 133 passed, 0 failed in the diagnostic selection excluding the same eight abstract-socket-dependent cases; `check:syntax` passes all 35 current source/entry files. The environment's independently reproduced `EPERM` limitation remains; this is not a 141-test full-suite pass. CI runs the complete `npm run check`, including all tests and automatic syntax discovery. The localization test helper keeps its elapsed-time wait; no production locks or deletion assertions were weakened.
