import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { planClaude } from "../dist/agents/claude.js";
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
 const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL("../dist/remote/channel-server.js",import.meta.url))],env:{...process.env,DITTO_API_BASE:stub.base,DITTO_API_KEY:"ditto_mcp_test",DITTO_CONFIG_DIR:mkdtempSync(path.join(os.tmpdir(),"ditto-channel-test-")),DITTO_REMOTE_SESSION_ID:"native-1",DITTO_REMOTE_CWD:os.tmpdir()},stderr:"pipe"});
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
  await client.callTool({name:"reply",arguments:{turn_id:"turn-1",text:"CHANNEL RECEIVED"}});
  const finished=await stub.waitFor(f=>f.type==="turn.finished");
  assert.equal(finished.response,"CHANNEL RECEIVED");
  stub.send(turn);
  await new Promise(r=>setTimeout(r,80));
  assert.equal(events,1,"bridge redelivery must not inject twice");
 } finally { await client.close(); await stub.close(); }
});
