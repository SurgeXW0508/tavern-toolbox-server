#!/usr/bin/env node
// Fail closed on likely secrets and personal infrastructure in every reachable Git ref.
// Output contains locations and categories only; never print the matched value.
import { execFileSync } from 'node:child_process';

const allowedAuthors = new Set(['SurgeXW', 'GitHub', 'github-actions[bot]', 'dependabot[bot]']);
const allowedEmails = new Set([
    'noreply@github.com',
    '329357869+SurgeXW0508@users.noreply.github.com',
]);
const patterns = [
    ['private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i],
    ['credential', /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/],
    ['authorization', /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]{12,}/i],
    ['credential assignment', /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|tailscale[_-]?(?:auth|key))\b\s*[:=]\s*['"]?[^\s'";,}{]{12,}/i],
    ['URL credentials', /https?:\/\/[^/\s:@]+:[^@/\s]+@/i],
    ['local user path', /(?:\/home\/|\/Users\/|\/volume\d+\/|[A-Za-z]:\\Users\\)[^\s'"`]+/],
];

const failures = [];
function git(...args) {
    return execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024 });
}
function flag(where, category) {
    failures.push(`${where}: ${category}`);
}
function inspectText(location, value, { skipDomains = false } = {}) {
    const lines = value.split(/\r?\n/);
    for (let line = 0; line < lines.length; line++) {
        const s = lines[line];
        const where = `${location}:${line + 1}`;
        for (const [label, re] of patterns) if (re.test(s)) flag(where, label);
        for (const match of s.matchAll(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi)) {
            if (!allowedEmails.has(match[0]) && !match[0].endsWith('@users.noreply.github.com') &&
                !match[0].endsWith('@example.invalid')) flag(where, 'email address');
        }
        for (const match of s.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
            const ip = match[0];
            const octets = ip.split('.').map(Number);
            if (octets.some(n => n > 255) || ip === '127.0.0.1') continue;
            if (octets[0] === 10 || octets[0] === 192 && octets[1] === 168 ||
                octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 ||
                octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127 ||
                octets[0] === 169 && octets[1] === 254) flag(where, 'private or overlay IP');
        }
        for (const match of skipDomains ? [] : s.matchAll(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|cn|me|local|lan|internal)\b/gi)) {
            const host = match[0].toLowerCase();
            if (host === 'json-schema.org' || host === 'github.com' || host.endsWith('.github.com') ||
                host === 'example.com' || host.endsWith('.example.com')) continue;
            flag(where, 'unreviewed hostname');
        }
    }
}

try {
    const refs = git('for-each-ref', '--format=%(refname)').toString().trim().split('\n').filter(Boolean);
    if (!refs.length) flag('repository', 'no Git refs to audit');
    for (const ref of refs) inspectText('ref name', ref);
    const commits = git('rev-list', '--all').toString().trim().split('\n').filter(Boolean);
    const objects = git('rev-list', '--objects', '--all').toString().trim().split('\n').filter(Boolean);
    for (const sha of commits) {
        const commit = git('cat-file', '-p', sha).toString();
        const [headers, ...body] = commit.split('\n\n');
        for (const kind of ['author', 'committer']) {
            const header = headers.split('\n').find(line => line.startsWith(`${kind} `));
            const identity = header?.match(/^\w+ (.+) <([^>]+)> \d+ [+-]\d+$/);
            if (!identity || !allowedAuthors.has(identity[1]) || !allowedEmails.has(identity[2])) {
                flag(`commit ${sha.slice(0, 12)} ${kind}`, 'unapproved identity');
            }
        }
        inspectText(`commit ${sha.slice(0, 12)} message`, body.join('\n\n'));
    }
    for (const object of objects) {
        const space = object.indexOf(' ');
        if (space < 0) continue;
        const sha = object.slice(0, space);
        const path = object.slice(space + 1);
        inspectText(`file path ${path}`, path, { skipDomains: true });
        if (git('cat-file', '-t', sha).toString().trim() !== 'blob') continue;
        const size = Number(git('cat-file', '-s', sha).toString().trim());
        if (size > 4 * 1024 * 1024) { flag(path, 'large blob requires manual review'); continue; }
        const content = git('cat-file', '-p', sha);
        if (content.includes(0)) { flag(path, 'binary blob requires manual review'); continue; }
        inspectText(`${path} (${sha.slice(0, 12)})`, content.toString('utf8'));
    }
    if (failures.length) {
        console.error(`Privacy audit failed (${failures.length} finding(s)); values suppressed:`);
        for (const finding of failures) console.error(`  ${finding}`);
        process.exitCode = 1;
    } else {
        console.log(`Privacy audit passed: ${refs.length} refs, ${commits.length} commits, ${objects.length} reachable objects.`);
    }
} catch (error) {
    console.error(`Privacy audit could not complete: ${error.code || error.name}`);
    process.exitCode = 1;
}
