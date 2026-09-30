import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePolicy, DEFAULT_POLICY, NETWORK_DEFAULTS, MEDIA_CEILINGS, NETWORK_CEILINGS } from '../src/config.js';
import { createNetwork } from '../src/network/index.js';
import { createMedia } from '../src/media/index.js';
const MiB = 1024 ** 2, GiB = 1024 ** 3;
const config = (media = {}, network = {}) => validatePolicy({ schemaVersion: 1,
    core: { allowedOrigins: ['https://example.com'] }, media,
    network: { enabled: true, transport: 'direct', destinationPolicy: 'allowlist-only', allowlist: ['img.example.com'], ...network } });

test('Image defaults and advertised limits agree; larger explicit byte and quota budgets remain bounded', () => {
    assert.equal(DEFAULT_POLICY.media.maxBytes, 64 * MiB);
    assert.equal(NETWORK_DEFAULTS.maxBytes, 64 * MiB);
    assert.equal(DEFAULT_POLICY.media.quotaBytes, 2 * GiB);
    for (const quotaBytes of [20 * GiB, 100 * GiB]) {
        const policy = config({ maxBytes: 256 * MiB, quotaBytes }, { maxBytes: 256 * MiB });
        assert.equal(policy.mediaError, null); assert.equal(policy.networkError, null);
        assert.equal(policy.media.maxBytes, 256 * MiB); assert.equal(policy.media.quotaBytes, quotaBytes);
        const network = createNetwork({ policy });
        const media = createMedia({ policy }, network);
        assert.equal(network.definition.capabilities[0].limits.maxBytes, 256 * MiB);
        assert.equal(media.definition.capabilities[0].limits.quotaBytes, quotaBytes);
        for (const key of ['maxDimension', 'maxPixels', 'maxFrames', 'maxFramePixels', 'maxConcurrentImports'])
            assert.equal(policy.media[key], DEFAULT_POLICY.media[key]);
        assert.equal(policy.network.globalConcurrency, NETWORK_DEFAULTS.globalConcurrency);
        assert.equal(policy.network.totalTimeoutMs, NETWORK_DEFAULTS.totalTimeoutMs);
    }
    const defaults = config(), disabled = createNetwork({ policy: validatePolicy({ schemaVersion: 1 }) });
    assert.equal(defaults.media.maxBytes, defaults.network.maxBytes);
    assert.equal(disabled.definition.capabilities[0].limits.maxBytes, 64 * MiB);
});

test('existing explicit budgets remain authoritative and invalid/unsafe numeric limits stay fail closed', () => {
    const old = config({ maxBytes: 16 * MiB, quotaBytes: 2 * GiB }, { maxBytes: 16 * MiB });
    assert.equal(old.media.maxBytes, 16 * MiB); assert.equal(old.network.maxBytes, 16 * MiB);
    for (const invalid of [null, 0, -1, .5, '67108864', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, MEDIA_CEILINGS.maxBytes + 1]) {
        assert.equal(config({ maxBytes: invalid }).mediaError, 'INVALID_MEDIA_CONFIG');
        assert.equal(config({}, { maxBytes: invalid }).networkError, 'INVALID_NETWORK_CONFIG');
    }
    for (const invalid of [null, 0, -1, .5, '100', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, MEDIA_CEILINGS.quotaBytes + 1])
        assert.equal(config({ quotaBytes: invalid }).mediaError, 'INVALID_MEDIA_CONFIG');
    for (const key of ['maxDimension', 'maxPixels', 'maxFrames', 'maxFramePixels', 'maxConcurrentImports'])
        assert.equal(config({ maxBytes: MEDIA_CEILINGS.maxBytes, [key]: DEFAULT_POLICY.media[key] + 1 }).mediaError, 'INVALID_MEDIA_CONFIG');
    assert.equal(config({}, { globalConcurrency: NETWORK_CEILINGS.globalConcurrency + 1 }).networkError, 'INVALID_NETWORK_CONFIG');
});
