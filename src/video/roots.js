import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { fail, aborted } from './validation.js';
import { VIDEO_LIMITS } from './policy.js';

export const fingerprint = info => JSON.stringify(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(info[key])));
export function locator(value) {
    if (typeof value !== 'string' || value.length > 2048 || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value)
        || value && value.split('/').some(part => !part || part === '.' || part === '..')
        || value.startsWith('/') || value.split('/').length > VIDEO_LIMITS.directoryDepth) fail('VIDEO_SOURCE_UNAVAILABLE');
    return value;
}
export function rootFor(policy, context, key) {
    const root = policy.roots.find(item => item.key === key && item.users.includes(context.userHandle));
    if (!root) fail('VIDEO_NOT_FOUND'); return root;
}
// Trusted administrator controls all parent directories. Node path APIs alone
// cannot eliminate malicious concurrent parent replacement (documented boundary).
export async function safePath(root, relative, directory = false) {
    locator(relative);
    const target = path.resolve(root.path, relative), within = path.relative(root.path, target);
    if (within.startsWith('..' + path.sep) || within === '..' || path.isAbsolute(within)) fail('VIDEO_SOURCE_UNAVAILABLE');
    let cursor = path.parse(target).root;
    const parts = target.slice(cursor.length).split(path.sep).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
        cursor = path.join(cursor, parts[i]);
        const info = await lstat(cursor);
        if (info.isSymbolicLink() || (i < parts.length - 1 || directory) && !info.isDirectory()) fail('VIDEO_SOURCE_UNAVAILABLE');
    }
    if (await realpath(target) !== target) fail('VIDEO_SOURCE_UNAVAILABLE');
    return target;
}
export function containerMime(prefix) {
    if (prefix.length >= 16 && prefix.toString('ascii', 4, 8) === 'ftyp'
        && prefix.readUInt32BE(0) >= 16 && prefix.readUInt32BE(0) <= 4096) {
        const brands = []; for (let n = 8; n + 4 <= Math.min(prefix.length, prefix.readUInt32BE(0)); n += 4) if (n !== 12) brands.push(prefix.toString('ascii', n, n + 4));
        if (brands.some(brand => ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V '].includes(brand))) return 'video/mp4';
    }
    // EBML DocType 0x4282 with the bounded, exact "webm" value. Codec decode
    // remains a client observation, not a signature guarantee.
    if (prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && prefix.includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]))) return 'video/webm';
    fail('VIDEO_FORMAT_UNSUPPORTED');
}
export async function openVideo(policy, context, key, relative, expected, signal) {
    aborted(signal);
    const root = rootFor(policy, context, key); let handle;
    try {
        const file = await safePath(root, relative);
        handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const info = await handle.stat({ bigint: true });
        if (!info.isFile() || info.size < 1n || info.size > BigInt(policy.maxBytes)) fail('VIDEO_SOURCE_UNAVAILABLE');
        const stamp = fingerprint(info);
        if (expected && stamp !== expected) fail('VIDEO_SOURCE_CHANGED');
        const prefix = Buffer.alloc(4096), { bytesRead } = await handle.read(prefix, 0, Math.min(4096, Number(info.size)), 0);
        const mime = containerMime(prefix.subarray(0, bytesRead));
        if (fingerprint(await handle.stat({ bigint: true })) !== stamp) fail('VIDEO_SOURCE_CHANGED');
        aborted(signal);
        return { handle, fingerprint: stamp, byteSize: Number(info.size), mime };
    } catch (error) {
        await handle?.close();
        if (error?.code?.startsWith('VIDEO_') || error?.code === 'CLIENT_ABORTED') throw error;
        fail('VIDEO_SOURCE_UNAVAILABLE');
    }
}
