/**
 * The local review recommendation: the one place that decides whether a
 * local review run may be read as approval.
 *
 * Fail closed. Only a clean, converged run in which every changed file was
 * reviewed on every lens with zero lens failures (including lenses that closed
 * cleanly in a findings-only final turn on wrap_up or max_rounds, DITTO-3103),
 * with a well-formed result, a verified current working tree, no blocking
 * finding, no unverified candidate, and no unresolved reuse or PR-inheritance
 * claim yields "approve". Bounded surrounding context and converged wrap_up /
 * max_rounds final turns are reported in reasons but do not block. A run with
 * blocking findings yields "changes" (findings are evidence even from a
 * partial run). Everything else, including failed, cancelled, timed-out,
 * malformed, lens-failed, budget/compression-abbreviated or undecided runs,
 * yields "none": no recommendation, and never approval.
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
const NIT_SEVERITIES = new Set(["low", "info", "nit"]);

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

/** Withheld reasons that are a decision about the candidate (ditto-review
 * internal/hosted triage.go / declined.go). Any other withheld candidate,
 * including verification_unavailable, candidate_limit,
 * file_evidence_unavailable, comment_limit, repeat_with_new_evidence and
 * reasons this client does not know, was never decided and blocks approval. */
const DECIDED_WITHHELD = new Set(["rejected_by_verifier", "below_confidence", "below_severity", "path_filtered", "documentation", "not_on_changed_line", "declined_earlier"]);

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

/**
 * How the linked issue's written scope bears on a local result
 * (DITTO-2434): "changes" for an unmet required item or a verdict
 * requesting changes, "unchecked" for a scope that was not fully checked
 * or is malformed, "none" when there is no scope result to apply.
 */
export function scopeOutcome(result: unknown): { kind: "changes" | "unchecked" | "none"; reason?: string; unmet: number } {
  if (!isObj(result)) return { kind: "none", unmet: 0 };
  const scope = isObj(result.scope) ? result.scope : undefined;
  const verdict = isObj(result.verdict) ? result.verdict : undefined;
  // An explicit request for changes stands even beside a malformed scope.
  if (verdict?.event === "REQUEST_CHANGES") {
    const items = scope?.status === "checked" && Array.isArray(scope.items) ? scope.items.filter(isObj) : [];
    const unmet = items.filter(i => i.required !== false && i.met !== true).length;
    return { kind: "changes", reason: unmet ? `${unmet} written requirement(s) of the linked issue are unmet` : "the review verdict requests changes", unmet };
  }
  // A checked scope carries a non-empty list of item objects (the engine
  // reports no_items otherwise); anything else is malformed, never approval.
  if (scope?.status === "checked" && !(Array.isArray(scope.items) && scope.items.length > 0 && scope.items.every(isObj))) return { kind: "unchecked", reason: "the linked issue's scope result is malformed (checked without a list of items)", unmet: 0 };
  const unmet = scope?.status === "checked" ? (scope.items as Obj[]).filter(i => i.required !== false && i.met !== true).length : 0;
  if (unmet) return { kind: "changes", reason: `${unmet} written requirement(s) of the linked issue are unmet`, unmet };
  if (scope && scope.status !== "checked" && scope.status !== "no_items") return { kind: "unchecked", reason: `the linked issue's written scope could not be checked (${typeof scope.status === "string" ? scope.status : "unknown"})`, unmet: 0 };
  return { kind: "none", unmet: 0 };
}

/** Abbreviated stop reasons where a lens ran its allotted window/round budget
 * and closed cleanly in its findings-only final turn (DITTO-3103). Any other
 * stop reason (budget, compression, empty_rounds, or a secondary lens failure)
 * remains incomplete and blocks approval. */
const CONVERGED_ABBREVIATED_REASONS = new Set(["wrap_up", "max_rounds"]);

export interface RecommendOptions {
  /** Whether the local snapshot skipped any changed path (computed by the CLI
   * from the captured snapshot). Used to fail closed when evaluating a legacy
   * partial receipt whose server did not yet distinguish converged wrap_up /
   * max_rounds runs from skipped changed files. */
  skippedChanged?: boolean;
}

function asList(v: unknown): unknown[] | undefined {
  return v === null ? [] : Array.isArray(v) ? v : undefined;
}

/** Verify per-file coverage across every lens. Returns ok=true only when every
 * lens finished with zero failed files and any abbreviated file closed via a
 * converged wrap_up or max_rounds final turn (never budget/compression/error). */
function checkCoverage(files: Obj | undefined): { ok: boolean; abbreviatedCount: number; reason?: string } {
  const abbreviated = files && "abbreviated" in files ? asList(files.abbreviated) : undefined;
  const failed = files && "failed" in files ? asList(files.failed) : undefined;
  if (!abbreviated || !failed) return { ok: false, abbreviatedCount: 0, reason: "the result has no per-file coverage report" };
  if (failed.length) return { ok: false, abbreviatedCount: abbreviated.length, reason: `${failed.length} changed file(s) were not reviewed by the primary lens` };
  const lenses = files && "lenses" in files ? asList(files.lenses) : undefined;
  if (lenses) {
    if (!lenses.every(isObj)) return { ok: false, abbreviatedCount: abbreviated.length, reason: "per-lens coverage report is malformed" };
    for (const lf of lenses) {
      const lfFailed = "failed" in lf ? asList(lf.failed) : undefined;
      if (!lfFailed) return { ok: false, abbreviatedCount: abbreviated.length, reason: "per-lens coverage report is missing failed files" };
      if (lfFailed.length) return { ok: false, abbreviatedCount: abbreviated.length, reason: `lens ${typeof lf.lens === "string" ? lf.lens : "unknown"} failed to review ${lfFailed.length} changed file(s)` };
    }
  }
  if (!lenses || !lenses.length) {
    if (!abbreviated.length) return { ok: true, abbreviatedCount: 0 };
    return { ok: false, abbreviatedCount: abbreviated.length, reason: `${abbreviated.length} changed file(s) were reviewed briefly without per-lens coverage details` };
  }
  const convergedPaths = new Set<string>();
  for (const lf of lenses as Obj[]) {
    const lfAbbr = "abbreviated" in lf ? asList(lf.abbreviated) : undefined;
    if (!lfAbbr) return { ok: false, abbreviatedCount: abbreviated.length, reason: "per-lens coverage report is missing abbreviated files" };
    for (const entry of lfAbbr) {
      if (!isObj(entry) || typeof entry.path !== "string" || typeof entry.reason !== "string" || !CONVERGED_ABBREVIATED_REASONS.has(entry.reason)) {
        return { ok: false, abbreviatedCount: Math.max(abbreviated.length, 1), reason: `changed file(s) stopped before converging (${isObj(entry) && typeof entry.reason === "string" ? entry.reason : "unknown"})` };
      }
      convergedPaths.add(entry.path);
    }
  }
  if (!abbreviated.length) return { ok: true, abbreviatedCount: convergedPaths.size };
  for (const entry of abbreviated) {
    if (!isObj(entry) || typeof entry.path !== "string" || !convergedPaths.has(entry.path)) {
      return { ok: false, abbreviatedCount: abbreviated.length, reason: `${abbreviated.length} changed file(s) were abbreviated for an unverified reason` };
    }
  }
  return { ok: true, abbreviatedCount: abbreviated.length };
}

/** Check whether a legacy partial receipt (from an engine before DITTO-3103)
 * represents a clean, converged wrap_up/max_rounds run where every other
 * completeness invariant holds. */
function convergedLegacyPartialReasons(run: LocalRunLike, result: Obj, cov: { ok: boolean; abbreviatedCount: number; reason?: string }, opts?: RecommendOptions): string[] {
  if (!Array.isArray(result.findings)) return ["run status is partial; only a completed run can approve"];
  if (result.tokenLimitReached === true) return ["token limit was reached before the review finished"];
  const manifest = isObj(result.coverage) ? result.coverage : undefined;
  if (!manifest || manifest.terminal_state !== "complete") return ["run status is partial; coverage did not reach terminal_state=complete"];
  const skipped = "skipped" in result && result.skipped !== undefined ? asList(result.skipped) : [];
  if (!skipped) return ["run status is partial; skipped file list is malformed"];
  const generated = new Set<string>();
  let nonGeneratedSkipped = 0;
  for (const s of skipped) {
    if (!isObj(s)) return ["run status is partial; skipped file list is malformed"];
    if (s.reason === "generated" && typeof s.path === "string") generated.add(s.path);
    else nonGeneratedSkipped++;
  }
  const innerCov = isObj(manifest.coverage) ? manifest.coverage : undefined;
  const waived = innerCov && "waived" in innerCov ? asList(innerCov.waived) : [];
  if (!waived) return ["run status is partial; waived file list is malformed"];
  for (const w of waived) {
    if (!isObj(w) || typeof w.path !== "string" || !generated.has(w.path)) {
      return ["run status is partial; non-generated file(s) were waived"];
    }
  }
  if (opts?.skippedChanged === true) return ["changed file(s) were skipped; cannot approve"];
  if (nonGeneratedSkipped > 0 && opts?.skippedChanged !== false) {
    return ["run status is partial; skipped files could not be verified as unchanged"];
  }
  if (!cov.ok) return [`run status is partial; ${cov.reason ?? "coverage is incomplete"}`];
  if (cov.abbreviatedCount === 0) return ["run status is partial; only a completed run can approve"];
  return [];
}

export function recommendLocalReview(run: LocalRunLike, opts?: RecommendOptions): Recommendation {
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
  // DITTO-2434: the linked issue's written scope (see scopeOutcome). It
  // applies to a completed or partial run, as findings do.
  if (status === "completed" || status === "partial") {
    const scoped = scopeOutcome(result);
    if (scoped.kind === "changes") return { verdict: "changes", approved: false, reasons: [scoped.reason!], blocking: scoped.unmet, nits: nitCount };
    if (scoped.kind === "unchecked") return none([scoped.reason!]);
  }
  if (status !== "completed" && status !== "partial") return none([`run status is ${status}; only a completed run can approve`]);
  if (!result) return none(["no review result is available"]);
  if (!findingsList(result)) return none(["result has no findings list; an absent list is not a clean review"]);
  const present = (v: unknown) => v !== undefined && v !== null && v !== "";
  if (present(run.error)) return none([`run error: ${typeof run.error === "string" ? run.error : JSON.stringify(run.error)}`]);
  if (present(result.error)) return none([`result error: ${typeof result.error === "string" ? result.error : JSON.stringify(result.error)}`]);
  const files = isObj(result.files) ? result.files : undefined;
  const cov = checkCoverage(files);
  const local = isObj(result.local) ? result.local : undefined;
  if (status === "partial") {
    if (!local || typeof local.changedCoverageComplete !== "boolean") return none(["run status is partial; only a completed run can approve"]);
    const legacyProblems = convergedLegacyPartialReasons(run, result, cov, opts);
    if (legacyProblems.length) return none(legacyProblems);
  } else {
    if (result.complete !== true) return none(["review coverage is incomplete (result.complete is not true)"]);
    if (!cov.ok) return none([cov.reason!]);
    if (!local || local.changedCoverageComplete !== true) return none(["changed paths were not fully reviewed"]);
  }
  // An undecided withheld candidate means a change was not fully judged. The
  // engine clears changedCoverageComplete for some (ditto-review#96); this
  // check is independent and allowlist-based.
  const held = (findingsList(result) ?? []).filter(f => f.status === "withheld" && !(typeof f.withheldReason === "string" && DECIDED_WITHHELD.has(f.withheldReason))).length;
  if (held) return none([`${held} withheld candidate finding(s) were not decided (unverified, over a limit, or an unknown reason)`]);
  if (cov.abbreviatedCount > 0) reasons.push(`${cov.abbreviatedCount} changed file(s) finished via wrap_up/max_rounds final turn`);
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
