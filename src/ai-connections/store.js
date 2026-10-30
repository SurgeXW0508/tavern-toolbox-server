import path from 'node:path';
import { mkdir, chmod, lstat } from 'node:fs/promises';
export class AiConnectionFailure extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new AiConnectionFailure(code); };
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
const idValid = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(v) && v !== 'tavern-current';
const string = (v, max) => typeof v === 'string' && v.length <= max;
export function validateProfile(p) {
    const allowed = ['id','name','apiUrl','model','models','source','proxyPreset','streamMode','imageInput','parameters'];
    if (!plain(p) || Object.keys(p).some(k => !allowed.includes(k)) || !idValid(p.id)
        || !string(p.name,80) || !p.name.trim() || !string(p.apiUrl,2048) || !string(p.model,256)
        || !['openai','claude','makersuite','deepseek','xai'].includes(p.source)
        || !string(p.proxyPreset,128) || !['auto','stream','nonstream'].includes(p.streamMode)) fail('INVALID_REQUEST');
    if (!p.apiUrl && !p.proxyPreset) fail('INVALID_REQUEST');
    if (p.apiUrl) { let u; try { u = new URL(p.apiUrl); } catch { fail('INVALID_REQUEST'); }
        if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.hash) fail('INVALID_REQUEST'); }
    if (!Array.isArray(p.models) || p.models.length > 256 || p.models.some(v => !string(v,256))) fail('INVALID_REQUEST');
    if (!plain(p.imageInput) || Object.keys(p.imageInput).some(k => !['enabled','maxImagesPerRequest'].includes(k))
        || typeof p.imageInput.enabled !== 'boolean' || !Number.isInteger(p.imageInput.maxImagesPerRequest)
        || p.imageInput.maxImagesPerRequest < 1 || p.imageInput.maxImagesPerRequest > 8) fail('INVALID_REQUEST');
    if (!plain(p.parameters) || Object.entries(p.parameters).some(([k,v]) => !['max_tokens','temperature','top_p','top_k','frequency_penalty','presence_penalty'].includes(k)
        || (!['unset','same_as_preset'].includes(v) && (typeof v !== 'number' || !Number.isFinite(v))))) fail('INVALID_REQUEST');
    for (const [key,value] of Object.entries(p.parameters)) {
        if (typeof value !== 'number') continue;
        if (key === 'max_tokens' && (!Number.isSafeInteger(value) || value <= 0)
            || key === 'top_k' && (!Number.isSafeInteger(value) || value < 0)
            || key === 'top_p' && (value < 0 || value > 1)
            || key === 'temperature' && value < 0) fail('INVALID_REQUEST');
    }
    if (Buffer.byteLength(JSON.stringify(p)) > 32768) fail('INVALID_REQUEST');
    return p;
}
export function createAiConnections(config) {
    let DatabaseSync, stopped = false;
    async function use(context, operation) {
        if (stopped || !DatabaseSync || !context?.userRoot) fail('AI_STORE_UNAVAILABLE');
        const root = path.join(context.userRoot, 'tavern-toolbox-server', 'ai-connections-v1');
        await mkdir(root, { recursive:true, mode:0o700 });
        if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) fail('AI_STORE_UNAVAILABLE');
        await chmod(root,0o700);
        const file = path.join(root,'connections.sqlite');
        try { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) fail('AI_STORE_UNAVAILABLE'); }
        catch(e) { if(e.code !== 'ENOENT') throw e; }
        if(stopped) fail('AI_STORE_UNAVAILABLE');
        const db = new DatabaseSync(file);
        try {
            await chmod(file,0o600);
            if(stopped) fail('AI_STORE_UNAVAILABLE');
            db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
            const version=db.prepare('PRAGMA user_version').get().user_version;
            if(version !== 0 && version !== 1) fail('AI_SCHEMA_INCOMPATIBLE');
            if(!version) {
                if(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n) fail('AI_SCHEMA_INCOMPATIBLE');
                db.exec("CREATE TABLE profiles(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, metadata TEXT NOT NULL, secret TEXT NOT NULL); CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, default_id TEXT NOT NULL); INSERT INTO state VALUES(1,0,''); PRAGMA user_version=1;");
            }
            const result=operation(db); db.exec('COMMIT'); return result;
        } catch(e) { try {db.exec('ROLLBACK');}catch{} throw e; } finally {db.close();}
    }
    const snapshot=db=>{
        const state=db.prepare('SELECT revision,default_id FROM state WHERE id=1').get();
        const rows=db.prepare('SELECT id,revision,metadata,length(secret)>0 AS has_secret FROM profiles ORDER BY id LIMIT 65').all();
        if(!state || !Number.isSafeInteger(state.revision) || state.revision<0 || rows.length>64) fail('AI_DATA_INVALID');
        const profiles=rows.map(r=>{const p=validateProfile(JSON.parse(r.metadata));if(p.id!==r.id || !Number.isSafeInteger(r.revision) || r.revision<1 || r.revision>state.revision)fail('AI_DATA_INVALID');return {...p,revision:r.revision,hasKey:!!r.has_secret};});
        if(state.default_id && !profiles.some(p=>p.id===state.default_id))fail('AI_DATA_INVALID');
        const result = {schemaVersion:1,revision:state.revision,defaultProfileId:state.default_id,profiles};
        if (Buffer.byteLength(JSON.stringify(result)) > 240 * 1024) fail('AI_PROFILE_LIMIT');
        return result;
    };
    return {
        definition:{ id:'ai-connections',version:'0.1.0',dependsOn:['core'],capabilities:[{id:'ai.connections',contract:{major:1,minMinor:0,maxMinor:0},operations:['read','command','credential'].map(id=>({id,available:true})),
            operationAvailability:()=>Object.fromEntries(['command','credential'].map(id=>[id,{available:config.policy.core.allowedOrigins.length>0,reasonCode:'ORIGIN_POLICY_MISSING'}])),
            limits:{maxProfiles:64,maxModels:256},constraints:{scope:'st-user',credentials:'protected-explicit-read',updates:'revision-cas'}}],
            initialize:async()=>{({DatabaseSync}=await import('node:sqlite'));},
            health:()=>({state:stopped?'unavailable':'ready',reasonCode:stopped?'AI_STORE_UNAVAILABLE':null}),shutdown:()=>{stopped=true;}},
        read:context=>use(context,snapshot),
        command(context, body) {
            if(!plain(body) || Object.keys(body).some(k=>!['operation','expectedRevision','profile','id','key'].includes(k)) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision<0) fail('INVALID_REQUEST');
            return use(context,db=>{
                const current=snapshot(db);
                if(current.revision!==body.expectedRevision)fail('REVISION_CONFLICT');
                if(current.revision>=Number.MAX_SAFE_INTEGER)fail('AI_DATA_INVALID');
                const revision=current.revision+1;
                if(body.operation==='save') {
                    const p=validateProfile(body.profile), old=db.prepare('SELECT secret,metadata FROM profiles WHERE id=?').get(p.id);
                    if(!old && current.profiles.length>=64)fail('AI_PROFILE_LIMIT');
                    if(body.key!==undefined && !string(body.key,8192))fail('INVALID_REQUEST');
                    if (old && body.key === undefined) {
                        const before = JSON.parse(old.metadata);
                        if (['apiUrl','source','proxyPreset'].some(k => before[k] !== p[k])) fail('CREDENTIAL_REQUIRED');
                    }
                    if(!old && body.key===undefined)fail('CREDENTIAL_REQUIRED');
                    db.prepare('INSERT INTO profiles VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,metadata=excluded.metadata,secret=excluded.secret').run(p.id,revision,JSON.stringify(p),body.key===undefined?old.secret:body.key);
                } else if(body.operation==='delete') {
                    if(!idValid(body.id) || !current.profiles.some(p=>p.id===body.id))fail('CONNECTION_NOT_FOUND');
                    db.prepare('DELETE FROM profiles WHERE id=?').run(body.id);
                    db.prepare("UPDATE state SET default_id='' WHERE default_id=?").run(body.id);
                } else if(body.operation==='default') {
                    if(body.id!=='' && !current.profiles.some(p=>p.id===body.id))fail('CONNECTION_NOT_FOUND');
                    db.prepare('UPDATE state SET default_id=? WHERE id=1').run(body.id);
                } else fail('INVALID_REQUEST');
                db.prepare('UPDATE state SET revision=? WHERE id=1').run(revision);return snapshot(db);
            });
        },
        credential(context,body) {
            if(!plain(body)||Object.keys(body).some(k=>!['id','revision'].includes(k))||!idValid(body.id)||!Number.isSafeInteger(body.revision))fail('INVALID_REQUEST');
            return use(context,db=>{const row=db.prepare('SELECT revision,secret,metadata FROM profiles WHERE id=?').get(body.id);
                if(!row)fail('CONNECTION_NOT_FOUND');if(row.revision!==body.revision)fail('REVISION_CONFLICT');
                return {id:body.id,revision:row.revision,key:row.secret,profile:validateProfile(JSON.parse(row.metadata))};});
        },
    };
}
