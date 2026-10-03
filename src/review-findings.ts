import type { Command, Option } from "commander";
import { ApiError, apiFetch, type Company, listCompanies, resolveCompany } from "./api.js";
import { readStoredAuth } from "./store.js";

/**
 * Ditto Review findings from the shell (DITTO-178): list a pull request's
 * findings, dismiss or undismiss one, and give feedback on one. Every action
 * goes through the same backend routes the developer console uses, so it is
 * recorded as the same learning signal (review_finding_feedback,
 * review_finding_dismissals) and a dismissal replies on the GitHub thread and
 * resolves it exactly as a console dismissal does.
 *
 * A finding is addressed the way a person meets it: by the GitHub
 * review-comment URL (`…/pull/12#discussion_r4167148147`), by `<run-id>:<finding-id>`,
 * or by a bare finding id together with `--pr`.
 */

/** One finding as `GET /api/v5/review/runs/{id}` returns it (the fields the CLI shows). */
export interface ReviewFinding {
  id: string;
  path: string;
  line: number;
  startLine?: number;
  severity: string;
  category?: string;
  title?: string;
  status?: string;
  withheldReason?: string;
  confidence?: number;
  commentUrl?: string;
  dismissed?: boolean;
  dismissReason?: string;
  feedback?: { mine?: string | null };
  canFeedback?: boolean;
  canDismiss?: boolean;
}

export interface ReviewRunDetail {
  run: { id: string; prNumber: number; headSha: string; status: string; reviewUrl?: string; prTitle?: string; createdAt?: string };
  result: { findings: ReviewFinding[] };
  repository: { id: string; fullName: string };
}

export interface ReviewDismissResponse {
  runId: string;
  findingId: string;
  githubStatus: string;
  githubReason?: string;
  replyUrl?: string;
  alreadyDismissed: boolean;
  githubUpdated: boolean;
  threadResolved: boolean;
  markerConflict?: { message: string; findingIds: string[] };
}

export interface ReviewUndismissResponse {
  runId: string;
  findingId: string;
  wasDismissed: boolean;
  dismissed: boolean;
  githubNote: string;
  githubReplyUrl?: string;
}

export interface ReviewFeedbackResponse {
  runId: string;
  findingId: string;
  attempt: number;
  feedback?: { mine?: string | null; counts?: Record<string, number> };
}

export const FEEDBACK_VERDICTS = ["useful", "wrong", "not_useful"] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

interface ScopeOptions {
  org?: string;
  output?: string;
}

interface FindingsOptions extends ScopeOptions {
  all?: boolean;
}

interface FindingOptions extends ScopeOptions {
  pr?: string;
}

interface DismissOptions extends FindingOptions {
  reason?: string;
}

interface FeedbackOptions extends FindingOptions {
  note?: string;
}

/** A pull request named by URL or `owner/name#N`. */
export interface PullRef {
  fullName: string;
  number: number;
  /** The GitHub review-comment id from a `#discussion_r<id>` fragment. */
  commentId?: string;
}

/** What a `<finding>` argument named. */
export type FindingRef =
  | { kind: "comment"; pull: PullRef; commentId: string }
  | { kind: "direct"; runId: string; findingId: string }
  | { kind: "id"; findingId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses a pull request reference: a GitHub PR URL (with or without a review-comment fragment) or `owner/name#N`. */
export function parsePullRef(text: string): PullRef | undefined {
  const value = text.trim();
  const url = value.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)\/pull\/(\d+)(?:\/[^#?\s]*)?(?:\?[^#\s]*)?(?:#(.*))?$/i);
  if (url) {
    const fragment = url[4] ?? "";
    const comment = fragment.match(/^discussion_r(\d+)$/) ?? fragment.match(/^r(\d+)$/);
    return { fullName: `${url[1]}/${url[2]}`, number: Number(url[3]), commentId: comment?.[1] };
  }
  const short = value.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (short) return { fullName: short[1]!, number: Number(short[2]) };
  return undefined;
}

/** Parses a `<finding>` argument. */
export function parseFindingRef(text: string): FindingRef {
  const value = text.trim();
  const pull = parsePullRef(value);
  if (pull) {
    if (!pull.commentId) {
      throw new Error(
        `${value} names a pull request, not a finding. Pass the review comment's URL (…#discussion_r<id>), or a finding id with --pr ${pull.fullName}#${pull.number}.`,
      );
    }
    return { kind: "comment", pull, commentId: pull.commentId };
  }
  const direct = value.match(/^([0-9a-f-]{36})[:/](\S+)$/i);
  if (direct && UUID.test(direct[1]!)) return { kind: "direct", runId: direct[1]!.toLowerCase(), findingId: direct[2]! };
  if (!value || /\s/.test(value)) throw new Error(`"${value}" is not a finding: pass a review comment URL, <run-id>:<finding-id>, or a finding id with --pr`);
  return { kind: "id", findingId: value };
}

function isJSON(options: { output?: string }): boolean {
  return options.output === "json" || options.output === "raw";
}

function scopeQuery(company: Company | undefined): string {
  return company ? `?company=${encodeURIComponent(company.id)}` : "";
}

function scopeSuffix(company: Company | undefined): string {
  return company ? `&company=${encodeURIComponent(company.id)}` : "";
}

/** The workspace named by --org or the stored default; undefined means "not chosen" (not "personal"). */
async function chosenScope(options: ScopeOptions): Promise<Company | undefined> {
  const wanted = options.org?.trim() || (await readStoredAuth())?.defaultCompany;
  if (!wanted) return undefined;
  return resolveCompany(wanted);
}

/** The run detail of a PR's newest run in one workspace; undefined on 404. */
async function latestRunIn(company: Company | undefined, pull: PullRef): Promise<ReviewRunDetail | undefined> {
  try {
    return await apiFetch<ReviewRunDetail>(
      `/api/v5/review/runs/latest?repository=${encodeURIComponent(pull.fullName)}&pr=${pull.number}${scopeSuffix(company)}`,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined;
    throw error;
  }
}

/**
 * The PR's newest run and the workspace it was found in. With --org (or a
 * stored default) only that workspace is asked; otherwise the personal
 * workspace and then every organization the key can see, because a GitHub
 * URL already names the repository and nobody wants to look up which
 * organization reviews it.
 */
export async function findLatestRun(options: ScopeOptions, pull: PullRef): Promise<{ company: Company | undefined; detail: ReviewRunDetail }> {
  const chosen = await chosenScope(options);
  if (chosen || options.org) {
    const detail = await latestRunIn(chosen, pull);
    if (!detail) throw new Error(`Ditto Review has no run for ${pull.fullName}#${pull.number} in ${chosen?.slug ?? "your personal workspace"}.`);
    return { company: chosen, detail };
  }
  const tried: string[] = [];
  const personal = await latestRunIn(undefined, pull);
  if (personal) return { company: undefined, detail: personal };
  tried.push("your personal workspace");
  for (const company of await listCompanies()) {
    const detail = await latestRunIn(company, pull);
    if (detail) return { company, detail };
    tried.push(company.slug);
  }
  throw new Error(
    `Ditto Review has no run for ${pull.fullName}#${pull.number} in ${tried.join(", ")}. Is the repository set up for Ditto Review (heyditto review repos --org <org>)?`,
  );
}

/** The run and finding a `<finding>` argument names, with the workspace to act in. */
export async function resolveFinding(
  text: string,
  options: FindingOptions,
): Promise<{ company: Company | undefined; runId: string; finding: ReviewFinding; detail?: ReviewRunDetail }> {
  const ref = parseFindingRef(text);
  if (ref.kind === "direct") {
    const company = await chosenScope(options);
    const detail = await apiFetch<ReviewRunDetail>(`/api/v5/review/runs/${encodeURIComponent(ref.runId)}${scopeQuery(company)}`);
    const finding = detail.result.findings.find((f) => f.id === ref.findingId);
    if (!finding) throw new Error(`run ${ref.runId} has no finding ${ref.findingId}. Findings: ${detail.result.findings.map((f) => f.id).join(", ") || "none"}`);
    return { company, runId: detail.run.id, finding, detail };
  }
  let pull: PullRef | undefined;
  if (ref.kind === "comment") pull = ref.pull;
  else {
    if (!options.pr) throw new Error(`a bare finding id needs --pr <pull-request url or owner/name#N>, or pass the review comment's URL instead`);
    pull = parsePullRef(options.pr);
    if (!pull) throw new Error(`--pr ${options.pr} is not a pull request URL or owner/name#N`);
  }
  const { company, detail } = await findLatestRun(options, pull);
  const finding =
    ref.kind === "comment"
      ? detail.result.findings.find((f) => f.commentUrl?.endsWith(`discussion_r${ref.commentId}`))
      : detail.result.findings.find((f) => f.id === ref.findingId);
  if (!finding) {
    const what = ref.kind === "comment" ? `the review comment discussion_r${ref.commentId}` : `finding ${ref.findingId}`;
    throw new Error(
      `${what} is not in the newest Ditto Review run of ${pull.fullName}#${pull.number} (run ${detail.run.id}, head ${detail.run.headSha.slice(0, 8)}). ` +
        `List it with: heyditto review findings ${pull.fullName}#${pull.number}`,
    );
  }
  return { company, runId: detail.run.id, finding, detail };
}

function short(value: string | undefined, width: number): string {
  if (!value) return "";
  return value.length > width ? `${value.slice(0, width - 1)}…` : value;
}

function findingState(f: ReviewFinding): string {
  if (f.dismissed) return "dismissed";
  if (f.status === "withheld") return f.withheldReason ? `held (${f.withheldReason})` : "held";
  return f.status || "";
}

function table(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  for (const row of [header, ...rows]) {
    process.stdout.write(`${row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]!))).join("  ")}\n`);
  }
}

export async function cmdReviewFindings(target: string, options: FindingsOptions): Promise<void> {
  const value = target.trim();
  let detail: ReviewRunDetail;
  let company: Company | undefined;
  if (UUID.test(value)) {
    company = await chosenScope(options);
    detail = await apiFetch<ReviewRunDetail>(`/api/v5/review/runs/${encodeURIComponent(value.toLowerCase())}${scopeQuery(company)}`);
  } else {
    const pull = parsePullRef(value);
    if (!pull) throw new Error(`${value} is not a pull request URL, owner/name#N, or a run id`);
    ({ company, detail } = await findLatestRun(options, pull));
  }
  const findings = options.all ? detail.result.findings : detail.result.findings.filter((f) => !f.dismissed);
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify({ company: company?.slug, run: detail.run, repository: detail.repository, findings }, null, 2)}\n`);
    return;
  }
  const run = detail.run;
  process.stdout.write(
    `${detail.repository.fullName}#${run.prNumber}${run.prTitle ? ` ${run.prTitle}` : ""}\nrun ${run.id} · head ${run.headSha.slice(0, 8)} · ${run.status}${run.reviewUrl ? ` · ${run.reviewUrl}` : ""}\n\n`,
  );
  if (findings.length === 0) {
    process.stdout.write(options.all ? "No findings.\n" : "No open findings (pass --all to include dismissed ones).\n");
    return;
  }
  table(
    ["FINDING", "SEV", "CONF", "STATE", "MINE", "WHERE", "TITLE"],
    findings.map((f) => [
      f.id,
      f.severity,
      f.confidence ? `${f.confidence}%` : "",
      findingState(f),
      f.feedback?.mine ?? "",
      `${f.path}:${f.line}`,
      short(f.title, 70),
    ]),
  );
  const withComments = findings.filter((f) => f.commentUrl);
  if (withComments.length > 0) {
    process.stdout.write("\nOn GitHub:\n");
    for (const f of withComments) process.stdout.write(`  ${f.id}  ${f.commentUrl}\n`);
  }
  process.stdout.write(
    `\nAct on one: heyditto review dismiss <comment-url|${run.id.slice(0, 8)}…:<finding>> --reason "…" · heyditto review feedback <finding> useful|wrong|not_useful\n`,
  );
}

export async function cmdReviewDismiss(target: string, options: DismissOptions): Promise<void> {
  const reason = options.reason?.trim() ?? "";
  if (!reason) throw new Error('--reason is required: say why this finding does not apply (it is posted on the GitHub thread and kept as a team decision)');
  if (reason.length > 1000) throw new Error("--reason must be at most 1000 characters");
  const { company, runId, finding } = await resolveFinding(target, options);
  const out = await apiFetch<ReviewDismissResponse>(
    `/api/v5/review/runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(finding.id)}/dismiss${scopeQuery(company)}`,
    { method: "POST", body: { reason } },
  );
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  const lines = [`${out.alreadyDismissed ? "Already dismissed" : "Dismissed"} ${finding.id} (${finding.severity}, ${finding.path}:${finding.line})${finding.title ? `: ${finding.title}` : ""}`];
  switch (out.githubStatus) {
    case "updated":
      lines.push(`  GitHub: replied and resolved the thread${out.replyUrl ? ` — ${out.replyUrl}` : ""}`);
      break;
    case "no_thread":
      lines.push("  GitHub: nothing to update (the finding has no review thread)");
      break;
    case "pending":
      lines.push("  GitHub: reply and resolve still running; check the thread in a minute");
      break;
    case "marker_conflict":
      lines.push("  GitHub: thread left open because another, different issue shares it");
      break;
    default:
      lines.push(`  GitHub: ${out.githubStatus}${out.githubReason ? ` — ${out.githubReason}` : ""} (run the command again to retry)`);
  }
  if (out.markerConflict) lines.push(`  Note: ${out.markerConflict.message}`);
  lines.push(`  Undo: heyditto review undismiss ${runId}:${finding.id}${company ? ` --org ${company.slug}` : ""}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

export async function cmdReviewUndismiss(target: string, options: FindingOptions): Promise<void> {
  const { company, runId, finding } = await resolveFinding(target, options);
  const out = await apiFetch<ReviewUndismissResponse>(
    `/api/v5/review/runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(finding.id)}/dismiss${scopeQuery(company)}`,
    { method: "DELETE" },
  );
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `${out.wasDismissed ? "Undismissed" : "Not dismissed"} ${finding.id} (${finding.path}:${finding.line}).\n  ${out.githubNote}\n`,
  );
}

export async function cmdReviewFeedback(target: string, verdict: string, options: FeedbackOptions): Promise<void> {
  const v = verdict.trim().toLowerCase().replace("-", "_") as FeedbackVerdict;
  if (!FEEDBACK_VERDICTS.includes(v)) throw new Error(`verdict must be one of ${FEEDBACK_VERDICTS.join(", ")}`);
  const note = options.note?.trim() ?? "";
  if (note.length > 1000) throw new Error("--note must be at most 1000 characters");
  const { company, runId, finding } = await resolveFinding(target, options);
  const out = await apiFetch<ReviewFeedbackResponse>(
    `/api/v5/review/runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(finding.id)}/feedback${scopeQuery(company)}`,
    { method: "POST", body: { verdict: v, note } },
  );
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Recorded "${v}" on ${finding.id} (${finding.path}:${finding.line})${finding.title ? `: ${finding.title}` : ""}${note ? `\n  note: ${note}` : ""}\n`);
}

export function registerReviewFindingCommands(
  review: Command,
  addExamples: (c: Command, ex: string) => Command,
  outputOption: () => Option,
  orgOption: () => Option,
): void {
  addExamples(
    review
      .command("findings")
      .description("list a pull request's Ditto Review findings (its newest run), or a run's by id")
      .argument("<pull-request|run-id>", "GitHub PR URL, owner/name#N, or a run id")
      .option("--all", "include dismissed findings")
      .addOption(orgOption())
      .addOption(outputOption())
      .action(cmdReviewFindings),
    `  heyditto review findings https://github.com/ditto-assistant/backend/pull/3158
  heyditto review findings ditto-assistant/ditto-app#3163 --all --output json`,
  );
  addExamples(
    review
      .command("dismiss")
      .description("dismiss a finding with a reason (managers): replies on its GitHub thread, resolves it, and keeps the same issue off this PR")
      .argument("<finding>", "review comment URL (…#discussion_r<id>), <run-id>:<finding-id>, or a finding id with --pr")
      .requiredOption("--reason <text>", "why it does not apply; posted on GitHub and kept as a team decision")
      .option("--pr <pull-request>", "the PR a bare finding id belongs to (URL or owner/name#N)")
      .addOption(orgOption())
      .addOption(outputOption())
      .action(cmdReviewDismiss),
    `  heyditto review dismiss "https://github.com/ditto-assistant/backend/pull/3112#discussion_r4171976544" --reason "Retrying with different arguments is the documented design (trace_test.go:106-115)."
  heyditto review dismiss f_6eb378e97faaaf48 --pr ditto-assistant/backend#3112 --reason "Theoretical: tool arguments never carry integers above 2^53."`,
  );
  addExamples(
    review
      .command("undismiss")
      .description("undo a dismissal (managers); the GitHub thread stays as it is")
      .argument("<finding>", "review comment URL, <run-id>:<finding-id>, or a finding id with --pr")
      .option("--pr <pull-request>", "the PR a bare finding id belongs to (URL or owner/name#N)")
      .addOption(orgOption())
      .addOption(outputOption())
      .action(cmdReviewUndismiss),
    `  heyditto review undismiss "https://github.com/ditto-assistant/backend/pull/3112#discussion_r4171976544"`,
  );
  addExamples(
    review
      .command("feedback")
      .description("say whether a finding was useful, wrong or not useful (any workspace member)")
      .argument("<finding>", "review comment URL, <run-id>:<finding-id>, or a finding id with --pr")
      .argument("<verdict>", FEEDBACK_VERDICTS.join("|"))
      .option("--note <text>", "what was wrong or missing (up to 1000 characters)")
      .option("--pr <pull-request>", "the PR a bare finding id belongs to (URL or owner/name#N)")
      .addOption(orgOption())
      .addOption(outputOption())
      .action(cmdReviewFeedback),
    `  heyditto review feedback "https://github.com/ditto-assistant/ditto-app/pull/3161#discussion_r4167262944" useful
  heyditto review feedback f_0a073e36dfb26698 --pr ditto-assistant/backend#3112 wrong --note "The retry test covers different arguments."`,
  );
}
