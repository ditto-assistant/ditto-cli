import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {chmodSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,symlinkSync,writeFileSync} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {MINTED_PLAINTEXT,startStub} from "./helpers/stub-api.mjs";
import {writePrivateKey} from "../dist/secret-stores/local-file.js";
import {providerKeySelection} from "../dist/router-discovery.js";

const cli=new URL('../dist/cli.js',import.meta.url);
function temp(){return realpathSync(mkdtempSync(path.join(os.tmpdir(),'heyditto-private-')));}
function run(base,args){return new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[cli.pathname,...args],{stdio:['ignore','pipe','pipe'],env:{...process.env,DITTO_API_BASE:base,DITTO_API_KEY:'ditto_mcp_fixture',DITTO_CONFIG_DIR:temp()}});
 let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);child.on('close',status=>resolve({status,stdout,stderr}));
});}

test('local key delivery is exclusive, private, and never printed',async()=>{
 const stub=await startStub(), dir=temp(), file=path.join(dir,'key');
 try {
  const out=await run(stub.base,['endpoints','keys','create','alpha','--key-file',file,'--yes','--output','json']);
  assert.equal(out.status,0,out.stderr);assert.equal(readFileSync(file,'utf8'),MINTED_PLAINTEXT);assert.equal(lstatSync(file).mode&0o777,0o600);
  assert.ok(!(out.stdout+out.stderr).includes(MINTED_PLAINTEXT));assert.equal(JSON.parse(out.stdout).store,'file');
  const again=await run(stub.base,['endpoints','keys','create','alpha','--key-file',file,'--yes']);
  assert.notEqual(again.status,0);assert.equal(stub.mints().length,1);assert.equal(readFileSync(file,'utf8'),MINTED_PLAINTEXT);
 } finally {stub.close();}
});
test('file store rejects symlinks, insecure parents, relative paths, scope flags, and empty secrets',async()=>{
 const stub=await startStub(), dir=temp(), insecure=path.join(dir,'insecure');mkdirSync(insecure,0o755);chmodSync(insecure,0o755);
 const link=path.join(dir,'link');symlinkSync(dir,link);
 try {
  for(const args of [['--key-file','relative'],['--key-file',path.join(link,'key')],['--key-file',path.join(insecure,'key')],['--key-file',path.join(dir,'key'),'--repo','acme/app']]) {
   const out=await run(stub.base,['endpoints','keys','create','alpha',...args,'--yes']);assert.notEqual(out.status,0);
  }
  assert.equal(stub.mints().length,0);assert.throws(()=>writePrivateKey(path.join(dir,'empty'),''));assert.equal(existsSync(path.join(dir,'empty')),false);
 } finally {stub.close();}
});
test('a destination racing into existence revokes the minted key without overwriting',async()=>{
 const dir=temp(),file=path.join(dir,'key');let revoked=false;
 const server=http.createServer((req,res)=>{
  req.resume();req.on('end',()=>{
   res.setHeader('content-type','application/json');
   if(req.url==='/api/v5/companies')return res.end('{"companies":[]}');
   if(req.method==='GET')return res.end(JSON.stringify({baseUrl:'https://router.heyditto.ai/v1',endpoints:[{id:'ep',slug:'alpha',model:'gm/gpt-6-luna'}]}));
   if(req.method==='POST'){writeFileSync(file,'other-file',{mode:0o600});res.statusCode=201;return res.end(JSON.stringify({id:'key-id',key:MINTED_PLAINTEXT}));}
   if(req.method==='DELETE'){revoked=true;res.statusCode=204;return res.end();}
   res.statusCode=404;res.end('{}');
  });
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {const out=await run(`http://127.0.0.1:${server.address().port}`,['endpoints','keys','create','alpha','--key-file',file,'--yes']);assert.notEqual(out.status,0);assert.equal(revoked,true);assert.equal(readFileSync(file,'utf8'),'other-file');assert.ok(!(out.stdout+out.stderr).includes(MINTED_PLAINTEXT));}
 finally {server.closeAllConnections();server.close();}
});
test('provider key selection never treats raw secrets, names or an empty list as all keys',()=>{
 const id='11111111-1111-1111-1111-111111111111';assert.deepEqual(providerKeySelection([id,id]),[id]);assert.equal(providerKeySelection(undefined),undefined);
 for(const x of [[],[''],['gm'],['sk-secret'],[id+',']])assert.throws(()=>providerKeySelection(x));
});
test('personal BYOK creation sends selected IDs atomically and discovery projects secrets away',async()=>{
 const id='11111111-1111-1111-1111-111111111111';let created;
 const server=http.createServer((req,res)=>{let body='';req.on('data',x=>body+=x);req.on('end',()=>{
  res.setHeader('content-type','application/json');
  if(req.url.endsWith('/provider-keys'))return res.end(JSON.stringify({keys:[{id,provider:'gm',configured:true,enabled:true,key:'must-not-leak',metadata:{secret:'must-not-leak'}}]}));
  if(req.method==='POST'){created=JSON.parse(body);return res.end(JSON.stringify({...created,id,status:'active'}));}
  res.statusCode=404;res.end('{}');
 });});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try {
  const out=await run(base,['endpoints','create','--slug','infinite-disk','--model','gm/gpt-6-luna','--billing-mode','byok','--provider-key',id,'--output','json']);assert.equal(out.status,0,out.stderr);
  assert.deepEqual(created,{slug:'infinite-disk',model:'gm/gpt-6-luna',billingMode:'byok',providerKeyIds:[id]});assert.equal(created.companyId,undefined);
  const keys=await run(base,['endpoints','provider-keys','--output','json']);assert.equal(keys.status,0,keys.stderr);assert.ok(!keys.stdout.includes('must-not-leak'));assert.equal(JSON.parse(keys.stdout).keys[0].id,id);
 } finally {server.closeAllConnections();server.close();}
});
