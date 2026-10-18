import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import fs,{chmodSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,symlinkSync,writeFileSync} from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {MINTED_PLAINTEXT,startStub} from "./helpers/stub-api.mjs";
import {writePrivateKey,localFile} from "../dist/secret-stores/local-file.js";
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
  assert.match(stub.mints()[0].body.name,/^local:[a-f0-9-]{36}$/);
  assert.equal(JSON.parse(out.stdout).key.name,stub.mints()[0].body.name);
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
test('post-create staging failures remove the partial secret and allow retry',()=>{
 const dir=temp(),file=path.join(dir,'key'),original=fs.fsyncSync;
 try {fs.fsyncSync=()=>{throw new Error('fixture sync failure');};syncBuiltinESMExports();assert.throws(()=>writePrivateKey(file,MINTED_PLAINTEXT),/fixture sync failure/);}
 finally {fs.fsyncSync=original;syncBuiltinESMExports();}
 assert.equal(existsSync(file),false);assert.deepEqual(readdirSync(dir),[]);
 writePrivateKey(file,MINTED_PLAINTEXT);assert.equal(readFileSync(file,'utf8'),MINTED_PLAINTEXT);assert.equal(lstatSync(file).nlink,1);
});
test('directory fsync failures persist rollback and allow retry without replacing the original error',()=>{
 const dir=temp(),file=path.join(dir,'key'),original=fs.fsyncSync;let directorySyncs=0;
 try {fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isDirectory()){directorySyncs++;if(directorySyncs===1)throw new Error('fixture directory sync failure');assert.equal(existsSync(file),false);}return original(fd);};syncBuiltinESMExports();assert.throws(()=>writePrivateKey(file,MINTED_PLAINTEXT),/fixture directory sync failure/);}
 finally {fs.fsyncSync=original;syncBuiltinESMExports();}
 assert.equal(directorySyncs,2);assert.equal(existsSync(file),false);assert.deepEqual(readdirSync(dir),[]);writePrivateKey(file,MINTED_PLAINTEXT);assert.equal(lstatSync(file).nlink,1);
});
test('local key labels are opaque and distinguish destinations without path-derived information',()=>{
 const first=localFile.keyName('/private/customer-a/key',{}),second=localFile.keyName('/private/customer-b/key',{});
 assert.notEqual(first,second);assert.match(first,/^local:[a-f0-9-]{36}$/);assert.ok(!first.includes('customer-a'));assert.ok(!first.includes('key'));
 assert.notEqual(first,localFile.keyName('/private/customer-a/key',{}));
});
test('rollback sync errors preserve the initial delivery failure and remove the file',()=>{
 const dir=temp(),file=path.join(dir,'key'),original=fs.fsyncSync;let attempts=0;
 try {fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isDirectory())throw new Error(++attempts===1?'initial publication failure':'rollback failure');return original(fd);};syncBuiltinESMExports();assert.throws(()=>writePrivateKey(file,MINTED_PLAINTEXT),/initial publication failure/);}
 finally {fs.fsyncSync=original;syncBuiltinESMExports();}
 assert.equal(attempts,2);assert.equal(existsSync(file),false);assert.deepEqual(readdirSync(dir),[]);
});
test('discovery supports readable text, JSON, profiles alias, and explicit malformed-response errors',async()=>{
 let malformed=false;const id='11111111-1111-1111-1111-111111111111';
 const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');
  if(req.url.endsWith('/provider-keys'))return res.end(JSON.stringify(malformed?{}:{keys:[{id,provider:'gm',configured:true,enabled:true}]}));
  if(req.url.includes('/providers/gm/models?includeLegacy=true'))return res.end(JSON.stringify({models:[{id:'gm/gpt-6-luna',name:'GPT 6 Luna'}]}));
  res.statusCode=404;res.end('{}');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try {
  const keys=await run(base,['profiles','provider-keys','--output','text']);assert.equal(keys.status,0,keys.stderr);assert.match(keys.stdout,/gm  enabled/);assert.doesNotMatch(keys.stdout,/"keys"/);
  const models=await run(base,['profiles','models','gm','--output','text']);assert.equal(models.status,0,models.stderr);assert.match(models.stdout,/gm\/gpt-6-luna  GPT 6 Luna/);
  const json=await run(base,['profiles','models','gm','--output','json']);assert.equal(JSON.parse(json.stdout).models[0].id,'gm/gpt-6-luna');
  malformed=true;const invalid=await run(base,['profiles','provider-keys','--output','json']);assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/invalid provider-key discovery response/);assert.doesNotMatch(invalid.stderr,/TypeError/);
 } finally {server.closeAllConnections();server.close();}
});
test('selected keys cannot silently create a Ditto-funded profile',async()=>{
 const stub=await startStub(), id='11111111-1111-1111-1111-111111111111';
 try {
  for(const extra of [[],['--billing-mode','ditto']]){const out=await run(stub.base,['profiles','create','--provider-key',id,...extra]);assert.notEqual(out.status,0);assert.match(out.stderr,/requires explicit --billing-mode/);}
  assert.equal(stub.calls.some(c=>c.method==='POST'),false);
 } finally {stub.close();}
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
