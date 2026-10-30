import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAiConnections} from '../src/ai-connections/store.js';
const config={policy:{core:{allowedOrigins:['https://example.test']}}};
const profile={id:'synthetic-profile',name:'Example',apiUrl:'https://example.invalid/v1',model:'synthetic-model',models:[],source:'openai',proxyPreset:'',streamMode:'auto',imageInput:{enabled:false,maxImagesPerRequest:1},parameters:{}};
test('account metadata persists across clients while secrets require exact revision; CAS prevents lost updates',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'ttb-ai-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const a=createAiConnections(config),b=createAiConnections(config);await a.definition.initialize();await b.definition.initialize();t.after(()=>a.definition.shutdown());t.after(()=>b.definition.shutdown());
 const alice={userRoot:path.join(root,'alice')},bob={userRoot:path.join(root,'bob')};
 const saved=await a.command(alice,{operation:'save',expectedRevision:0,profile,key:'synthetic-credential'});
 assert.equal(saved.revision,1);assert.equal(saved.profiles[0].hasKey,true);assert(!JSON.stringify(saved).includes('synthetic-credential'));
 assert.deepEqual(await b.read(alice),saved);assert.deepEqual((await b.read(bob)).profiles,[]);
 await assert.rejects(b.credential(bob,{id:profile.id,revision:1}),{code:'CONNECTION_NOT_FOUND'});
 await assert.rejects(b.command(alice,{operation:'delete',expectedRevision:0,id:profile.id}),{code:'REVISION_CONFLICT'});
 assert.equal((await b.credential(alice,{id:profile.id,revision:1})).key,'synthetic-credential');
 await b.command(alice,{operation:'save',expectedRevision:1,profile:{...profile,name:'Updated'}});
 await assert.rejects(a.credential(alice,{id:profile.id,revision:1}),{code:'REVISION_CONFLICT'});
 assert.equal((await a.credential(alice,{id:profile.id,revision:2})).key,'synthetic-credential');
 await a.command(alice,{operation:'default',expectedRevision:2,id:profile.id});
 await b.command(alice,{operation:'delete',expectedRevision:3,id:profile.id});
 assert.equal((await a.read(alice)).defaultProfileId,'');
 assert.equal((await stat(path.join(alice.userRoot,'tavern-toolbox-server/ai-connections-v1/connections.sqlite'))).mode&0o777,0o600);
});
test('invalid metadata and oversized secret fail without partial persistence',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'ttb-ai-'));t.after(()=>rm(root,{recursive:true,force:true}));const s=createAiConnections(config);await s.definition.initialize();t.after(()=>s.definition.shutdown());const c={userRoot:root};
 for(const p of [{...profile,apiKey:'unexpected'},{...profile,id:'../invalid'},{...profile,apiUrl:'javascript:alert(1)'}])await assert.rejects(s.command(c,{operation:'save',expectedRevision:0,profile:p,key:''}),{code:'INVALID_REQUEST'});
 await assert.rejects(s.command(c,{operation:'save',expectedRevision:0,profile,key:'x'.repeat(8193)}),{code:'INVALID_REQUEST'});
 assert.equal((await s.read(c)).revision,0);
});

test('HTTP credential reads require authenticated context, protocol, trusted Origin and CSRF; lists/logs omit keys',async t=>{
 const {default:express}=await import('express');const {once}=await import('node:events');const {createCore}=await import('../src/core.js');
 const root=await mkdtemp(path.join(tmpdir(),'ttb-ai-http-'));t.after(()=>rm(root,{recursive:true,force:true}));const logs=[];
 const core=await createCore({logger:{info:v=>logs.push(v),error:v=>logs.push(v)},policyOptions:{configPath:path.join(root,'policy.json'),read:async()=>JSON.stringify({schemaVersion:1,core:{allowedOrigins:['https://example.test']}})}});t.after(()=>core.shutdown());
 const app=express();app.use(express.json({limit:'64kb'}));app.use((req,res,next)=>{const user=req.headers['x-test-user'];if(['alice','bob'].includes(user))req.user={profile:{handle:user,enabled:true},directories:{root:path.join(root,user)}};req.session={csrfToken:'fixture-csrf'};next();});const router=express.Router();core.attach(router);app.use(router);
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;const contexts={};
 for(const user of ['alice','bob']){const r=await fetch(base+'/v1/status',{headers:{'X-Test-User':user,'X-TTB-Protocol':'1.0'}});contexts[user]=(await r.json()).data.contextId;}
 async function call(route='',body,user='alice',extra={}){const r=await fetch(base+'/v1/ai/connections'+route,{method:body?'POST':'GET',headers:{'X-Test-User':user,'X-TTB-Protocol':'1.0','X-TTB-Context':contexts[user]||'','Origin':'https://example.test','X-CSRF-Token':'fixture-csrf','Content-Type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,headers:r.headers,body:await r.json()};}
 const saved=await call('/commands',{operation:'save',expectedRevision:0,profile,key:'synthetic-credential'});assert.equal(saved.status,200);
 const read=await call();assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');assert(!JSON.stringify(read.body).includes('synthetic-credential'));
 for(const extra of [{'X-CSRF-Token':'bad'},{Origin:'https://foreign.example.test'},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await call('/credential',{id:profile.id,revision:1},'alice',extra)).status,403);
 assert.equal((await call('/credential',{id:profile.id,revision:1},'bob',{'X-TTB-Context':contexts.alice})).status,409);
 assert.equal((await call('/credential',{id:profile.id,revision:1},'bob')).status,404);
 assert.equal((await call('/credential',{id:profile.id,revision:1},'')).status,403);
 const secret=await call('/credential',{id:profile.id,revision:1});assert.equal(secret.status,200);assert.equal(secret.body.data.key,'synthetic-credential');assert.equal(secret.headers.get('cache-control'),'no-store');
 const change=await call('/commands',{operation:'save',expectedRevision:1,profile:{...profile,apiUrl:'https://other.example.invalid/v1'}});assert.equal(change.body.error.code,'CREDENTIAL_REQUIRED');assert.equal((await call()).body.data.revision,1);
 assert(!JSON.stringify(logs).includes('synthetic-credential'));
});

test('concurrent writes accept one revision, explicit empty key clears it, and restart retains committed data',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'ttb-ai-cas-'));t.after(()=>rm(root,{recursive:true,force:true}));const c={userRoot:root};
 const s=createAiConnections(config);await s.definition.initialize();
 const results=await Promise.allSettled(['first','second'].map(name=>s.command(c,{operation:'save',expectedRevision:0,profile:{...profile,name,model:''},key:'synthetic-credential'})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'REVISION_CONFLICT');
 await s.command(c,{operation:'save',expectedRevision:1,profile:{...profile,apiUrl:'https://other.example.invalid/v1'},key:''});s.definition.shutdown();
 const restarted=createAiConnections(config);await restarted.definition.initialize();t.after(()=>restarted.definition.shutdown());
 assert.equal((await restarted.read(c)).profiles[0].hasKey,false);assert.equal((await restarted.credential(c,{id:profile.id,revision:2})).key,'');
});
