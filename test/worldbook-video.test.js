import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,rename} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {validatePolicy} from '../src/config.js';
import {createWorldbook} from '../src/worldbook/index.js';
import {WorldbookStore} from '../src/worldbook/store.js';
import {createVideo} from '../src/video/index.js';
import {createReferenceCoordinator} from '../src/governance/coordination.js';
const token=()=>`${Date.now()}-${randomUUID()}`;
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'wb-video-')),source=path.join(root,'clips');await mkdir(source);
 const policy=validatePolicy({schemaVersion:1,core:{allowedOrigins:['https://example.invalid']},video:{roots:[{key:'clips',label:'Clips',path:source,users:['alice']}]}}),coordinate=createReferenceCoordinator(),context={userRoot:root,userHandle:'alice',contextId:'a'.repeat(32)};
 const video=createVideo({policy},{coordinate}),worldbook=createWorldbook({policy},{coordinate,video});await video.definition.initialize();await worldbook.definition.initialize();video.registerReferenceProvider(worldbook.videoReferenceProvider);
 t.after(async()=>{await video.close();await worldbook.definition.shutdown();await rm(root,{recursive:true,force:true});});
 const core=(action,data)=>worldbook.command(context,{commandId:token(),action,data});await core('column-create',{profile:{title:'资料',description:'',icon:{type:'builtin',value:'book'},accent:'#112233'},materials:[1,2].map(uid=>({name:'资料'+uid,description:'body',source:{locator:'book',uid,title:'Entry'+uid}}))});
 const store=await worldbook.store(context),rows=store.catalog({page:1,tags:[]}).items,assets=[];
 const bytes=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(4),Buffer.from('isommp42'),Buffer.alloc(64)]);
 for(let i=0;i<2;i++)await writeFile(path.join(source,`${i}.mp4`),bytes);
 const page=await video.browse(context,{rootKey:'clips'});for(const candidate of page.entries)assets.push(await video.register(context,{candidateId:candidate.id,operationId:randomUUID(),title:candidate.name}));
 const command=(action,data,commandId=token())=>worldbook.videoCommand(context,{commandId,action,data});
 return {root,source,context,video,worldbook,store,rows,assets,command,core,coordinate};
}
test('Video CAS is independent, exact receipts recover uncertain writes and old image/metadata commands retain attachments',async t=>{
 const h=await fixture(t),id=h.rows[0].id,item={kind:'video',mediaRef:h.assets[0].mediaRef},commandId=token(),data={id,revision:1,items:[item]};
 const saved=await h.command('video-add',data,commandId);assert.equal(saved.video.revision,2);assert.deepEqual((await h.worldbook.videoOperation(h.context,{commandId})).result.video,saved.video);
 assert.equal((await h.command('video-add',data,commandId)).replayed,true);await assert.rejects(h.command('video-add',{...data,items:[]},commandId),{code:'WORLDBOOK_IDEMPOTENCY_MISMATCH'});
 await assert.rejects(h.command('video-remove',{id,revision:1,assetId:item.mediaRef.assetId}),{code:'WORLDBOOK_VIDEO_CONFLICT'});
 await h.core('material-update',{id,revision:h.rows[0].revision,fields:{description:'old client edit'}});
 await h.worldbook.mediaCommand(h.context,{commandId:token(),action:'media-clear-cover',data:{id,revision:1}});
 assert.deepEqual(h.store.video.read(id),saved.video);assert.equal(h.store.detail(id).material.description,'old client edit');
 await assert.rejects(h.core('video-remove',{id,revision:2,assetId:item.mediaRef.assetId}),{code:'WORLDBOOK_VALIDATION'});
 const add=await h.command('video-add',{id,revision:2,items:[{kind:'video',mediaRef:h.assets[1].mediaRef}]});
 const reordered=await h.command('video-reorder',{id,revision:add.video.revision,assetIds:add.video.attachments.map(row=>row.mediaRef.assetId).reverse()});assert.equal(reordered.video.attachments[0].mediaRef.assetId,h.assets[1].mediaRef.assetId);
 await assert.rejects(h.command('video-replace',{id,revision:reordered.video.revision,assetId:h.assets[1].mediaRef.assetId,mediaRef:h.assets[0].mediaRef}),{code:'WORLDBOOK_DUPLICATE'});
});
test('Shared Video unregister uses fresh Worldbook references; offline references unlink, material copy starts empty and delete retains registrations',async t=>{
 const h=await fixture(t),[a,b]=h.rows,assetId=h.assets[0].mediaRef.assetId;
 for(const row of [a,b])await h.command('video-add',{id:row.id,revision:1,items:[{kind:'video',mediaRef:h.assets[0].mediaRef}]});
 assert.equal((await h.video.references(h.context,assetId)).count,2);
 await assert.rejects(h.video.unregister(h.context,assetId,{operationId:randomUUID(),metadataRevision:1,sourceRevision:1}),{code:'VIDEO_REFERENCED'});
 const detail=h.store.detail(a.id);const copied=await h.core('material-copy',{id:a.id,revision:detail.material.revision,structureRevision:detail.column.structureRevision,columnId:a.columnId,parentId:null,targetStructureRevision:detail.column.structureRevision});
 assert.equal(h.store.video.read(copied.id).attachments.length,0);
 await rename(h.source,h.source+'-offline');await h.command('video-remove',{id:a.id,revision:2,assetId});assert.equal((await h.video.references(h.context,assetId)).count,1);
 const before=h.store.detail(b.id);await h.core('material-delete',{id:b.id,revision:before.material.revision,structureRevision:before.column.structureRevision});
 assert.equal((await h.video.references(h.context,assetId)).count,0);assert.equal((await h.video.list(h.context)).total,2);
 assert.deepEqual(await h.video.unregister(h.context,assetId,{operationId:randomUUID(),metadataRevision:1,sourceRevision:1}),{removed:true});
});
test('Relation creation serializes with unregister and incomplete provider cannot authorize removal',async t=>{
 const h=await fixture(t),id=h.rows[0].id,asset=h.assets[0],pending=h.command('video-add',{id,revision:1,items:[{kind:'video',mediaRef:asset.mediaRef}]});
 await assert.rejects(h.video.unregister(h.context,asset.mediaRef.assetId,{operationId:randomUUID(),metadataRevision:1,sourceRevision:1}),{code:'VIDEO_REFERENCED'});await pending;
 h.video.registerReferenceProvider({id:'offline',enumerate:async()=>{throw Error('offline');}});
 await assert.rejects(h.video.unregister(h.context,h.assets[1].mediaRef.assetId,{operationId:randomUUID(),metadataRevision:1,sourceRevision:1}),{code:'VIDEO_REFERENCES_INCOMPLETE'});
 await assert.rejects(h.command('video-add',{id,revision:2,items:[{kind:'video',mediaRef:{provider:'server',assetId:randomUUID()}}]}),{code:'WORLDBOOK_VIDEO_UNAVAILABLE'});
});
test('Schema 3 to 4 migration failure rolls back DDL; normal upgrade retains identities, images and metadata',async t=>{
 const h=await fixture(t),id=h.rows[0].id,before=h.store.detail(id),media=h.store.media.read(id);
 h.store.db.exec('DROP TRIGGER wb_video_material_insert;DROP TABLE wb_video_attachments;DROP TABLE wb_video_versions;PRAGMA user_version=3;');h.store.close();
 class Interrupted extends DatabaseSync{exec(sql){if(sql.includes('CREATE TABLE wb_video_versions')){super.exec('BEGIN IMMEDIATE;CREATE TABLE wb_video_versions(n);');throw Error('interrupted video migration');}return super.exec(sql);}}
 await assert.rejects(new WorldbookStore(h.root,Interrupted).initialize(),/interrupted video migration/);
 const db=new DatabaseSync(path.join(h.root,'tavern-toolbox-server/worldbook-v1/worldbook.sqlite'));assert.equal(db.prepare('PRAGMA user_version').get().user_version,3);assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='wb_video_versions'").get(),undefined);db.close();
 await h.store.initialize();assert.deepEqual(h.store.detail(id),before);assert.deepEqual(h.store.media.read(id),media);assert.equal(h.store.video.read(id).revision,1);
});
