import assert from "node:assert/strict";
import test from "node:test";
import { sdkMcpConfig } from "../dist/agents/mcp-config.js";

test("SDK config exports Ditto and project Backroom with concrete credentials and session", () => {
  const config = sdkMcpConfig({ endpoint: "sn118", approvalMode: "park", clientApprovals: true, servers: [
    { name: "ditto", url: "https://router.test/mcp/ditto", tools: [{ name: "search_memories", tier: "read", approval: false }] },
    { name: "backroom", url: "https://router.test/mcp/backroom", tools: [{ name: "list_screenings", tier: "read", approval: true }] },
  ] }, "fresh-thread", "synthetic-key");
  assert.deepEqual(Object.keys(config.mcpServers), ["ditto", "ditto-backroom"]);
  assert.equal(config.mcpServers["ditto-backroom"].headers.Authorization, "Bearer synthetic-key");
  assert.equal(config.mcpServers.ditto.headers["X-Ditto-Session-Id"], "fresh-thread");
});

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("mcp-config selects .ditto Backroom endpoint in cwd, overrides explicitly, and revokes failed exports", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-sdk-"));
  const requests = [];
  let failCatalog = false;
  let failRevoke = false;
  const server = http.createServer((req, res) => {
    requests.push([req.method, req.url]);
    res.setHeader("content-type", "application/json");
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === "/api/v5/companies") return res.end(JSON.stringify({companies:[]}));
    if (req.url === "/api/v5/inference/endpoints") return res.end(JSON.stringify({baseUrl:base+"/v1", endpoints:[
      {id:"project",slug:"sn118",model:"native",status:"active"}, {id:"personal",slug:"other",model:"native",status:"active"},
    ]}));
    if (req.method === "POST" && req.url.endsWith("/keys")) return res.end(JSON.stringify({id:"test-key",key:"synthetic-key"}));
    if (req.method === "DELETE") {
      if (failRevoke) res.statusCode = 503;
      return res.end("{}");
    }
    if (req.url === "/v1/mcp") {
      if (failCatalog) { res.statusCode = 503; return res.end("{}"); }
      return res.end(JSON.stringify({endpoint:"sn118",approvalMode:"park",clientApprovals:false,servers:[
        {name:"ditto",url:base+"/mcp/ditto",tools:[{name:"search_memories",tier:"read",approval:false}]},
        {name:"backroom",url:base+"/mcp/backroom",tools:[{name:"list_screenings",tier:"read",approval:false}]},
      ]}));
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  try {
    await mkdir(path.join(dir,".ditto/endpoints"),{recursive:true});
    await writeFile(path.join(dir,".ditto/config.toml"),'version = 1\n[repository]\nname = "subnet"\ndefault_endpoint = "dev"\n');
    await writeFile(path.join(dir,".ditto/endpoints/dev.toml"),'managed = true\nname = "dev"\nslug = "sn118"\nmodel = "native"\n');
    const run = (args=[]) => new Promise((resolve,reject) => {
      const child = spawn(process.execPath,[fileURLToPath(new URL("../dist/cli.js",import.meta.url)),"mcp-config",...args],{
        cwd:dir,env:{...process.env,DITTO_API_BASE:`http://127.0.0.1:${server.address().port}`,DITTO_API_KEY:"synthetic-login",DITTO_CONFIG_DIR:path.join(dir,"config"),DITTO_CLI_AUTO_UPDATE:"0",T3CODE_THREAD_ID:"fresh-thread"},stdio:["ignore","pipe","pipe"],
      });
      let stdout="",stderr="";
      child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);
      child.on("error",reject);child.on("close",code=>resolve({code,stdout,stderr}));
    });
    const result = await run();
    assert.equal(result.code,0,result.stderr);
    assert.deepEqual(Object.keys(JSON.parse(result.stdout).mcpServers),["ditto","ditto-backroom"]);
    assert.ok(requests.some(([method,url])=>method==="POST"&&url==="/api/v5/inference/endpoints/project/keys"));
    const override = await run(["--endpoint","other"]);
    assert.equal(override.code,0,override.stderr);
    assert.ok(requests.some(([method,url])=>method==="POST"&&url==="/api/v5/inference/endpoints/personal/keys"));
    const createdBeforeUnknown = requests.filter(([method]) => method === "POST").length;
    const unknown = await run(["--endpoint", "missing-endpoint"]);
    assert.notEqual(unknown.code, 0);
    assert.equal(unknown.stdout, "");
    assert.match(unknown.stderr, /No endpoint named "missing-endpoint"/);
    assert.equal(requests.filter(([method]) => method === "POST").length, createdBeforeUnknown);
    failCatalog = true;
    const failed = await run();
    assert.notEqual(failed.code,0);
    assert.equal(failed.stdout,"");
    assert.ok(requests.some(([method,url])=>method==="DELETE"&&url==="/api/v5/inference/endpoints/project/keys/test-key"));
    assert.doesNotMatch(failed.stderr, /could not revoke MCP key/);
    failRevoke = true;
    const unrevoked = await run();
    assert.notEqual(unrevoked.code, 0);
    assert.equal(unrevoked.stdout, "");
    assert.match(unrevoked.stderr, /could not revoke MCP key test-key; it may remain valid until its one-hour expiry/);
    assert.match(unrevoked.stderr, /503/);
    assert.doesNotMatch(unrevoked.stderr, /synthetic-key/);
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); await rm(dir,{recursive:true,force:true}); }
});
