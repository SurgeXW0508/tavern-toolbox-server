import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createAccountDocuments } from '../src/account-documents/store.js';
import { createAccountRecords } from '../src/account-records/store.js';
import {
  advisorRecordConsumers,
  reconcileAdvisorSettingsCommit,
  validateAdvisorSettings,
  validateOraclePersonas,
  validateAdvisorRecord,
} from '../src/account-documents/oracle-advisor.js';
const config={policy:{core:{allowedOrigins:['https://example.test']}}};
const identity={kind:'character',owner:'Alice.png',chat:'chat-1'};
const recipe=arc=>({version:1,nodes:(arc?['arc-beat-protocol','compile-task']:['story-plan-protocol','current-input']).map(source=>({id:source,type:'protected',title:source,role:'system',enabled:true,source,options:{}}))});
const recipeWithMainChat=(depth=-1)=>({
  version:1,
  nodes:[
    {id:'main-chat',type:'source',title:'主聊天记录',role:'system',enabled:true,source:'main-chat',options:{depth,includeHidden:false}},
    ...recipe(false).nodes,
  ],
});
const settings=(version=4,extra={})=>({advisor:{settingsVersion:version,connectionId:'',recipe:recipe(false),promptProfiles:{version:1,activeId:'official',items:[]}},arc:{settingsVersion:3,connectionId:'',tokenBudget:0,recipe:recipe(true),promptProfiles:{version:1,activeId:'official',items:[]}},guidanceDepth:4,...extra});
const modernSettings=(extra={})=>({advisor:{settingsVersion:5,connectionId:'',recipe:recipe(false),promptProfiles:{version:1,activeId:'official',items:[]}},guidanceDepth:1,guidanceShouldScan:true,...extra});
const legacyGuidanceItem=(extra={})=>({id:'g-1',title:'推进',goal:'先试探态度',seed:'借一杯热茶开口',why:'顺理成章',intensity:'normal',sourceThreadId:'t',sourceMessageId:'m',adoptedAt:'2026-11-24T00:00:00.000Z',adoptedAtMessageCount:2,reminded:false,injectionOverride:'',...extra});
const guidanceItem=(extra={})=>legacyGuidanceItem({kind:'single',paused:false,...extra});
const legacyArcRecord=(active=null)=>({draft:{mode:'transparent',throughline:'主线',span:'short',waypoints:['起点','中段','收束'],difficulty:'normal',direction:'',redlines:[]},compiled:null,lastAttempt:null,active,lastEnded:null});
const legacyActiveArc=()=>({id:'arc-1',mode:'transparent',throughline:'主线',span:'short',waypoints:['起点','中段','收束'],difficulty:'normal',direction:'',redlines:[],waypointIndex:0,currentBeat:{title:'拍1',goal:'铺垫',objective:'打开线索',seed:'细节',why:'自然',type:'setup'},intensity:'normal',injectionOverride:'',status:'active',history:[],startedAt:1,updatedAt:1,adoptedAtMessageCount:1,reminded:false,remindedAt:0});
const thread=(id='t',messages=[{id:'m',role:'user',content:'保留完整内容'}])=>({identity:{...identity},thread:{id,title:'对话',autoTitle:true,createdAt:1,updatedAt:1,messages}});
test('Advisor documents enforce canonical settings, profile recipes and independent bounded persona library',()=>{
  validateAdvisorSettings(settings(4));
  validateAdvisorSettings(settings(5,{guidanceShouldScan:false}));
  validateAdvisorSettings(modernSettings());
  validateAdvisorSettings({advisor:modernSettings().advisor,guidanceDepth:1});
  validateOraclePersonas({personas:[]});
  for(const mutate of [p=>p.extra=1,p=>p.advisor.apiKey='secret',p=>p.guidanceDepth=-1,p=>p.advisor.settingsVersion=3,p=>p.advisor.settingsVersion=7,
    p=>p.guidanceShouldScan='yes',p=>p.guidanceShouldScan=null,p=>p.arc=null,
    p=>p.advisor.connectionId='device-local-id',p=>p.arc.connectionId='tavern-current',p=>p.advisor.connectionId='cloud:bad/path',
    p=>p.advisor.recipe.nodes[0].enabled=false,p=>p.advisor.recipe.nodes[0].source='correction',p=>p.advisor.recipe.nodes[0].options.path='/tmp/private',
    p=>p.arc.recipe.nodes.pop(),p=>p.advisor.promptProfiles.activeId='unknown',p=>p.advisor.promptProfiles.items=[{id:'p',name:'P',payload:{recipe:recipe(false),tokenBudget:4}}]]){
    const p=settings();mutate(p);assert.throws(()=>validateAdvisorSettings(p),{code:'DOCUMENT_INVALID'});
  }
  const persona={id:'custom-p',label:'人格',description:'',voice:'语气',example:'',custom:true};
  validateOraclePersonas({personas:[persona]});
  for(const p of [{personas:[{...persona,id:'plain'}]},{personas:[persona,persona]},{personas:[{...persona,voice:'x'.repeat(8001)}]},
    {personas:[{...persona,custom:false}]},{personas:[{...persona,apiKey:'forbidden'}]},{personas:Array.from({length:51},(_,i)=>({...persona,id:'p'+i}))}])assert.throws(()=>validateOraclePersonas(p),{code:'DOCUMENT_INVALID'});
});
test('record validators reject malformed identities, unknown fields, truncated messages and excessive indexes',()=>{
  validateAdvisorRecord('oracle-advisor-threads',thread('t',[
    {id:'m1',role:'user',content:'保留完整内容'},
    {id:'m2',role:'assistant',content:'半截回复',prompt:false,stopped:true,meta:'GPT · 已停止'},
    {id:'m3',role:'assistant',content:'未确认回复',prompt:false,unconfirmed:true,meta:'GPT · 未确认完成'},
  ]));
  for(const mutate of [p=>p.identity.userRoot='/tmp/other',p=>p.identity.kind='current',p=>p.thread.messages[0].role='system',
    p=>p.thread.messages[0].content=null,p=>p.thread.messages.push(p.thread.messages[0]),p=>p.thread.messages[0].runtime={polling:true},
    p=>p.thread.messages[0].stopped=true,p=>p.thread.messages[0].unconfirmed=true,
    p=>p.thread.messages.push({id:'m-bad-1',role:'assistant',content:'x',stopped:'true'}),
    p=>p.thread.messages.push({id:'m-bad-2',role:'assistant',content:'x',unconfirmed:1})]){
    const p=thread();mutate(p);assert.throws(()=>validateAdvisorRecord('oracle-advisor-threads',p),{code:'DOCUMENT_INVALID'});
  }
  assert.throws(()=>validateAdvisorRecord('oracle-advisor-thread-index',{identity,threads:Array.from({length:51},(_,i)=>({id:'t'+i,title:'T',autoTitle:true,createdAt:1,updatedAt:1,messageCount:0}))}),{code:'DOCUMENT_INVALID'});
  assert.throws(()=>validateAdvisorRecord('oracle-advisor-workspace',{identity,threadId:'t',draft:'D',loreSelection:{selected:{},hybrid:false},scrollTop:10}),{code:'DOCUMENT_INVALID'});
  // Story records: new payloads omit arc, preserve historical replaced-by-arc outcome, and keep legacy arc readable while rejecting dual-active or malformed arc.
  validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:guidanceItem(),lastEnded:legacyGuidanceItem({outcome:'replaced-by-arc',endedAt:'2026-11-24T00:05:00.000Z'})}});
  validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:null,lastEnded:null},arc:legacyArcRecord(legacyActiveArc())});
  assert.throws(()=>validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:guidanceItem(),lastEnded:null},arc:legacyArcRecord(legacyActiveArc())}),{code:'DOCUMENT_INVALID'});
  assert.throws(()=>validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:null,lastEnded:null},arc:null}),{code:'DOCUMENT_INVALID'});
  // Dormant arc workspace consumer remains readable/valid for legacy records.
  validateAdvisorRecord('oracle-advisor-arc-workspace',{identity,draft:legacyArcRecord().draft,draftDirty:false});
});
test('Advisor production consumers use independent Document and Record CAS without exposing other Oracle apps',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'ttb-advisor-server-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const documents=createAccountDocuments(config),records=createAccountRecords(config,{consumers:advisorRecordConsumers});
  await documents.definition.initialize();await records.definition.initialize();t.after(()=>{documents.definition.shutdown();records.definition.shutdown();});
  const alice={userRoot:path.join(root,'alice'),contextId:'alice'},bob={userRoot:path.join(root,'bob'),contextId:'bob'};
  await documents.commit(alice,'oracle-advisor-settings',{schemaVersion:1,expectedRevision:0,payload:settings(4)});
  await documents.commit(alice,'oracle-advisor-settings',{schemaVersion:1,expectedRevision:1,payload:modernSettings()});
  const readSettings=await documents.read(alice,'oracle-advisor-settings',1);
  assert.equal(readSettings.revision,2);
  assert.equal(readSettings.payload.advisor.settingsVersion,5);
  assert.equal(readSettings.payload.guidanceShouldScan,true);
  assert.equal('arc' in readSettings.payload,false);
  assert.equal((await documents.read(bob,'oracle-advisor-settings',1)).revision,0);
  const commit=(id,payload,expectedRevision=0)=>records.commit(alice,'oracle-advisor-threads',id,{schemaVersion:1,expectedRevision,payload});
  await commit('thread-a',thread('a'));await commit('thread-b',thread('b'));await commit('thread-a',thread('a'),1);
  assert.equal((await records.read(alice,'oracle-advisor-threads','thread-b',1)).revision,1);
  await assert.rejects(commit('thread-a',thread('a'),1),{code:'REVISION_CONFLICT'});
  assert.equal((await records.read(bob,'oracle-advisor-threads','thread-a',1)).status,'missing');
  // Workspace consumer must allow deletion (tombstone) and have 10000 record cap.
  const wsConsumer=advisorRecordConsumers.find(c=>c.id==='oracle-advisor-workspace');
  assert.equal(wsConsumer.deletable,true);
  assert.equal(wsConsumer.maxRecords,10000);
  await records.commit(alice,'oracle-advisor-workspace','ws-a',{schemaVersion:1,expectedRevision:0,payload:{identity,threadId:'a',draft:'草稿',loreSelection:{selected:{},hybrid:false}}});
  const deleted=await records.delete(alice,'oracle-advisor-workspace','ws-a',{schemaVersion:1,expectedRevision:1});
  assert.equal(deleted.status,'deleted');
  assert.equal((await records.read(alice,'oracle-advisor-workspace','ws-a',1)).status,'deleted');
  for(const consumer of ['oracle-correction','oracle-diagnosis','oracle-lorebook-manager'])assert.throws(()=>records.consumer(consumer),{code:'RECORD_CONSUMER_NOT_REGISTERED'});
});
test('reconcileAdvisorSettingsCommit protects v5 fields from v0.57.0 v4 write-backs while keeping v4-only and v5 commits verbatim',async t=>{
  // 1. Direct unit checks: null / v4 current returns incoming verbatim; v5 incoming returns verbatim
  const v4Init=settings(4);
  assert.equal(reconcileAdvisorSettingsCommit(v4Init,null),v4Init);
  assert.equal(reconcileAdvisorSettingsCommit(v4Init,settings(4)),v4Init);
  const v5Explicit=modernSettings({guidanceDepth:4,guidanceShouldScan:false,advisor:{...modernSettings().advisor,recipe:recipeWithMainChat(-1)}});
  assert.equal(reconcileAdvisorSettingsCommit(v5Explicit,modernSettings()),v5Explicit);

  // 2. End-to-end SQLite commit reconciliation
  const root=await mkdtemp(path.join(tmpdir(),'ttb-advisor-reconcile-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const documents=createAccountDocuments(config);
  await documents.definition.initialize();t.after(()=>documents.definition.shutdown());
  const alice={userRoot:path.join(root,'alice'),contextId:'alice'};

  // Stage 2 saves v5 with shouldScan: false, guidanceDepth: 4, official main-chat depth 10, and arc stub
  const v5Saved={
    advisor:{settingsVersion:5,connectionId:'cloud:stage2',recipe:recipeWithMainChat(10),promptProfiles:{version:1,activeId:'official',items:[]}},
    arc:settings(4).arc,
    guidanceDepth:4,
    guidanceShouldScan:false,
  };
  const r1=await documents.commit(alice,'oracle-advisor-settings',{schemaVersion:1,expectedRevision:0,payload:v5Saved});
  assert.equal(r1.revision,1);
  assert.deepEqual(r1.payload,v5Saved);

  // Legacy v0.57.0 client reads and writes back v4 (edits connectionId, drops guidanceShouldScan, resets official main-chat depth to -1)
  const v4FromOldClient={
    advisor:{settingsVersion:4,connectionId:'cloud:from-old-device',recipe:recipeWithMainChat(-1),promptProfiles:{version:1,activeId:'official',items:[]}},
    arc:settings(4).arc,
    guidanceDepth:4,
  };
  const r2=await documents.commit(alice,'oracle-advisor-settings',{schemaVersion:1,expectedRevision:1,payload:v4FromOldClient});
  assert.equal(r2.revision,2);
  assert.equal(r2.payload.advisor.settingsVersion,5,'must keep settingsVersion 5');
  assert.equal(r2.payload.advisor.connectionId,'cloud:from-old-device','must preserve legacy client edit');
  assert.equal(r2.payload.guidanceShouldScan,false,'must preserve existing guidanceShouldScan');
  assert.equal(r2.payload.guidanceDepth,4,'must preserve guidanceDepth');
  assert.equal(r2.payload.advisor.recipe.nodes[0].options.depth,10,'official main-chat depth reset to -1 must be restored to 10');
  assert.deepEqual(r2.payload.arc,settings(4).arc,'must keep legacy arc intact');

  // Legacy v0.57.0 client editing a custom profile with main-chat depth -1 must NOT override custom profile depth
  const customProfile={id:'custom-1',name:'我的配置',payload:{recipe:recipeWithMainChat(-1)}};
  const v4CustomFromOldClient={
    advisor:{settingsVersion:4,connectionId:'cloud:custom',recipe:recipeWithMainChat(-1),promptProfiles:{version:1,activeId:'custom-1',items:[customProfile]}},
    arc:settings(4).arc,
    guidanceDepth:4,
  };
  const r3=await documents.commit(alice,'oracle-advisor-settings',{schemaVersion:1,expectedRevision:2,payload:v4CustomFromOldClient});
  assert.equal(r3.revision,3);
  assert.equal(r3.payload.advisor.settingsVersion,5);
  assert.equal(r3.payload.guidanceShouldScan,false);
  assert.equal(r3.payload.advisor.recipe.nodes[0].options.depth,-1,'custom profile main-chat depth -1 must stay untouched');
});

test('Stage 3: oracle-advisor-settings validates v6 quickCommands and preserves them across v4/v5 write-backs',async t=>{
  const quick=(i,extra={})=>({id:`aq-${i}`,name:`指令 ${i}`,content:`请帮我推进第 ${i} 步`,favorite:i%2===0,...extra});
  const v6Settings=(commands=[quick(1),quick(2)],extra={})=>({
    advisor:{
      settingsVersion:6,
      connectionId:'cloud:stage3',
      recipe:recipeWithMainChat(10),
      promptProfiles:{version:1,activeId:'official',items:[]},
      quickCommands:commands,
    },
    arc:settings(4).arc,
    guidanceDepth:1,
    guidanceShouldScan:true,
    ...extra,
  });

  validateAdvisorSettings(v6Settings([]));
  validateAdvisorSettings(v6Settings(Array.from({length:50},(_,i)=>quick(i))));

  // Reject invalid quickCommands payloads
  for(const badCommands of [
    'not-array',
    Array.from({length:51},(_,i)=>quick(i)),
    [quick(1),quick(1)],
    [quick(1,{id:''})],
    [quick(1,{name:'   '})],
    [quick(1,{content:''})],
    [quick(1,{favorite:'yes'})],
    [{...quick(1),extra:true}],
    [quick(1,{name:'x'.repeat(61)})],
    [quick(1,{content:'x'.repeat(8001)})],
  ]){
    assert.throws(()=>validateAdvisorSettings(v6Settings(badCommands)),{code:'DOCUMENT_INVALID'});
  }

  // End-to-end SQLite commit reconciliation for v6 -> v5 and v6 -> v4 write-backs
  const root=await mkdtemp(path.join(tmpdir(),'ttb-advisor-stage3-reconcile-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const documents=createAccountDocuments(config);
  await documents.definition.initialize();t.after(()=>documents.definition.shutdown());
  const alice={userRoot:path.join(root,'alice'),contextId:'alice'};

  const initialCmds=[quick(1,{favorite:true}),quick(2,{favorite:false})];
  const r1=await documents.commit(alice,'oracle-advisor-settings',{schemaVersion:1,expectedRevision:0,payload:v6Settings(initialCmds,{guidanceShouldScan:false})});
  assert.equal(r1.revision,1);
  assert.deepEqual(r1.payload.advisor.quickCommands,initialCmds);

  // Stage 2 (v5) client edits guidanceShouldScan without quickCommands -> must keep v6 + quickCommands while respecting v5 edit
  const v5WriteBack={
    advisor:{settingsVersion:5,connectionId:'cloud:from-v5',recipe:recipeWithMainChat(10),promptProfiles:{version:1,activeId:'official',items:[]}},
    arc:settings(4).arc,
    guidanceDepth:2,
    guidanceShouldScan:true,
  };
  const r2=await documents.commit(alice,'oracle-advisor-settings',{schemaVersion:1,expectedRevision:1,payload:v5WriteBack});
  assert.equal(r2.revision,2);
  assert.equal(r2.payload.advisor.settingsVersion,6,'must preserve v6 on v5 write-back');
  assert.equal(r2.payload.advisor.connectionId,'cloud:from-v5');
  assert.equal(r2.payload.guidanceShouldScan,true,'must respect explicit v5 guidanceShouldScan edit');
  assert.deepEqual(r2.payload.advisor.quickCommands,initialCmds,'must preserve quickCommands on v5 write-back');

  // Legacy v0.57.0 (v4) client writes back without guidanceShouldScan or quickCommands and resets official main-chat depth to -1
  const v4WriteBack={
    advisor:{settingsVersion:4,connectionId:'cloud:from-v4',recipe:recipeWithMainChat(-1),promptProfiles:{version:1,activeId:'official',items:[]}},
    arc:settings(4).arc,
    guidanceDepth:2,
  };
  const r3=await documents.commit(alice,'oracle-advisor-settings',{schemaVersion:1,expectedRevision:2,payload:v4WriteBack});
  assert.equal(r3.revision,3);
  assert.equal(r3.payload.advisor.settingsVersion,6,'must preserve v6 on v4 write-back');
  assert.equal(r3.payload.guidanceShouldScan,true,'must preserve guidanceShouldScan on v4 write-back');
  assert.equal(r3.payload.advisor.recipe.nodes[0].options.depth,10,'must restore official main-chat depth 10');
  assert.deepEqual(r3.payload.advisor.quickCommands,initialCmds,'must preserve quickCommands on v4 write-back');

  // Explicit v6 commit emptying quickCommands must pass through verbatim
  const v6Cleared=v6Settings([]);
  const r4=await documents.commit(alice,'oracle-advisor-settings',{schemaVersion:1,expectedRevision:3,payload:v6Cleared});
  assert.equal(r4.revision,4);
  assert.deepEqual(r4.payload.advisor.quickCommands,[],'v6 explicit empty quickCommands must not be overridden');
});

test('Stage 3: oracle-advisor-story validates dual-mode single (with kind/paused) and sequence with strict cursor invariants',()=>{
  const beat=(i,status,extra={})=>({
    id:`beat-${i}`,
    title:`第 ${i} 拍`,
    goal:`完成第 ${i} 阶段推进`,
    seed:`线索 ${i}`,
    why:`契合理由 ${i}`,
    status,
    intensity:'normal',
    injectionOverride:'',
    ...extra,
  });
  const seq=(beats,cursor,extra={})=>({
    kind:'sequence',
    id:'seq-1',
    title:'长线序列',
    beats,
    cursor,
    paused:false,
    sourceThreadId:'t-1',
    sourceMessageId:'m-1',
    adoptedAt:'2026-11-24T00:00:00.000Z',
    adoptedAtMessageCount:4,
    reminded:false,
    ...extra,
  });

  // Valid single variants: legacy (no kind/paused), explicit kind + paused
  validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:guidanceItem({kind:'single',paused:true}),lastEnded:guidanceItem({kind:'single',paused:false,outcome:'completed',endedAt:'2026-11-24T01:00:00.000Z'})}});

  // Valid active sequence (done, skipped, active, pending, skipped) & 1-beat / 24-beat bounds
  const activeSeq=seq([beat(1,'done'),beat(2,'skipped'),beat(3,'active',{intensity:'push'}),beat(4,'pending'),beat(5,'skipped')],2,{paused:true});
  const completedSeq=seq([beat(1,'done'),beat(2,'skipped'),beat(3,'done')],2,{outcome:'completed',endedAt:'2026-11-24T02:00:00.000Z'});
  const abandonedSeq=seq([beat(1,'done'),beat(2,'active'),beat(3,'pending')],1,{outcome:'abandoned',endedAt:'2026-11-24T02:00:00.000Z'});
  const maxSeq=seq([beat(0,'active'),...Array.from({length:23},(_,i)=>beat(i+1,'pending'))],0);

  validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:activeSeq,lastEnded:completedSeq}});
  validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:seq([beat(1,'active')],0),lastEnded:abandonedSeq}});
  validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:maxSeq,lastEnded:null}});
  validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:activeSeq,lastEnded:null},arc:legacyArcRecord(null)});

  // Invalid single variants
  assert.throws(()=>validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:guidanceItem({kind:'arc'}),lastEnded:null}}),{code:'DOCUMENT_INVALID'});
  assert.throws(()=>validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:guidanceItem({paused:'yes'}),lastEnded:null}}),{code:'DOCUMENT_INVALID'});

  // Invalid active sequences
  const invalidActives=[
    seq([],0), // 0 beats
    seq([beat(0,'active'),...Array.from({length:24},(_,i)=>beat(i+1,'pending'))],0), // 25 beats
    seq([beat(1,'active'),beat(1,'pending')],0), // duplicate beat id
    seq([beat(1,'active',{goal:'   '})],0), // blank goal
    seq([beat(1,'active'),beat(2,'active')],0), // two active beats
    seq([beat(1,'done'),beat(2,'pending')],1), // cursor beat not active
    seq([beat(1,'pending'),beat(2,'active')],1), // pending before cursor
    seq([beat(1,'active'),beat(2,'done')],0), // done after cursor
    seq([beat(1,'active'),beat(2,'pending')],2), // cursor out of range
    seq([beat(1,'active')],-1), // negative cursor
    seq([beat(1,'active')],0,{paused:'no'}), // non-bool paused
    seq([beat(1,'active')],0,{id:''}), // empty id
  ];
  for(const badSeq of invalidActives){
    assert.throws(()=>validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:badSeq,lastEnded:null}}),{code:'DOCUMENT_INVALID'});
  }

  // Invalid lastEnded sequences
  assert.throws(()=>validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:null,lastEnded:seq([beat(1,'done'),beat(2,'active')],1,{outcome:'completed',endedAt:'2026-11-24T02:00:00.000Z'})}}),{code:'DOCUMENT_INVALID'});
  assert.throws(()=>validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:null,lastEnded:seq([beat(1,'done'),beat(2,'pending')],0,{outcome:'completed',endedAt:'2026-11-24T02:00:00.000Z'})}}),{code:'DOCUMENT_INVALID'});
  assert.throws(()=>validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:null,lastEnded:seq([beat(1,'active'),beat(2,'active')],0,{outcome:'abandoned',endedAt:'2026-11-24T02:00:00.000Z'})}}),{code:'DOCUMENT_INVALID'});

  // Sequence active + legacy arc active must still be rejected
  assert.throws(()=>validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:activeSeq,lastEnded:null},arc:legacyArcRecord(legacyActiveArc())}),{code:'DOCUMENT_INVALID'});
});

test('[S3-R2-Server-2] oracle-advisor-story upgrades to schemaVersion 2 with 1->2 on-demand migration, strict v2 active single validation, and old-client rejection',async t=>{
  // Only oracle-advisor-story moves to schemaVersion 2; all other Advisor record consumers remain schemaVersion 1.
  const storyConsumer=advisorRecordConsumers.find(c=>c.id==='oracle-advisor-story');
  assert.equal(storyConsumer.schemaVersion,2);
  assert.equal(Array.isArray(storyConsumer.migrations),true);
  for(const c of advisorRecordConsumers.filter(x=>x.id!=='oracle-advisor-story')){
    assert.equal(c.schemaVersion,1,`consumer ${c.id} must remain schemaVersion 1`);
  }

  // v2 strict validation rejects active single missing kind or paused, while allowing legacy lastEnded without kind/paused
  assert.throws(()=>validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:legacyGuidanceItem(),lastEnded:null}}),{code:'DOCUMENT_INVALID'});
  assert.throws(()=>validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:legacyGuidanceItem({kind:'single'}),lastEnded:null}}),{code:'DOCUMENT_INVALID'});
  assert.throws(()=>validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:legacyGuidanceItem({paused:false}),lastEnded:null}}),{code:'DOCUMENT_INVALID'});
  validateAdvisorRecord('oracle-advisor-story',{
    identity,
    guidance:{active:null,lastEnded:legacyGuidanceItem({outcome:'replaced-by-arc',endedAt:'2026-11-24T00:05:00.000Z'})},
  });

  const root=await mkdtemp(path.join(tmpdir(),'ttb-advisor-story-v2-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const records=createAccountRecords(config,{consumers:advisorRecordConsumers});
  await records.definition.initialize();t.after(()=>records.definition.shutdown());
  const advertisedStory=records.definition.capabilities[0].constraints.consumers.find(c=>c.id==='oracle-advisor-story');
  assert.equal(advertisedStory.schemaVersion,2);
  assert.equal('migrations' in advertisedStory,false);

  const alice={userRoot:path.join(root,'alice'),contextId:'alice'};
  // Initialize DB by writing one unrelated v1 thread record
  await records.commit(alice,'oracle-advisor-threads','init-thread',{schemaVersion:1,expectedRevision:0,payload:thread('init-thread')});
  const file=path.join(alice.userRoot,'tavern-toolbox-server/account-records-v1/records.sqlite');

  // Seed 3 v1 oracle-advisor-story rows directly in SQLite:
  // 1) Stage 2 v1 single (no kind, no paused) + arc.draft + legacy lastEnded(replaced-by-arc)
  const stage2Payload={
    identity,
    guidance:{
      active:legacyGuidanceItem({id:'s2-single'}),
      lastEnded:legacyGuidanceItem({id:'s2-ended',outcome:'replaced-by-arc',endedAt:'2026-11-24T00:05:00.000Z'}),
    },
    arc:legacyArcRecord(null),
  };
  // 2) Early Stage 3 (b563ff0) v1 paused single (paused: true, without kind)
  const earlyPausedPayload={
    identity:{...identity,chat:'chat-paused'},
    guidance:{active:legacyGuidanceItem({id:'s3-paused',paused:true}),lastEnded:null},
  };
  // 3) Early Stage 3 (b563ff0) v1 sequence (kind: 'sequence')
  const earlySeqPayload={
    identity:{...identity,chat:'chat-seq'},
    guidance:{
      active:{
        kind:'sequence',id:'seq-v1',title:'序列测试',
        beats:[
          {id:'b1',title:'拍1',goal:'铺垫冲突',seed:'茶杯',why:'自然',status:'done',intensity:'normal',injectionOverride:''},
          {id:'b2',title:'拍2',goal:'揭开疑点',seed:'门铃',why:'推进',status:'active',intensity:'push',injectionOverride:'自定义'},
          {id:'b3',title:'拍3',goal:'收束转折',seed:'眼神',why:'落点',status:'pending',intensity:'seed',injectionOverride:''},
        ],
        cursor:1,paused:false,sourceThreadId:'t',sourceMessageId:'m',adoptedAt:'2026-11-24T00:00:00.000Z',adoptedAtMessageCount:3,reminded:false,
      },
      lastEnded:null,
    },
  };

  const db=new DatabaseSync(file);
  const seed=(recordId,payload)=>{
    const encoded=JSON.stringify(payload);
    const charge=256+Buffer.byteLength(recordId,'utf8')+Buffer.byteLength(encoded,'utf8');
    db.prepare('INSERT INTO records(consumer,record_id,schema_version,revision,deleted,created_at,updated_at,payload,storage_bytes) VALUES(?,?,?,?,0,1000,2000,?,?)')
      .run('oracle-advisor-story',recordId,1,1,encoded,charge);
    return charge;
  };
  const totalBytes=seed('chat-stage2',stage2Payload)+seed('chat-paused',earlyPausedPayload)+seed('chat-seq',earlySeqPayload);
  db.prepare('INSERT INTO collections(consumer,records,tombstones,bytes) VALUES(?,?,0,?)').run('oracle-advisor-story',3,totalBytes);
  db.close();

  // Stage 2 v1 -> v2 auto-migration adds kind:'single' and paused:false while preserving lastEnded & arc.draft verbatim
  const migratedStage2=await records.read(alice,'oracle-advisor-story','chat-stage2',2);
  assert.equal(migratedStage2.schemaVersion,2);
  assert.equal(migratedStage2.revision,2);
  assert.equal(migratedStage2.payload.guidance.active.kind,'single');
  assert.equal(migratedStage2.payload.guidance.active.paused,false);
  assert.deepEqual(migratedStage2.payload.guidance.lastEnded,stage2Payload.guidance.lastEnded);
  assert.deepEqual(migratedStage2.payload.arc,stage2Payload.arc);

  // Early Stage 3 v1 paused single -> v2 preserves paused:true and adds kind:'single'
  const migratedPaused=await records.read(alice,'oracle-advisor-story','chat-paused',2);
  assert.equal(migratedPaused.schemaVersion,2);
  assert.equal(migratedPaused.revision,2);
  assert.equal(migratedPaused.payload.guidance.active.kind,'single');
  assert.equal(migratedPaused.payload.guidance.active.paused,true);

  // Early Stage 3 v1 sequence -> v2 preserves beats/cursor verbatim
  const migratedSeq=await records.read(alice,'oracle-advisor-story','chat-seq',2);
  assert.equal(migratedSeq.schemaVersion,2);
  assert.equal(migratedSeq.revision,2);
  assert.deepEqual(migratedSeq.payload.guidance.active,earlySeqPayload.guidance.active);

  // Direct v2 commit with active single missing kind or paused is rejected with RECORD_INVALID
  await assert.rejects(
    async ()=>records.commit(alice,'oracle-advisor-story','chat-bad',{schemaVersion:2,expectedRevision:0,payload:{identity,guidance:{active:legacyGuidanceItem(),lastEnded:null}}}),
    {code:'RECORD_INVALID'},
  );

  // Old v1 client fails closed on read and commit with RECORD_SCHEMA_INCOMPATIBLE
  assert.throws(()=>records.read(alice,'oracle-advisor-story','chat-stage2',1),{code:'RECORD_SCHEMA_INCOMPATIBLE'});
  assert.throws(()=>records.commit(alice,'oracle-advisor-story','chat-stage2',{schemaVersion:1,expectedRevision:2,payload:stage2Payload}),{code:'RECORD_SCHEMA_INCOMPATIBLE'});
});

