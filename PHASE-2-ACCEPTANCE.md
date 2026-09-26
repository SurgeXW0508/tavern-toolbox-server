# Phase 2 Network Foundation acceptance

Branches reviewed: Server `stage/phase-2-network-foundation`; Frontend `stage/phase-2-server-network-client`. This record closes the pre-merge acceptance gate; repository merge and release status are tracked on GitHub.

## Code-side verification

- Core discovery and Protocol 1.0 remain readable with Network disabled or degraded. An older Phase 1 config defaults Network to disabled; malformed Network policy is isolated from Core.
- `network.remoteFetch` contract 1.0 advertises the image profile, JPEG/PNG/WebP/GIF, transport kind, destination policy and finite effective limits. Successful POST sends validated binary; errors use the Protocol 1.0 JSON envelope.
- Tests cover exact URL and allowlist matching, IDN normalization, IPv4/IPv6 special addresses, mixed DNS fail-closed, redirect blocking, MIME/signature, streamed size, rate limits, real router auth/CSRF/Origin and binary response, explicit HTTP proxy IP authority, HTTPS CONNECT pinned IP plus hostname SNI/Host and certificate rejection, and proxy failure without direct fallback.
- The real HTTP route test covers proxy failure → Network degraded (fetch still available) → proxy recovery → successful fetch → Network ready, without restarting the Server.
- Transport fixtures also replace both host global Agents with constructors that reject inherited requests and set host proxy environment variables. Explicit proxy HTTP and HTTPS CONNECT plus direct HTTP/HTTPS still reach only their selected peer; CONNECT uses the approved IP while TLS retains hostname SNI, Host and certificate verification. A real proxy socket failure followed by recovery returns Network to ready.
- These simulated Agents did not reproduce the installed-host failure in `8021daa`. The added host-proxy regression uses the real SillyTavern-locked ProxyAgent and equivalent initializer side effects. It reproduces `ERR_INVALID_PROTOCOL` on the old transport and passes with explicit request protocols: before initialization, after initialization, host API proxy coexistence, and failure/recovery. See [root cause and fixture equivalence](docs/NETWORK-HOST-PROXY-REGRESSION.md). The real host chain was subsequently verified by the user.
- Frontend tests cover absent Server, old Server capability absence, authenticated same-origin POST, binary result, operation abort, UI status and Object URL cleanup. Full Local regression and build pass.
- `npm run audit:privacy` checks the public Server source and Git metadata. Public docs contain illustrative addresses only.

## Verified on the installed host (user report)

- Official SillyTavern Web 1.19.0 on Docker/NAS loads both plugins; 柏宝库 coexists and Core stays ready.
- Network reaches ready with the configured explicit HTTP proxy; an allowlisted HTTPS image is fetched through the Server and proxy, including from a phone. SillyTavern's own requestProxy behavior coexists.
- A non-allowlisted target is rejected. Disabling Network leaves Core and existing Local Toolbox functionality intact.
- Stopping the proxy causes Remote Fetch failure; restoring it permits a successful retry without restarting SillyTavern. The backend health transitions are visible through authoritative status, although the previous frontend display lagged.

## Final real-host UI acceptance (user confirmation, 2026-09-26)

- The frontend displays Network degraded immediately after failed Fetch with the proxy stopped and ready immediately after a successful retry with the proxy restored.
- The compact Server Dialog, image preview, scrolling, close actions and mobile soft-keyboard layout were accepted on the real Web Tavern.
- This confirmation closes the two remaining UI checkpoints for Phase 2.

The route-level automated suite covers authentication, CSRF, Origin, URL/DNS/IP and resource rejection. This document does not claim each negative security case was separately exercised on the installed host. Keep real URL query values, session tokens, proxy endpoints and private addresses out of public evidence. The user confirmed both UI checkpoints on 2026-09-26. Phase 2 is accepted for merge. The confirmation is scoped to those observed behaviors and the earlier installed-host checks.
