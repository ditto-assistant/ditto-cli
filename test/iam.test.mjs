import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath,pathToFileURL} from "node:url";
const cli=fileURLToPath(new URL("../dist/cli.js",import.meta.url));
const org={id:"aaaaaaaa-0000-0000-0000-000000000001",slug:"team",name:"Team",role:"owner"};
async function stub({denied=false,conflict=false}={}){
 const calls=[];
 const server=http.createServer((req,res)=>{
  let text="";req.on("data",x=>text+=x);req.on("end",()=>{
   const body=text?JSON.parse(text):undefined;calls.push({method:req.method,url:req.url,body});res.setHeader("Content-Type","application/json");
   const reply=(status,result)=>{res.statusCode=status;res.end(JSON.stringify(result));};
   if(req.headers.authorization!=="Bearer ditto_mcp_iam_test")return reply(401,{message:"unauthorized"});
   if(req.method==="GET"&&req.url==="/api/v5/companies")return reply(200,{companies:[org]});
   const prefix=`/api/v5/companies/${org.id}/iam/`;if(!req.url.startsWith(prefix))return reply(401,{message:"route not granted for CLI key"});
   const op=req.url.slice(prefix.length);
   const reads=["catalog","roles.list","bindings.list","audit.list","mode.get"];
   const writes=["roles.put","roles.delete","bindings.put","bindings.delete","explain","mode.get","mode.set"];
   if(!(req.method==="GET"?reads:writes).includes(op))return reply(401,{message:"route not granted for CLI key"});
   if(denied)return reply(403,{message:"your current permissions do not allow this IAM action"});
   if(conflict)return reply(409,{message:"IAM state changed"});
   return reply(200,{operation:op,payload:body??null,revision:2});
  });
 });
 await new Promise(r=>server.listen(0,"127.0.0.1",r));
 return {base:`http://127.0.0.1:${server.address().port}`,calls,close(){server.closeAllConnections();server.close();}};
}
function run(base,args,stdin,extra={}){return new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[cli,"--no-auto-update",...args],{env:{...process.env,DITTO_API_KEY:"ditto_mcp_iam_test",DITTO_API_BASE:base,DITTO_CONFIG_DIR:mkdtempSync(path.join(os.tmpdir(),"ditto-iam-test-")),...extra},stdio:["pipe","pipe","pipe"]});
 let stdout="",stderr="";child.stdout.on("data",x=>stdout+=x);child.stderr.on("data",x=>stderr+=x);child.on("error",reject);child.on("close",status=>resolve({status,stdout,stderr}));child.stdin.end(stdin);
});}
const scope=["--org","team","--output","json"];

test("IAM reads use the exact organization and explicit operations",async()=>{
 const s=await stub();try{
  for(const [args,op,method] of [[["catalog"],"catalog","GET"],[["roles","list"],"roles.list","GET"],[["bindings","list"],"bindings.list","GET"],[["audit"],"audit.list","GET"],[["mode","get"],"mode.get","POST"]]){
   const r=await run(s.base,["iam",...args,...scope]);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).operation,op);assert.equal(s.calls.at(-1).method,method);assert.equal(s.calls.at(-1).url,`/api/v5/companies/${org.id}/iam/${op}`);
  }
 }finally{s.close();}
});

test("role files and stdin bindings preserve exact version and service-account identity",async()=>{
 const s=await stub();try{
  const dir=mkdtempSync(path.join(os.tmpdir(),"iam-policy-"));const role={name:"Router user",expected_revision:0,statements:[{effect:"allow",actions:["inference.endpoints.use"]}]};
  const filename=path.join(dir,"role.json");writeFileSync(filename,JSON.stringify(role));
  let r=await run(s.base,["iam","roles","put","--file",filename,...scope]);assert.equal(r.status,0,r.stderr);assert.deepEqual(s.calls.at(-1).body,role);
  const binding={principal:{type:"service_account",id:"service-uid"},role_id:"role-id",role_revision:2,expected_revision:0,resource:{company_id:org.id,type:"inference_endpoint",id:"endpoint-id"}};
  r=await run(s.base,["iam","bindings","put","--file","-",...scope],JSON.stringify(binding));assert.equal(r.status,0,r.stderr);assert.deepEqual(s.calls.at(-1).body,binding);
 }finally{s.close();}
});

test("dry-run mode change preserves expected revision and never substitutes enforcement",async()=>{
 const s=await stub();try{
  const r=await run(s.base,["iam","mode","set","shadow","--revision","4","--dry-run",...scope]);assert.equal(r.status,0,r.stderr);
  assert.deepEqual(s.calls.at(-1).body,{domain:"inference",mode:"shadow",expected_revision:4,dry_run:true});
  assert.equal(s.calls.filter(c=>c.url.endsWith("mode.set")).length,1);
 }finally{s.close();}
});

test("explain forwards optional self principal and session constraints without granting locally",async()=>{
 const s=await stub();try{
  const check={permission:"inference.endpoints.use",resource:{company_id:org.id,type:"inference_endpoint",id:"ep"},session_permissions:[],session_constrained:true};
  const r=await run(s.base,["iam","explain","--file","-",...scope],JSON.stringify(check));assert.equal(r.status,0,r.stderr);assert.deepEqual(s.calls.at(-1).body,check);
 }finally{s.close();}
});

test("invalid revision, malformed/nonobject/oversized policy fail before IAM request",async()=>{
 const s=await stub();try{
  for(const revision of ["-1","Infinity","1.5","9007199254740992"]){const r=await run(s.base,["iam","bindings","delete","binding","--revision",revision,...scope]);assert.equal(r.status,1);}
  for(const raw of ["null","[]","{} {}",`{"name":"${"x".repeat(65536)}"}`]){const r=await run(s.base,["iam","roles","put","--file","-",...scope],raw);assert.equal(r.status,1);}
  assert.equal(s.calls.filter(c=>c.url.includes("/iam/")).length,0);
 }finally{s.close();}
});

test("IAM server refusal and revision conflict fail without retries or identity changes",async()=>{
 for(const option of [{denied:true},{conflict:true}]){
  const s=await stub(option);try{
   const r=await run(s.base,["iam","roles","delete","role-id","--revision","2",...scope]);assert.equal(r.status,1);assert.equal(r.stdout,"");assert.match(r.stderr,option.denied?/403/:/409/);assert.equal(s.calls.filter(c=>c.url.endsWith("roles.delete")).length,1);
  }finally{s.close();}
 }
});

test("server rights bound default session expiry without changing explicit or legacy lifetime",async()=>{
 const {iamLaunchExpiry}=await import("../dist/agents/iam.js");
 assert.equal(iamLaunchExpiry({id:"ep"},"1mo",false),"1mo");
 const endpoint={id:"ep",access:{iamEnforced:true,createSession:true,createKey:false,maxSessionSeconds:43200}};
 assert.equal(iamLaunchExpiry(endpoint,"1mo",false),"12h");
 assert.equal(iamLaunchExpiry(endpoint,"1mo",true),"1mo");
 assert.equal(iamLaunchExpiry({...endpoint,access:{...endpoint.access,createKey:true}},"1mo",false),"1mo");
 assert.equal(iamLaunchExpiry({...endpoint,access:{...endpoint.access,maxSessionSeconds:14400}},"1mo",false),"4h");
 assert.throws(()=>iamLaunchExpiry({...endpoint,access:{...endpoint.access,maxSessionSeconds:0}},"1mo",false),/valid temporary/);
});


test("an explicit org UUID skips human directory resolution and leaves service identity to server",async()=>{
 const s=await stub();try{
  const r=await run(s.base,["iam","mode","get","--org",org.id,"--output","json"]);assert.equal(r.status,0,r.stderr);assert.equal(s.calls.length,1);assert.equal(s.calls[0].url,`/api/v5/companies/${org.id}/iam/mode.get`);
 }finally{s.close();}
});

test("service credential files report their distinct source",async()=>{
 const {resolveApiKey}=await import("../dist/config.js");
 const dir=mkdtempSync(path.join(os.tmpdir(),"iam-source-"));const filename=path.join(dir,"secret");
 writeFileSync(filename,`ditto_svc_${"A".repeat(43)}\n`);
 const oldKey=process.env.DITTO_API_KEY,oldFile=process.env.DITTO_SERVICE_CREDENTIAL_FILE;
 try{
  delete process.env.DITTO_API_KEY;process.env.DITTO_SERVICE_CREDENTIAL_FILE=filename;
  const resolved=await resolveApiKey();assert.equal(resolved.source,"service-file");
 }finally{
  if(oldKey===undefined)delete process.env.DITTO_API_KEY;else process.env.DITTO_API_KEY=oldKey;
  if(oldFile===undefined)delete process.env.DITTO_SERVICE_CREDENTIAL_FILE;else process.env.DITTO_SERVICE_CREDENTIAL_FILE=oldFile;
 }
});

test("credential issuance suppresses untrusted diagnostics, redirects and extra success fields",async()=>{
 const secret=`ditto_svc_${"A".repeat(43)}`;
 const id="bbbbbbbb-0000-0000-0000-000000000002";
 let mode="error",redirectHits=0;
 const server=http.createServer((req,res)=>{
  req.resume();req.on("end",()=>{
   if(req.url==="/redirect-target"){redirectHits++;res.end("{}");return;}
   res.setHeader("Content-Type","application/json");
   if(mode==="error"){res.statusCode=500;res.end(JSON.stringify({message:secret}));}
   else if(mode==="redirect"){res.statusCode=307;res.setHeader("Location","/redirect-target");res.end(secret);}
   else if(mode==="malformed")res.end(`{"secret":"${secret}`);
   else if(mode==="invalid-secret")res.end(JSON.stringify({id,secret:"bad"}));
   else if(mode==="unsafe-id")res.end(JSON.stringify({id:secret,secret}));
   else res.end(JSON.stringify({id,secret,unexpected:secret}));
  });
 });
 await new Promise(r=>server.listen(0,"127.0.0.1",r));
 const base=`http://127.0.0.1:${server.address().port}`;
 try{
  for(mode of ["error","redirect","malformed","unsafe-id","invalid-secret","write-failure","close-failure","success"]){
   const dir=mkdtempSync(path.join(os.tmpdir(),"iam-credential-"));const filename=path.join(dir,"secret");
   const preload=path.join(dir,"preload.mjs");
   writeFileSync(preload,`import fs from "node:fs/promises"; import {syncBuiltinESMExports} from "node:module"; const open=fs.open; fs.open=async (...args)=>{const f=await open(...args); if(args[0]===process.env.IAM_TEST_TARGET){if(process.env.IAM_TEST_MODE==="write-failure")f.writeFile=async()=>{const e=new Error(process.env.IAM_TEST_SECRET);e.code="ENOSPC";throw e}; if(process.env.IAM_TEST_MODE==="close-failure"){const close=f.close.bind(f);f.close=async()=>{await close();const e=new Error(process.env.IAM_TEST_SECRET);e.code="EIO";throw e}}} return f}; syncBuiltinESMExports();`);
   const extra=mode.endsWith("-failure")?{NODE_OPTIONS:`--import=${pathToFileURL(preload).href}`,IAM_TEST_TARGET:filename,IAM_TEST_MODE:mode,IAM_TEST_SECRET:secret}:{};
   const r=await run(base,["iam","service-credentials","issue","--org",org.id,"--file","-","--secret-file",filename],"{}",extra);
   assert.equal(r.status,mode==="success"?0:1,r.stderr);
   assert.ok(!r.stdout.includes(secret)&&!r.stderr.includes(secret),mode);
   assert.equal(existsSync(filename),true,mode);
   if(mode==="invalid-secret")assert.match(r.stderr,new RegExp(id));
   if(mode.endsWith("-failure")){assert.match(r.stderr,new RegExp(id));assert.match(r.stderr,mode==="write-failure"?/ENOSPC/:/EIO/);}
   if(mode==="success"){assert.deepEqual(JSON.parse(r.stdout),{id});assert.equal(readFileSync(filename,"utf8"),`${secret}\n`);}
  }
  assert.equal(redirectHits,0);
 }finally{server.closeAllConnections();server.close();}
});
