import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createCore } from '../src/core.js';
async function fixture(t, write = true, mediaUnavailable = false) {
    const root = await mkdtemp(path.join(tmpdir(), 'ttb-wb-http-')),
        logs = [];
    const core = await createCore({
        ...(mediaUnavailable?{registerModules:registry=>registry.register({id:'media',version:'fixture',dependsOn:[],capabilities:[]})}:{}),
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
    return { request, status: status.data, logs, url };
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

test('HTTP Metadata draft survives another device Binding rebind, and source mutation via Metadata is rejected atomically',async t=>{
 const env=await fixture(t);
 const created=await env.request('/v1/worldbook/commands',{data:command('column-create',{profile:{title:'并发',description:'',icon:{type:'builtin',value:'book'},accent:'#123456'},materials:[{name:'自定义名称',description:'原描述',source:{locator:'书A',uid:1,title:'Entry A'}}]})});assert.equal(created.status,200);
 const original=(await env.request('/v1/worldbook/catalog')).body.data.items[0];
 const phone=command('binding-rebind',{id:original.id,bindingRevision:original.bindingRevision,source:{locator:'书B',uid:7,title:'Entry B'}});
 assert.equal((await env.request('/v1/worldbook/commands',{data:phone})).status,200);
 const pc=await env.request('/v1/worldbook/commands',{data:command('material-update',{id:original.id,revision:original.revision,fields:{description:'PC 已保存的草稿'}})});assert.equal(pc.status,200);
 const saved=(await env.request('/v1/worldbook/materials/'+original.id)).body.data.material;
 assert.equal(saved.description,'PC 已保存的草稿');assert.equal(saved.name,'自定义名称');assert.equal(saved.source.locator,'书B');assert.equal(saved.bindingRevision,original.bindingRevision+1);assert.equal(saved.revision,original.revision+1);
 const legacy=await env.request('/v1/worldbook/commands',{data:command('material-update',{id:saved.id,revision:saved.revision,fields:{description:'不得部分提交',source:{locator:'书C',uid:9,title:'拒绝'}}})});assert.equal(legacy.status,400);
 assert.deepEqual((await env.request('/v1/worldbook/materials/'+original.id)).body.data.material,saved);
 assert.equal((await env.request('/v1/worldbook/commands',{data:phone})).body.data.replayed,true);
 assert.equal((await env.request('/v1/worldbook/materials/'+original.id)).body.data.material.source.locator,'书B');
});

test('Worldbook Media HTTP is an optional context-bound capability, independent of Core; Governance uses Media revision and context',async t=>{
 const f=await fixture(t),cap=f.status.capabilities.find(row=>row.id==='worldbook.media');
 assert.equal(cap.operations.find(row=>row.id==='command').available,true);
 const created=await f.request('/v1/worldbook/commands',{data:command('column-create',{profile:{title:'媒体HTTP',description:'',icon:{type:'builtin',value:'book'},accent:'#112233'},materials:[{name:'资料',source:{locator:'书',uid:1,title:'条目'}}]})});
 const page=await f.request('/v1/worldbook/catalog'),id=page.body.data.items[0].id;
 assert.equal((await f.request('/v1/worldbook/media/read',{data:{materialIds:[]}})).status,400);
 assert.equal((await f.request('/v1/worldbook/media/read',{data:{materialIds:Array(21).fill(id)}})).status,400);
 assert.equal((await f.request('/v1/worldbook/media/commands',{data:command('media-set-cover',{id,revision:1,kind:'image',mediaRef:{provider:'server',assetId:'12345678-1234-4123-8123-123456789abc'}})})).status,422);
 const bytes=await sharp({create:{width:16,height:12,channels:3,background:'red'}}).png().toBuffer();
 const response=await fetch(f.url+'/v1/media/import/local',{method:'POST',headers:{'X-TTB-Protocol':'1.0',Origin:'https://example.invalid','X-CSRF-Token':'worldbook-fixture-csrf','Content-Type':'image/png'},body:bytes});
 const ref=(await response.json()).data.mediaRef;
 const write=command('media-set-cover',{id,revision:1,kind:'image',mediaRef:ref});
 const denied=await f.request('/v1/worldbook/media/commands',{data:write,headers:{'X-TTB-Context':'wrong'}});assert.equal(denied.body.error.code,'CONTEXT_CHANGED');
 const saved=await f.request('/v1/worldbook/media/commands',{data:write});assert.equal(saved.body.data.media.revision,2);
 const detail=await f.request(`/v1/governance/assets/${ref.assetId}`);assert.equal(detail.body.data.references.total,1);
 const body={providerId:'worldbook',groupId:id,referenceId:'cover',revision:1,action:'unlink'};
 assert.equal((await f.request('/v1/governance/action',{data:body})).body.error.code,'WORLDBOOK_MEDIA_CONFLICT');
 const wrong=await f.request('/v1/governance/action',{data:{...body,revision:2},headers:{'X-TTB-Context':'wrong'}});assert.equal(wrong.body.error.code,'CONTEXT_CHANGED');
 const unlinked=await f.request('/v1/governance/action',{data:{...body,revision:2}});assert.equal(unlinked.body.data.revision,3);
 assert.equal((await f.request('/v1/worldbook/media/read',{data:{materialIds:[id],coversOnly:true}})).body.data.items[0].cover,null);
 const old=await fixture(t,true,true);assert.equal(old.status.capabilities.find(row=>row.id==='worldbook.core').operations.find(row=>row.id==='catalog').available,true);
 assert.equal(old.status.capabilities.find(row=>row.id==='worldbook.media').operations.find(row=>row.id==='read').available,false);
 assert.equal((await old.request('/v1/worldbook/catalog')).status,200);
});


test('Folder Candidate capability is additive over HTTP; tree changes reject replay and continuation',async t=>{
 const e=await fixture(t),cap=e.status.capabilities.find(row=>row.id==='worldbook.core');
 assert.equal(cap.constraints.storageSchemaVersion,3);assert.equal(cap.constraints.featureVersion,2);assert.ok(cap.constraints.candidateScopes.includes('folder'));
 const send=async(action,data)=>{const r=await e.request('/v1/worldbook/commands',{data:command(action,data)});assert.equal(r.status,200);return r.body.data;};
 const column=(await send('column-create',{profile:{title:'Folder HTTP',description:'',icon:{type:'builtin',value:'book'},accent:'#123456'},materials:[]})).column.id;
 const summary=async()=> (await e.request('/v1/worldbook/summary')).body.data.columns.find(row=>row.id===column);
 let c=await summary();
 const f=await send('folder-create',{columnId:column,parentId:null,name:'完整分组',structureRevision:c.structureRevision});
 c=await summary();
 await send('material-create',{columnId:column,parentId:f.folderId,structureRevision:c.structureRevision,material:{name:'子孙资料',source:{locator:'HTTP_BOOK',uid:7,title:'Entry'}}});
 const rt=await e.request('/v1/worldbook/runtime',{data:{mode:'observed',offset:0,bindings:[{locator:'HTTP_BOOK',uid:7,enabled:false}],unknownBooks:[],complete:true}});assert.equal(rt.status,200);
 const runtimeToken=rt.body.data.token,scope={columnId:column,folderId:f.folderId};
 const candidate=await e.request('/v1/worldbook/features',{data:{kind:'roll',runtimeToken,scope,limit:1}});assert.equal(candidate.status,200);assert.equal(candidate.body.data.scopeTotal,1);assert.deepEqual(candidate.body.data.folderScope.path,['完整分组']);
 assert.equal((await e.request('/v1/worldbook/features',{data:{kind:'facets',id:'tags',scope}})).status,400);
 assert.equal((await e.request('/v1/worldbook/features',{data:{kind:'session-end',sessionId:candidate.body.data.sessionId,scope}})).status,400);
 c=await summary();await send('folder-create',{columnId:column,parentId:null,name:'结构已变化',structureRevision:c.structureRevision});
 for(const cursor of [0,1]){const r=await e.request('/v1/worldbook/features',{data:{kind:'roll',sessionId:candidate.body.data.sessionId,cursor,runtimeToken}});assert.equal(r.status,409);assert.equal(r.body.error.code,'WORLDBOOK_TREE_CHANGED');}
 const legacy=await e.request('/v1/worldbook/features',{data:{kind:'discovery',scope:{columnId:column},runtimeToken}});assert.equal(legacy.status,200);assert.equal(legacy.body.data.scopeTotal,1);assert.equal('folderScope'in legacy.body.data,false);
 assert.equal((await e.request('/v1/worldbook/features',{data:{kind:'session-end',sessionId:candidate.body.data.sessionId}})).status,200);
});
