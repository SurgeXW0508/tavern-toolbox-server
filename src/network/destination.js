import dns from 'node:dns/promises';
import net from 'node:net';
import { domainToASCII } from 'node:url';

const denied4 = new net.BlockList();
const v4 = (...octets) => octets.join('.');
for (const [address, prefix] of [
    [v4(0,0,0,0), 8], [v4(10,0,0,0), 8], [v4(100,64,0,0), 10], [v4(127,0,0,0), 8],
    [v4(169,254,0,0), 16], [v4(172,16,0,0), 12], [v4(192,0,0,0), 24],
    [v4(192,0,2,0), 24], [v4(192,88,99,0), 24], [v4(192,168,0,0), 16],
    [v4(198,18,0,0), 15], [v4(198,51,100,0), 24], [v4(203,0,113,0), 24],
    [v4(224,0,0,0), 4], [v4(240,0,0,0), 4],
]) denied4.addSubnet(address, prefix, 'ipv4');
const public6 = new net.BlockList();
public6.addSubnet('2000::', 3, 'ipv6');
const denied6 = new net.BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32],
    ['2002::', 16], ['3fff::', 20]]) denied6.addSubnet(address, prefix, 'ipv6');

export function publicUnicast(address) {
    const type = net.isIP(address);
    if (type === 4) return !denied4.check(address, 'ipv4');
    if (type === 6) return !/^::ffff:/i.test(address)
        && public6.check(address, 'ipv6') && !denied6.check(address, 'ipv6');
    return false;
}

export class NetworkFailure extends Error {
    constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new NetworkFailure(code); };

export function canonicalHost(host) {
    if (net.isIP(host)) return host.toLowerCase();
    const ascii = domainToASCII(host.replace(/\.$/, '')).toLowerCase();
    if (!ascii || ascii.length > 253 || ascii.split('.').some(label =>
        !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) fail('TARGET_NOT_ALLOWED');
    return ascii;
}

export function parseTarget(raw, policy, previous) {
    if (typeof raw !== 'string' || raw.length > 2048 || /[\u0000-\u0020\u007f]/.test(raw)
        || raw.includes('\\') || raw.includes('#')) fail('TARGET_NOT_ALLOWED');
    let url;
    try { url = new URL(raw); } catch { fail('TARGET_NOT_ALLOWED'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname
        || url.hash || url.port || (url.protocol === 'http:' && (!policy.allowHttp || previous?.protocol === 'https:')))
        fail('TARGET_NOT_ALLOWED');
    // URL erases explicit default ports; even an explicit :443 is allowed only for HTTPS.
    const authority = raw.match(/^https?:\/\/([^/?#]+)/i)?.[1] || '';
    const port = authority.match(/:(\d+)$/)?.[1];
    if (port && Number(port) !== (url.protocol === 'https:' ? 443 : 80)) fail('TARGET_NOT_ALLOWED');
    const host = canonicalHost(url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname);
    if (policy.destinationPolicy === 'allowlist-only' && !policy.allowlist.some(entry => {
        const wildcard = entry.startsWith('*.');
        const domain = canonicalHost(wildcard ? entry.slice(2) : entry);
        return wildcard ? host.endsWith(`.${domain}`) && host !== domain : host === domain;
    })) fail('TARGET_NOT_ALLOWED');
    return { url, host, port: url.protocol === 'https:' ? 443 : 80 };
}

export async function approveDestination(raw, policy, previous, resolver = dns) {
    const target = parseTarget(raw, policy, previous);
    if (net.isIP(target.host)) {
        if (!publicUnicast(target.host)) fail('DNS_UNSAFE');
        return { ...target, addresses: [target.host] };
    }
    const answers = await Promise.all([resolver.resolve4(target.host), resolver.resolve6(target.host)].map(p =>
        p.catch(error => ['ENODATA', 'ENOTFOUND', 'ENODOMAIN'].includes(error?.code) ? [] : Promise.reject(error))));
    const addresses = [...new Set(answers.flat())];
    if (!addresses.length) fail('DNS_UNRESOLVED');
    if (addresses.some(ip => !publicUnicast(ip))) fail('DNS_UNSAFE');
    return { ...target, addresses };
}
