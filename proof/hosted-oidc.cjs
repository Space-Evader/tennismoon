/* Isolated GitHub-hosted HTTP proof. Executes checksum-pinned b6923 route/auth source.
 * Real GitHub OIDC/JWKS; synthetic, memory-only D1 adapter. No Sites deployment or production data.
 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),http=require('node:http'),Module=require('node:module'),{AsyncLocalStorage}=require('node:async_hooks');
const ts=require('typescript');
const root=path.resolve(process.env.PROOF_SOURCE_DIR||'proof/b6923');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'source-manifest.json'),'utf8'));
assert.equal(manifest.application_commit,'b6923cd16315197c0c4e4982f8a495140e1931fd');
const {createHash}=require('node:crypto');
for(const [file,hash]of Object.entries(manifest.tested_files))assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex'),hash,file+' must match the release snapshot');
process.chdir(root);
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,f);
const {LocalD1}=require(path.join(root,'tests/local-d1.cjs'));
const databaseFile=path.join(require('node:os').tmpdir(),'tennismoon-isolated-'+process.pid+'.sqlite');
const db=new LocalD1(databaseFile),context=new AsyncLocalStorage();
const audience='urn:tennismoon:isolated-final-gates:b6923cd';
const env={DB:db,TENNISMOON_OWNER_EMAIL:'synthetic-owner@example.invalid',RADAR_INTAKE_ENABLED:'true',RADAR_INTAKE_REPOSITORY_ID:'1341281090',RADAR_INTAKE_OWNER_ID:'178354125',RADAR_INTAKE_WORKFLOW_REF:process.env.GITHUB_WORKFLOW_REF,RADAR_INTAKE_AUDIENCE:audience};
const original=Module._load;
Module._load=function(id,parent,main){
 if(id==='cloudflare:workers')return{env};
 if(id==='next/server')return{NextResponse:{json:Response.json}};
 if(id==='next/headers')return{headers:async()=>context.getStore()};
 if(id==='next/navigation')return{redirect:()=>{throw new Error('No browser sign-in in isolated proof')}};
 return original.call(this,id,parent,main);
};
const intake=require(path.join(root,'app/api/radar/intake/route.ts')),owner=require(path.join(root,'app/api/radar/review/route.ts'));
const packet=JSON.parse(fs.readFileSync(path.join(root,'real-runner-packet.json'),'utf8'));
const cases=[];
const server=http.createServer(async(req,res)=>{
 try{let chunks=[],size=0;for await(const c of req){size+=c.length;if(size>20000)throw new Error('Bound');chunks.push(c);}
 const headers=new Headers(req.headers);
 // This VM has no Sites identity proxy. Do not accept caller-supplied proxy identity headers.
 for(const name of [...headers.keys()])if(name.startsWith('oai-authenticated-'))headers.delete(name);
 const request=new Request('http://127.0.0.1'+req.url,{method:'POST',headers,body:Buffer.concat(chunks)});
 const route=req.url==='/api/radar/intake'?intake:req.url==='/api/radar/review'?owner:null;
 if(!route){res.writeHead(404);return res.end();}
 const response=await context.run(headers,()=>route.POST(request));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end('Isolated HTTP proof failed');}
});
async function getToken(aud){
 assert.ok(process.env.ACTIONS_ID_TOKEN_REQUEST_URL&&process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,'Run in the authorized OIDC job');
 const url=new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);url.searchParams.set('audience',aud);
 const r=await fetch(url,{headers:{Authorization:'Bearer '+process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN},signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);
 const value=(await r.json()).value;assert.equal(typeof value,'string');return value;
}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const token=await getToken(audience); // Memory only: never log/export the token or private request bearer.
 async function post(route,body,t=token){const r=await fetch(base+route,{method:'POST',headers:{Authorization:'Bearer '+t,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const data=await r.json();return{status:r.status,data};}
 let r=await post('/api/radar/intake',packet);assert.equal(r.status,201,JSON.stringify(r.data));assert.equal(r.data.published,false);const id=r.data.id;
 r=await post('/api/radar/intake',packet);assert.equal(r.status,200);assert.equal(r.data.id,id);assert.equal(r.data.replayed,true);cases.push('real GitHub OIDC -> hosted isolated intake HTTP 201; exact replay HTTP 200');
 for(const action of ['approve','publish','draft','import-packet','revert'])assert.equal((await post('/api/radar/review',{action,id:1,confirmEvidence:true})).status,403);
 cases.push('same real staging token denied all five owner approval/publication actions (403)');
 assert.equal((await post('/api/radar/intake',packet,'invalid')).status,401);
 const wrong=await getToken('urn:tennismoon:wrong-audience');assert.equal((await post('/api/radar/intake',packet,wrong)).status,401);
 const savedRepo=env.RADAR_INTAKE_REPOSITORY_ID;env.RADAR_INTAKE_REPOSITORY_ID='untrusted';assert.equal((await post('/api/radar/intake',packet)).status,401);env.RADAR_INTAKE_REPOSITORY_ID=savedRepo;
 cases.push('real issuer tokens with wrong audience/repository, and invalid signatures, denied');
 for(const bad of [{...packet,action:'publish'},{...packet,owner_approved:true},{...packet,context:{...packet.context,reviewedAt:Date.now()}}])assert.equal((await post('/api/radar/intake',bad)).status,400);
 const {runId}=await require(path.join(root,'app/radar/intake.ts')).verifyReader(token,{enabled:'true',repositoryId:env.RADAR_INTAKE_REPOSITORY_ID,ownerId:env.RADAR_INTAKE_OWNER_ID,workflowRef:env.RADAR_INTAKE_WORKFLOW_REF,audience});
 const limited=new LocalD1();for(let n=0;n<8;n++)limited.sql.prepare('INSERT INTO radar_intake_packets(id,payload,created_at,reader_run_id) VALUES(?,?,?,?)').run('synthetic-bound-'+n,'{"synthetic_test_seed":true}',Date.now(),runId);
 env.DB=limited;assert.equal((await post('/api/radar/intake',packet)).status,429);env.DB=db;limited.close();
 cases.push('eight-candidate run bound enforced (429); approval/time smuggling denied (400)');
 assert.equal(db.count('radar_intake_packets'),1);const saved=JSON.parse(db.sql.prepare('SELECT payload FROM radar_intake_packets WHERE id=?').get(id).payload);assert.equal(saved.context.reviewedAt,null);assert.equal(saved.owner_approved,false);
 assert.equal(db.count('radar_entries'),0);assert.equal(db.count('radar_update_proposals'),0);assert.equal(db.count('radar_publication_history'),0);
 const result={application_commit:manifest.application_commit,application_tree:manifest.application_tree,execution:'GitHub-hosted isolated VM; actual HTTP route; native Sites dispatch is not under test',oidc:'real GitHub issuer/JWKS',event:process.env.GITHUB_EVENT_NAME,workflow_ref:process.env.GITHUB_WORKFLOW_REF,cases,production_calls:0,publications:0,owner_approvals:0,scheduled_jobs:0,private_tokens_exported:false};
 const acknowledged_at=new Date().toISOString();
 if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,'staging_receipt='+JSON.stringify({id,acknowledged_at,published:false,owner_approved:false})+'\n');
 result.staging_persisted_to_isolated_sqlite=true;console.log(JSON.stringify(result));
})().catch(e=>{console.error('Hosted proof failed: '+e.message);process.exitCode=1;}).finally(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));db.close();const reopened=new LocalD1(databaseFile,false);assert.equal(reopened.count('radar_intake_packets'),1);reopened.close();fs.rmSync(databaseFile,{force:true});console.log(JSON.stringify({isolated_database_reopen:'pass',production_database_access:false}));});
