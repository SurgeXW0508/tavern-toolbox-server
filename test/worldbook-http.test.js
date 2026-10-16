import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCore } from '../src/core.js';
async function fixture(t, write = true) {
    const root = await mkdtemp(path.join(tmpdir(), 'ttb-wb-http-')),
        logs = [];
    const core = await createCore({
        logger: { info: (row) => logs.push(row), error: (row) => logs.push(row) },
        policyOptions: {
            configPath: '/fixture/policy',
            read: async () =>
                JSON.stringify({
                    schemaVersion: 1,
                    core: { allowedOrigins: write ? ['https://example.invalid'] : [] },
                }),
        },
    });
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.use((req, res, next) => {
        if (req.get('X-Test-User') !== 'none')
            req.user = {
                profile: { handle: req.get('X-Test-User') || 'fixture', enabled: true },
                directories: { root: path.join(root, req.get('X-Test-User') || 'fixture') },
            };
        req.session = { csrfToken: 'worldbook-fixture-csrf' };
        next();
    });
    const router = express.Router();
    core.attach(router);
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await core.shutdown();
        await rm(root, { recursive: true, force: true });
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    const status = await (await fetch(url + '/v1/status', { headers: { 'X-TTB-Protocol': '1.0' } })).json();
    const request = async (route, { data, headers = {} } = {}) => {
        const response = await fetch(url + route, {
            method: data ? 'POST' : 'GET',
            headers: {
                'X-TTB-Protocol': '1.0',
                'X-TTB-Context': status.data.contextId,
                Origin: 'https://example.invalid',
                'X-CSRF-Token': 'worldbook-fixture-csrf',
                ...(data ? { 'Content-Type': 'application/json' } : {}),
                ...headers,
            },
            ...(data ? { body: JSON.stringify(data) } : {}),
        });
        return { status: response.status, body: await response.json() };
    };
    return { request, status: status.data, logs };
}
const command = (action, data) => ({ commandId: `${Date.now()}-${randomUUID()}`, action, data });
test('Worldbook HTTP uses host auth/context/protocol/CSRF and private bounded error envelope without metadata logs', async (t) => {
    const env = await fixture(t);
    const cap = env.status.capabilities.find((row) => row.id === 'worldbook.core');
    assert.equal(cap.operations.find((row) => row.id === 'catalog').available, true);
    assert.equal(cap.operations.find((row) => row.id === 'command').available, true);
    assert.equal((await env.request('/v1/worldbook/summary', { headers: { 'X-Test-User': 'none' } })).status, 403);
    assert.equal(
        (await env.request('/v1/worldbook/summary', { headers: { 'X-TTB-Context': 'old' } })).body.error.code,
        'CONTEXT_CHANGED',
    );
    assert.equal((await env.request('/v1/worldbook/summary', { headers: { 'X-TTB-Protocol': '2.0' } })).status, 409);
    const body = command('column-create', {
        profile: { title: '资料', description: '', icon: { type: 'builtin', value: 'book' }, accent: '#123456' },
        materials: [
            {
                name: '资料',
                description: 'PRIVATE_TEST_DESCRIPTION',
                source: { locator: 'PRIVATE_BOOK', uid: 1, title: 'Entry' },
            },
        ],
    });
    assert.equal(
        (await env.request('/v1/worldbook/commands', { data: body, headers: { 'X-CSRF-Token': 'wrong' } })).status,
        403,
    );
    const created = await env.request('/v1/worldbook/commands', { data: body });
    assert.equal(created.status, 200);
    assert.deepEqual((await env.request('/v1/worldbook/commands', { data: body })).body.data, {
        ...created.body.data,
        replayed: true,
    });
    const catalog = await env.request('/v1/worldbook/catalog');
    assert.equal(catalog.body.data.total, 1);
    assert.equal(catalog.body.data.items[0].description, undefined);
    assert.equal((await env.request('/v1/worldbook/summary')).body.data.columns.length, 3);
    const target = catalog.body.data.items[0];
    assert.equal(
        (await env.request('/v1/worldbook/materials/' + target.id)).body.data.material.description,
        'PRIVATE_TEST_DESCRIPTION',
    );
    const other = await env.request('/v1/status', { headers: { 'X-Test-User': 'second' } }),
        otherHeaders = { 'X-Test-User': 'second', 'X-TTB-Context': other.body.data.contextId };
    assert.equal((await env.request('/v1/worldbook/catalog', { headers: otherHeaders })).body.data.total, 0);
    assert.equal((await env.request('/v1/worldbook/materials/' + target.id, { headers: otherHeaders })).status, 404);
    const edit = command('material-update', { id: target.id, revision: target.revision, fields: { summary: '新' } });
    assert.equal((await env.request('/v1/worldbook/commands', { data: edit })).status, 200);
    edit.commandId = `${Date.now()}-${randomUUID()}`;
    const stale = await env.request('/v1/worldbook/commands', { data: edit });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'WORLDBOOK_CONFLICT');
    assert.equal((await env.request('/v1/worldbook/catalog?page=0')).status, 400);
    assert.equal((await env.request('/v1/worldbook/materials/material-missing')).status, 404);
    assert.doesNotMatch(JSON.stringify(env.logs), /PRIVATE_TEST_DESCRIPTION|PRIVATE_BOOK/);
});
test('Worldbook capability keeps readable surfaces when write Origin policy is unavailable', async (t) => {
    const env = await fixture(t, false),
        cap = env.status.capabilities.find((row) => row.id === 'worldbook.core');
    assert.equal(cap.operations.find((row) => row.id === 'summary').available, true);
    assert.equal(cap.operations.find((row) => row.id === 'command').available, false);
    assert.equal((await env.request('/v1/worldbook/summary')).status, 200);
});

test('observed Runtime HTTP transfer accepts enabled=false, drives bounded Roll/Discovery and exact-state plans without persisting or logging ST data',async t=>{
 const env=await fixture(t);
 const created=await env.request('/v1/worldbook/commands',{data:command('column-create',{profile:{title:'范围',description:'',icon:{type:'builtin',value:'book'},accent:'#123456'},materials:Array.from({length:60},(_,i)=>({name:`资料 ${i}`,description:'PRIVATE_CONTENT',source:{locator:'PRIVATE_SOURCE',uid:i,title:`Entry ${i}`}}))})});assert.equal(created.status,200);
 const bindings=Array.from({length:101},(_,i)=>({locator:'PRIVATE_SOURCE',uid:i,enabled:i%5===0}));
 const first=await env.request('/v1/worldbook/runtime',{data:{mode:'observed',unknownBooks:[],offset:0,bindings:bindings.slice(0,100),complete:false}});assert.equal(first.status,200);
 const last=await env.request('/v1/worldbook/runtime',{data:{mode:'observed',token:first.body.data.token,offset:100,bindings:bindings.slice(100),complete:true}});assert.equal(last.status,200);const runtimeToken=last.body.data.token;
 const enabled=await env.request('/v1/worldbook/catalog?status=enabled&runtimeToken='+runtimeToken);assert.equal(enabled.body.data.total,12);
 const roll=await env.request('/v1/worldbook/features',{data:{kind:'roll',scope:{columnId:created.body.data.column.id},runtimeToken,limit:20}});assert.equal(roll.status,200);assert.equal(roll.body.data.items.length,20);assert.equal(roll.body.data.scopeTotal,48);assert(roll.body.data.items.every(row=>!('description'in row)&&row.source.uid%5!==0));
 const next=await env.request('/v1/worldbook/features',{data:{kind:'roll',sessionId:roll.body.data.sessionId,cursor:roll.body.data.nextCursor,runtimeToken,limit:20}});assert.equal(next.status,200);assert.equal(next.body.data.items.length,20);assert(!next.body.data.items.some(row=>roll.body.data.items.some(previous=>previous.source.uid===row.source.uid)));
 const discovery=await env.request('/v1/worldbook/features',{data:{kind:'discovery',runtimeToken,scope:{}}});assert.equal(discovery.status,200);assert.equal(discovery.body.data.candidateCount,20);
 assert.equal((await env.request('/v1/worldbook/features',{data:{kind:'discovery',runtimeToken,aiKey:'PRIVATE_AI_KEY'}})).status,400);
 const preset=await env.request('/v1/worldbook/commands',{data:command('preset-create',{name:'精确',columnId:created.body.data.column.id})});assert.equal(preset.status,200);
 const missing=await env.request('/v1/worldbook/runtime',{data:{mode:'observed',unknownBooks:[],offset:0,bindings:bindings.slice(0,1),complete:true}});assert.equal(missing.status,200);
 const plan=await env.request('/v1/worldbook/features',{data:{kind:'plan',presetId:preset.body.data.presetId,revision:1,runtimeToken:missing.body.data.token}});assert.equal(plan.status,409);assert.equal(plan.body.error.code,'WORLDBOOK_RUNTIME_UNAVAILABLE');
 assert.doesNotMatch(JSON.stringify(env.logs),/PRIVATE_SOURCE|PRIVATE_CONTENT|PRIVATE_AI_KEY/);
});
