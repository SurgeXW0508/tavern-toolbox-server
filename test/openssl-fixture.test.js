import test from 'node:test';
import assert from 'node:assert/strict';
import { requireOpenSslFixture } from './fixtures/openssl.js';

test('missing openssl skips only local HTTPS fixtures and fails CI', () => {
    const missing = () => ({ error: Object.assign(new Error('missing'), { code: 'ENOENT' }) });
    const skipped = [];
    assert.equal(requireOpenSslFixture({ skip: message => skipped.push(message) }, { probe: missing, ci: false }), false);
    assert.match(skipped[0], /openssl CLI is absent/);
    assert.throws(() => requireOpenSslFixture({ skip() {} }, { probe: missing, ci: true }), /CI requires openssl/);
    assert.equal(requireOpenSslFixture({ skip() { throw new Error('unexpected skip'); } },
        { probe: () => ({ status: 0 }), ci: true }), true);
});
