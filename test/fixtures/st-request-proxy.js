import http from 'node:http';
import https from 'node:https';
import { ProxyAgent } from 'proxy-agent';

// Equivalent enabled/valid-config path of SillyTavern 1.19.0 initRequestProxy:
// https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/src/request-proxy.js
// Use the real locked ProxyAgent implementation, including its stack-sensitive
// protocol getter. Only URL validation, warning and console formatting are omitted.
export function initRequestProxy({ url, bypass = [], enableKeepAlive = false }) {
    process.env.all_proxy = url;
    if (bypass.length) process.env.no_proxy = bypass.join(',');
    const agent = new ProxyAgent({ httpAgent: http.globalAgent, httpsAgent: https.globalAgent,
        keepAlive: enableKeepAlive });
    http.globalAgent = agent;
    https.globalAgent = agent;
    return agent;
}
