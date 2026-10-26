import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorldbookStore } from '../src/worldbook/store.js';
import { WorldbookCandidateSessions } from '../src/worldbook/candidate-sessions.js';
import { query } from '../src/worldbook/validation.js';
async function fixture(t) {
 const root=await mkdtemp(path.join(tmpdir(),'ttb-folder-scope-')),store=new WorldbookStore(root,DatabaseSync);await store.initialize();t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 const send=(action,data)=>store.execute({commandId:`${Date.now()}-${randomUUID()}`,action,data});
 const create=(title)=>send('column-create',{profile:{title,description:'',icon:{type:'builtin',value:'book'},accent:'#123456'},materials:[]}).column.id;
 const column=create('栏目'),other=create('另一栏目');
 const folder=(name,parentId=null,col=column)=>send('folder-create',{columnId:col,parentId,name,structureRevision:store.column(col).structure_revision}).folderId;
 const material=(name,uid,parentId=null,col=column)=>send('material-create',{columnId:col,parentId,structureRevision:store.column(col).structure_revision,material:{name,summary:'简介',description:'不应进入候选的正文',source:{locator:'资源书',uid,title:`Entry ${uid}`}}}).id;
 const move=(id,parentId)=>{const d=store.detail(id),revision=store.column(column).structure_revision;return send('material-move',{id,revision:d.material.revision,columnId:column,parentId,structureRevision:revision,targetStructureRevision:revision});};
 const a=folder('角色'),b=folder('常用',a),c=folder('子分组',b),x=folder('剧情'),same=folder('常用',x);
 const ids=[material('A',1,a),material('B',2,b),material('C',3,c),material('D',4,a)],outside=material('X',9,same);
 const runtime=()=>({observed:true,unknownBooks:[],bindings:store.all('SELECT DISTINCT entry_uid FROM materials').map(r=>({locator:'资源书',uid:r.entry_uid,enabled:false}))});
 const sessions=new WorldbookCandidateSessions(),context={userRoot:root,contextId:'context-one'};
 const read=(kind,scope,extra={})=>sessions.read(context,store,{kind,scope,...extra},runtime());
 return {root,store,send,column,other,folder,material,move,a,b,c,x,same,ids,outside,runtime,sessions,context,read};
}
for(const kind of ['roll','discovery'])test(`${kind} uses the complete descendant tree and ID scope, with existing bounded random cursor and replay`,async t=>{
 const e=await fixture(t),scope={columnId:e.column,folderId:e.a};let input={},result;const found=new Set();
 do {result=e.read(kind,scope,{...input,limit:1});assert.equal(result.items.length,1);assert.deepEqual(e.read(kind,scope,{...input,sessionId:result.sessionId,cursor:input.cursor??0,limit:1}),result);for(const row of result.items){assert.ok(e.ids.includes(row.id));assert.ok(!found.has(row.id));assert.equal('description' in row,false);found.add(row.id);}input={sessionId:result.sessionId,cursor:result.nextCursor};}while(result.nextCursor!==null);
 assert.equal(found.size,4);assert.deepEqual(result.folderScope,{columnId:e.column,folderId:e.a,treeRevision:e.store.column(e.column).tree_revision,path:['角色']});
 const own=e.read(kind,{columnId:e.column,folderId:e.b},{limit:20});assert.deepEqual(new Set(own.items.map(r=>r.id)),new Set(e.ids.slice(1,3)));assert.deepEqual(own.folderScope.path,['角色','常用']);
 const same=e.read(kind,{columnId:e.column,folderId:e.same});assert.deepEqual(same.items.map(r=>r.id),[e.outside]);assert.deepEqual(same.folderScope.path,['剧情','常用']);
 const session=e.sessions.sessions.get(result.sessionId);assert.equal(Array.isArray(session.scope),false);assert.equal('materialIds' in session,false);assert.ok(session.seed);assert.ok(session.response.items.length<=20);
});
for(const mutation of ['move-out','move-in','folder-move','folder-delete','unrelated-tree-edit'])test(`Folder ${mutation} invalidates continuation AND cached replay without affecting legacy Column scope`,async t=>{
 const e=await fixture(t),scope={columnId:e.column,folderId:e.a},start=e.read('roll',scope,{limit:1});const legacy=e.read('roll',{columnId:e.column},{limit:1});
 if(mutation==='move-out')e.move(e.ids[0],e.same);
 if(mutation==='move-in')e.move(e.outside,e.a);
 if(mutation==='folder-move')e.send('folder-move',{id:e.b,parentId:e.x,revision:e.store.one('SELECT revision FROM folders WHERE id=?',e.b).revision,structureRevision:e.store.column(e.column).structure_revision});
 if(mutation==='folder-delete')e.send('folder-delete',{id:e.a,revision:1,structureRevision:e.store.column(e.column).structure_revision,deleteContents:true});
 if(mutation==='unrelated-tree-edit')e.folder('不相关分组');
 for(const cursor of [start.nextCursor,0])assert.throws(()=>e.read('roll',scope,{sessionId:start.sessionId,cursor}),{code:'WORLDBOOK_TREE_CHANGED'});
 const after=e.read('roll',{columnId:e.column},{sessionId:legacy.sessionId,cursor:legacy.nextCursor});assert.equal(after.sessionId,legacy.sessionId);
 assert.equal(e.sessions.sessions.get(start.sessionId).folderScope.treeRevision,start.folderScope.treeRevision);
});
test('Invalid/deleted/cross-column Folder fails closed; only Candidate paths accept folderId and mixed hidden filters are rejected',async t=>{
 const e=await fixture(t),wrong=e.folder('另一栏分组',null,e.other);
 for(const kind of ['roll','discovery']){
  assert.throws(()=>e.read(kind,{columnId:e.column,folderId:'folder-missing'}),{code:'WORLDBOOK_NOT_FOUND'});
  assert.throws(()=>e.read(kind,{columnId:e.column,folderId:wrong}),{code:'WORLDBOOK_VALIDATION'});
  for(const scope of [{folderId:e.a},{columnId:e.column,folderId:''},{columnId:e.column,folderId:e.a,q:'隐藏搜索'},{columnId:e.column,folderId:e.a,tags:[]}])assert.throws(()=>e.read(kind,scope),{code:'WORLDBOOK_VALIDATION'});
 }
 assert.equal(e.sessions.sessions.size,0);
 const scope={columnId:e.column,folderId:e.a};assert.throws(()=>query(scope),{code:'WORLDBOOK_VALIDATION'});
 for(const kind of ['facets','picker','companions','bindings','presets','tree-search'])assert.throws(()=>e.store.features.read({kind,scope,...(kind==='facets'?{id:'tags'}:{}),...(['picker','companions'].includes(kind)?{subjectId:e.ids[0]}:{})}),{code:'WORLDBOOK_VALIDATION'});
});
test('Large 537-descendant Folder at depth 16 keeps complete Candidate continuation, bounded DTOs, Runtime/dedup and Companion boundaries',async t=>{
 const e=await fixture(t);let parent=e.c;for(let depth=4;depth<=16;depth++)parent=e.folder(`深度 ${depth}`,parent);
 const all=new Set(e.ids);for(let i=0;i<533;i++)all.add(e.material(`大分组 ${i}`,100+i,i===532?parent:e.b));
 // The duplicate source inside the folder deduplicates there; an outside copy
 // cannot replace its representative. Companion relationships remain unscoped.
 e.material('内部重复',1,e.b);e.material('外部重复',2,e.same);e.send('companions-save',{id:e.ids[0],revision:1,memberIds:[e.outside]});
 let input={kind:'discovery',scope:{columnId:e.column,folderId:e.a},limit:20},last;const seen=new Set();
 do{last=e.sessions.read(e.context,e.store,input,e.runtime());assert.equal(last.scopeTotal,537);assert.ok(last.items.length<=20);assert.ok(Buffer.byteLength(JSON.stringify(last))<131072);for(const row of last.items){assert.ok(!seen.has(row.source.uid));seen.add(row.source.uid);assert.ok(all.has(row.id)||row.source.uid===1);assert.notEqual(row.id,e.outside);assert.equal('description' in row,false);}input={...input,sessionId:last.sessionId,cursor:last.nextCursor};}while(last.nextCursor!==null);
 assert.equal(seen.size,537);assert.ok(seen.has(632));
 assert.equal(e.store.features.read({kind:'companions',subjectId:e.ids[0]}).items[0].id,e.outside);
 assert.equal(e.store.one('PRAGMA user_version').user_version,4);
});
test('Empty/disabled candidate semantics and session end retain existing behavior under Folder scope',async t=>{
 const e=await fixture(t),empty=e.folder('空分组');assert.equal(e.read('roll',{columnId:e.column,folderId:empty}).items.length,0);
 const runtime=e.runtime();runtime.bindings.forEach(r=>r.enabled=true);const input={kind:'discovery',scope:{columnId:e.column,folderId:e.a}};const result=e.sessions.read(e.context,e.store,input,runtime);assert.equal(result.items.length,0);assert.equal(result.nextCursor,null);
 assert.deepEqual(e.sessions.read(e.context,e.store,{kind:'session-end',sessionId:result.sessionId},null),{ended:true});assert.equal(e.sessions.sessions.has(result.sessionId),false);
 runtime.unknownBooks=['资源书'];assert.throws(()=>e.sessions.read(e.context,e.store,input,runtime),{code:'WORLDBOOK_RUNTIME_UNAVAILABLE'});
});
