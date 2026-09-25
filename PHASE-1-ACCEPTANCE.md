# Phase 1 candidate verification (development branch)

This is a code-side review record, **not** an installed SillyTavern acceptance certificate. The corresponding frontend branch is `stage/server-core-client-phase-1`; the server branch is `stage/phase-1-core-foundation`. Frontend stable baseline is v0.46.0, remote main `da27b7a78e834939018c204ad4488e6b2da6d1bd`. Do not merge either branch or publish a release before the user's real-host review.

| ID | Code-side evidence | Real-environment boundary |
| --- | --- | --- |
| P1-01 | Client absent test, nonblocking startup wiring, full frontend regression | Official Web without plugin still needs confirmation |
| P1-02 | Missing-host test causes zero requests; no login prompt | Actual TT phone/tablet pending |
| P1-03 | HTTP server test, fixed wire fixture, exact single `core.status`; default relative ST `DATA_ROOT` config path is normalized | NAS `/status` now returns `ok=true/coreState=ready`; full frontend discovery/status presentation still pending retest |
| P1-04 | 1.0 negotiation, incompatible range stops versioned request, release-independent Client test | Additional real version combinations pending |
| P1-05 | Client ignores unknown optional response data/unknown capability; never executes dynamic operation | — |
| P1-06 | Client covers timeout, network error, gateway 502, HTML 200, historical success distinction | Reverse proxy failure modes pending |
| P1-07 | 401/403 categorized AccessBlocked, no retry/data write | Real host CSRF/session chain pending |
| P1-08 | Fixture initialization failure and dependent isolation over HTTP, independent capability available | — |
| P1-09 | Duplicate module, dependency cycle, invalid config tests; fail-closed reasons | — |
| P1-10 | Distinct host user context via HTTP, query user ignored, missing identity 403, per-user health; relative ST `directories.root` is normalized before deriving context identity | Real NAS single-user authenticated `/status` succeeds; account change pending |
| P1-11 | Abort on destroy/invalidate, accountStorage change invalidates 30-second cache, stale late response cannot overwrite the newer history, no poll; UI unsubscribe | Actual script reload and host account switching pending |
| P1-12 | HTTP router rejects absent user; unsafe mutation gate tested without production write route | **Not passed as installed-host gate**: real SillyTavern auth/CSRF/cross-origin rejection and loader order pending |
| P1-13 | Production routes only read status, no DB/module media/network registration; no Local business-key writes | Runtime audit in NAS pending |
| P1-14 | Diff restricted to core client and status UI; all prior Local repositories untouched | Asset/Genesis/Worldbook real regression pending |
| P1-15 | Server Scope resolution forbids Local persistence on four failing states; Local writer invoked zero times | Future Server provider integration explicitly out of scope |
| P1-16 | End-to-end 5-second budget, response 256 KiB cap, manual refresh coalescing and 1-second spacing, abort test | Slow real reverse proxy pending |
| P1-17 | DOM status/refresh/preview/copy path, diagnostics whitelist and HTML escaping; single global gear menu reachable from AI/Worldbook/Oracle/Assets App | **Three viewport final rendering/touch audit pending** |
| P1-18 | Bounded shutdown, request rejection, boot/context rotation, no DB | NAS restart and Docker mount behavior pending |
| P1-19 | Dedicated ID/namespace, config outside plugin source, no host monkeypatch | NAS reports Core plugin loaded and 柏宝库 continues working; expanded cross-user/long-running coexistence still pending |
| P1-20 | Frontend full `npm run check`, including old Local tests | Key user flows in real official Web/TT pending |
| P1-21 | Installation checklist in README | **Partial real evidence:** NAS Core `/status` ready, 柏宝库 working, and direct Web fetch returns HTTP 200. Fixed frontend Client, restart, TT, and three viewport checks pending; no release acceptance claim |
| P1-22 | Source diff reviewed: no Network/Media/SQLite/Jobs, proxy, migration, standalone UI or generic RPC | — |

Automated runs on the candidate: server `npm run check` (including relative-root regression tests and syntax checks); frontend `npm run check` (all existing tests plus Server client/UI tests and build); additionally a disposable live HTTP harness loaded actual Server Core and actual frontend Client in one process and observed `Available` plus `core.status/read`. A browser-receiver timer fixture reproduces the prior request-preparation failure and passes after binding the timer to its Window. The disposable HTTP harness emulates router mount and `req.user`; it does not emulate or prove SillyTavern security middleware. Re-run all checks after the final branch commit.
