import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { preparePluginSession, runPluginServer } from "../dist/remote/plugin-server.js";
import { hookNodeExecutable, claudeHookSettings, codexNotifyOverride } from "../dist/remote/hooks.js";
import { startHostStub } from "./helpers/host-stub.mjs";

// Real symlink resolution proves upgrades do not bake removed Cellar paths into hooks.
test("Homebrew hooks use the matching stable opt link and reject a different Node", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ditto-node-path-"));
  try {
    const executable = path.join(root, "Cellar/node/26.9.0/bin/node");
    await mkdir(path.dirname(executable), {recursive:true});
    await writeFile(executable, "node");
    await mkdir(path.join(root, "opt"));
    await symlink(path.join(root, "Cellar/node/26.9.0"), path.join(root, "opt/node"));
    const stable = path.join(root, "opt/node/bin/node");
    assert.equal(hookNodeExecutable(executable), stable);
    const command = JSON.parse(claudeHookSettings("/tmp/socket", "/hook.js", hookNodeExecutable(executable))).hooks.Stop[0].hooks[0].command;
    assert.ok(command.startsWith(`'${stable}'`));
    assert.ok(!command.includes("Cellar"));
    assert.ok(codexNotifyOverride("/tmp/socket", "/hook.js", hookNodeExecutable(executable)).includes("/opt/node/bin/node"));
    await rm(path.join(root, "opt/node"));
    assert.equal(hookNodeExecutable(executable), executable);
    assert.equal(hookNodeExecutable("/usr/local/bin/node"), "/usr/local/bin/node");
  } finally { await rm(root,{recursive:true,force:true}); }
});

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
