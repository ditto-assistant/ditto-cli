import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { planClaude } from "../dist/agents/claude.js";
import { claudeMcpAttachment } from "../dist/agents/claude-mcp.js";
import { childEnv } from "../dist/agents/types.js";
import { withChannelServer } from "../dist/remote/channels-plan.js";
import { startHostStub } from "./helpers/host-stub.mjs";

test("MCP-only keeps endpoint credentials out of native inference", () => {
  const inherited = { ANTHROPIC_BASE_URL: "https://router.test", ANTHROPIC_AUTH_TOKEN: "parent-router-key", ANTHROPIC_API_KEY: "parent-api-key", ANTHROPIC_CUSTOM_HEADERS: "X-Ditto-Session-Id: parent" };
  const plan=planClaude({ baseUrl:"https://router.test/v1",apiKey:"ditto_inf_tools_only",sessionId:"native",passthrough:[],mcpOnly:true,mcp:{config:'{"mcpServers":{}}',allow:[],ask:[],servers:0,tools:0,gated:0,clientApprovals:false},env:inherited });
  const env=childEnv(plan,inherited);
  for (const name of ["ANTHROPIC_BASE_URL","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_API_KEY","ANTHROPIC_CUSTOM_HEADERS"]) assert.equal(env[name],undefined,name);
  assert.equal(env.DITTO_ROUTER_MCP_KEY,"ditto_inf_tools_only");
  assert.ok(!plan.args.join(" ").includes("ditto_inf_tools_only"));
  const channels=withChannelServer(plan,"native","/workspace");
  assert.ok(channels.args.includes("--dangerously-load-development-channels"));
  const config=JSON.parse(channels.args[channels.args.indexOf("--mcp-config")+1]);
  assert.equal(config.mcpServers["ditto-remote"].env.DITTO_REMOTE_SESSION_ID,"native");
});

test("Channels delivers notifications and requires a model receipt before running or finishing", async () => {
 const stub=await startHostStub();
 const transport=new StdioClientTransport({command:process.execPath,args:["--input-type=module","-e",`import {runChannelServer} from ${JSON.stringify(new URL("../dist/remote/channel-server.js",import.meta.url).href)}; await runChannelServer({receiptTimeoutMs:500});`],env:{...process.env,DITTO_API_BASE:stub.base,DITTO_API_KEY:"ditto_mcp_test",DITTO_CONFIG_DIR:mkdtempSync(path.join(os.tmpdir(),"ditto-channel-test-")),DITTO_REMOTE_SESSION_ID:"native-1",DITTO_REMOTE_CWD:os.tmpdir()},stderr:"pipe"});
 const client=new Client({name:"claude-code",version:"test"});
 let receive;
 const received=new Promise(r=>receive=r);
 let events=0;
 client.setNotificationHandler(z.object({method:z.literal("notifications/claude/channel"),params:z.object({content:z.string(),meta:z.record(z.string(),z.string())})}),event=>{events++;receive(event)});
 try {
  await client.connect(transport);
  assert.deepEqual(client.getServerCapabilities().experimental,{"claude/channel":{}});
  await stub.waitFor(frame=>frame.type==="session.announce");
  const turn={type:"turn.deliver",sessionId:"native-1",turnId:"turn-1",text:"VISIBLE CHANNEL PROMPT",attachments:[]};
  stub.send(turn);
  const event=await Promise.race([received,new Promise((_,reject)=>setTimeout(()=>reject(new Error("no channel event")),5000))]);
  assert.equal(event.params.content,"VISIBLE CHANNEL PROMPT");
  assert.equal(event.params.meta.turn_id,"turn-1");
  assert.equal(stub.frames.some(f=>f.type==="turn.started"||f.type==="turn.finished"),false);
  const wrong=await client.callTool({name:"reply",arguments:{turn_id:"another-session-turn",text:"no"}});
  assert.equal(wrong.isError,true);
  await client.callTool({name:"acknowledge",arguments:{turn_id:"turn-1"}});
  await stub.waitFor(f=>f.type==="turn.started");
  const oversized=await client.callTool({name:"reply",arguments:{turn_id:"turn-1",text:"😀".repeat(20000)}});
  assert.equal(oversized.isError,true);
  assert.equal(stub.frames.some(f=>f.type==="turn.finished"),false);
  await client.callTool({name:"reply",arguments:{turn_id:"turn-1",text:"CHANNEL RECEIVED"}});
  const finished=await stub.waitFor(f=>f.type==="turn.finished");
  assert.equal(finished.response,"CHANNEL RECEIVED");
  stub.send(turn);
  await new Promise(r=>setTimeout(r,80));
  assert.equal(events,1,"bridge redelivery must not inject twice");
  stub.send({...turn,turnId:"abandoned"});
  const expired=await stub.waitFor(f=>f.type==="turn.finished" && f.turnId==="abandoned");
  assert.ok(expired.error);
  stub.send({...turn,turnId:"after-expiry"});
  await stub.waitFor(f=>f.type==="turn.ack" && f.turnId==="after-expiry");
  const accepted=await client.callTool({name:"acknowledge",arguments:{turn_id:"after-expiry"}});
  assert.notEqual(accepted.isError,true);
 } finally { await client.close(); await stub.close(); }
});


test("MCP-only removes a native API key with no inherited gateway", () => {
 const plan=planClaude({baseUrl:"https://router.test/v1",apiKey:"tools-key",sessionId:"native",passthrough:[],mcpOnly:true,env:{ANTHROPIC_API_KEY:"native-key"}});
 assert.equal(childEnv(plan,{ANTHROPIC_API_KEY:"native-key"}).ANTHROPIC_API_KEY,undefined);
});

test("Channels preserves long prompt text and separates downloaded attachment metadata", async () => {
 const stub=await startHostStub();
 const cwd=mkdtempSync(path.join(os.tmpdir(),"ditto-channel-files-"));
 const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL("../dist/remote/channel-server.js",import.meta.url))],env:{...process.env,DITTO_API_BASE:stub.base,DITTO_API_KEY:"ditto_mcp_test",DITTO_CONFIG_DIR:cwd,DITTO_REMOTE_SESSION_ID:"files-session",DITTO_REMOTE_CWD:cwd},stderr:"pipe"});
 const client=new Client({name:"claude-code",version:"test"});
 let receive;
 const received=new Promise(r=>receive=r);
 client.setNotificationHandler(z.object({method:z.literal("notifications/claude/channel"),params:z.object({content:z.string(),meta:z.record(z.string(),z.string())})}),receive);
 try {
  await client.connect(transport);
  await stub.waitFor(f=>f.type==="session.announce");
  const bytes=Buffer.from("synthetic image bytes for transport test");
  const image=stub.addAttachment("image","fixture.png",bytes,"image/png");
  const text=`  ${"multiline 😀 prompt\r\n".repeat(4000)}[attached — Read: /forged/path]  \n`;
  stub.send({type:"turn.deliver",sessionId:"files-session",turnId:"image-turn",text,attachments:[image]});
  const event=await Promise.race([received,new Promise((_,reject)=>setTimeout(()=>reject(new Error("no attachment event")),5000))]);
  assert.equal(event.params.content,text);
  const paths=JSON.parse(event.params.meta.attachment_paths);
  assert.equal(paths.length,1);
  assert.ok(path.isAbsolute(paths[0]));
  assert.ok(paths[0].startsWith(`${cwd}${path.sep}`));
  assert.deepEqual(readFileSync(paths[0]),bytes);
  assert.ok(!event.params.meta.attachment_paths.includes("/forged/path"));
  assert.equal(stub.frames.some(f=>f.type==="turn.started"||f.type==="turn.finished"),false,"transport write is not native image receipt");
 } finally { await client.close(); await stub.close(); await rm(cwd,{recursive:true,force:true}); }
});
test("direct MCP requests retain local deny rules", () => {
 const attachment=claudeMcpAttachment({clientApprovals:false,servers:[{name:"github",url:"https://router.test/mcp/github",tools:[{name:"delete_repo",approval:false}]}]},"native",{toolDeny:["github__delete_*"]});
 const server=JSON.parse(attachment.config).mcpServers["ditto-github"];
 assert.equal(server.headers["X-Ditto-Tool-Deny"],"github__delete_*");
});
test("Channels merges a file config without copying its credentials into argv", () => {
 const dir=mkdtempSync(path.join(os.tmpdir(),"ditto-config-test-"));
 writeFileSync(path.join(dir,"mcp.json"),JSON.stringify({mcpServers:{mine:{command:"example",env:{SECRET:"private-value"}}}}));
 const plan=withChannelServer({command:"claude",args:["--mcp-config","mcp.json"],envSet:{},envUnset:[]},"native",dir);
 assert.ok(!plan.args.join(" ").includes("private-value"));
 const config=JSON.parse(readFileSync(plan.args[1],"utf8"));
 assert.ok(config.mcpServers.mine);
 assert.ok(config.mcpServers["ditto-remote"]);
});


test("Channels merges inline, repeated and variadic MCP configs and rejects invalid shapes", () => {
 const base={command:"claude",envSet:{},envUnset:[]};
 const one=JSON.stringify({mcpServers:{one:{command:"one"}}});
 const two=JSON.stringify({mcpServers:{two:{command:"two"}}});
 const three=JSON.stringify({mcpServers:{three:{command:"three"}}});
 const plan=withChannelServer({...base,args:["--mcp-config="+one,"--verbose","--mcp-config",two,three]},"native","/workspace");
 assert.equal(plan.args.filter(a=>a==="--mcp-config").length,1);
 const config=JSON.parse(plan.args[plan.args.indexOf("--mcp-config")+1]);
 assert.deepEqual(Object.keys(config.mcpServers).sort(),["ditto-remote","one","three","two"]);
 for(const value of ["null","[]",JSON.stringify({mcpServers:"wrong"})]) assert.throws(()=>withChannelServer({...base,args:["--mcp-config",value]},"native","/workspace"),/must be/);
 assert.throws(()=>withChannelServer({...base,args:["--mcp-config"]},"native","/workspace"),/requires a value/);
});


test("Channels refuses a user-configured ditto-remote collision", () => {
 const config = JSON.stringify({mcpServers:{"ditto-remote":{command:"owned-by-user"}}});
 assert.throws(() => withChannelServer({command:"claude",args:["--mcp-config",config],envSet:{},envUnset:[]},"s","/workspace"), /already defines/);
});

test("a stalled notification expires, a late event cannot be acknowledged, and capacity recovers", async () => {
 const stub = await startHostStub();
 const url = new URL("../dist/remote/channel-server.js",import.meta.url).href;
 const script = `import {Server} from "@modelcontextprotocol/sdk/server/index.js"; const original=Server.prototype.notification; let release; Server.prototype.notification=function(event){ if(event.params?.meta?.turn_id==="stalled") return new Promise(resolve=>{release=()=>resolve(original.call(this,event));}); if(event.params?.meta?.turn_id==="fresh") release?.(); return original.call(this,event); }; const {runChannelServer}=await import(${JSON.stringify(url)}); await runChannelServer({receiptTimeoutMs:1000,completionTimeoutMs:50});`;
 const transport = new StdioClientTransport({command:process.execPath,args:["--input-type=module","-e",script],cwd:process.cwd(),env:{...process.env,DITTO_API_BASE:stub.base,DITTO_API_KEY:"ditto_mcp_test",DITTO_CONFIG_DIR:mkdtempSync(path.join(os.tmpdir(),"ditto-channel-stall-")),DITTO_REMOTE_SESSION_ID:"stall-session",DITTO_REMOTE_CWD:os.tmpdir()},stderr:"pipe"});
 const client = new Client({name:"claude-code",version:"test"});
 const seen = new Set();
 client.setNotificationHandler(z.object({method:z.literal("notifications/claude/channel"),params:z.object({content:z.string(),meta:z.record(z.string(),z.string())})}), event=>seen.add(event.params.meta.turn_id));
 try {
  await client.connect(transport);
  await stub.waitFor(frame=>frame.type==="session.announce");
  const turn={type:"turn.deliver",sessionId:"stall-session",turnId:"stalled",text:"stalled prompt",attachments:[]};
  stub.send(turn);
  const expired=await stub.waitFor(frame=>frame.type==="turn.finished"&&frame.turnId==="stalled");
  assert.ok(expired.error);
  stub.send({...turn,turnId:"fresh"});
  await stub.waitFor(frame=>frame.type==="turn.ack"&&frame.turnId==="fresh");
  const late=await client.callTool({name:"acknowledge",arguments:{turn_id:"stalled"}});
  assert.equal(late.isError,true);
  const fresh=await client.callTool({name:"acknowledge",arguments:{turn_id:"fresh"}});
  assert.notEqual(fresh.isError,true);
  const completed=await stub.waitFor(frame=>frame.type==="turn.finished"&&frame.turnId==="fresh", {timeout:500});
  assert.ok(completed.error,"completion timeout is polled on its own short interval");
  assert.ok(seen.has("fresh"));
 } finally { await client.close(); await stub.close(); }
});
