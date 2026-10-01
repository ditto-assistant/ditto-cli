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
    .description("Ditto Review repositories and their settings")
    .summary("Ditto Review settings");
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
