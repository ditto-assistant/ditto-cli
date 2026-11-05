import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ALPHA } from "./helpers/stub-api.mjs";

const cli=fileURLToPath(new URL("../dist/cli.js",import.meta.url));

// DITTO-2346: `heyditto claude` printed `?graph=<storage KG ID>`, which the app's
// graph picker cannot resolve ("This workspace is unavailable"). The launch link
// must carry the registration's public graphAlias, and must not fall back to a
// bare Personal Space link when the recording home has no selectable alias.
for(const [label,registration,expectLink,expectNotice] of [
  ["company-owned recording home",{kgID:"app_ditto-30c005_owner",graphAlias:"omniaura/ditto"},"?graph=omniaura%2Fditto",false],
  ["app-owned recording home",{kgID:"app_personal-graph_owner",graphAlias:"personal-graph"},"?graph=personal-graph",false],
  ["personal main",{kgID:"",graphAlias:"main"},"?graph=main",false],
  ["home without a selectable alias",{kgID:"app_hidden_owner",graphAlias:""},undefined,true],
])test(`claude launch session link: ${label}`,{skip:process.platform==="win32"},async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"ditto-session-link-"));
  const cwd=path.join(root,"repo");const bin=path.join(root,"bin");
  await mkdir(cwd);await mkdir(bin);
  await writeFile(path.join(bin,"claude"),`#!${process.execPath}\n`,{mode:0o755});
  const server=createServer((req,res)=>{
    let raw="";req.on("data",chunk=>raw+=chunk);req.on("end",()=>{
      const json=(value,status=200)=>{res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify(value));};
      if(req.url==="/api/v5/inference/endpoints")return json({baseUrl:`http://127.0.0.1:${server.address().port}/v1`,endpoints:[ALPHA]});
      if(req.url==="/api/v5/companies")return json({companies:[]});
      if(req.url.endsWith("/keys")&&req.method==="POST")return json({id:"link-key",key:"ditto_inf_synthetic",keyHint:"test"},201);
      if(req.url.endsWith("/keys/link-key")&&req.method==="DELETE"){res.writeHead(204);return res.end();}
      if(req.url==="/api/v5/sessions/register")return json({threadId:"external:link-fixture",...registration});
      json({},404);
    });
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{
    const result=await promisify(execFile)(process.execPath,[cli,"claude","--endpoint","alpha","--no-mcp"],{cwd,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,DITTO_CONFIG_DIR:path.join(root,"config"),CLAUDE_CONFIG_DIR:path.join(root,"claude"),DITTO_API_BASE:`http://127.0.0.1:${server.address().port}`,DITTO_API_KEY:"ditto_mcp_synthetic"},timeout:15000});
    const output=result.stdout+result.stderr;
    assert.ok(!output.includes(`graph=${encodeURIComponent(registration.kgID||"__none__")}`),output);
    if(registration.kgID)assert.ok(!output.includes(registration.kgID),`a storage KG ID never reaches the link: ${output}`);
    const sessionLine=output.split("\n").find(line=>line.includes("/chat/external%3Alink-fixture"));
    if(expectLink){
      assert.ok(sessionLine,output);
      assert.ok(sessionLine.endsWith(expectLink),sessionLine);
    }else{
      assert.equal(sessionLine,undefined,`no link that would open Personal Space: ${output}`);
    }
    assert.equal(output.includes("session link unavailable: this endpoint records to a workspace you cannot open"),expectNotice,output);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});
