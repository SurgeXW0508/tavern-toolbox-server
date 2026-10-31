import { mutationGate } from '../security.js';
import { AiConnectionFailure } from './store.js';
export function attachAiConnectionRoutes(router,{aiConnections,registry,config,send,failure}) {
    const fail=code=>{throw new AiConnectionFailure(code);};
    const route=operation=>async(req,res)=>{
        const {context,requestId}=res.locals.ttbRequest;
        try {
            if(req.get('X-TTB-Protocol')!=='1.0')fail('PROTOCOL_INCOMPATIBLE');
            if(req.get('X-TTB-Context')!==context.contextId)fail('CONTEXT_CHANGED');
            const capability=(await registry.snapshot(context)).capabilities.find(c=>c.id==='ai.connections');
            if(capability?.state!=='ready'||!capability.operations.find(o=>o.id===operation)?.available)fail('AI_STORE_UNAVAILABLE');
            let body=req.body;
            if(operation!=='read') {
                if(!mutationGate(req,config.policy.core.allowedOrigins))fail('CSRF_REJECTED');
                if(!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type']||''))fail('INVALID_REQUEST');
                if(body===undefined){const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>65536)fail('INVALID_REQUEST');chunks.push(chunk);}try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('INVALID_REQUEST');}}
                if(Buffer.byteLength(JSON.stringify(body)||'')>65536)fail('INVALID_REQUEST');
            }
            const result=await aiConnections[operation](context,body);
            return send(res,200,result,requestId,true,3*1024*1024);
        }catch(error){const code=error instanceof AiConnectionFailure?error.code:'AI_STORE_UNAVAILABLE';
            return send(res,code==='CSRF_REJECTED'?403:['REVISION_CONFLICT','CONTEXT_CHANGED','PROTOCOL_INCOMPATIBLE'].includes(code)?409:code==='CONNECTION_NOT_FOUND'?404:code==='INVALID_REQUEST'?400:503,failure(code,'AI 账户连接操作失败；未自动重试'),requestId,true,4096);
        }
    };
    router.get('/v1/ai/connections',route('read'));
    router.post('/v1/ai/connections/commands',route('command'));
    router.post('/v1/ai/connections/credential',route('credential'));
}
