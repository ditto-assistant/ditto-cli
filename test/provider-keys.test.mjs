import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync,realpathSync} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const cli=new URL('../dist/cli.js',import.meta.url);
const SECRET='sk-or-v1-never-printed';

// A stand-in Ditto API for /api/v5/inference/provider-keys.
async function startKeysStub({grant=true,limit=false}={}){
 const calls=[];
 const keys=[{id:'11111111-1111-4111-8111-111111111111',provider:'openrouter',configured:true,enabled:true,metadata:{secret:'must-not-leak'}},
  {id:'22222222-2222-4222-8222-222222222222',provider:'gm',label:'work',configured:true,enabled:true}];
 const server=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
  const body=raw?JSON.parse(raw):undefined;calls.push({method:req.method,url:req.url,body,auth:req.headers.authorization});
  const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  const refused=()=>send(403,{message:"This sign-in can't manage provider keys.",code:'provider_keys_not_granted',status:403});
  if(req.url==='/api/v2/mcp/device-code')return send(200,{device_code:'dc',user_code:'ABCD-EFGH',verification_url:'https://app.example/device',expires_in:60,interval:1});
  if(req.url==='/api/v2/mcp/device-token')return send(200,{access_token:'ditto_mcp_new',token_type:'Bearer'});
  if(req.url==='/api/v5/inference/provider-keys/providers')return send(200,{providers:[{id:'gm',displayName:'GM',docsUrl:'https://saygm.com'},{id:'claude',displayName:'Anthropic',docsUrl:'https://console.anthropic.com'}]});
  if(req.url==='/api/v5/inference/provider-keys'&&req.method==='GET')return send(200,{keys});
  if(req.url==='/api/v5/inference/provider-keys'&&req.method==='POST'){
   if(!grant)return refused();
   if(limit&&body.label)return send(402,{message:'plan does not allow more keys for this provider',code:'provider_key_limit',status:402});
   // A careless server echoing the key must not reach stdout.
   return send(200,{key:{id:'33333333-3333-4333-8333-333333333333',provider:body.provider,...(body.label?{label:body.label}:{}),configured:true,enabled:body.enabled!==false,key:body.key},validation:{ok:false,status:401,error:'bad key',checkedAt:'2026-11-11T00:00:00Z'}});
  }
  const m=req.url.match(/^\/api\/v5\/inference\/provider-keys\/([^/]+)(\/validate)?$/);
  if(m&&m[2])return send(200,{validation:{ok:true,checkedAt:'2026-11-11T00:00:00Z'}});
  if(m&&req.method==='PATCH'){if(!grant)return refused();const k=keys.find(x=>x.id===m[1]);return send(200,{key:{...k,enabled:body.enabled}});}
  if(m&&req.method==='DELETE'){if(!grant)return refused();return send(200,{});}
  send(404,{message:'not found'});
 });});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {base:`http://127.0.0.1:${server.address().port}`,calls,close:()=>server.close()};
}

function run(base,args,input){return new Promise((resolve,reject)=>{
 const dir=realpathSync(mkdtempSync(path.join(os.tmpdir(),'heyditto-keys-')));
 const child=spawn(process.execPath,[cli.pathname,...args],{stdio:['pipe','pipe','pipe'],env:{...process.env,DITTO_API_BASE:base,DITTO_API_KEY:'ditto_mcp_fixture',DITTO_CONFIG_DIR:dir}});
 let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);child.on('close',status=>resolve({status,stdout,stderr}));
 child.stdin.end(input??'');
});}

test('keys list and providers print metadata only',async()=>{
 const stub=await startKeysStub();
 try{
  const json=await run(stub.base,['keys','list','--output','json']);assert.equal(json.status,0,json.stderr);
  const listed=JSON.parse(json.stdout);assert.equal(listed.keys.length,2);assert.ok(!json.stdout.includes('must-not-leak'));
  const text=await run(stub.base,['keys','list']);assert.match(text.stdout,/openrouter  on  11111111/);assert.match(text.stdout,/gm "work"  on  22222222/);
  const providers=await run(stub.base,['keys','providers','--output','json']);assert.deepEqual(JSON.parse(providers.stdout).providers.map(p=>p.id),['gm','claude']);
 }finally{stub.close();}
});

test('keys set reads the key from stdin, normalizes the provider and never prints the key',async()=>{
 const stub=await startKeysStub();
 try{
  const out=await run(stub.base,['keys','set','Anthropic'],`  ${SECRET}\n`);
  assert.equal(out.status,0,out.stderr);
  const post=stub.calls.find(c=>c.method==='POST');assert.deepEqual(post.body,{provider:'claude',key:SECRET});
  assert.equal(post.auth,'Bearer ditto_mcp_fixture');
  assert.ok(!(out.stdout+out.stderr).includes(SECRET));
  assert.match(out.stdout,/Saved your claude key to Ditto\./);assert.match(out.stdout,/refused the key \(HTTP 401: bad key\)\. It is saved anyway/);
  const json=await run(stub.base,['keys','set','gm','--disabled','--output','json'],'gm_live_x');
  assert.equal(json.status,0,json.stderr);const saved=JSON.parse(json.stdout);
  assert.equal(saved.key.provider,'gm');assert.equal(saved.key.enabled,false);assert.equal(saved.validation.status,401);
  assert.deepEqual(stub.calls.filter(c=>c.method==='POST').at(-1).body,{provider:'gm',key:'gm_live_x',enabled:false});
  assert.ok(!json.stdout.includes('gm_live_x'),'an echoed key is dropped from the output');
 }finally{stub.close();}
});

test('keys set --label saves a named key, and explains the plan limit',async()=>{
 const stub=await startKeysStub();
 try{
  const out=await run(stub.base,['keys','set','gm','--label',' work '],'gm_live_work');
  assert.equal(out.status,0,out.stderr);
  assert.deepEqual(stub.calls.find(c=>c.method==='POST').body,{provider:'gm',key:'gm_live_work',label:'work'});
  assert.match(out.stdout,/Saved your gm "work" key to Ditto\./);
 }finally{stub.close();}
 const limited=await startKeysStub({limit:true});
 try{
  const out=await run(limited.base,['keys','set','gm','--label','work','--output','json'],'gm_live_work');
  assert.equal(out.status,1);const {error}=JSON.parse(out.stdout);
  assert.equal(error.code,'provider_key_limit');assert.match(error.message,/plan allows no more gm keys/);
 }finally{limited.close();}
});

test('the hidden prompt drops escape sequences and control characters',async()=>{
 const {SecretInput}=await import('../dist/provider-keys.js');
 const input=new SecretInput();
 assert.equal(input.feed('sk-\u001b[Dab\u001bOH\u0015c'),undefined);
 assert.equal(input.feed('d\u007fe\u001b[1;5C'),undefined);
 assert.equal(input.value,'sk-abce');
 assert.equal(input.feed('f\rignored'),'done');assert.equal(input.value,'sk-abcef');
 assert.equal(new SecretInput().feed('x\u0003'),'cancel');
});

test('keys set refuses an empty key and a key given as an argument',async()=>{
 const stub=await startKeysStub();
 try{
  const empty=await run(stub.base,['keys','set','gm','--output','json'],'  \n');
  assert.equal(empty.status,1);assert.equal(JSON.parse(empty.stdout).error.code,'empty_key');
  const extra=await run(stub.base,['keys','set','gm','gm_live_in_argv']);
  assert.notEqual(extra.status,0);
  assert.equal(stub.calls.filter(c=>c.method==='POST').length,0);
 }finally{stub.close();}
});

test('a sign-in without key access gets the backend code as JSON and no retry',async()=>{
 const stub=await startKeysStub({grant:false});
 try{
  const out=await run(stub.base,['keys','set','openrouter','--output','json'],SECRET);
  assert.equal(out.status,1);const {error}=JSON.parse(out.stdout);
  assert.equal(error.code,'provider_keys_not_granted');assert.equal(error.status,403);assert.match(error.message,/can't manage provider keys/);
  assert.equal(stub.calls.filter(c=>c.url.startsWith('/api/v2/mcp/device')).length,0);
  const text=await run(stub.base,['keys','disable','openrouter'],'');
  assert.equal(text.status,1);assert.match(text.stderr,/can't manage provider keys/);
 }finally{stub.close();}
});

test('enable, disable, validate and remove resolve a provider or an id',async()=>{
 const stub=await startKeysStub();
 try{
  const off=await run(stub.base,['keys','disable','openrouter','--output','json']);assert.equal(off.status,0,off.stderr);
  assert.deepEqual(stub.calls.find(c=>c.method==='PATCH'),{method:'PATCH',url:'/api/v5/inference/provider-keys/11111111-1111-4111-8111-111111111111',body:{enabled:false},auth:'Bearer ditto_mcp_fixture'});
  const on=await run(stub.base,['keys','enable','gm','--label','work']);assert.equal(on.status,0,on.stderr);assert.match(on.stdout,/Turned on your gm "work" key/);
  const missing=await run(stub.base,['keys','enable','gm','--output','json']);
  assert.equal(missing.status,1);assert.equal(JSON.parse(missing.stdout).error.code,'key_not_found');
  const checked=await run(stub.base,['keys','validate','11111111-1111-4111-8111-111111111111']);
  assert.equal(checked.status,0,checked.stderr);assert.match(checked.stdout,/openrouter accepted the key/);
  const unconfirmed=await run(stub.base,['keys','remove','openrouter']);
  assert.notEqual(unconfirmed.status,0);assert.equal(stub.calls.filter(c=>c.method==='DELETE').length,0);
  const removed=await run(stub.base,['keys','remove','openrouter','--yes']);
  assert.equal(removed.status,0,removed.stderr);assert.equal(stub.calls.filter(c=>c.method==='DELETE').length,1);
 }finally{stub.close();}
});

test('login --keys asks for the keys intent and refuses pasted keys',async()=>{
 const stub=await startKeysStub();
 const previous=process.env.DITTO_API_BASE;process.env.DITTO_API_BASE=stub.base;
 try{
  const {deviceLogin}=await import('../dist/device-login.js');
  const result=await deviceLogin({intent:'keys',onCode:()=>{}});
  assert.equal(result.apiKey,'ditto_mcp_new');
  assert.equal(stub.calls.find(c=>c.url==='/api/v2/mcp/device-code').body.intent,'keys');
  const pasted=await run(stub.base,['login','--keys','--stdin'],'ditto_mcp_x');
  assert.notEqual(pasted.status,0);assert.match(pasted.stderr,/--keys signs in through the browser/);
 }finally{process.env.DITTO_API_BASE=previous;if(previous===undefined)delete process.env.DITTO_API_BASE;stub.close();}
});
