// Offline regression coverage for the local review recommendation gate.
// Every server here is a local fixture: no request leaves 127.0.0.1 and no
// inference runs. Live runs are recorded separately and are never simulated.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { recommendLocalReview, gateExitCode } from "../dist/review-recommendation.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const REPO = { id: "33333333-3333-3333-3333-333333333333", fullName: "acme/project", enabled: true };
const RUN = "66666666-6666-6666-6666-666666666666";

const clean = (over = {}) => ({ status: "completed", workspaceCurrent: true, result: { complete: true, findings: [], files: { completed: ["app.ts"], abbreviated: [], failed: [] }, local: { contextComplete: true, changedCoverageComplete: true } }, ...over });
const withResult = (result, over = {}) => clean({ result: { ...clean().result, ...result }, ...over });
const finding = (severity, extra = {}) => ({ status: "posted", severity, path: "app.ts", line: 1, title: `${severity} finding`, ...extra });

test("only a completed, complete, current, well-formed run approves", () => {
  const rec = recommendLocalReview(clean());
  assert.equal(rec.verdict, "approve"); assert.equal(rec.approved, true); assert.equal(gateExitCode(rec), 0);
});

for (const [name, run, pattern] of [
  ["partial", clean({ status: "partial", result: { ...clean().result, complete: false } }), /status is partial/],
  ["failed", { status: "failed", error: "engine stopped" }, /status is failed/],
  ["cancelled", { status: "cancelled" }, /status is cancelled/],
  ["skipped", { status: "skipped" }, /status is skipped/],
  ["superseded with a complete-looking result", clean({ status: "superseded" }), /status is superseded/],
  ["completed but incomplete coverage", withResult({ complete: false }), /coverage is incomplete/],
  ["completed with no findings list", withResult({ findings: undefined }), /no findings list/],
  ["completed with no result", { status: "completed", workspaceCurrent: true }, /no review result/],
  ["completed with an error", withResult({ error: "budget exhausted" }), /result error: budget exhausted/],
  ["changed coverage incomplete", withResult({ local: { contextComplete: true, changedCoverageComplete: false } }), /changed paths were not fully reviewed/],
  ["working tree changed", clean({ workspaceCurrent: false }), /working tree changed/],
  ["working tree unverified (status read)", clean({ workspaceCurrent: null }), /could not be verified/],
]) {
  test(`no recommendation and no approval: ${name}`, () => {
    const rec = recommendLocalReview(run);
    assert.equal(rec.verdict, "none"); assert.equal(rec.approved, false); assert.equal(gateExitCode(rec), 1);
    assert.match(rec.reasons.join("; "), pattern);
  });
}

for (const [name, run, pattern] of [
  ["findings is a string", withResult({ findings: "none" }), /findings is not an array/],
  ["findings has a non-object", withResult({ findings: [null] }), /non-object entry/],
  ["complete is a string", withResult({ complete: "true" }), /complete is not a boolean/],
  ["result is an array", clean({ result: [] }), /result is not an object/],
  ["status is missing", { result: clean().result, workspaceCurrent: true }, /status is not a string/],
  ["local is a string", withResult({ local: "complete" }), /local is not an object/],
]) {
  test(`malformed responses fail closed: ${name}`, () => {
    const rec = recommendLocalReview(run);
    assert.equal(rec.verdict, "none"); assert.match(rec.reasons.join("; "), /malformed response/); assert.match(rec.reasons.join("; "), pattern);
  });
}

test("blocking findings request changes, even from a partial run; nits alone approve", () => {
  for (const severity of ["critical", "high", "medium", "unknown-severity", undefined]) {
    const rec = recommendLocalReview(withResult({ findings: [finding(severity)] }));
    assert.equal(rec.verdict, "changes", String(severity)); assert.equal(gateExitCode(rec), 2); assert.equal(rec.blocking, 1);
  }
  const partial = recommendLocalReview(clean({ status: "partial", result: { complete: false, findings: [finding("high")] } }));
  assert.equal(partial.verdict, "changes");
  const nits = recommendLocalReview(withResult({ findings: [finding("low"), finding("nit")] }));
  assert.equal(nits.verdict, "approve"); assert.equal(nits.nits, 2);
  const partialNits = recommendLocalReview(clean({ status: "partial", result: { complete: false, findings: [finding("low")] } }));
  assert.equal(partialNits.verdict, "none", "a partial run with only nits is not approval");
  const withheld = recommendLocalReview(withResult({ findings: [finding("high", { status: "withheld", withheldReason: "rejected_by_verifier" })] }));
  assert.equal(withheld.verdict, "approve", "withheld candidates are not posted findings");
  const failedWithFindings = recommendLocalReview({ status: "failed", result: { findings: [finding("high")] } });
  assert.equal(failedWithFindings.verdict, "none", "a failed run's findings are not a usable result");
});

const unfinished = { path: "app.ts", lens: 0, model: "m", reason: "budget exhausted" };
for (const [name, run, pattern] of [
  ["unfinished reuse work", clean({ reuse: { version: 1, unfinished: [unfinished] } }), /unfinished work/],
  ["unfinished work hidden by a clear top-level alias", clean({ reuse: { version: 1, unfinished: [] }, result: { ...clean().result, reuse: { version: 1, unfinished: [unfinished] } } }), /unfinished work|disagree/],
  ["unsupported reuse version", clean({ reuse: { version: 2 } }), /unsupported version/],
  ["reuse resolution failed", clean({ reuse: { version: 1, status: "failed" } }), /not resolved/],
  ["reuse resolution error", clean({ reuse: { version: 1, error: "anchor not reachable" } }), /resolution error: anchor not reachable/],
  ["reuse is not an object", clean({ reuse: "yes" }), /not an object/],
  ["unverifiable PR inheritance", clean({ inheritance: { status: "inherited", sourceRunId: RUN } }), /cannot verify PR inheritance/],
  ["unverifiable inheritance inside result", withResult({ inheritance: { sourceRunId: RUN } }), /cannot verify PR inheritance/],
]) {
  test(`reuse/inheritance hard gate fails closed: ${name}`, () => {
    // Even with blocking findings present, a failed gate yields no recommendation.
    for (const findings of [[], [finding("high")]]) {
      const rec = recommendLocalReview({ ...run, result: { ...run.result, findings } });
      assert.equal(rec.verdict, "none"); assert.equal(rec.approved, false); assert.match(rec.reasons.join("; "), pattern);
    }
  });
}

test("a present null findings list is the engine's empty list; an absent key is not", () => {
  // Observed in production run c4d4aff0-e78b-44de-97e9-9f72a9132d99 (2026-11-05):
  // a completed, complete clean review returned "findings": null.
  assert.equal(recommendLocalReview(withResult({ findings: null })).verdict, "approve");
  const absent = clean(); delete absent.result.findings;
  assert.equal(recommendLocalReview(absent).verdict, "none");
});

test("round-1 self-review findings stay fixed", () => {
  // S2: a blocking finding with a null or empty status cannot hide from the gate.
  for (const status of [null, ""]) assert.equal(recommendLocalReview(withResult({ findings: [finding("high", { status })] })).verdict, "changes");
  // R3.1: an unrecognized status counts; only withheld/duplicate candidates are excluded.
  assert.equal(recommendLocalReview(withResult({ findings: [finding("high", { status: "pending" })] })).verdict, "changes");
  assert.equal(recommendLocalReview(withResult({ findings: [finding("high", { status: "duplicate" })] })).verdict, "approve");
  // R3.3: equal reuse receipts with different key order are not a disagreement.
  const a = { version: 1, unfinished: [], sourceRunId: RUN }, b = { sourceRunId: RUN, unfinished: [], version: 1 };
  assert.equal(recommendLocalReview(clean({ reuse: a, result: { ...clean().result, reuse: b } })).verdict, "approve");
  // PR review: an object severity is unknown (blocks) and does not throw.
  assert.equal(recommendLocalReview(withResult({ findings: [{ status: "posted", severity: { toString: null } }] })).verdict, "changes");
  // PR review: unfinished: null is an empty list.
  assert.equal(recommendLocalReview(clean({ reuse: { version: 1, unfinished: null } })).verdict, "approve");
  // Every lens must finish every changed file; a missing coverage report is not complete.
  assert.equal(recommendLocalReview(withResult({ files: { completed: [], abbreviated: [{ path: "app.ts", reason: "lens security: max_rounds" }], failed: [] } })).verdict, "none");
  assert.equal(recommendLocalReview(withResult({ files: { completed: [], abbreviated: [], failed: [{ path: "app.ts", reason: "time limit" }] } })).verdict, "none");
  assert.match(recommendLocalReview(withResult({ files: undefined })).reasons.join(), /no per-file coverage report/);
  // Present null lists are empty (Go nil slices); absent lists are not.
  assert.equal(recommendLocalReview(withResult({ files: { completed: ["app.ts"], abbreviated: null, failed: null } })).verdict, "approve");
  assert.equal(recommendLocalReview(withResult({ files: { completed: ["app.ts"], failed: [] } })).verdict, "none");
  assert.equal(recommendLocalReview(withResult({ files: { completed: ["app.ts"], abbreviated: "none", failed: [] } })).verdict, "none");
  // Abbreviated work with a blocking finding is still CHANGES (findings are evidence).
  assert.equal(recommendLocalReview(withResult({ findings: [finding("high")], files: { completed: [], abbreviated: [{ path: "app.ts", reason: "x" }], failed: [] } })).verdict, "changes");
  // S7: non-boolean coverage flags are not complete coverage; missing local metadata is not either.
  for (const local of [{ contextComplete: true, changedCoverageComplete: null }, { contextComplete: true, changedCoverageComplete: "yes" }, undefined]) {
    assert.equal(recommendLocalReview(withResult({ local })).verdict, "none", JSON.stringify(local));
  }
  // S8: a non-string error value blocks approval.
  assert.equal(recommendLocalReview(clean({ error: { code: "x" } })).verdict, "none");
  assert.equal(recommendLocalReview(withResult({ error: 7 })).verdict, "none");
  // S6: a partial run's nit count survives into the structured recommendation.
  assert.equal(recommendLocalReview(clean({ status: "partial", result: { complete: false, findings: [finding("low")] } })).nits, 1);
});

test("DITTO-2455: bounded context is reported but does not block; unverified candidates do", () => {
  const bounded = recommendLocalReview(withResult({ local: { contextComplete: false, changedCoverageComplete: true } }));
  assert.equal(bounded.verdict, "approve"); assert.match(bounded.reasons.join(), /surrounding context was bounded/);
  for (const withheldReason of ["verification_unavailable", "candidate_limit", "file_evidence_unavailable", "comment_limit", "repeat_with_new_evidence", "some_future_reason", "", undefined]) {
    const rec = recommendLocalReview(withResult({ findings: [finding("high", { status: "withheld", withheldReason })] }));
    assert.equal(rec.verdict, "none", String(withheldReason)); assert.match(rec.reasons.join(), /were not decided/);
  }
  // Decided withheld candidates (the engine's own decisions) do not block.
  for (const withheldReason of ["rejected_by_verifier", "below_confidence", "below_severity", "path_filtered", "documentation", "not_on_changed_line", "declined_earlier"]) {
    assert.equal(recommendLocalReview(withResult({ findings: [finding("high", { status: "withheld", withheldReason })] })).verdict, "approve", withheldReason);
  }
  // Changed coverage still has to be complete on every lens.
  assert.equal(recommendLocalReview(withResult({ local: { contextComplete: false, changedCoverageComplete: false } })).verdict, "none");
});

test("a resolved v1 reuse receipt in both places does not block approval", () => {
  const reuse = { version: 1, sourceRunId: RUN, reused: [{ path: "app.ts", lens: 0, model: "m" }], unfinished: [] };
  assert.equal(recommendLocalReview(clean({ reuse, result: { ...clean().result, reuse } })).verdict, "approve");
});

// ---- CLI-level coverage against a local fixture server --------------------

function git(cwd, ...args) {
  const out = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}
async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ditto-local-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Gate fixture"); git(root, "config", "user.email", "gate@example.test");
  git(root, "remote", "add", "origin", "git@github.com:acme/project.git");
  await writeFile(path.join(root, "app.ts"), "export const a = 1;\n"); await writeFile(path.join(root, "lib.ts"), "export const b = 1;\n");
  git(root, "add", "."); git(root, "commit", "-m", "fixture");
  return root;
}

/** `terminal(body)` builds the terminal run from the admitted request; a raw
 * string is sent verbatim to exercise malformed JSON. */
async function server(t, { terminal, admission } = {}) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", c => body += c);
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : undefined;
      calls.push({ method: req.method, url: req.url, body: parsed });
      const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(typeof data === "string" ? data : JSON.stringify(data)); };
      if (req.url === "/api/v5/review") return send(200, { repositories: [REPO] });
      if (req.url === `/api/v5/review/repositories/${REPO.id}/local`) {
        if (admission) return send(...admission);
        calls.digest = parsed.snapshot.digest; calls.profile = parsed.profile;
        return send(202, { runId: RUN, status: "queued", profile: parsed.profile, snapshotDigest: parsed.snapshot.digest, budgetCents: 25, maxSeconds: 90 });
      }
      if (req.url === `/api/v5/review/local/runs/${RUN}/cancel`) return send(200, { runId: RUN, status: "cancelled" });
      if (req.url === `/api/v5/review/local/runs/${RUN}`) {
        const out = terminal ? terminal(calls) : { status: "completed", result: clean().result };
        return send(200, typeof out === "string" ? out : { runId: RUN, profile: calls.profile ?? "quick", snapshotDigest: calls.digest, budgetCents: 25, maxSeconds: 90, ...out });
      }
      send(404, { message: "unexpected route" });
    });
  });
  await new Promise(resolve => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  return { base: `http://127.0.0.1:${srv.address().port}`, calls };
}

function run(root, base, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "review", ...args], { cwd: root, env: { ...process.env, DITTO_API_KEY: "ditto_mcp_fixture", DITTO_API_BASE: base, DITTO_CONFIG_DIR: path.join(root, ".git", "fixture-config") }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c);
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

test("--gate maps approve/changes/none to exit 0/2/1 and JSON carries the recommendation", async t => {
  const root = await repository(t); await writeFile(path.join(root, "app.ts"), "export const a = 2;\n");
  const approve = await server(t);
  const ok = await run(root, approve.base, ["local", "--gate", "--output", "json"]);
  assert.equal(ok.code, 0, ok.stderr); assert.deepEqual(JSON.parse(ok.stdout).recommendation, { verdict: "approve", approved: true, reasons: [], blocking: 0, nits: 0 });
  const changes = await server(t, { terminal: () => ({ status: "completed", result: { ...clean().result, findings: [finding("medium")] } }) });
  const ch = await run(root, changes.base, ["local", "--gate"]);
  assert.equal(ch.code, 2, ch.stderr); assert.match(ch.stdout, /Recommendation: changes requested — 1 blocking finding/);
  const partial = await server(t, { terminal: () => ({ status: "partial", result: { complete: false, findings: [], local: { contextComplete: false, changedCoverageComplete: true } } }) });
  const none = await run(root, partial.base, ["local", "--gate", "--output", "json"]);
  assert.equal(none.code, 1); const data = JSON.parse(none.stdout);
  assert.equal(data.recommendation.verdict, "none"); assert.equal(data.recommendation.approved, false);
  // Without --gate the historical exit codes are unchanged: findings exit 0.
  const legacy = await run(root, changes.base, ["local"]);
  assert.equal(legacy.code, 0, legacy.stderr);
});

test("malformed terminal responses never render a clean review and exit nonzero", async t => {
  const root = await repository(t); await writeFile(path.join(root, "app.ts"), "export const a = 2;\n");
  for (const result of [{ complete: true, findings: "none" }, { complete: true, findings: [null] }, { complete: "yes", findings: [] }]) {
    const svc = await server(t, { terminal: () => ({ status: "completed", result }) });
    const text = await run(root, svc.base, ["local"]);
    assert.equal(text.code, 1, JSON.stringify(result)); assert.doesNotMatch(text.stdout, /No findings/); assert.match(text.stdout, /Recommendation: none \(not approval\) — malformed response/);
    const gated = await run(root, svc.base, ["local", "--gate", "--output", "json"]);
    assert.equal(gated.code, 1); assert.equal(JSON.parse(gated.stdout).recommendation.verdict, "none");
  }
  const noStatus = await server(t, { terminal: () => ({ status: 42 }) });
  const bad = await run(root, noStatus.base, ["local", "--gate"]);
  assert.equal(bad.code, 1); assert.match(bad.stderr, /malformed run/); assert.doesNotMatch(bad.stdout, /approve/);
  assert.ok(noStatus.calls.some(c => c.url.endsWith("/cancel")), "a malformed in-flight run is cancelled, not left running");
  const notJSON = await server(t, { terminal: () => "{not json" });
  const garbage = await run(root, notJSON.base, ["local", "--gate"]);
  assert.equal(garbage.code, 1); assert.doesNotMatch(garbage.stdout, /approve/);
});

test("a clean production-shaped receipt (findings: null) reports no findings and approves under --gate", async t => {
  const root = await repository(t); await writeFile(path.join(root, "app.ts"), "export const a = 2;\n");
  const svc = await server(t, { terminal: () => ({ status: "completed", result: { ...clean().result, findings: null } }) });
  const out = await run(root, svc.base, ["local", "--gate"]);
  assert.equal(out.code, 0, out.stderr); assert.match(out.stdout, /No findings in reviewed scope/); assert.match(out.stdout, /Recommendation: approve/);
  assert.doesNotMatch(out.stdout, /No review result is available/);
});

test("failed and cancelled runs are no recommendation even with findings attached", async t => {
  const root = await repository(t); await writeFile(path.join(root, "app.ts"), "export const a = 2;\n");
  for (const status of ["failed", "cancelled"]) {
    const svc = await server(t, { terminal: () => ({ status, error: "stopped", result: { complete: false, findings: [finding("high")] } }) });
    const out = await run(root, svc.base, ["local", "--gate", "--output", "json"]);
    assert.equal(out.code, 1, status); assert.equal(JSON.parse(out.stdout).recommendation.verdict, "none");
  }
});

test("a reuse or inheritance resolution failure blocks any recommendation at the CLI", async t => {
  const root = await repository(t); await writeFile(path.join(root, "app.ts"), "export const a = 2;\n");
  for (const extra of [{ reuse: { version: 1, status: "failed" } }, { inheritance: { status: "inherited" } }, { reuse: { version: 1, unfinished: [unfinished] } }]) {
    const svc = await server(t, { terminal: () => ({ status: "completed", result: { ...clean().result, findings: [finding("high")] }, ...extra }) });
    const out = await run(root, svc.base, ["local", "--gate", "--output", "json"]);
    assert.equal(out.code, 1, JSON.stringify(extra)); const rec = JSON.parse(out.stdout).recommendation;
    assert.equal(rec.verdict, "none"); assert.equal(rec.approved, false);
  }
});

test("a refused admission (the anchorRef HTTP 400) says nothing was admitted or approved", async t => {
  const root = await repository(t); await writeFile(path.join(root, "app.ts"), "export const a = 2;\n");
  // The exact production body shape (go-kit errs), with the backend fix's problem text.
  const problem = "This Ditto server does not accept the local review field \"anchorRef\". No review was admitted. Use a heyditto CLI release that matches this server.";
  const body = { fields: { snapshot: problem }, params: { field: "snapshot", problem }, message: "Check the local review input and try again.", code: "review_local_input", ref: "dbme2rnrfp5gaide20n0", action: "fix_input", status: 400 };
  const svc = await server(t, { admission: [400, body] });
  const out = await run(root, svc.base, ["local", "--gate"]);
  assert.equal(out.code, 1); assert.match(out.stderr, /refused the local review request \(HTTP 400 · review_local_input · dbme2rnrfp5gaide20n0 · This Ditto server does not accept the local review field "anchorRef"/);
  // Today's production body (before the backend fix) and older string-error bodies still report their reason.
  for (const [legacy, want] of [[{ message: "Check the local review input and try again.", code: "review_local_input", ref: "r1", status: 400 }, /review_local_input · r1 · Check the local review input/], [{ error: "snapshot contract mismatch" }, /snapshot contract mismatch/], [{ error: { code: "nested" } }, /HTTP 400 · nested/], [{ code: "permission_denied", error: { message: "Ask an organization manager" } }, /Ask an organization manager/]]) {
    const old = await server(t, { admission: [400, legacy] });
    const res = await run(root, old.base, ["local", "--gate"]);
    assert.equal(res.code, 1); assert.match(res.stderr, want); assert.doesNotMatch(res.stderr, /TypeError|slice is not a function/);
  }
  assert.match(out.stderr, /No review was admitted and nothing was approved/);
  assert.equal(svc.calls.filter(c => c.method === "POST").length, 1, "a refusal is never retried");
});

test("timeouts emit a JSON receipt that is never approval and cancel the admitted run", async t => {
  const root = await repository(t); await writeFile(path.join(root, "app.ts"), "export const a = 2;\n");
  const svc = await server(t, { terminal: () => ({ status: "running" }) });
  const out = await run(root, svc.base, ["local", "--timeout", "2", "--gate", "--output", "json"]);
  assert.equal(out.code, 124, out.stderr); const data = JSON.parse(out.stdout);
  assert.equal(data.recommendation.verdict, "none"); assert.match(data.recommendation.reasons[0], /timed out/);
  if (data.runId) assert.ok(svc.calls.some(c => c.url.endsWith("/cancel") && c.method === "POST"));
});

test("staged, unstaged and untracked selection reaches the upload exactly", async t => {
  const root = await repository(t);
  await writeFile(path.join(root, "app.ts"), "staged\n"); git(root, "add", "app.ts");
  await writeFile(path.join(root, "lib.ts"), "unstaged\n");
  await writeFile(path.join(root, "new.ts"), "untracked\n");
  const svc = await server(t);
  const staged = await run(root, svc.base, ["local", "--staged", "--output", "json"]);
  assert.equal(staged.code, 0, staged.stderr);
  const working = await run(root, svc.base, ["local", "--profile", "deep", "--output", "json"]);
  assert.equal(working.code, 0, working.stderr);
  const posts = svc.calls.filter(c => c.method === "POST" && c.url.endsWith("/local"));
  assert.deepEqual(posts[0].body.snapshot.changedPaths, ["app.ts"]); assert.equal(posts[0].body.snapshot.mode, "staged");
  assert.deepEqual(posts[1].body.snapshot.changedPaths, ["app.ts", "lib.ts", "new.ts"]); assert.equal(posts[1].body.snapshot.mode, "workspace");
  assert.equal(posts[1].body.profile, "deep");
  const bad = await run(root, svc.base, ["local", "--profile", "huge"]);
  assert.equal(bad.code, 1); assert.match(bad.stderr, /--profile must be quick, standard or deep/);
});

test("--gate refuses --preview and an empty selection is no recommendation", async t => {
  const root = await repository(t);
  const svc = await server(t);
  const empty = await run(root, svc.base, ["local", "--gate", "--output", "json"]);
  assert.equal(empty.code, 1, empty.stderr); const data = JSON.parse(empty.stdout);
  assert.equal(data.reason, "no_changes"); assert.equal(data.recommendation.verdict, "none");
  const legacy = await run(root, svc.base, ["local"]);
  assert.equal(legacy.code, 0, "without --gate an empty selection keeps its exit code");
  await writeFile(path.join(root, "app.ts"), "export const a = 2;\n");
  const preview = await run(root, svc.base, ["local", "--preview", "--gate"]);
  assert.equal(preview.code, 1); assert.match(preview.stderr, /--preview starts no review/);
  assert.equal(svc.calls.filter(c => c.method === "POST").length, 0);
});

test("a null admission or poll body is a clear error, never a TypeError", async t => {
  const root = await repository(t); await writeFile(path.join(root, "app.ts"), "export const a = 2;\n");
  const poll = await server(t, { terminal: () => "null" });
  const out = await run(root, poll.base, ["local", "--gate"]);
  assert.equal(out.code, 1); assert.match(out.stderr, /malformed run/); assert.doesNotMatch(out.stderr, /TypeError|Cannot read/);
  const admission = await server(t, { admission: [202, "null"] });
  const adm = await run(root, admission.base, ["local", "--gate"]);
  assert.equal(adm.code, 1); assert.match(adm.stderr, /no valid run ID/); assert.doesNotMatch(adm.stderr, /TypeError|Cannot read/);
});

test("local-status never approves (it cannot verify the working tree) and local-cancel reports JSON", async t => {
  const root = await repository(t);
  const svc = await server(t, { terminal: () => ({ status: "completed", result: clean().result }) });
  const status = await run(root, svc.base, ["local-status", RUN, "--gate", "--output", "json"]);
  assert.equal(status.code, 1, status.stderr); const rec = JSON.parse(status.stdout).recommendation;
  assert.equal(rec.verdict, "none"); assert.match(rec.reasons[0], /could not be verified/);
  const cancel = await run(root, svc.base, ["local-cancel", RUN, "--output", "json"]);
  assert.equal(cancel.code, 0, cancel.stderr); assert.equal(JSON.parse(cancel.stdout).status, "cancelled");
});
