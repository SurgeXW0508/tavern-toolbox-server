# Phase 2 Network candidate checkpoint

Branches: Server `stage/phase-2-network-foundation`; Frontend `stage/phase-2-server-network-client`. Neither branch is a release or an accepted NAS installation.

## Code-side verification

- Core discovery and Protocol 1.0 remain readable with Network disabled or degraded. An older Phase 1 config defaults Network to disabled; malformed Network policy is isolated from Core.
- `network.remoteFetch` contract 1.0 advertises the image profile, JPEG/PNG/WebP/GIF, transport kind, destination policy and finite effective limits. Successful POST sends validated binary; errors use the Protocol 1.0 JSON envelope.
- Tests cover exact URL and allowlist matching, IDN normalization, IPv4/IPv6 special addresses, mixed DNS fail-closed, redirect blocking, MIME/signature, streamed size, rate limits, real router auth/CSRF/Origin and binary response, explicit HTTP proxy IP authority, HTTPS CONNECT pinned IP plus hostname SNI/Host and certificate rejection, and proxy failure without direct fallback.
- The real HTTP route test covers proxy failure → Network degraded (fetch still available) → proxy recovery → successful fetch → Network ready, without restarting the Server.
- Transport fixtures also replace both host global Agents with constructors that reject inherited requests and set host proxy environment variables. Explicit proxy HTTP and HTTPS CONNECT plus direct HTTP/HTTPS still reach only their selected peer; CONNECT uses the approved IP while TLS retains hostname SNI, Host and certificate verification. A real proxy socket failure followed by recovery returns Network to ready.
- Frontend tests cover absent Server, old Server capability absence, authenticated same-origin POST, binary result, operation abort, UI status and Object URL cleanup. Full Local regression and build pass.
- `npm run audit:privacy` checks the public Server source and Git metadata. Public docs contain illustrative addresses only.

## Installed-host verification still required

1. Confirm official SillyTavern Web 1.19.0 starts both plugins and 柏宝库 remains available; Core status still responds.
2. Put the real trusted Origin, allowed public image host and explicit HTTP proxy endpoint only in the private administrator config. Restart and confirm Network ready.
3. In the Toolbox global settings, fetch an allowed HTTPS image from desktop and a representative phone/tablet, preview it, cancel a request and close the page. Check that closing/replacing releases the preview.
4. Check non-allowlisted domain, private/overlay address, invalid URL, missing/invalid user context, CSRF and Origin are rejected by the real SillyTavern middleware. Confirm browser inability to reach the image does not affect a Server fetch through the configured proxy.
5. With SillyTavern `initRequestProxy()` active, stop the proxy and observe an explicit failure without direct fallback; restart it and confirm recovery without restarting SillyTavern. Disable Network and confirm Core and Local Toolbox still work. Confirm no Media file, Regex edit or persistent proxy URL was created.

Do not move to Phase 3 or merge/release on the basis of in-process HTTP fixtures alone. Do not record real URL query values, session tokens, proxy endpoints or private addresses in public issues, logs or test fixtures.
