import { setTimeout as delay } from "node:timers/promises";
import type { Command, Option } from "commander";
import { apiFetch, type Company, resolveCompany } from "./api.js";
import { readStoredAuth } from "./store.js";

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
export interface ReviewRepository {
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
  lastError?: string;
}

interface ScopeOptions {
  org?: string;
  output?: string;
}

interface SetOptions extends ScopeOptions {
  maxMinutes?: string;
  budgetCents?: string;
  enabled?: string;
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
  if (options.maxMinutes !== undefined) changes.maxMinutes = intFlag("--max-minutes", options.maxMinutes, MIN_MAX_MINUTES, MAX_MAX_MINUTES);
  if (options.budgetCents !== undefined) changes.budgetCents = intFlag("--budget-cents", options.budgetCents, 1, MAX_BUDGET_CENTS);
  if (options.enabled !== undefined) {
    if (options.enabled !== "on" && options.enabled !== "off") throw new Error("--enabled must be on or off");
    changes.enabled = options.enabled === "on";
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
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify(saved, null, 2)}\n`);
    return;
  }
  const after = { ...repo, ...changes } as ReviewRepository;
  const lines = [`Saved ${repo.fullName}:`];
  if ("maxMinutes" in changes) lines.push(`  time limit  ${repo.maxMinutes} → ${after.maxMinutes} min`);
  if ("budgetCents" in changes) lines.push(`  budget/run  ${money(repo.budgetCents)} → ${money(after.budgetCents)}`);
  if ("enabled" in changes) lines.push(`  enabled     ${repo.enabled ? "on" : "off"} → ${after.enabled ? "on" : "off"}`);
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
  scoped(review.command("status").description("show a run, results, and prior attempts")
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
      .command("set")
      .description("change a repository's review settings (the rest are kept as saved)")
      .argument("<repository>", "owner/name")
      .option("--max-minutes <n>", `time limit of one review (${MIN_MAX_MINUTES}-${MAX_MAX_MINUTES})`)
      .option("--budget-cents <n>", "spend limit of one review, in cents (1-10000)")
      .option("--enabled <on|off>", "review this repository's pull requests")
      .addOption(orgOption())
      .addOption(outputOption())
      .action(cmdReviewSet),
    `  heyditto review set ditto-assistant/console --max-minutes 20 --org omni-aura
  heyditto review set acme/api --budget-cents 300 --enabled on`,
  );
}
