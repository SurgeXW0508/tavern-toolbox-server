import { spawnSync } from 'node:child_process';

export function requireOpenSslFixture(t, { probe = () => spawnSync('openssl', ['version'], { encoding: 'utf8' }),
    ci = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true' } = {}) {
    const result = probe();
    if (result.error?.code === 'ENOENT') {
        if (ci) throw new Error('CI requires openssl CLI for the Network HTTPS/CONNECT security fixtures');
        t.skip('openssl CLI is absent; HTTPS fixture is unavailable in this host image');
        return false;
    }
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`openssl CLI probe failed (${result.status})`);
    return true;
}
