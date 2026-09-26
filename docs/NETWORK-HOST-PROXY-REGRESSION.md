# SillyTavern 1.19.0 request proxy regression

## Reproduction and cause

The installed-host report remained reproducible on `8021daa`: a complete Network image fetch succeeded in a standalone process, but failed after SillyTavern `initRequestProxy()` ran. Synthetic global Agent replacements had missed a behavior of the real dependency.

Development reproduction used the original [SillyTavern 1.19.0 initializer](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/src/request-proxy.js), with only the unrelated URL-validation and console-color utilities substituted, and a disposable local HTTP proxy/TLS PNG origin. The initializer function itself was unchanged. The [host lockfile](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/package-lock.json) selects `proxy-agent` 6.5.0, `agent-base` 7.1.3 and `https-proxy-agent` 7.0.6.

A development-only wrapper around the real `openApproved()` retained the raw error before Network normalized it. Before initialization, CONNECT, verified TLS and the complete PNG fetch succeeded. After initialization the original failure was:

```text
TypeError [ERR_INVALID_PROTOCOL]: Protocol "https:" not supported. Expected "http:"
ClientRequest → http.request → tunnel Agent.createConnection
             → https.request → openApproved → fetchImage
```

This fails during CONNECT request construction, before the proxy socket is opened:

1. Node's HTTP ClientRequest defaults an absent `options.protocol` from `defaultAgent.protocol`, even when `options.agent` is explicitly supplied.
2. SillyTavern installs the same real ProxyAgent in both global Agent slots.
3. Its agent-base protocol getter infers HTTPS from an enclosing `https.request()` stack frame.
4. Network creates its HTTP CONNECT synchronously inside the outer HTTPS request's Agent connection callback. The omitted protocol therefore defaults to HTTPS, while Network's explicitly owned HTTP Agent requires HTTP.

The fix specifies the protocol on every Network ClientRequest, including `http:` for the CONNECT control request. Own Agents, approved-IP sockets, original hostname TLS verification and all destination policies are retained. Production does not alter host Agents or proxy environment. No raw errors or extra target details are added to production responses/logs.

## Automated fixture equivalence

`test/fixtures/st-request-proxy.js` implements the enabled, valid-configuration branch of that initializer using the real locked ProxyAgent, including its stack-sensitive protocol getter. It performs the same relevant state changes:

- Set `all_proxy` to the configured proxy.
- Set `no_proxy` when bypass entries exist.
- Capture the previous HTTP and HTTPS Agents.
- Construct ProxyAgent with those Agents and the configured keep-alive value.
- Assign the same ProxyAgent to both global Agent slots.

Only validation of already-valid fixture inputs, the private-filter warning and console formatting are omitted. Global Agent/environment restoration exists solely in isolated test cleanup. The fixture does not substitute Agent networking methods or the protocol getter.

`test/host-proxy.test.js` exercises complete `createNetwork().fetchImage()` with real `openApproved()`, a public approved DNS answer, an IP CONNECT proxy fixture and a certificate for the original hostname. Only fixture DNS and the test CA are injected. The proxy maps known synthetic authorities to the local TLS fixture without external service access.

Verified behavior:

- Full validated PNG before and after host proxy initialization.
- CONNECT receives the approved IP; upstream receives original SNI and Host.
- Ordinary HTTPS requests without a TTB Agent override continue through the host global proxy, with an authorized TLS certificate.
- Proxy socket failure produces `TRANSPORT_UNAVAILABLE` and degraded health; retry after recovery returns PNG and ready health without reinitializing either module.
- TTB operations preserve the host Agent identities and proxy environment values.

Running the new regression against the `8021daa` transport fails with the same `ERR_INVALID_PROTOCOL`; applying explicit protocols passes. Existing certificate-rejection, SSRF, redirect, abort and resource tests remain required. Test dependencies are development-only. Install with `npm ci --ignore-scripts`, then run `npm run check` and `npm run audit:privacy`.

## Installed-host verification

Code reproduction established this failure mechanism and its correction. The user subsequently verified the actual SillyTavern requestProxy and Toolbox Remote Image Test together on the installed NAS, including a proxy stop/restart and successful retry without restarting SillyTavern. Keep real targets, query strings, proxy configuration and session material out of public evidence. The remaining Phase 2 acceptance checks concern immediate Network health refresh in the frontend and the real mobile Dialog layout; see [PHASE-2-ACCEPTANCE.md](../PHASE-2-ACCEPTANCE.md).
