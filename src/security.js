import path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';

export function userContext(req, secret) {
    const handle = req.user?.profile?.handle;
    const root = req.user?.directories?.root;
    if (req.user?.profile?.enabled === false || typeof handle !== 'string' || !handle.trim()
        || typeof root !== 'string' || !root.trim()) return null;
    let resolvedRoot;
    try {
        // SillyTavern may expose directories.root relative to its server cwd (for example ./data/default-user).
        // The value comes from the authenticated host context, not from a client-selected path, so normalize it
        // before deriving the opaque boot-local context identity instead of requiring an absolute host path.
        resolvedRoot = path.resolve(root);
    } catch {
        return null;
    }
    // Opaque within a boot; never a credential or a durable storage identity.
    const contextId = createHmac('sha256', secret).update(JSON.stringify([handle, resolvedRoot])).digest('hex').slice(0, 32);
    return { contextId };
}

export function mutationGate(req, allowedOrigins) {
    const origin = req.headers?.origin;
    if (!origin || origin === 'null' || !allowedOrigins.includes(origin)) return false;
    const site = req.headers?.['sec-fetch-site'];
    const mode = req.headers?.['sec-fetch-mode'];
    if (site && site !== 'same-origin') return false;
    if (mode && !['cors', 'same-origin'].includes(mode)) return false;
    // SillyTavern installs csrf-sync before plugin routers; check its session state as well.
    // If the host disabled CSRF, /csrf-token returns "disabled" and no valid state exists.
    const sessionToken = req.session?.csrfToken;
    const supplied = req.headers?.['x-csrf-token'];
    if (typeof sessionToken !== 'string' || sessionToken === 'disabled' || !sessionToken
        || typeof supplied !== 'string' || supplied.length !== sessionToken.length) return false;
    return timingSafeEqual(Buffer.from(sessionToken), Buffer.from(supplied));
}

export function setPrivateHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
}
