import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountDocuments } from '../src/account-documents/store.js';
import { createAccountRecords } from '../src/account-records/store.js';
import { advisorRecordConsumers,validateAdvisorSettings,validateOraclePersonas,validateAdvisorRecord } from '../src/account-documents/oracle-advisor.js';
const config={policy:{core:{allowedOrigins:['https://example.test']}}};
const identity={kind:'character',owner:'Alice.png',chat:'chat-1'};
const recipe=arc=>({version:1,nodes:(arc?['arc-beat-protocol','compile-task']:['story-plan-protocol','current-input']).map(source=>({id:source,type:'protected',title:source,role:'system',enabled:true,source,options:{}}))});
const settings=(version=4,extra={})=>({advisor:{settingsVersion:version,connectionId:'',recipe:recipe(false),promptProfiles:{version:1,activeId:'official',items:[]}},arc:{settingsVersion:3,connectionId:'',tokenBudget:0,recipe:recipe(true),promptProfiles:{version:1,activeId:'official',items:[]}},guidanceDepth:4,...extra});
const modernSettings=(extra={})=>({advisor:{settingsVersion:5,connectionId:'',recipe:recipe(false),promptProfiles:{version:1,activeId:'official',items:[]}},guidanceDepth:1,guidanceShouldScan:true,...extra});
const guidanceItem=(extra={})=>({id:'g-1',title:'推进',goal:'先试探态度',seed:'借一杯热茶开口',why:'顺理成章',intensity:'normal',sourceThreadId:'t',sourceMessageId:'m',adoptedAt:'2026-11-24T00:00:00.000Z',adoptedAtMessageCount:2,reminded:false,injectionOverride:'',...extra});
const legacyArcRecord=(active=null)=>({draft:{mode:'transparent',throughline:'主线',span:'short',waypoints:['起点','中段','收束'],difficulty:'normal',direction:'',redlines:[]},compiled:null,lastAttempt:null,active,lastEnded:null});
const legacyActiveArc=()=>({id:'arc-1',mode:'transparent',throughline:'主线',span:'short',waypoints:['起点','中段','收束'],difficulty:'normal',direction:'',redlines:[],waypointIndex:0,currentBeat:{title:'拍1',goal:'铺垫',objective:'打开线索',seed:'细节',why:'自然',type:'setup'},intensity:'normal',injectionOverride:'',status:'active',history:[],startedAt:1,updatedAt:1,adoptedAtMessageCount:1,reminded:false,remindedAt:0});
const thread=(id='t',messages=[{id:'m',role:'user',content:'保留完整内容'}])=>({identity:{...identity},thread:{id,title:'对话',autoTitle:true,createdAt:1,updatedAt:1,messages}});
test('Advisor documents enforce canonical settings, profile recipes and independent bounded persona library',()=>{
  validateAdvisorSettings(settings(4));
  validateAdvisorSettings(settings(5,{guidanceShouldScan:false}));
  validateAdvisorSettings(modernSettings());
  validateAdvisorSettings({advisor:modernSettings().advisor,guidanceDepth:1});
  validateOraclePersonas({personas:[]});
  for(const mutate of [p=>p.extra=1,p=>p.advisor.apiKey='secret',p=>p.guidanceDepth=-1,p=>p.advisor.settingsVersion=3,p=>p.advisor.settingsVersion=6,
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
  validateAdvisorRecord('oracle-advisor-story',{identity,guidance:{active:guidanceItem(),lastEnded:guidanceItem({outcome:'replaced-by-arc',endedAt:'2026-11-24T00:05:00.000Z'})}});
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
