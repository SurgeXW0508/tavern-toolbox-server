import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir, unlink, utimes, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { createCore } from '../src/core.js';
import { validatePolicy } from '../src/config.js';
import { createAudio } from '../src/network/audio.js';
import { createNetwork } from '../src/network/index.js';
import { createAudioSources } from '../src/audio-sources/store.js';
import { STAGING_MAX_AGE } from '../src/audio-assets/store.js';

const origin = 'https://example.test', url = 'https://audio.example.test/music.mp3?signature=fixture';
const bytes = Buffer.concat([Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0, 255, 251, 144, 0]), Buffer.alloc(256 * 1024, 17)]);
const document = { schemaVersion: 1, core: { allowedOrigins: [origin] }, network: { enabled: true, transport: 'direct',
    destinationPolicy: 'allowlist-only', allowlist: ['audio.example.test'] } };
const resolver = { resolve4: async () => ['8.8.8.8'], resolve6: async () => [] };
const signal = () => new AbortController().signal;
function response(data = bytes, extra = {}) {
    const stream = Readable.from([data]); stream.statusCode = 200;
    stream.headers = { 'content-type': 'audio/mpeg', 'content-length': String(data.length), ...extra };
    return { response: stream, close() { stream.destroy(); } };
}
function sink() {
    const chunks = [], headers = {}, stream = new Writable({ write(chunk, _, done) { chunks.push(Buffer.from(chunk)); done(); } });
    stream.setHeader = (key, value) => { headers[key] = value; };
    return Object.assign(stream, { headers, bytes: () => Buffer.concat(chunks) });
}
async function harness(t, override = {}, options = {}) {
    const directory = await mkdtemp(path.join(tmpdir(), 'ttb-audio-assets-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const config = { policy: validatePolicy({ ...document, ...override }) };
    let calls = 0, mode = 'valid', began, stalled;
    const started = new Promise(resolve => { began = resolve; });
    const audio = createAudio(config, { resolver, open: async (...args) => {
        calls++; if (options.open) return options.open(...args);
        if (mode === 'fail') throw new Error('unavailable');
        if (mode === 'bad') return response(Buffer.from('not an audio file'));
        if (mode === 'partial') return response(bytes.subarray(0, 9), { 'content-length': String(bytes.length) });
        if (mode === 'stalled') {
            const stream = new Readable({ read() {} }); stream.statusCode = 200;
            stream.headers = { 'content-type': 'audio/mpeg', 'content-length': String(bytes.length) };
            stream.push(bytes.subarray(0, 8)); stalled = stream; began(); return { response: stream, close() { stream.destroy(); } };
        }
        return response();
    } });
    const sources = createAudioSources(config, audio); await sources.definition.initialize();
    t.after(() => sources.definition.shutdown()); t.after(() => audio.definition.shutdown());
    const alice = { userRoot: path.join(directory, 'alice'), contextId: 'alice' }, bob = { userRoot: path.join(directory, 'bob'), contextId: 'bob' };
    return { directory, config, audio, sources, alice, bob, started, calls: () => calls, mode: value => { mode = value; },
        assetFile: id => path.join(alice.userRoot, 'tavern-toolbox-server/audio-assets-v1/originals', id + '.audio'),
        resume: () => { stalled.push(bytes.subarray(8)); stalled.push(null); },
        staging: path.join(alice.userRoot, 'tavern-toolbox-server/audio-assets-v1/staging') };
}
async function finish(sources, context, job) {
    for (let i = 0; i < 10000; i++) {
        const current = sources.job(context, job.jobId);
        if (['completed', 'failed', 'cancelled'].includes(current.state)) return current;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('localization did not finish');
}
async function localize(h, source, context = h.alice, repair = false) {
    return finish(h.sources, context, await h.sources.localize(context, source.sourceId, source.revision, repair));
}

test('installed Stage 1 SQLite migration keeps existing Source ID/path and canonical reuse', async t => {
    const h = await harness(t), folder = path.join(h.alice.userRoot, 'tavern-toolbox-server/audio-sources-v1'); await mkdir(folder, { recursive: true });
    const db = new DatabaseSync(path.join(folder, 'sources.sqlite')), id = 'v'.repeat(32);
    db.exec('CREATE TABLE sources (source_id TEXT PRIMARY KEY NOT NULL, identity_hash TEXT UNIQUE NOT NULL, remote_url TEXT NOT NULL, backend TEXT NOT NULL, local_asset_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); PRAGMA user_version=1;');
    db.prepare('INSERT INTO sources VALUES (?, ?, ?, ?, NULL, 1, 1)').run(id, createHash('sha256').update(url).digest('hex'), url, 'remote'); db.close();
    const source = await h.sources.read(h.alice, id); assert.equal(source.revision, 0); assert.equal(source.backend, 'remote');
    assert.equal(source.playbackPath, '/api/plugins/tavern-toolbox-server/v1/audio/sources/' + id + '/stream');
    assert.equal((await h.sources.create(h.alice, url)).source.sourceId, id); const local = (await localize(h, source)).source;
    assert.equal(local.playbackPath, source.playbackPath); assert.equal(local.sourceId, id);
});

test('cancelled start request cannot begin or silently commit a localization task', async t => {
    const h = await harness(t), source = (await h.sources.create(h.alice, url)).source;
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(h.sources.localize(h.alice, source.sourceId, 0, false, aborted.signal), { code: 'CLIENT_ABORTED' }); assert.equal(h.calls(), 0);
    h.mode('stalled'); const request = new AbortController(); const job = await h.sources.localize(h.alice, source.sourceId, 0, false, request.signal);
    await h.started; request.abort(); assert.equal((await finish(h.sources, h.alice, job)).state, 'cancelled');
    assert.equal((await h.sources.read(h.alice, source.sourceId)).backend, 'remote'); assert.deepEqual(await readdir(h.staging), []);
});

test('invalid Asset metadata and unknown Source reference state fail closed, with no fallback or unsafe deletion', async t => {
    const h = await harness(t), source = (await h.sources.create(h.alice, url)).source, local = (await localize(h, source)).source;
    const db = new DatabaseSync(path.join(h.alice.userRoot, 'tavern-toolbox-server/audio-assets-v1/metadata.sqlite'));
    db.prepare('UPDATE assets SET mime = ? WHERE asset_id = ?').run('text/html', local.localAssetId);
    const calls = h.calls(); await assert.rejects(h.sources.stream(h.alice, source.sourceId, undefined, sink(), signal()), { code: 'AUDIO_ASSET_DATA_INVALID' }); assert.equal(h.calls(), calls);
    db.prepare('UPDATE assets SET mime = ? WHERE asset_id = ?').run('audio/mpeg', local.localAssetId); db.close();
    const sourceDb = new DatabaseSync(path.join(h.alice.userRoot, 'tavern-toolbox-server/audio-sources-v1/sources.sqlite'));
    sourceDb.prepare('UPDATE sources SET identity_hash = ? WHERE source_id = ?').run('invalid', source.sourceId);
    await assert.rejects(h.sources.assets.remove(h.alice, local.localAssetId), { code: 'AUDIO_SOURCE_DATA_INVALID' });
    assert.equal((await stat(h.assetFile(local.localAssetId))).size, bytes.length); sourceDb.close();
});

test('Remote → Local preserves identity/path; native 200/206/416 uses disk with Network disabled; restart persists', async t => {
    const h = await harness(t), { source } = await h.sources.create(h.alice, url);
    const job = await localize(h, source); assert.equal(job.state, 'completed');
    const local = await h.sources.read(h.alice, source.sourceId);
    assert.equal(local.backend, 'local'); assert.equal(local.playbackPath, source.playbackPath); assert.equal(local.sourceId, source.sourceId);
    assert.equal(local.asset.byteSize, bytes.length); assert.equal(local.asset.health, 'healthy'); assert.equal(h.calls(), 1);
    assert.equal((await h.sources.create(h.alice, url)).source.backend, 'local', 'updated libraries reuse Local without download');
    h.config.policy = validatePolicy({ ...document, network: { enabled: false } }); h.mode('fail');
    const restarted = createAudioSources(h.config, createAudio(h.config)); await restarted.definition.initialize();
    t.after(() => restarted.definition.shutdown());
    for (const [range, status, expected] of [[undefined, 200, bytes], ['bytes=2-100', 206, bytes.subarray(2, 101)],
        ['bytes=-12', 206, bytes.subarray(-12)], ['bytes=100-', 206, bytes.subarray(100)], ['bytes=999999-', 416, Buffer.alloc(0)]]) {
        const output = sink(); await restarted.stream(h.alice, source.sourceId, range, output, signal());
        assert.equal(output.statusCode, status); assert.deepEqual(output.bytes(), expected); assert.equal(output.headers['Accept-Ranges'], 'bytes');
    }
    assert.equal(h.calls(), 1); await assert.rejects(restarted.stream(h.alice, source.sourceId, 'bytes=0-1,3-4', sink(), signal()), { code: 'UNSUPPORTED_RANGE' });
    assert.deepEqual(await restarted.read(h.alice, source.sourceId), local);
    assert.equal((await stat(h.assetFile(local.localAssetId))).mode & 0o777, 0o600);
});

test('same Source concurrent clients single-flight; repeated Localize is idempotent; distinct Sources digest-deduplicate', async t => {
    const h = await harness(t), a = (await h.sources.create(h.alice, url)).source, b = (await h.sources.create(h.alice, url + '&other=1')).source;
    const starts = await Promise.all([h.sources.localize(h.alice, a.sourceId, 0), h.sources.localize({ ...h.alice }, a.sourceId, 0)]);
    assert.equal(starts[0].jobId, starts[1].jobId); assert.equal((await finish(h.sources, h.alice, starts[0])).state, 'completed');
    const al = await h.sources.read(h.alice, a.sourceId); assert.equal((await localize(h, al)).state, 'completed'); assert.equal(h.calls(), 1);
    const bl = await localize(h, b); assert.equal(bl.state, 'completed'); assert.equal(bl.source.localAssetId, al.localAssetId);
    const listing = await h.sources.assets.list(h.alice); assert.equal(listing.assets.length, 1); assert.equal(listing.assets[0].referenceCount, 2);
    assert.equal((await readdir(h.staging)).length, 0);
});

test('Local backpressure abort frees file-stream slots without Network; localization concurrency is bounded and recovers', async t => {
    const h = await harness(t, { audioAssets: { perUserConcurrency: 1, globalConcurrency: 1 } });
    const source = (await h.sources.create(h.alice, url)).source; const local = (await localize(h, source)).source;
    const controllers = [], tasks = [], outputs = [];
    for (let index = 0; index < 4; index++) {
        const controller = new AbortController(); controllers.push(controller);
        const output = new Writable({ highWaterMark: 1, write() {} }); output.setHeader = () => {}; output.on('error', () => {}); outputs.push(output);
        const task = h.sources.stream(h.alice, source.sourceId, undefined, output, controller.signal); task.catch(() => {}); tasks.push(task);
    }
    await assert.rejects(h.sources.stream(h.alice, source.sourceId, undefined, sink(), signal()), { code: 'RESOURCE_BUSY' });
    controllers.forEach(controller => controller.abort());
    for (const task of tasks) await assert.rejects(task, { code: 'CLIENT_ABORTED' });
    await h.sources.stream(h.alice, source.sourceId, 'bytes=0-2', sink(), signal()); assert.equal(h.calls(), 1);
    const other = (await h.sources.create(h.alice, url + '&other=1')).source; h.mode('stalled');
    const job = await h.sources.localize(h.alice, other.sourceId, 0); await h.started;
    const third = (await h.sources.create(h.bob, url)).source;
    await assert.rejects(h.sources.localize(h.bob, third.sourceId, 0), { code: 'RESOURCE_BUSY' });
    assert.equal((await h.sources.localize(h.alice, local.sourceId, local.revision)).state, 'completed', 'healthy idempotent reuse needs no download slot');
    h.sources.cancel(h.alice, job.jobId); await finish(h.sources, h.alice, job); h.mode('valid');
    assert.equal((await localize(h, third, h.bob)).state, 'completed');
});

test('different service instances serialize binding and digest commit for one user volume', async t => {
    const h = await harness(t), phone = createAudioSources(h.config, h.audio); await phone.definition.initialize(); t.after(() => phone.definition.shutdown());
    const a = (await h.sources.create(h.alice, url)).source, b = (await phone.create(h.alice, url + '&other=1')).source;
    const [ja, jb] = await Promise.all([h.sources.localize(h.alice, a.sourceId, 0), phone.localize(h.alice, b.sourceId, 0)]);
    const [da, db] = await Promise.all([finish(h.sources, h.alice, ja), finish(phone, h.alice, jb)]);
    assert.equal(da.state, 'completed'); assert.equal(db.state, 'completed'); assert.equal(da.source.localAssetId, db.source.localAssetId);
    assert.equal((await h.sources.assets.list(h.alice)).assets.length, 1);
});

test('download failure, malformed content, partial body and size rejection never bind Local or leave staging', async t => {
    const h = await harness(t), { source } = await h.sources.create(h.alice, url);
    for (const [mode, code] of [['fail', 'REMOTE_UNAVAILABLE'], ['bad', 'AUDIO_ASSET_INVALID_CONTENT'], ['partial', 'REMOTE_UNAVAILABLE']]) {
        h.mode(mode); const job = await localize(h, source); assert.equal(job.state, 'failed'); assert.equal(job.code, code);
        assert.equal((await h.sources.read(h.alice, source.sourceId)).backend, 'remote'); assert.deepEqual(await readdir(h.staging), []);
        assert.equal((await h.sources.assets.list(h.alice)).summary.count, 0);
    }
    const small = await harness(t, { audioAssets: { maxBytes: 16 } }); const s = (await small.sources.create(small.alice, url)).source;
    const failure = await localize(small, s); assert.equal(failure.code, 'REMOTE_RESOURCE_TOO_LARGE'); assert.equal((await small.sources.read(small.alice, s.sourceId)).backend, 'remote');
});

test('cancel and shutdown abort staging, release Audio budget, retain completed items and leave Remote binding', async t => {
    const h = await harness(t), complete = (await h.sources.create(h.alice, url + '&complete=1')).source; await localize(h, complete);
    const source = (await h.sources.create(h.alice, url)).source; h.mode('stalled');
    const job = await h.sources.localize(h.alice, source.sourceId, 0); await h.started;
    await assert.rejects(async () => h.sources.job(h.bob, job.jobId), { code: 'AUDIO_JOB_NOT_FOUND' });
    h.sources.cancel(h.alice, job.jobId); assert.equal((await finish(h.sources, h.alice, job)).state, 'cancelled');
    assert.equal((await h.sources.read(h.alice, source.sourceId)).backend, 'remote'); assert.equal((await h.sources.read(h.alice, complete.sourceId)).backend, 'local');
    assert.deepEqual(await readdir(h.staging), []); h.mode('valid'); assert.equal((await localize(h, source)).state, 'completed');
    const other = (await h.sources.create(h.alice, url + '&restart=1')).source; h.mode('stalled');
    await h.sources.localize(h.alice, other.sourceId, 0); await new Promise(resolve => setTimeout(resolve, 10));
    await h.sources.definition.shutdown(); assert.deepEqual(await readdir(h.staging), []);
    const restarted = createAudioSources(h.config, h.audio); await restarted.definition.initialize(); t.after(() => restarted.definition.shutdown());
    assert.equal((await restarted.read(h.alice, other.sourceId)).backend, 'remote');
});

test('concurrent Source switch/release/delete veto stale localization commit; no dangling Asset', async t => {
    const h = await harness(t), a = (await h.sources.create(h.alice, url)).source; await localize(h, a);
    const al = await h.sources.read(h.alice, a.sourceId); h.mode('stalled');
    const job = await h.sources.localize(h.alice, a.sourceId, al.revision, true); await h.started;
    const switched = await h.sources.backend(h.alice, a.sourceId, al.revision, 'remote');
    assert.equal(switched.localAssetId, al.localAssetId, 'switch keeps reference');
    h.resume(); const failure = await finish(h.sources, h.alice, job); assert.equal(failure.code, 'AUDIO_SOURCE_CONFLICT');
    assert.deepEqual(await readdir(h.staging), []);
    await assert.rejects(h.sources.backend(h.alice, a.sourceId, al.revision, 'local'), { code: 'AUDIO_SOURCE_CONFLICT' });
    assert.equal((await h.sources.read(h.alice, a.sourceId)).backend, 'remote');
    await assert.rejects(h.sources.assets.remove(h.alice, al.localAssetId), { code: 'AUDIO_ASSET_REFERENCED' });
    const released = await h.sources.backend(h.alice, a.sourceId, switched.revision, 'remote', true);
    assert.equal(released.localAssetId, null); assert.equal(released.playbackPath, a.playbackPath);
    await h.sources.assets.remove(h.alice, al.localAssetId); assert.equal((await h.sources.assets.list(h.alice)).summary.count, 0);
});

test('abandoned localization lease aborts and frees staging/budget without Server restart', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
    const h = await harness(t); const source = (await h.sources.create(h.alice, url)).source;
    h.mode('stalled'); const job = await h.sources.localize(h.alice, source.sourceId, 0); await h.started;
    t.mock.timers.tick(46000);
    assert.equal((await finish(h.sources, h.alice, job)).state, 'cancelled'); assert.deepEqual(await readdir(h.staging), []);
    assert.equal((await h.sources.read(h.alice, source.sourceId)).backend, 'remote');
    h.mode('valid'); assert.equal((await localize(h, source)).state, 'completed');
});

test('actual process kill during download leaves Source Remote; next boot safely removes expired staging', async t => {
    const h = await harness(t);
    const code = `import {createAudioSources} from ${JSON.stringify(new URL('../src/audio-sources/store.js', import.meta.url).href)};
        import {createAudio} from ${JSON.stringify(new URL('../src/network/audio.js', import.meta.url).href)};
        import {validatePolicy} from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)};
        import {Readable} from 'node:stream';
        const config={policy:validatePolicy(${JSON.stringify(document)})}, context=${JSON.stringify(h.alice)};
        const audio=createAudio(config,{resolver:{resolve4:async()=>['8.8.8.8'],resolve6:async()=>[]},open:async()=>{
          const response=new Readable({read(){}}); response.statusCode=200; response.headers={'content-type':'audio/mpeg','content-length':'1000'};
          response.push(Buffer.from('ID3partial')); setTimeout(()=>process.send({ready:true}),50); return {response,close(){response.destroy()}};
        }}); const sources=createAudioSources(config,audio); await sources.definition.initialize();
        const {source}=await sources.create(context,${JSON.stringify(url)});process.send({source});
        await sources.localize(context,source.sourceId,source.revision);setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let source; await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('fixture timeout')), 10000);
        child.on('message', message => { if (message.source) source = message.source; if (message.ready) { clearTimeout(timer); resolve(); } }); child.once('error', reject); });
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    assert.equal((await h.sources.read(h.alice, source.sourceId)).backend, 'remote');
    const staged = await readdir(h.staging); assert.equal(staged.length, 1);
    const old = new Date(Date.now() - STAGING_MAX_AGE - 1000); await utimes(path.join(h.staging, staged[0]), old, old);
    assert.equal((await h.sources.assets.list(h.alice)).summary.count, 0); assert.deepEqual(await readdir(h.staging), []);
});

test('shared references protect deletion; Source delete does not remove Asset; confirmed orphan cleanup is exact', async t => {
    const h = await harness(t), a = (await h.sources.create(h.alice, url)).source, b = (await h.sources.create(h.alice, url + '&b=1')).source;
    const al = (await localize(h, a)).source, bl = (await localize(h, b)).source;
    await h.sources.remove(h.alice, a.sourceId, al.revision); assert.equal((await h.sources.assets.read(h.alice, al.localAssetId)).referenceCount, 1);
    await assert.rejects(h.sources.assets.cleanup(h.alice, [al.localAssetId]), { code: 'AUDIO_ASSET_REFERENCED' });
    await h.sources.backend(h.alice, b.sourceId, bl.revision, 'remote', true);
    assert.equal((await h.sources.assets.list(h.alice)).summary.orphan, 1);
    assert.deepEqual((await h.sources.assets.cleanup(h.alice, [al.localAssetId])).removed, [al.localAssetId]);
    assert.equal((await h.sources.read(h.alice, b.sourceId)).backend, 'remote');
    await assert.rejects(h.sources.stream(h.alice, a.sourceId, undefined, sink(), signal()), { code: 'AUDIO_SOURCE_NOT_FOUND' });
});

test('missing, truncated, same-size corruption and symlink fail Local without Network; explicit repair restores', async t => {
    const h = await harness(t), source = (await h.sources.create(h.alice, url)).source;
    let current = (await localize(h, source)).source;
    for (const kind of ['missing', 'size', 'digest', 'symlink']) {
        const file = h.assetFile(current.localAssetId);
        if (kind === 'missing') await unlink(file);
        else if (kind === 'size') await writeFile(file, bytes.subarray(0, 9));
        else if (kind === 'digest') { const changed = Buffer.from(bytes); changed[20] ^= 1; await writeFile(file, changed);
            assert.equal((await h.sources.assets.check(h.alice, current.localAssetId, signal())).health, 'corrupt'); }
        else { await unlink(file); await symlink('/etc/passwd', file); }
        const calls = h.calls(); await assert.rejects(h.sources.stream(h.alice, source.sourceId, undefined, sink(), signal()), { code: 'AUDIO_ASSET_UNHEALTHY' });
        assert.equal(h.calls(), calls); assert.equal((await h.sources.read(h.alice, source.sourceId)).backend, 'local');
        const repaired = await localize(h, current, h.alice, true); assert.equal(repaired.state, 'completed'); current = repaired.source;
        assert.equal(current.playbackPath, source.playbackPath); assert.equal(current.asset.health, 'healthy');
    }
});

test('quota limits new content, digest reuse at full quota succeeds; limits and user Assets are isolated', async t => {
    const h = await harness(t, { audioAssets: { quotaBytes: bytes.length, maxBytes: bytes.length } });
    const a = (await h.sources.create(h.alice, url)).source, b = (await h.sources.create(h.alice, url + '&b=1')).source;
    const al = (await localize(h, a)).source; assert.equal((await localize(h, b)).state, 'completed');
    h.mode('bad'); // valid signature but distinct bytes, using a separate core below
    const different = Buffer.from(bytes.subarray(0, 32)); different[20] ^= 1;
    const another = createAudio(h.config, { resolver, open: async () => response(different) });
    const phone = createAudioSources(h.config, another); await phone.definition.initialize(); t.after(() => phone.definition.shutdown());
    const c = (await phone.create(h.alice, url + '&new=1')).source;
    const failed = await finish(phone, h.alice, await phone.localize(h.alice, c.sourceId, 0)); assert.equal(failed.code, 'AUDIO_QUOTA_EXCEEDED');
    assert.equal((await phone.read(h.alice, c.sourceId)).backend, 'remote'); assert.deepEqual(await readdir(h.staging), []);
    assert.equal((await h.sources.assets.list(h.bob)).summary.count, 0);
    await assert.rejects(h.sources.assets.read(h.bob, al.localAssetId), { code: 'AUDIO_ASSET_NOT_FOUND' });
    await assert.rejects(h.sources.assets.remove(h.bob, al.localAssetId), { code: 'AUDIO_ASSET_NOT_FOUND' });
    const bobSource = (await phone.create(h.bob, url)).source;
    assert.equal((await finish(phone, h.bob, await phone.localize(h.bob, bobSource.sourceId, 0))).state, 'completed');
    assert.equal(validatePolicy({ ...document, audioAssets: { quotaBytes: 0 } }).audioAssetsError, 'INVALID_AUDIO_ASSET_CONFIG');
});

test('stale staging recovery is directory/name bounded; pending complete commit becomes known orphan; incomplete pending is removed', async t => {
    const h = await harness(t); await h.sources.assets.list(h.alice); await h.sources.definition.shutdown();
    const root = path.join(h.alice.userRoot, 'tavern-toolbox-server/audio-assets-v1'), old = new Date(Date.now() - STAGING_MAX_AGE - 10000);
    const stale = 's'.repeat(32) + '.part', recent = 'r'.repeat(32) + '.part';
    await writeFile(path.join(h.staging, stale), 'partial'); await utimes(path.join(h.staging, stale), old, old);
    await writeFile(path.join(h.staging, recent), 'recent'); await writeFile(path.join(h.staging, 'keep.txt'), 'outside naming');
    const external = path.join(h.directory, 'external.part'); await writeFile(external, 'do not delete');
    await symlink(external, path.join(h.staging, 'y'.repeat(32) + '.part'));
    const db = new DatabaseSync(path.join(root, 'metadata.sqlite')), id = 'a'.repeat(32), incomplete = 'b'.repeat(32), stageId = 'c'.repeat(32);
    const digest = createHash('sha256').update(bytes).digest('hex');
    db.prepare("INSERT INTO assets VALUES (?, ?, 'audio/mpeg', ?, ?, 'pending', 'healthy', ?)").run(id, digest, bytes.length, Date.now(), stageId);
    await writeFile(path.join(h.staging, stageId + '.part'), bytes);
    db.prepare("INSERT INTO assets VALUES (?, ?, 'audio/mpeg', ?, ?, 'pending', 'healthy', ?)").run(incomplete, 'd'.repeat(64), 100, Date.now(), 'e'.repeat(32));
    await writeFile(path.join(h.staging, 'e'.repeat(32) + '.part'), 'partial'); db.close();
    const restarted = createAudioSources(h.config, h.audio); await restarted.definition.initialize(); t.after(() => restarted.definition.shutdown());
    const page = await restarted.assets.list(h.alice); assert.equal(page.summary.count, 1); assert.equal(page.assets[0].assetId, id); assert.equal(page.summary.orphan, 1);
    const remains = await readdir(h.staging); assert(!remains.includes(stale)); assert(remains.includes(recent)); assert(remains.includes('keep.txt'));
    assert(remains.includes('y'.repeat(32) + '.part')); assert.equal(await readFile(external, 'utf8'), 'do not delete');
    assert.equal((await restarted.assets.check(h.alice, id, signal())).health, 'healthy');
});

test('localization shares Audio approval/profile/budget and never Image slots; denied URL has no download bypass', async t => {
    const h = await harness(t, { audio: { perUserConcurrency: 1, globalConcurrency: 1 } });
    const source = (await h.sources.create(h.alice, url)).source; h.mode('stalled');
    const job = await h.sources.localize(h.alice, source.sourceId, 0); await h.started;
    const ticket = await h.audio.create(url, h.alice.contextId, signal());
    await assert.rejects(h.audio.stream(ticket.accessId, h.alice.contextId, undefined, sink(), signal()), { code: 'RESOURCE_BUSY' });
    const image = createNetwork(h.config, { resolver, open: async () => response(Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64'), { 'content-type': 'image/gif' }) });
    assert.equal((await image.fetchImage('https://audio.example.test/image.gif', h.alice.contextId)).mime, 'image/gif'); image.shutdown();
    h.sources.cancel(h.alice, job.jobId); await finish(h.sources, h.alice, job); h.mode('valid'); await h.audio.stream(ticket.accessId, h.alice.contextId, undefined, sink(), signal());
    const denied = await harness(t, { network: { ...document.network, allowlist: [] } }), s = (await denied.sources.create(denied.alice, url)).source;
    const failed = await localize(denied, s); assert.equal(failed.code, 'TARGET_NOT_ALLOWED'); assert.equal(denied.calls(), 0);
});

test('native Local routes require ST session, hide metadata/logs, use 206, protect controls and lookup never creates', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ttb-audio-routes-')); t.after(() => rm(directory, { recursive: true, force: true })); const logs = [];
    const core = await createCore({ logger: { info: x => logs.push(x), error: x => logs.push(x) },
        policyOptions: { configPath: path.join(directory, 'policy.json'), read: async () => JSON.stringify(document) }, audioOptions: { resolver, open: async () => response() } });
    t.after(() => core.shutdown());
    const app = express(); app.use(express.json()); app.use((req, _res, next) => {
        if (req.headers['x-test-user']) req.user = { profile: { handle: req.headers['x-test-user'], enabled: true }, directories: { root: path.join(directory, req.headers['x-test-user']) } };
        req.session = { csrfToken: 'fixture' }; next();
    }); const router = express.Router(); core.attach(router); app.use('/api/plugins/tavern-toolbox-server', router);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}`, prefix = '/api/plugins/tavern-toolbox-server', contexts = {};
    for (const user of ['alice', 'bob']) contexts[user] = (await (await fetch(base + prefix + '/v1/status', { headers: { 'X-TTB-Protocol': '1.0', 'X-Test-User': user } })).json()).data.contextId;
    async function call(route, data, user = 'alice', extra = {}) {
        const r = await fetch(base + prefix + route, { method: data ? 'POST' : 'GET', headers: { 'X-TTB-Protocol': '1.0', 'X-TTB-Context': contexts[user],
            Origin: origin, 'X-CSRF-Token': 'fixture', 'Content-Type': 'application/json', 'X-Test-User': user, ...extra }, ...(data ? { body: JSON.stringify(data) } : {}) });
        return { status: r.status, body: await r.json() };
    }
    assert.equal((await call('/v1/audio/sources/lookup', { url })).body.data.source, null);
    assert.equal((await call('/v1/audio/sources')).body.data.sources.length, 0);
    const s = (await call('/v1/audio/sources', { url })).body.data.source;
    assert.equal((await call('/v1/audio/sources/lookup', { url })).body.data.source.sourceId, s.sourceId);
    assert.equal((await call('/v1/audio/sources/lookup', { url }, 'bob')).body.data.source, null);
    assert.equal((await call('/v1/audio/sources/' + s.sourceId + '/localize', { revision: 0 }, 'alice', { 'X-CSRF-Token': 'bad' })).status, 403);
    const started = (await call('/v1/audio/sources/' + s.sourceId + '/localize', { revision: 0 })).body.data;
    let result;
    for (let i = 0; i < 50; i++) { result = (await call('/v1/audio/jobs/' + started.jobId)).body.data; if (result.state === 'completed') break; }
    assert.equal(result.state, 'completed'); const local = result.source;
    assert.equal((await call('/v1/audio/jobs/' + started.jobId, undefined, 'bob')).status, 404);
    const native = await fetch(base + s.playbackPath, { headers: { 'X-Test-User': 'alice', Range: 'bytes=0-2' } });
    assert.equal(native.status, 206); assert.equal(await native.text(), 'ID3'); assert.equal(native.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(base + s.playbackPath)).status, 403);
    assert.equal((await fetch(base + local.asset.playbackPath, { headers: { 'X-Test-User': 'bob' } })).status, 404);
    assert.equal((await call('/v1/audio/assets/' + local.localAssetId + '/delete', {})).status, 409);
    assert.equal((await call('/v1/audio/assets/' + local.localAssetId + '/check', { path: '/etc/passwd' })).status, 400);
    assert.equal((await call('/v1/audio/sources/' + s.sourceId + '/releaseLocal', { revision: local.revision })).status, 200);
    assert.equal((await call('/v1/audio/assets/cleanup', { assetIds: [local.localAssetId] })).status, 200);
    assert.doesNotMatch(JSON.stringify(logs), /signature|music\.mp3|audio\.example|alice|bob|metadata\.sqlite|originals/);
    assert(!JSON.stringify(logs).includes(s.sourceId)); assert(!JSON.stringify(logs).includes(local.localAssetId));
});
