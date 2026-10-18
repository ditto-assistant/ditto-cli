import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Command, Option } from "commander";
import { apiFetch, type Company, resolveCompany } from "./api.js";
import { registerReviewFindingCommands } from "./review-findings.js";
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
function normalizeSkipRules(value: ReviewSkipRules | undefined): ReviewSkipRules | null {
  if (value === undefined) return null;
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
