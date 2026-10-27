import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Command, Option } from "commander";
import { ApiError, apiFetch, type Company, resolveCompany } from "./api.js";
import { registerReviewFindingCommands } from "./review-findings.js";
import { readStoredAuth } from "./store.js";
import { captureReviewSnapshot, reviewGit } from "./review-snapshot.js";

/**
 * Ditto Review repository settings: the developer console's Review →
 * Repository settings page, from the shell.
 *
 * The server replaces a repository's settings wholesale on save, so `set`
 * reads the repository, applies only the flags given and sends the whole row
 * back with the revision it read. A tab or another agent that saved in
 * between makes the server refuse the write (409) instead of having its
 * change rolled back silently.
 */

/** One repository as `GET /api/v5/review` lists it. */
export interface ReviewSkipRules {
  headBranches?: string[];
  baseBranches?: string[];
  titles?: string[];
  authors?: string[];
  labels?: string[];
  bots?: boolean;
}

export interface ReviewRepository {
  skipRules?: ReviewSkipRules;
  id: string;
  fullName: string;
  endpointId: string;
  revision: number;
  enabled: boolean;
  verify: boolean;
  reviewDrafts: boolean;
  postSummary: boolean;
  autofixCi: boolean;
  allowFixCommand: boolean;
  resolveFixedThreads: boolean;
  reviewVerdicts: boolean;
  blockingSeverity: string;
  instructions: string;
  mode: string;
  trigger: string;
  minSeverity: string;
  pathFilters: string[] | null;
  pathInstructions: unknown[] | null;
  budgetCents: number;
  maxMinutes: number;
  minConfidence: number;
  maxComments: number;
  autofixMaxPushes: number;
  monthlyBudgetUsd: number | null;
  /** Fast mode: the review runs on GLM-5.3-FlashX (backend#3351). Absent from older backends. */
  fastMode?: boolean;
  lastError?: string;
}

interface ScopeOptions {
  org?: string;
  output?: string;
}

interface SetOptions extends ScopeOptions {
  skipRulesFile?: string;
  clearSkipRules?: boolean;
  maxMinutes?: string;
  budgetCents?: string;
  enabled?: string;
  fast?: string;
}

/** The server's bounds (backend reviewLimits). */
const MIN_MAX_MINUTES = 5;
const MAX_MAX_MINUTES = 45;
const MAX_BUDGET_CENTS = 10_000;

function isJSON(options: { output?: string }): boolean {
  return options.output === "json" || options.output === "raw";
}

async function resolveScope(options: ScopeOptions): Promise<Company | undefined> {
  const wanted = options.org?.trim() || (await readStoredAuth())?.defaultCompany;
  if (!wanted) return undefined;
  return resolveCompany(wanted);
}

function scopeQuery(company: Company | undefined): string {
  return company ? `?company=${encodeURIComponent(company.id)}` : "";
}

export async function listReviewRepositories(company: Company | undefined): Promise<ReviewRepository[]> {
  const out = await apiFetch<{ repositories?: ReviewRepository[] }>(`/api/v5/review${scopeQuery(company)}`);
  return out.repositories ?? [];
}

export interface ReviewRun {
  id: string;
  repositoryId: string;
  prNumber: number;
  status: string;
  headSha: string;
  attempts: number;
  reviewUrl?: string;
  error?: string;
  cancelRequested?: boolean;
  chargedCredits?: number;
  creditsPerDollar?: number;
  summary?: unknown;
}

interface ReviewList {
  repositories: ReviewRepository[];
  runs: ReviewRun[];
}

interface ReviewDetail {
  run: ReviewRun;
  repository: ReviewRepository;
  result?: unknown;
  attempts?: unknown[];
}

interface WatchOptions extends ScopeOptions {
  interval?: string;
  timeout?: string;
  watch?: boolean;
}

interface LocalOptions extends ScopeOptions {
  staged?: boolean;
  base?: string;
  profile?: string;
  contextFile?: string;
  repository?: string;
  directory?: string;
  preview?: boolean;
  timeout?: string;
  requestId?: string;
}

interface LocalRun {
  runId: string;
  status: string;
  profile: string;
  snapshotDigest: string;
  budgetCents: number;
  maxSeconds: number;
  chargedCredits?: number;
  creditsPerDollar?: number;
  error?: string;
  workspaceCurrent?: boolean | null;
  workspaceCurrentReason?: string;
  result?: {
    complete?: boolean;
    error?: string;
    costUsd?: number;
    findings?: { status?: string; severity?: string; path?: string; line?: number; startLine?: number; title?: string; body?: string; explanation?: string }[];
    local?: { changedCoverageComplete?: boolean; contextComplete?: boolean; [key: string]: unknown };
    [key: string]: unknown;
  };
}

function repositoryFromRemote(remote: string): string {
  const match = /^(?:git@github\.com:|https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!match) throw new Error("cannot identify a GitHub repository from origin; pass --repository <owner/name>");
  return match[1];
}

function printLocalRun(run: LocalRun, options: LocalOptions): void {
  if (isJSON(options)) return writeJSON(run);
  const result = run.result;
  process.stdout.write(`Local review ${run.status} · ${run.profile}\nRun: ${run.runId}\nSnapshot: ${run.snapshotDigest}\n`);
  const findings = result?.findings?.filter(f => !f.status || f.status === "posted") ?? [];
  const reportable = result && (Array.isArray(result.findings) || result.complete === true) && ["completed", "partial"].includes(run.status);
  if (reportable) {
    process.stdout.write(`${findings.length ? `${findings.length} finding${findings.length === 1 ? "" : "s"} in reviewed scope` : "No findings in reviewed scope"}\n`);
    for (const f of findings) process.stdout.write(`\n${f.severity ?? "finding"} · ${f.path ?? ""}:${f.line ?? f.startLine ?? ""} · ${f.title ?? ""}\n${f.body ?? f.explanation ?? ""}\n`);
  } else process.stdout.write("No review result is available for this run.\n");
  if (!result?.complete || run.status !== "completed") process.stdout.write("Review incomplete; check coverage and errors before relying on this result.\n");
  if (result?.local?.contextComplete === false) process.stdout.write("Surrounding context was bounded; omitted files were not reviewed.\n");
  if (run.workspaceCurrent === false) process.stdout.write("The working tree changed after capture; these findings describe the saved snapshot.\n");
  if (run.workspaceCurrent === null) process.stdout.write("Current working-tree identity could not be checked; these findings describe the saved snapshot.\n");
  process.stdout.write(`Limits: ${run.maxSeconds}s, ${money(run.budgetCents)} maximum inference budget\n`);
  if (run.chargedCredits !== undefined) process.stdout.write(`Charged: ${run.chargedCredits} credits${run.creditsPerDollar ? ` (${run.creditsPerDollar} credits/USD)` : ""}\n`);
  if (run.error || result?.error) process.stdout.write(`Error: ${run.error || result?.error}\n`);
}

async function pollLocalRun(route: string, signal: AbortSignal): Promise<LocalRun> {
  for (let attempt = 0; ; attempt++) {
    try { return await apiFetch<LocalRun>(route, { signal }); }
    catch (error) {
      const transient = error instanceof TypeError || (error instanceof ApiError && (error.status >= 500 || [408, 429].includes(error.status)));
      if (!transient || signal.aborted || attempt === 2) throw error;
      process.stderr.write("Review status is temporarily unavailable; retrying the read.\n");
      await delay(500 * (attempt + 1), undefined, { signal });
    }
  }
}

export async function cmdReviewLocal(options: LocalOptions): Promise<void> {
  if (options.staged && options.base) throw new Error("--staged and --base cannot be used together");
  const profile = options.profile ?? "quick";
  if (!["quick", "standard", "deep"].includes(profile)) throw new Error("--profile must be quick, standard or deep");
  if (options.requestId) { try { runPath(options.requestId); } catch { throw new Error("--request-id must be a UUID"); } }
  const timeout = intFlag("--timeout", options.timeout ?? "1200", 1, 1800) * 1000;
  const context = options.contextFile ? new TextDecoder("utf-8", { fatal: true }).decode(await readFile(options.contextFile)) : undefined;
  if (context && (Buffer.byteLength(context) > 16000 || context.includes("\0"))) throw new Error("--context-file must contain at most 16000 UTF-8 bytes without NUL characters");
  // Preview deliberately has no auth or network dependency.
  const company = options.preview ? undefined : await resolveScope(options);
  const repos = options.preview ? [] : await listReviewRepositories(company);
  const controller = new AbortController();
  let interrupted = 0, timedOut = false, runId: string | undefined, posted = false, capturedRoot: string | undefined;
  const interrupt = (signal: NodeJS.Signals) => { interrupted = signal === "SIGTERM" ? 143 : 130; controller.abort(); };
  const onInt = () => interrupt("SIGINT"), onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  const requestId = options.requestId?.toLowerCase() ?? randomUUID();
  const recovery = (): string => {
    const args = ["heyditto", "review", "local", "--request-id", requestId, "--profile", profile];
    if (capturedRoot) args.push("--directory", capturedRoot);
    if (options.staged) args.push("--staged");
    if (options.base) args.push("--base", options.base);
    if (options.contextFile) args.push("--context-file", path.resolve(options.contextFile));
    if (options.repository) args.push("--repository", options.repository);
    if (company) args.push("--org", company.id);
    return args.map(arg => /^[a-zA-Z0-9_./:=@-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'").join(" ");
  };
  try {
    const captured = await captureReviewSnapshot({ staged: options.staged, base: options.base, cwd: options.directory, signal: controller.signal });
    capturedRoot = captured.root;
    const { snapshot } = captured;
    const preview = {
      requestId, profile, snapshotDigest: snapshot.digest, mode: snapshot.mode, baseSha: snapshot.baseSha,
      changedPaths: snapshot.changedPaths, baseFileCount: snapshot.baseFiles.length, headFileCount: snapshot.headFiles.length,
      contentBytes: captured.bytes, payloadBytes: Buffer.byteLength(JSON.stringify({ requestId, snapshot, profile, context })),
      contextComplete: snapshot.contextComplete, omittedContext: snapshot.omittedContext, skipped: snapshot.skipped,
    };
    if (options.preview) {
      if (isJSON(options)) return writeJSON(preview);
      process.stdout.write(`Local review preview · ${profile}\nSnapshot: ${snapshot.digest}\nSelected changes: ${snapshot.changedPaths.length}\nContext files: ${snapshot.headFiles.length} (${captured.bytes} decoded bytes; ${preview.payloadBytes} payload bytes)\n`);
      for (const file of snapshot.changedPaths) process.stdout.write(`  ${file}\n`);
      process.stdout.write(`Omitted context: ${snapshot.omittedContext.length}; skipped files: ${snapshot.skipped.length}\nNo source uploaded; no review started.\n`);
      return;
    }
    if (!snapshot.changedPaths.length) {
      const empty = { status: "skipped", reason: "no_changes", snapshotDigest: snapshot.digest, changedPaths: [] };
      if (isJSON(options)) writeJSON(empty); else process.stdout.write("No working-diff changes to review.\n");
      return;
    }
    const fullName = options.repository ?? repositoryFromRemote((await reviewGit(captured.root, ["remote", "get-url", "origin"], undefined, controller.signal)).toString("utf8"));
    const repo = repos.find(r => r.fullName.toLowerCase() === fullName.toLowerCase());
    if (!repo) throw new Error(`${fullName} is not set up in this workspace; see heyditto review repos${options.org ? ` --org ${options.org}` : ""}`);
    process.stderr.write(`Uploading ${snapshot.changedPaths.length} changed paths with ${snapshot.headFiles.length} context files (${preview.payloadBytes} bytes) for ${profile} review; omitted context: ${snapshot.omittedContext.length}.\nRequest: ${requestId}\n`);
    if (controller.signal.aborted) throw controller.signal.reason;
    posted = true;
    // Complete the admission response even on Ctrl-C so a returned run can be
    // cancelled. An uncertain POST is never retried automatically.
    let run = await apiFetch<LocalRun>(`/api/v5/review/repositories/${encodeURIComponent(repo.id)}/local${scopeQuery(company)}`, {
      method: "POST", body: { requestId, snapshot, profile, ...(context ? { context } : {}) }, signal: AbortSignal.timeout(30000),
    });
    try { runPath(run.runId); } catch { throw new Error("Review API returned no valid run ID"); }
    runId = run.runId;
    process.stderr.write(`Local review run: ${runId}\n`);
    const route = `/api/v5/review/local/runs/${encodeURIComponent(runId)}`;
    let prior = "";
    for (;;) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (run.status !== prior) { process.stderr.write(`Local review: ${run.status}\n`); prior = run.status; }
      if (TERMINAL_REVIEW_STATUSES.has(run.status)) {
        if (run.snapshotDigest !== snapshot.digest) throw new Error("Review API returned a result for a different snapshot");
        clearTimeout(timer);
        try {
          const current = await captureReviewSnapshot({ staged: options.staged, base: options.base, cwd: captured.root, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
          run.workspaceCurrent = current.snapshot.digest === snapshot.digest;
        } catch { run.workspaceCurrent = null; run.workspaceCurrentReason = "Snapshot could not be recaptured"; }
        printLocalRun(run, options);
        if (interrupted) process.exitCode = interrupted;
        else if (["failed", "cancelled", "partial"].includes(run.status) || (run.status === "completed" && run.result?.complete !== true)) process.exitCode = 1;
        return;
      }
      if (!ACTIVE_REVIEW_STATUSES.has(run.status)) throw new Error(`unknown local review status: ${run.status}`);
      await delay(500, undefined, { signal: controller.signal });
      run = await pollLocalRun(`${route}${scopeQuery(company)}`, controller.signal);
    }
  } catch (error) {
    if (runId) {
      try {
        await apiFetch(`/api/v5/review/local/runs/${encodeURIComponent(runId)}/cancel${scopeQuery(company)}`, { method: "POST", signal: AbortSignal.timeout(5000) });
        process.stderr.write(`Cancellation requested for ${runId}.\n`);
      } catch { process.stderr.write(`Could not confirm cancellation of ${runId}; use heyditto review local-status ${runId}${options.org ? ` --org ${options.org}` : ""} to inspect it.\n`); }
    }
    if (interrupted || timedOut) {
      process.stderr.write(`${timedOut ? "Local review timed out" : "Local review interrupted"}${runId ? ` (run ${runId})` : posted ? `; admission outcome is unknown (request ${requestId})` : ""}.\n`);
      if (posted && !runId) process.stderr.write(`Recover the same admission: ${recovery()}\nChanged source, profile or context is refused; no automatic retry was made.\n`);
      process.exitCode = interrupted || 124;
      return;
    }
    if (posted && !runId && error instanceof ApiError && error.status >= 400 && error.status < 500) {
      if (error.status === 404) throw new Error("The local review endpoint is unavailable on this Ditto backend; no local review was admitted.");
      throw error;
    }
    if (posted && !runId) throw new Error(`${error instanceof Error ? error.message : String(error)}\nAdmission outcome is unknown; request ${requestId}.\nRecover the same admission: ${recovery()}\nChanged source, profile or context is refused; no automatic retry was made.`);
    throw error;
  } finally {
    clearTimeout(timer); process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm);
  }
}

export async function cmdReviewLocalStatus(id: string, options: ScopeOptions): Promise<void> {
  runPath(id);
  const company = await resolveScope(options);
  const run = await apiFetch<LocalRun>(`/api/v5/review/local/runs/${encodeURIComponent(id)}${scopeQuery(company)}`);
  run.workspaceCurrent = null;
  run.workspaceCurrentReason = "Status reads do not recapture a local checkout";
  printLocalRun(run, options);
}

export async function cmdReviewLocalCancel(id: string, options: ScopeOptions): Promise<void> {
  runPath(id);
  const company = await resolveScope(options);
  const result = await apiFetch(`/api/v5/review/local/runs/${encodeURIComponent(id)}/cancel${scopeQuery(company)}`, { method: "POST" });
  if (isJSON(options)) writeJSON(result); else process.stdout.write(`Cancellation requested for local review ${id}.\n`);
}

const TERMINAL_REVIEW_STATUSES = new Set(["completed", "partial", "failed", "cancelled", "skipped", "superseded"]);
const ACTIVE_REVIEW_STATUSES = new Set(["queued", "running", "publishing"]);

function runPath(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("run id must be a UUID (see `heyditto review runs`)");
  }
  return `/api/v5/review/runs/${encodeURIComponent(id)}`;
}

async function findReviewRepository(fullName: string, company: Company | undefined): Promise<ReviewRepository> {
  const repos = await listReviewRepositories(company);
  const repo = repos.find((r) => r.fullName.toLowerCase() === fullName.trim().toLowerCase());
  if (!repo) throw new Error(`${fullName} is not set up in this workspace (see \`heyditto review repos --org <organization>\`).`);
  return repo;
}

function writeJSON(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printRun(detail: ReviewDetail, options: ScopeOptions): void {
  if (isJSON(options)) return writeJSON(detail);
  const r = detail.run;
  process.stdout.write(`${detail.repository.fullName} #${r.prNumber}: ${r.status}${r.cancelRequested ? " (cancellation requested)" : ""}\n`);
  process.stdout.write(`Run: ${r.id}\nHead: ${r.headSha}\n`);
  if (r.reviewUrl) process.stdout.write(`Review: ${r.reviewUrl}\n`);
  if (r.summary) process.stdout.write(`Summary: ${JSON.stringify(r.summary)}\n`);
  if (r.error) process.stdout.write(`Error: ${r.error}\n`);
}

export async function cmdReviewRuns(fullName: string | undefined, options: ScopeOptions): Promise<void> {
  const company = await resolveScope(options);
  const out = await apiFetch<ReviewList>(`/api/v5/review${scopeQuery(company)}`);
  let runs = out.runs ?? [];
  if (fullName) {
    const repo = out.repositories.find((r) => r.fullName.toLowerCase() === fullName.trim().toLowerCase());
    if (!repo) throw new Error(`${fullName} is not set up in this workspace`);
    runs = runs.filter((r) => r.repositoryId === repo.id);
  }
  if (isJSON(options)) return writeJSON({ runs });
  const names = new Map(out.repositories.map((r) => [r.id, r.fullName]));
  if (!runs.length) process.stdout.write("No recent review runs in this workspace.\n");
  for (const r of runs) process.stdout.write(`${r.id}  ${r.status}  ${names.get(r.repositoryId) ?? r.repositoryId} #${r.prNumber}  ${r.headSha.slice(0, 7)}\n`);
}

export async function cmdReviewPulls(fullName: string, options: ScopeOptions): Promise<void> {
  const company = await resolveScope(options);
  const repo = await findReviewRepository(fullName, company);
  const out = await apiFetch<{ pulls: { number: number; title: string; draft: boolean; url: string }[] }>(
    `/api/v5/review/repositories/${encodeURIComponent(repo.id)}/pulls${scopeQuery(company)}`,
  );
  if (isJSON(options)) return writeJSON(out);
  if (!out.pulls.length) process.stdout.write(`No open pull requests in ${repo.fullName}.\n`);
  for (const p of out.pulls) process.stdout.write(`#${p.number}${p.draft ? " (draft)" : ""}  ${p.title}\n  ${p.url}\n`);
}

export async function cmdReviewStatus(id: string, options: ScopeOptions): Promise<void> {
  const route = runPath(id);
  const company = await resolveScope(options);
  printRun(await apiFetch<ReviewDetail>(`${route}${scopeQuery(company)}`), options);
}

function watchLimits(options: WatchOptions): { intervalMs: number; timeoutMs: number } {
  return {
    intervalMs: intFlag("--interval", options.interval ?? "10", 1, 60) * 1000,
    timeoutMs: intFlag("--timeout", options.timeout ?? "3600", 1, 86400) * 1000,
  };
}

async function watchReview(id: string, company: Company | undefined, options: WatchOptions): Promise<void> {
  const route = runPath(id);
  const { intervalMs, timeoutMs } = watchLimits(options);
  const deadline = performance.now() + timeoutMs;
  let prior = "";
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error(`timed out waiting for review ${id}; the review continues on the server`);
    let detail: ReviewDetail;
    try {
      detail = await apiFetch<ReviewDetail>(`${route}${scopeQuery(company)}`, { signal: AbortSignal.timeout(Math.ceil(remaining)) });
    } catch (error) {
      if (performance.now() >= deadline) throw new Error(`timed out waiting for review ${id}; the review continues on the server`);
      throw error;
    }
    const status = detail.run.status;
    if (status !== prior) {
      process.stderr.write(`Review ${id}: ${status}\n`);
      prior = status;
    }
    if (TERMINAL_REVIEW_STATUSES.has(status)) {
      printRun(detail, options);
      if (status === "failed") process.exitCode = 1;
      return;
    }
    if (!ACTIVE_REVIEW_STATUSES.has(status)) throw new Error(`unknown review status: ${status}`);
    await delay(Math.max(1, Math.min(intervalMs, deadline - performance.now())));
  }
}

export async function cmdReviewWatch(id: string, options: WatchOptions): Promise<void> {
  runPath(id);
  watchLimits(options);
  const company = await resolveScope(options);
  await watchReview(id, company, options);
}

export async function cmdReviewStart(fullName: string, prNumber: string, options: WatchOptions): Promise<void> {
  const number = intFlag("pr-number", prNumber, 1, 2_147_483_647);
  if (options.watch) watchLimits(options);
  const company = await resolveScope(options);
  const repo = await findReviewRepository(fullName, company);
  const out = await apiFetch<{ runId: string; status: string; alreadyReviewed?: unknown }>(
    `/api/v5/review/repositories/${encodeURIComponent(repo.id)}/pulls/${number}/review${scopeQuery(company)}`,
    { method: "POST" },
  );
  if (options.watch) {
    process.stderr.write(`Review requested for ${repo.fullName} #${number}: ${out.runId}\n`);
    if (out.alreadyReviewed) process.stderr.write("This head was already reviewed; this request starts a new attempt within the repository's budget.\n");
    return watchReview(out.runId, company, options);
  }
  if (isJSON(options)) return writeJSON(out);
  process.stdout.write(`${repo.fullName} #${number}: ${out.status}\nRun: ${out.runId}\n`);
  if (out.alreadyReviewed) process.stdout.write("This head was already reviewed; a new attempt was requested.\n");
}

export async function cmdReviewAction(id: string, action: "retry" | "cancel", options: ScopeOptions): Promise<void> {
  const route = runPath(id);
  const company = await resolveScope(options);
  const out = await apiFetch<{ status: string; cancelRequested?: boolean; reusedResult?: boolean; watchCancelled?: boolean }>(
    `${route}/${action}${scopeQuery(company)}`, { method: "POST" },
  );
  if (isJSON(options)) return writeJSON(out);
  process.stdout.write(`${id}: ${out.status}${out.cancelRequested ? " (cancellation requested)" : ""}${out.reusedResult ? " (reusing stored result)" : ""}${out.watchCancelled ? " (CI watch cancelled)" : ""}\n`);
}

const SKIP_LISTS = ["headBranches", "baseBranches", "titles", "authors", "labels"] as const;
function normalizeSkipRules(value: ReviewSkipRules | null | undefined): ReviewSkipRules | null {
  if (value == null) return null;
  return Object.fromEntries([...SKIP_LISTS.map(key => [key, value[key] ?? []]), ["bots", value.bots ?? false]]);
}
export function parseSkipRules(text: string): ReviewSkipRules {
  const rules: unknown = JSON.parse(text);
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) throw new Error("Skip rules must be a JSON object");
  for (const [key, value] of Object.entries(rules)) {
    if (key === "bots") { if (typeof value !== "boolean") throw new Error("bots must be a boolean"); continue; }
    if (!(SKIP_LISTS as readonly string[]).includes(key)) throw new Error(`Unknown skip rule field: ${key}`);
    if (!Array.isArray(value) || value.length > 50 || value.some(v => typeof v !== "string" || !v.trim() || v !== v.trim() || Buffer.byteLength(v) > 200 || /[\p{Cc}]/u.test(v))) {
      throw new Error(`${key} must contain at most 50 nonempty patterns of at most 200 bytes without surrounding whitespace or control characters`);
    }
  }
  return rules as ReviewSkipRules;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function cmdReviewRepos(options: ScopeOptions): Promise<void> {
  const company = await resolveScope(options);
  const repos = await listReviewRepositories(company);
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify({ repositories: repos }, null, 2)}\n`);
    return;
  }
  if (repos.length === 0) {
    process.stdout.write(`No repositories are set up for Ditto Review${company ? ` in ${company.slug}` : ""}.\n`);
    return;
  }
  const rows = repos.map((r) => [
    r.fullName,
    r.enabled ? "on" : "off",
    `${r.maxMinutes} min`,
    money(r.budgetCents),
    r.mode,
    r.trigger,
  ]);
  const header = ["REPOSITORY", "ENABLED", "TIME LIMIT", "BUDGET/RUN", "MODE", "TRIGGER"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  for (const row of [header, ...rows]) {
    process.stdout.write(`${row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]!))).join("  ")}\n`);
  }
}

/** The PUT body that saves `repo` exactly as read, guarded by its revision. */
export function reviewRepositoryInput(repo: ReviewRepository): Record<string, unknown> {
  return {
    ifRevision: repo.revision,
    ...(repo.skipRules !== undefined ? { skipRules: repo.skipRules } : {}),
    fullName: repo.fullName,
    endpointId: repo.endpointId,
    enabled: repo.enabled,
    verify: repo.verify,
    reviewDrafts: repo.reviewDrafts,
    postSummary: repo.postSummary,
    autofixCi: repo.autofixCi,
    allowFixCommand: repo.allowFixCommand,
    resolveFixedThreads: repo.resolveFixedThreads,
    reviewVerdicts: repo.reviewVerdicts,
    blockingSeverity: repo.blockingSeverity,
    instructions: repo.instructions,
    mode: repo.mode,
    trigger: repo.trigger,
    minSeverity: repo.minSeverity,
    pathFilters: repo.pathFilters ?? [],
    pathInstructions: repo.pathInstructions ?? [],
    budgetCents: repo.budgetCents,
    maxMinutes: repo.maxMinutes,
    minConfidence: repo.minConfidence,
    maxComments: repo.maxComments,
    autofixMaxPushes: repo.autofixMaxPushes,
    monthlyBudgetUsd: repo.monthlyBudgetUsd,
  };
}

function intFlag(flag: string, value: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} must be a whole number from ${min} to ${max}`);
  return n;
}

export async function cmdReviewSet(fullName: string, options: SetOptions): Promise<void> {
  const changes: Record<string, unknown> = {};
  if (options.skipRulesFile && options.clearSkipRules) throw new Error("Use --skip-rules-file or --clear-skip-rules, not both");
  if (options.skipRulesFile) changes.skipRules = parseSkipRules(await readFile(options.skipRulesFile, "utf8"));
  if (options.clearSkipRules) changes.skipRules = {};
  if (options.maxMinutes !== undefined) changes.maxMinutes = intFlag("--max-minutes", options.maxMinutes, MIN_MAX_MINUTES, MAX_MAX_MINUTES);
  if (options.budgetCents !== undefined) changes.budgetCents = intFlag("--budget-cents", options.budgetCents, 1, MAX_BUDGET_CENTS);
  if (options.enabled !== undefined) {
    if (options.enabled !== "on" && options.enabled !== "off") throw new Error("--enabled must be on or off");
    changes.enabled = options.enabled === "on";
  }
  if (options.fast !== undefined) {
    if (options.fast !== "on" && options.fast !== "off") throw new Error("--fast must be on or off");
    changes.fastMode = options.fast === "on";
  }
  if (Object.keys(changes).length === 0) {
    throw new Error("nothing to change; pass at least one --flag (see `heyditto review set --help`)");
  }
  const company = await resolveScope(options);
  const repos = await listReviewRepositories(company);
  const repo = repos.find((r) => r.fullName.toLowerCase() === fullName.trim().toLowerCase());
  if (!repo) {
    const known = repos.map((r) => r.fullName).join(", ");
    throw new Error(
      `${fullName} is not set up for Ditto Review${company ? ` in ${company.slug}` : " in your personal workspace (pass --org?)"}.` +
        (known ? `\n\nRepositories here: ${known}` : ""),
    );
  }
  const saved = await apiFetch<ReviewRepository>(`/api/v5/review/repositories${scopeQuery(company)}`, {
    method: "PUT",
    body: { ...reviewRepositoryInput(repo), ...changes },
  });
  if ("skipRules" in changes && JSON.stringify(saved.skipRules ?? null) !== JSON.stringify(changes.skipRules)) {
    // Key ordering may differ on a jsonb response; compare normalized values.
    if (JSON.stringify(normalizeSkipRules(saved.skipRules)) !== JSON.stringify(normalizeSkipRules(changes.skipRules as ReviewSkipRules))) {
      throw new Error("Skip rules were not saved by this backend. Update the backend and retry.");
    }
  }
  if (isJSON(options)) return writeJSON(saved);
  const after = { ...repo, ...changes } as ReviewRepository;
  const lines = [`Saved ${repo.fullName}:`];
  if ("skipRules" in changes) lines.push(`  PR skip rules  ${JSON.stringify(saved.skipRules)}`);
  if ("maxMinutes" in changes) lines.push(`  time limit  ${repo.maxMinutes} → ${after.maxMinutes} min`);
  if ("budgetCents" in changes) lines.push(`  budget/run  ${money(repo.budgetCents)} → ${money(after.budgetCents)}`);
  if ("enabled" in changes) lines.push(`  enabled     ${repo.enabled ? "on" : "off"} → ${after.enabled ? "on" : "off"}`);
  if ("fastMode" in changes) {
    if (saved.fastMode === undefined) {
      lines.push("  fast mode   not saved: this Ditto backend does not support fast mode yet");
    } else {
      lines.push(`  fast mode   ${repo.fastMode ? "on" : "off"} → ${saved.fastMode ? "on" : "off"}${saved.fastMode ? " (GLM-5.3-FlashX: faster, about 2.5× the per-token cost)" : ""}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

interface AddOptions extends ScopeOptions {
  endpoint?: string;
  maxMinutes?: string;
  budgetCents?: string;
  fast?: string;
  verdicts?: string;
}

/** What a new repository starts with when a flag does not say (the console's defaults). */
const ADD_DEFAULT_MAX_MINUTES = 30;
const ADD_DEFAULT_BUDGET_CENTS = 100;

function onOff(flag: string, value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== "on" && value !== "off") throw new Error(`${flag} must be on or off`);
  return value === "on";
}

/**
 * Sets a GitHub repository up for Ditto Review in the workspace, as the
 * console's "Add repository" does: one PUT of its settings. The backend
 * links the repository through your GitHub connection (you must be an admin
 * of it, with the Ditto Code app installed on it). Without --endpoint the
 * review endpoint the workspace's repositories already use is reused.
 */
export async function cmdReviewAdd(fullName: string, options: AddOptions): Promise<void> {
  const name = fullName.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`${fullName} is not a repository; pass owner/name`);
  const maxMinutes =
    options.maxMinutes === undefined ? ADD_DEFAULT_MAX_MINUTES : intFlag("--max-minutes", options.maxMinutes, MIN_MAX_MINUTES, MAX_MAX_MINUTES);
  const budgetCents =
    options.budgetCents === undefined ? ADD_DEFAULT_BUDGET_CENTS : intFlag("--budget-cents", options.budgetCents, 1, MAX_BUDGET_CENTS);
  const fast = onOff("--fast", options.fast);
  const verdicts = onOff("--verdicts", options.verdicts);
  const company = await resolveScope(options);
  const repos = await listReviewRepositories(company);
  const where = company ? ` in ${company.slug}` : " in your personal workspace";
  if (repos.some((r) => r.fullName.toLowerCase() === name.toLowerCase())) {
    throw new Error(`${name} is already set up for Ditto Review${where}; change it with \`heyditto review set ${name} …\``);
  }
  let endpointId = options.endpoint?.trim();
  if (!endpointId) {
    const used = [...new Set(repos.map((r) => r.endpointId).filter(Boolean))];
    if (used.length !== 1) {
      throw new Error(
        used.length === 0
          ? `no repository${where} has a review endpoint to reuse; pass --endpoint <id>, or add the first repository from the console (developer.heyditto.ai/review)`
          : `this workspace's repositories use ${used.length} review endpoints (${used.join(", ")}); pass --endpoint <id> to choose one`,
      );
    }
    endpointId = used[0]!;
  }
  const body: Record<string, unknown> = {
    fullName: name,
    endpointId,
    enabled: true,
    verify: true,
    reviewDrafts: false,
    instructions: "",
    budgetCents,
    maxMinutes,
    ...(fast !== undefined ? { fastMode: fast } : {}),
    ...(verdicts !== undefined ? { reviewVerdicts: verdicts } : {}),
  };
  const saved = await apiFetch<ReviewRepository>(`/api/v5/review/repositories${scopeQuery(company)}`, { method: "PUT", body });
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify(saved, null, 2)}\n`);
    return;
  }
  const lines = [
    `Added ${saved.fullName ?? name} to Ditto Review${where}:`,
    `  reviews     ${saved.enabled === false ? "off" : "on"} (${saved.trigger ?? "auto"}, ${saved.mode ?? "suggest"})`,
    `  time limit  ${saved.maxMinutes ?? maxMinutes} min`,
    `  budget/run  ${money(saved.budgetCents ?? budgetCents)}`,
    `  endpoint    ${saved.endpointId ?? endpointId}`,
  ];
  if (saved.reviewVerdicts !== undefined) lines.push(`  verdicts    ${saved.reviewVerdicts ? "on (approve or request changes)" : "off (comments only)"}`);
  if (saved.fastMode !== undefined) lines.push(`  fast mode   ${saved.fastMode ? "on" : "off"}`);
  lines.push(`Change any setting: heyditto review set ${saved.fullName ?? name} --help`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

export function registerReviewCommands(
  program: Command,
  addExamples: (c: Command, ex: string) => Command,
  outputOption: () => Option,
  orgOption: () => Option,
): void {
  const review = program
    .command("review")
    .description("Ditto Review repositories, settings, and review runs")
    .summary("manage and follow Ditto Review");
  addExamples(
    review
      .command("repos", { isDefault: true })
      .description("list the repositories set up for Ditto Review")
      .addOption(orgOption())
      .addOption(outputOption())
      .action(cmdReviewRepos),
    `  heyditto review repos --org omni-aura
  heyditto review repos --output json`,
  );
  const scoped = (command: Command): Command => command.addOption(orgOption()).addOption(outputOption());
  addExamples(scoped(review.command("local")
    .description("review a working diff before a PR; uploads selected changes and bounded tracked source context to Ditto Review")
    .option("--staged", "review index bytes only, excluding unstaged and untracked changes")
    .option("--base <ref>", "review branch and working changes since merge-base(ref, HEAD); conflicts with --staged")
    .option("--profile <profile>", "quick, standard or deep (default quick)", "quick")
    .option("--context-file <file>", "read task context from a UTF-8 file (maximum 16000 bytes)")
    .option("--repository <owner/name>", "Review repository (default: current checkout's GitHub origin)")
    .option("--directory <directory>", "checkout to review (default: current directory)")
    .option("--preview", "inspect selected paths and upload size locally; no auth, upload or inference")
    .option("--timeout <seconds>", "cancel after this many seconds including capture and queue time (1-1800)", "1200")
    .option("--request-id <uuid>", "recover an uncertain admission with exactly the same source, profile and context"))
    .action(cmdReviewLocal),
    `  heyditto review local --preview\n  heyditto review local --staged --profile quick --org omniaura\n  heyditto review local --base main --context-file .tmp/task.md --output json`);
  scoped(review.command("local-status").description("inspect a pre-PR review run without starting or retrying it")
    .argument("<run-id>", "local review run UUID")).action(cmdReviewLocalStatus);
  scoped(review.command("local-cancel").description("cancel a queued or running pre-PR review")
    .argument("<run-id>", "local review run UUID")).action(cmdReviewLocalCancel);
  const watched = (command: Command): Command => command
    .option("--interval <seconds>", "poll interval (1-60 seconds)", "10")
    .option("--timeout <seconds>", "stop waiting after this many seconds (review continues)", "3600");
  scoped(review.command("runs").description("list recent review runs in this workspace")
    .argument("[repository]", "filter by owner/name")).action(cmdReviewRuns);
  scoped(review.command("pulls").description("list open pull requests available to review")
    .argument("<repository>", "owner/name")).action(cmdReviewPulls);
  addExamples(
    watched(scoped(review.command("start").description("request a review of the current PR head (uses the repository's budget; re-reviews cost a new attempt)")
      .argument("<repository>", "owner/name").argument("<pr-number>", "open pull request number")
      .option("--watch", "follow the requested run until it finishes"))).action(cmdReviewStart),
    `  heyditto review start ditto-assistant/console 88 --org omniaura --watch`,
  );
  scoped(review.command("status").description("show run status; JSON includes results and prior attempts")
    .argument("<run-id>", "review run UUID")).action(cmdReviewStatus);
  watched(scoped(review.command("watch").description("follow a review until it finishes; does not start or retry it")
    .argument("<run-id>", "review run UUID"))).action(cmdReviewWatch);
  for (const action of ["retry", "cancel"] as const) {
    scoped(review.command(action).description(action === "retry"
      ? "retry an eligible run (may spend a new budget; publication retries reuse stored results)"
      : "request cancellation of a queued/running review or its CI watch")
      .argument("<run-id>", "review run UUID")).action((id: string, options: ScopeOptions) => cmdReviewAction(id, action, options));
  }
  addExamples(
    review
      .command("add")
      .description("set a GitHub repository up for Ditto Review (you must be an admin of it, with the Ditto Code app installed)")
      .argument("<repository>", "owner/name")
      .option("--endpoint <id>", "review endpoint to bill to (default: the one this workspace's repositories use)")
      .option("--max-minutes <n>", `time limit of one review (${MIN_MAX_MINUTES}-${MAX_MAX_MINUTES}, default ${ADD_DEFAULT_MAX_MINUTES})`)
      .option("--budget-cents <n>", `spend limit of one review, in cents (1-10000, default ${ADD_DEFAULT_BUDGET_CENTS})`)
      .option("--verdicts <on|off>", "approve or request changes after each review (default off)")
      .option("--fast <on|off>", "fast mode: review on GLM-5.3-FlashX (faster, about 2.5x the per-token cost)")
      .addOption(orgOption())
      .addOption(outputOption())
      .action(cmdReviewAdd),
    `  heyditto review add ditto-assistant/ditto-cli --org omniaura --verdicts on
  heyditto review add acme/api --budget-cents 300 --max-minutes 20 --endpoint 44444444-…`,
  );
  addExamples(
    review
      .command("set")
      .description("change a repository's review settings (the rest are kept as saved)")
      .argument("<repository>", "owner/name")
      .option("--max-minutes <n>", `time limit of one review (${MIN_MAX_MINUTES}-${MAX_MAX_MINUTES})`)
      .option("--budget-cents <n>", "spend limit of one review, in cents (1-10000)")
      .option("--enabled <on|off>", "review this repository's pull requests")
      .option("--skip-rules-file <file>", "replace PR skip rules from a JSON file (headBranches, baseBranches, titles, authors, labels, bots)")
      .option("--clear-skip-rules", "remove all PR skip rules")
      .option("--fast <on|off>", "fast mode: review on GLM-5.3-FlashX (faster, about 2.5x the per-token cost)")
      .addOption(orgOption())
      .addOption(outputOption())
      .action(cmdReviewSet),
    `  heyditto review set ditto-assistant/console --max-minutes 20 --org omni-aura
  heyditto review set acme/api --budget-cents 300 --enabled on
  heyditto review set acme/api --fast on --org omniaura`,
  );
  registerReviewFindingCommands(review, addExamples, outputOption, orgOption);
}
