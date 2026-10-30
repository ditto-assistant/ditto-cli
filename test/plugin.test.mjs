import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { preparePluginSession, runPluginServer } from "../dist/remote/plugin-server.js";
import { remoteSessionURL } from "../dist/remote/session-link.js";
import { startHostStub } from "./helpers/host-stub.mjs";

test("plugin preserves a launcher's session without choosing an endpoint or creating credentials", async () => {
  const before = { key: process.env.DITTO_API_KEY, session: process.env.DITTO_REMOTE_SESSION_ID };
  try {
    process.env.DITTO_API_KEY = "ditto_test";
    process.env.DITTO_REMOTE_SESSION_ID = "wrapper-native-session";
    assert.deepEqual(await preparePluginSession("/work"), {sessionId:"wrapper-native-session",cwd:"/work"});
  } finally {
    for(const [k,v] of [["DITTO_API_KEY",before.key],["DITTO_REMOTE_SESSION_ID",before.session]]) v===undefined?delete process.env[k]:process.env[k]=v;
  }
});

test("standalone plugin requires an existing unambiguous endpoint and never silently creates one", async () => {
  const stub = await startHostStub({endpoints:[]});
  const config = await mkdtemp(path.join(os.tmpdir(), "ditto-plugin-config-"));
  const names=["DITTO_API_KEY","DITTO_CONFIG_DIR","DITTO_API_BASE","DITTO_REMOTE_SESSION_ID","DITTO_REMOTE_ENDPOINT"];
  const original=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  try {
    process.env.DITTO_API_KEY="ditto_mcp_test";process.env.DITTO_CONFIG_DIR=config;process.env.DITTO_API_BASE=stub.base;delete process.env.DITTO_REMOTE_SESSION_ID;delete process.env.DITTO_REMOTE_ENDPOINT;
    await assert.rejects(preparePluginSession(os.tmpdir()),/Select an existing endpoint/);
    assert.equal(stub.calls.some(c=>c.method==="POST"),false);
  } finally {
    for(const [k,v] of Object.entries(original)) v===undefined?delete process.env[k]:process.env[k]=v;
    await stub.close();await rm(config,{recursive:true,force:true});
  }
});


test("standalone plugin registers a native Channels session with existing login and default endpoint", async () => {
  const stub = await startHostStub({remoteRegistration:true});
  const config = await mkdtemp(path.join(os.tmpdir(), "ditto-plugin-register-"));
  const names=["DITTO_API_KEY","DITTO_CONFIG_DIR","DITTO_API_BASE","DITTO_REMOTE_SESSION_ID","DITTO_REMOTE_ENDPOINT"];
  const original=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  try {
    await writeFile(path.join(config,"config.json"),JSON.stringify({apiKey:"ditto_mcp_test",defaultEndpoint:"alpha"}));
    delete process.env.DITTO_API_KEY;process.env.DITTO_CONFIG_DIR=config;process.env.DITTO_API_BASE=stub.base;delete process.env.DITTO_REMOTE_SESSION_ID;delete process.env.DITTO_REMOTE_ENDPOINT;
    const session=await preparePluginSession(os.tmpdir());
    assert.match(session.sessionId,/^[a-f0-9-]{36}$/);
    const registrations=stub.calls.filter(c=>c.method==="POST");
    assert.equal(registrations.length,1);
    assert.deepEqual(registrations[0].body,{sessionId:session.sessionId,endpointId:"11111111-1111-1111-1111-111111111111",harness:"claude-code",inference:"native",transport:"channels",title:`${path.basename(os.tmpdir())} · ${session.sessionId.slice(0,8)}`});
  } finally {
    for(const [k,v] of Object.entries(original)) v===undefined?delete process.env[k]:process.env[k]=v;
    await stub.close();await rm(config,{recursive:true,force:true});
  }
});


test("installing the plugin without explicit channel opt-in cannot register a remote session", async () => {
  const original=process.env.DITTO_REMOTE_CHANNELS_ENABLED;
  try { delete process.env.DITTO_REMOTE_CHANNELS_ENABLED; await assert.rejects(runPluginServer(),/explicitly/); }
  finally { original===undefined?delete process.env.DITTO_REMOTE_CHANNELS_ENABLED:process.env.DITTO_REMOTE_CHANNELS_ENABLED=original; }
});


test("session links select a public graph alias and never use an internal storage KG ID", () => {
  const link=new URL(remoteSessionURL({threadId:"external:session",kgID:"app_ditto-private-owner",graphAlias:"omniaura/ditto"}));
  assert.equal(link.searchParams.get("graph"),"omniaura/ditto");
  assert.equal(link.pathname,"/chat/external%3Asession");
  assert.equal(new URL(remoteSessionURL({threadId:"t",kgID:"app_ditto-private-owner"})).search,"");
});


test("plugin entry shows known setup guidance and hides arbitrary server cause text", async () => {
  const config=await mkdtemp(path.join(os.tmpdir(),"ditto-plugin-diagnostics-"));
  const secret="private server cause must not appear";
  let emptyCatalog=false;
  const server=createServer((req,res)=>{
    if(emptyCatalog){
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify(req.url==="/api/v5/companies"?{companies:[]}:{endpoints:[],baseUrl:"https://router.test/v1"}));
      return;
    }
    res.writeHead(401,{"Content-Type":"application/json"});res.end(JSON.stringify({message:secret}));
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const execute=async overrides=>{
    try {
      await promisify(execFile)(process.execPath,[fileURLToPath(new URL("../dist/remote/plugin-server.js",import.meta.url))],{env:{...process.env,DITTO_CONFIG_DIR:config,DITTO_API_KEY:"",DITTO_REMOTE_SESSION_ID:"",DITTO_REMOTE_CWD:config,DITTO_REMOTE_ENDPOINT:"",DITTO_REMOTE_CHANNELS_ENABLED:"",...overrides},timeout:5000});
      assert.fail("plugin startup must fail for this fixture");
    } catch (error) {assert.equal(error.code,1);return error.stderr;}
  };
  try {
    const inactive=await execute({});
    assert.match(inactive,/Enable this review plugin explicitly/);
    assert.doesNotMatch(inactive,/Sign in with/);
    const signedOut=await execute({DITTO_REMOTE_CHANNELS_ENABLED:"1"});
    assert.match(signedOut,/heyditto login/);
    assert.doesNotMatch(signedOut,/Enable this review plugin/);
    const failed=await execute({DITTO_REMOTE_CHANNELS_ENABLED:"1",DITTO_API_KEY:"ditto_mcp_synthetic",DITTO_API_BASE:`http://127.0.0.1:${server.address().port}`});
    assert.match(failed,/Ditto Remote could not start/);
    assert.doesNotMatch(failed,new RegExp(secret));
    assert.doesNotMatch(failed,/ditto_mcp_synthetic/);
    emptyCatalog=true;
    const unselected=await execute({DITTO_REMOTE_CHANNELS_ENABLED:"1",DITTO_API_KEY:"ditto_mcp_synthetic",DITTO_API_BASE:`http://127.0.0.1:${server.address().port}`});
    assert.match(unselected,/Select an existing endpoint/);
    assert.doesNotMatch(unselected,/Ditto Remote could not start/);
  } finally {await new Promise(resolve=>server.close(resolve));await rm(config,{recursive:true,force:true});}
});
