/**
 * The local review recommendation: the one place that decides whether a
 * local review run may be read as approval.
 *
 * Fail closed. Only a completed run with complete coverage, a well-formed
 * result, a verified current working tree, no blocking finding, and no
 * unresolved reuse or PR-inheritance claim yields "approve". A run with
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
    if (value.unfinished !== undefined && !Array.isArray(value.unfinished)) problems.push(`${where}.unfinished is not an array`);
    else if (Array.isArray(value.unfinished) && value.unfinished.length) problems.push(`${where} has ${value.unfinished.length} unfinished work unit(s)`);
  }
  // Two copies of the receipt must not disagree: a clear alias must not hide
  // unfinished work in the other one.
  if (present.length === 2 && JSON.stringify(present[0][1]) !== JSON.stringify(present[1][1])) problems.push("reuse and result.reuse disagree; reuse resolution cannot be verified");
  for (const [where, value] of [["inheritance", run.inheritance], ["result.inheritance", result.inheritance]] as const) {
    if (value === undefined || value === null) continue;
    // No server contract for inherited local receipts exists in this client
    // yet. Any claim of inheritance is therefore unverifiable here, and an
    // unverifiable gate fails closed rather than being ignored.
    problems.push(`${where} is present but this CLI cannot verify PR inheritance; upgrade @heyditto/cli`);
  }
  return problems;
}

function visibleFindings(result: Obj): Obj[] {
  const findings = findingsList(result) ?? [];
  return findings.filter(f => f.status === undefined || f.status === "posted");
}

export function recommendLocalReview(run: LocalRunLike): Recommendation {
  const reasons: string[] = [];
  const none = (extra: string[] = []): Recommendation => ({ verdict: "none", approved: false, reasons: [...reasons, ...extra], blocking: 0, nits: 0 });
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
    const blocking = findings.filter(f => !NIT_SEVERITIES.has(String(f.severity ?? "").toLowerCase())).length;
    const nits = findings.length - blocking;
    if (blocking) return { verdict: "changes", approved: false, reasons: [`${blocking} blocking finding(s)`], blocking, nits };
    reasons.push(...(nits ? [`${nits} non-blocking finding(s)`] : []));
  }
  if (status !== "completed") return none([`run status is ${status}; only a completed run can approve`]);
  if (!result) return none(["no review result is available"]);
  if (result.complete !== true) return none(["review coverage is incomplete (result.complete is not true)"]);
  if (!findingsList(result)) return none(["result has no findings list; an absent list is not a clean review"]);
  if (typeof run.error === "string" && run.error) return none([`run error: ${run.error}`]);
  if (typeof result.error === "string" && result.error) return none([`result error: ${result.error}`]);
  const local = isObj(result.local) ? result.local : {};
  if (local.changedCoverageComplete === false) return none(["changed paths were not fully reviewed"]);
  if (local.contextComplete === false) return none(["surrounding context was bounded"]);
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
