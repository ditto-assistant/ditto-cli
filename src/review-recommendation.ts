/**
 * The local review recommendation: the one place that decides whether a
 * local review run may be read as approval.
 *
 * Fail closed. Only a completed run in which every changed file was fully
 * reviewed on every lens, with a well-formed result, a verified current
 * working tree, no blocking finding, no unverified candidate, and no
 * unresolved reuse or PR-inheritance claim yields "approve". Bounded
 * surrounding context is reported but does not block (DITTO-2455). A run with
 * blocking findings yields "changes" (findings are evidence even from a
 * partial run). Everything else, including failed, partial, cancelled,
 * timed-out, malformed or budget-exhausted runs, yields "none": no
 * recommendation, and never approval.
 */

export type Verdict = "approve" | "changes" | "none";

export interface Recommendation {
  verdict: Verdict;
  /** True only for verdict "approve". Kept explicit for scripts and agents. */
  approved: boolean;
  /** Why the verdict is what it is; always non-empty unless approved cleanly. */
  reasons: string[];
  blocking: number;
  nits: number;
}

/** Severities that block approval. Anything not listed as a nit blocks, so an
 * unknown or missing severity can never be read as clean. */
const NIT_SEVERITIES = new Set(["low", "info", "nit", "note", "trivial"]);

export interface LocalRunLike {
  status?: unknown;
  error?: unknown;
  workspaceCurrent?: boolean | null;
  reuse?: unknown;
  inheritance?: unknown;
  result?: unknown;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The findings list of a result, or undefined when there is no list. A
 * present JSON null is Go's nil-slice encoding of an empty list: production
 * engines (ditto-review before the foldSystemic fix) send it for every clean
 * review. An absent key is not a list. */
export function findingsList(result: unknown): Obj[] | undefined {
  if (!isObj(result) || !("findings" in result)) return undefined;
  if (result.findings === null) return [];
  return Array.isArray(result.findings) && result.findings.every(isObj) ? result.findings as Obj[] : undefined;
}

/** Shape problems in a terminal run that make its result unusable as evidence.
 * Returns an empty list when the run is well formed. */
export function malformedLocalRun(run: LocalRunLike): string[] {
  const problems: string[] = [];
  if (typeof run.status !== "string") problems.push("status is not a string");
  if (run.result === undefined || run.result === null) return problems;
  if (!isObj(run.result)) { problems.push("result is not an object"); return problems; }
  const r = run.result;
  if (r.complete !== undefined && typeof r.complete !== "boolean") problems.push("result.complete is not a boolean");
  if (r.findings !== undefined && r.findings !== null) {
    if (!Array.isArray(r.findings)) problems.push("result.findings is not an array");
    else if (r.findings.some(f => !isObj(f))) problems.push("result.findings contains a non-object entry");
  }
  if (r.local !== undefined && r.local !== null && !isObj(r.local)) problems.push("result.local is not an object");
  return problems;
}

/** Reuse receipts (DITTO-1502) and PR inheritance (DITTO-1547) are hard
 * gates: a recommendation is only produced when every claimed reuse or
 * inheritance resolved, and this client can verify that it did. */
export function reuseAndInheritanceProblems(run: LocalRunLike): string[] {
  const problems: string[] = [];
  const result = isObj(run.result) ? run.result : {};
  const receipts: [string, unknown][] = [["reuse", run.reuse], ["result.reuse", result.reuse]];
  const present = receipts.filter(([, v]) => v !== undefined && v !== null);
  for (const [where, value] of present) {
    if (!isObj(value)) { problems.push(`${where} is not an object; reuse resolution cannot be verified`); continue; }
    if (value.version !== 1) problems.push(`${where} has unsupported version ${JSON.stringify(value.version)}; reuse resolution cannot be verified`);
    if (value.error !== undefined && value.error !== null && value.error !== "") problems.push(`${where} reports a resolution error: ${String(value.error)}`);
    for (const key of ["status", "resolution"]) {
      const s = value[key];
      if (s !== undefined && s !== "resolved" && s !== "verified") problems.push(`${where}.${key} is ${JSON.stringify(s)}, not resolved`);
    }
    // null is Go's encoding of an empty list, as for findings.
    if (value.unfinished !== undefined && value.unfinished !== null && !Array.isArray(value.unfinished)) problems.push(`${where}.unfinished is not an array`);
    else if (Array.isArray(value.unfinished) && value.unfinished.length) problems.push(`${where} has ${value.unfinished.length} unfinished work unit(s)`);
  }
  // Two copies of the receipt must not disagree: a clear alias must not hide
  // unfinished work in the other one.
  if (present.length === 2 && canonical(present[0][1]) !== canonical(present[1][1])) problems.push("reuse and result.reuse disagree; reuse resolution cannot be verified");
  for (const [where, value] of [["inheritance", run.inheritance], ["result.inheritance", result.inheritance]] as const) {
    if (value === undefined || value === null) continue;
    // No server contract for inherited local receipts exists in this client
    // yet. Any claim of inheritance is therefore unverifiable here, and an
    // unverifiable gate fails closed rather than being ignored.
    problems.push(`${where} is present but this CLI cannot verify PR inheritance; upgrade @heyditto/cli`);
  }
  return problems;
}

/** The engine's statuses for candidates it did not post (ditto-review
 * internal/hosted: "withheld" after verification, "duplicate" when folded). */
const UNPOSTED_STATUSES = new Set(["withheld", "duplicate"]);

/** Withheld reasons meaning a candidate on a change was never verified. */
const HELD_UNVERIFIED = new Set(["verification_unavailable", "candidate_limit", "file_evidence_unavailable"]);

/** A finding counts unless the engine explicitly withheld or deduplicated it.
 * Any other status, including a missing, empty or unrecognized one, counts, so
 * a blocking finding can never hide from the gate. */
export function isVisibleFinding(f: Obj): boolean {
  return !(typeof f.status === "string" && UNPOSTED_STATUSES.has(f.status));
}

/** JSON with object keys sorted, so equal receipts compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObj(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function visibleFindings(result: Obj): Obj[] {
  return (findingsList(result) ?? []).filter(isVisibleFinding);
}

export function recommendLocalReview(run: LocalRunLike): Recommendation {
  const reasons: string[] = [];
  let nitCount = 0;
  const none = (extra: string[] = []): Recommendation => ({ verdict: "none", approved: false, reasons: [...reasons, ...extra], blocking: 0, nits: nitCount });
  const malformed = malformedLocalRun(run);
  if (malformed.length) return none(malformed.map(p => `malformed response: ${p}`));
  const gate = reuseAndInheritanceProblems(run);
  if (gate.length) return none(gate);
  const status = run.status as string;
  const result = isObj(run.result) ? run.result : undefined;
  // Findings are evidence even when coverage was bounded, so a partial run
  // with blocking findings is CHANGES. Failed and cancelled runs present no
  // usable result at all.
  if (result && findingsList(result) && (status === "completed" || status === "partial")) {
    const findings = visibleFindings(result);
    // A non-string severity is unknown, and unknown blocks.
    const blocking = findings.filter(f => !(typeof f.severity === "string" && NIT_SEVERITIES.has(f.severity.toLowerCase()))).length;
    const nits = findings.length - blocking;
    if (blocking) return { verdict: "changes", approved: false, reasons: [`${blocking} blocking finding(s)`], blocking, nits };
    nitCount = nits;
    reasons.push(...(nits ? [`${nits} non-blocking finding(s)`] : []));
  }
  if (status !== "completed") return none([`run status is ${status}; only a completed run can approve`]);
  if (!result) return none(["no review result is available"]);
  if (result.complete !== true) return none(["review coverage is incomplete (result.complete is not true)"]);
  if (!findingsList(result)) return none(["result has no findings list; an absent list is not a clean review"]);
  const present = (v: unknown) => v !== undefined && v !== null && v !== "";
  if (present(run.error)) return none([`run error: ${typeof run.error === "string" ? run.error : JSON.stringify(run.error)}`]);
  if (present(result.error)) return none([`result error: ${typeof result.error === "string" ? result.error : JSON.stringify(result.error)}`]);
  // Every lens must finish every changed file. Local reviews only review the
  // changed paths, so any abbreviated or failed entry is unfinished changed
  // work (production run b14c5978 abbreviated its main file yet reported
  // changed coverage complete). A missing coverage report is not complete.
  const files = isObj(result.files) ? result.files : undefined;
  if (!files || !Array.isArray(files.abbreviated) || !Array.isArray(files.failed)) return none(["the result has no per-file coverage report"]);
  if (files.abbreviated.length || files.failed.length) return none([`${files.abbreviated.length + files.failed.length} changed file(s) were reviewed briefly or not reviewed by every lens`]);
  // Local receipts always carry both flags; anything but true is incomplete.
  const local = isObj(result.local) ? result.local : {};
  if (local.changedCoverageComplete !== true) return none(["changed paths were not fully reviewed"]);
  // Held candidates mean a change was not verified. The engine already clears
  // changedCoverageComplete for these (ditto-review#96); check independently.
  const held = (findingsList(result) ?? []).filter(f => typeof f.withheldReason === "string" && HELD_UNVERIFIED.has(f.withheldReason)).length;
  if (held) return none([`${held} candidate finding(s) could not be verified`]);
  // DITTO-2455 (owner decision): a local review is complete once every change
  // is fully reviewed, even when surrounding context is bounded. Bounded
  // context is reported, never treated as approval-blocking.
  if (local.contextComplete !== true) reasons.push("surrounding context was bounded; omitted files were not reviewed");
  if (run.workspaceCurrent !== true) return none([run.workspaceCurrent === false ? "the working tree changed after capture" : "the current working tree could not be verified against the reviewed snapshot"]);
  const nits = visibleFindings(result).length;
  return { verdict: "approve", approved: true, reasons, blocking: 0, nits };
}

/** Exit code under --gate: 0 approve, 2 changes, 1 no recommendation. */
export function gateExitCode(rec: Recommendation): number {
  return rec.verdict === "approve" ? 0 : rec.verdict === "changes" ? 2 : 1;
}

export function formatRecommendation(rec: Recommendation): string {
  const head = rec.verdict === "approve" ? "Recommendation: approve" : rec.verdict === "changes" ? "Recommendation: changes requested" : "Recommendation: none (not approval)";
  return `${head}${rec.reasons.length ? ` — ${rec.reasons.join("; ")}` : ""}\n`;
}
