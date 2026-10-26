import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createCore } from '../src/core.js';

async function host(t, invalid = false) {
    const root = await mkdtemp(path.join(tmpdir(), 'ttb-video-http-')), source = path.join(root, 'clips'); await mkdir(source);
    const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(4), Buffer.from('isommp42'), Buffer.alloc(64, 9)]);
    await writeFile(path.join(source, 'clip.mp4'), bytes);
    await mkdir(path.join(root, 'alice', 'characters'), { recursive: true }); await mkdir(path.join(root, 'bob', 'characters'), { recursive: true });
    const origin = 'https://example.invalid', policy = { schemaVersion: 1, core: { allowedOrigins: [origin] }, video: invalid ? { roots: 'bad' } : { roots: [{ key: 'clips', label: 'Clips', path: source, users: ['alice', 'bob'] }] } };
    const logs = [], core = await createCore({ policyOptions: { configPath: '/fixture/config', read: async () => JSON.stringify(policy) }, logger: { info: row => logs.push(row), error: row => logs.push(row) } });
    const app = express(); app.use(express.json({ limit: 8192 }));
    app.use((req, _res, next) => {
        if (req.headers['x-test-user']) req.user = { profile: { handle: req.headers['x-test-user'], enabled: true }, directories: { root: path.join(root, req.headers['x-test-user']) } };
        req.session = { csrfToken: 'fixture-csrf' }; next();
    });
    const router = express.Router(); core.attach(router); const prefix = '/st/api/plugins/tavern-toolbox-server'; app.use(prefix, router);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => { await core.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
    async function request(route, { user = 'alice', method = 'GET', body, headers = {}, native = false } = {}) {
        const response = await fetch(url + prefix + route, { method, headers: { ...(user ? { 'x-test-user': user } : {}),
            ...(!native ? { 'X-TTB-Protocol': '1.0' } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
        return response;
    }
    async function identity(user = 'alice') { return (await (await request('/v1/status', { user })).json()).data; }
    return { root, source, bytes, prefix, request, identity, logs, origin };
}

test('Video HTTP works through ST subpaths with native authenticated Range/HEAD and current context, without custom stream headers', async t => {
    const h = await host(t), state = await h.identity(), ctx = state.contextId;
    assert.equal(state.capabilities.find(row => row.id === 'video.sources').operations.find(row => row.id === 'register').available, true);
    const headers = { 'X-TTB-Context': ctx, Origin: h.origin, 'X-CSRF-Token': 'fixture-csrf' };
    const browse = await h.request('/v1/video/source-browse', { method: 'POST', body: { rootKey: 'clips' }, headers }); assert.equal(browse.status, 200);
    const page = (await browse.json()).data;
    const register = await h.request('/v1/video/register', { method: 'POST', body: { candidateId: page.entries[0].id, operationId: randomUUID(), title: 'Sample' }, headers });
    assert.equal(register.status, 200); const id = (await register.json()).data.mediaRef.assetId;
    const response = await h.request(`/v1/video/items/${id}/playback`, { method: 'POST', body: {}, headers }); assert.equal(response.status, 200);
    const resolved = (await response.json()).data;
    const detail = (await (await h.request(`/v1/video/items/${id}`, {headers})).json()).data; assert.equal(detail.rootLabel, 'Clips'); assert.equal(detail.sourceState, 'available');
    const streamPath = resolved.playbackPath.replace('/api/plugins/tavern-toolbox-server', '');
    const stream = await h.request(streamPath, { native: true, headers: { Range: 'bytes=3-12' } });
    assert.equal(stream.status, 206); assert.deepEqual(Buffer.from(await stream.arrayBuffer()), h.bytes.subarray(3, 13));
    assert.equal(stream.headers.get('cache-control'), 'no-store'); assert.equal(stream.headers.get('cross-origin-resource-policy'), 'same-origin');
    const head = await h.request(streamPath, { native: true, method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(Number(head.headers.get('content-length')), h.bytes.length);
    assert.equal((await h.request(streamPath, { native: true, user: undefined, headers: { 'x-test-user': '' } })).status, 403);
    assert.equal((await h.request(streamPath, { native: true, user: 'bob' })).status, 409);
    assert.equal((await h.request(streamPath, { native: true, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await h.request(streamPath, { native: true, headers: { Range: 'bytes=99999-' } })).status, 416);
    assert.equal((await h.request(streamPath + '&extra=1', { native: true })).status, 400);
    const bobState = await h.identity('bob');
    assert.equal((await h.request(`/v1/video/items/${id}`, { user: 'bob', headers: { 'X-TTB-Context': bobState.contextId } })).status, 404);
    assert.equal((await h.request('/v1/video/register', { method: 'POST', body: {}, headers: { ...headers, 'X-CSRF-Token': 'wrong' } })).status, 403);
    assert.equal((await h.request('/v1/video/items', { headers: { 'X-TTB-Context': 'stale' } })).status, 409);
    assert.equal((await h.request('/v1/video/items?limit=49', { headers })).status, 400);
    assert.equal((await h.request('/v1/video/items?offset=abc', { headers })).status, 400);
    const catalog = await (await h.request('/v1/video/items?search=sample', { headers })).json(); assert.equal(catalog.data.total, 1);
    assert.equal(JSON.stringify(catalog).includes(h.source), false);
    assert.equal(JSON.stringify(h.logs).includes(ctx), false); assert.equal(JSON.stringify(h.logs).includes(h.source), false);
});

test('Invalid video configuration cannot disable Core, image or worldbook capabilities', async t => {
    const h = await host(t, true), state = await h.identity();
    assert.equal(state.core.state, 'ready');
    assert.equal(state.capabilities.find(row => row.id === 'video.catalog').state, 'unavailable');
    assert.equal(state.capabilities.find(row => row.id === 'worldbook.core').state, 'ready');
    assert.equal((await h.request('/v1/video/roots', { headers: { 'X-TTB-Context': state.contextId } })).status, 503);
});

test('P2 HTTP poster binding protects image deletion; metadata CAS, progress CAS and unregister preserve files', async t => {
    const h = await host(t), state = await h.identity(), headers = { 'X-TTB-Context': state.contextId, Origin: h.origin, 'X-CSRF-Token': 'fixture-csrf' };
    const post = async (route, body) => { const response = await h.request(route, { method: 'POST', body, headers }); return { status: response.status, payload: await response.json() }; };
    const page = (await post('/v1/video/source-browse', { rootKey: 'clips' })).payload.data;
    const registered = await post('/v1/video/register', { candidateId: page.entries[0].id, operationId: randomUUID(), title: 'Sample' });
    const video = registered.payload.data, id = video.mediaRef.assetId;
    // Upload a real PNG through Core; JSON body helper is intentionally not used for bytes.
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } }).png().toBuffer();
    // host() request is JSON only; a data URL is never used as product media.
    const address = h.request;
    const { createMedia } = await import('../src/media/index.js');
    const { validatePolicy } = await import('../src/config.js');
    const media = createMedia({ policy: validatePolicy({ schemaVersion: 1 }) }, { definition: { health: () => ({ state: 'disabled' }) } });
    await media.definition.initialize(); t.after(() => media.definition.shutdown());
    const image = await media.importBytes({ userRoot: path.join(h.root, 'alice') }, png, 'image/png');
    const changed = await post(`/v1/video/items/${id}/update`, { operationId: randomUUID(), metadataRevision: 1, patch: { posterRef: image.mediaRef } });
    assert.equal(changed.status, 200); assert.deepEqual(changed.payload.data.posterRef, image.mediaRef);
    const stale = await post(`/v1/video/items/${id}/update`, { operationId: randomUUID(), metadataRevision: 1, patch: { title: 'Stale' } }); assert.equal(stale.status, 409);
    const deletion = await h.request('/v1/media/assets/' + image.mediaRef.assetId, { method: 'DELETE', headers }); assert.equal(deletion.status, 409, JSON.stringify(await deletion.json()));
    const initial = await h.request(`/v1/video/items/${id}/progress`, { headers }); assert.equal((await initial.json()).data.revision, 0);
    const firstBody = { sourceRevision: 1, expectedProgressRevision: 0, writeId: randomUUID(), positionSeconds: 30, durationHint: 100, completed: false };
    const first = await post(`/v1/video/items/${id}/progress`, firstBody); assert.equal(first.status, 200); assert.equal(first.payload.data.revision, 1);
    assert.deepEqual((await post(`/v1/video/items/${id}/progress`, firstBody)).payload.data, first.payload.data);
    assert.equal((await post(`/v1/video/items/${id}/progress`, { ...firstBody, writeId: randomUUID(), positionSeconds: 9 })).status, 409);
    assert.equal((await post(`/v1/video/items/${id}/progress`, { ...firstBody, writeId: randomUUID(), expectedProgressRevision: 1, positionSeconds: 9 })).payload.data.positionSeconds, 9);
    const operation = randomUUID();
    const removed = await post(`/v1/video/items/${id}/unregister`, { operationId: operation, metadataRevision: 2, sourceRevision: 1 }); assert.equal(removed.status, 200);
    assert.equal((await post(`/v1/video/items/${id}/unregister`, { operationId: operation, metadataRevision: 2, sourceRevision: 1 })).status, 200);
    const receipt = await h.request('/v1/video/operations/' + operation, { headers }); assert.equal((await receipt.json()).data.found, true);
    assert.equal((await h.request(`/v1/video/items/${id}`, { headers })).status, 404);
    assert.equal((await h.request('/v1/media/assets/' + image.mediaRef.assetId, { method: 'DELETE', headers })).status, 200);
    assert.deepEqual(await (await import('node:fs/promises')).readFile(path.join(h.source, 'clip.mp4')), h.bytes);
});
