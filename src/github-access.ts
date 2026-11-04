import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { ApiError, apiFetch } from "./api.js";
import { openInBrowser } from "./browser.js";

/**
 * Ditto Code GitHub App access, from the shell (DITTO-1550).
 *
 * Whether the Ditto Code app can reach a repository is a GitHub setting the
 * person changes on GitHub; Ditto never grants it. The backend reads GitHub
 * with the person's own connection and answers, per repository, a state and
 * the one GitHub page to open next. GitHub cannot preselect a repository on
 * that page, so the CLI prints exactly what to choose there.
 *
 * App access is not Review registration: an app that can see a repository
 * reviews nothing until `heyditto review add` sets it up.
 */

/** One repository as `GET /api/v5/review/github-access` reports it. */
export interface RepositoryAccess {
  repository: string;
  owner: string;
  ownerType?: string;
  state: string;
  admin: boolean;
  installationId?: number;
  actionUrl?: string;
  installUrl?: string;
  configureUrl?: string;
}

export const ACCESS_GRANTED = "granted";

const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function fetchRepositoryAccess(names: string[], signal?: AbortSignal): Promise<RepositoryAccess[]> {
  const query = names.map((n) => `repository=${encodeURIComponent(n)}`).join("&");
  const out = await apiFetch<{ repositories?: RepositoryAccess[] }>(`/api/v5/review/github-access?${query}`, { signal });
  return out.repositories ?? [];
}

const execFileAsync = promisify(execFile);

/** owner/name of the current checkout's GitHub origin. */
export async function currentCheckoutRepository(cwd = process.cwd()): Promise<string> {
  let remote: string;
  try {
    remote = (await execFileAsync("git", ["remote", "get-url", "origin"], { cwd })).stdout;
  } catch {
    throw new Error("this directory has no git origin; pass the repository as owner/name");
  }
  const match = /^(?:git@github\.com:|https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!match) throw new Error("cannot identify a GitHub repository from origin; pass the repository as owner/name");
  return match[1]!;
}

function shortName(full: string): string {
  return full.slice(full.indexOf("/") + 1);
}

/**
 * What to do on GitHub for the repositories sharing one action page. `all`
 * is the person's explicit choice of "All repositories"; it is never the
 * fallback, and without it the instructions keep the current selection.
 */
function instructions(group: RepositoryAccess[], all: boolean): string[] {
  const first = group[0]!;
  const org = first.ownerType?.toLowerCase() === "organization";
  const names = group.map((r) => shortName(r.repository)).join(", ");
  const scope = all
    ? `choose "All repositories" (you asked for every current and future repository of ${first.owner})`
    : `choose "Only select repositories" and add ${names}`;
  const lines: string[] = [];
  switch (first.state) {
    case "not_installed":
      lines.push(
        `The Ditto Code GitHub App is not installed on ${first.owner}.`,
        `Open: ${first.actionUrl}`,
        `On GitHub, pick ${first.owner} as the account to install on, then ${scope}, and confirm.`,
      );
      break;
    case "repository_not_selected":
      lines.push(
        `The Ditto Code GitHub App is installed on ${first.owner}, but ${group.length === 1 ? "this repository is" : "these repositories are"} not in its selection.`,
        `Open: ${first.actionUrl}`,
        all
          ? `Under "Repository access", choose "All repositories", then Save.`
          : `Under "Repository access", keep "Only select repositories", add ${names}, then Save. Repositories already selected stay selected.`,
      );
      break;
    case "permissions_pending":
      lines.push(
        `The Ditto Code GitHub App's installation on ${first.owner} has not accepted the permissions Ditto needs (contents read, pull requests write).`,
        `Open: ${first.actionUrl}`,
        `Review and accept the requested permissions there.`,
      );
      break;
    case "suspended":
      lines.push(
        `The Ditto Code GitHub App's installation on ${first.owner} is suspended.`,
        `Open: ${first.actionUrl}`,
        `Unsuspend it there (an owner of ${first.owner} can).`,
      );
      break;
    default:
      lines.push(`Ditto Code cannot access ${names} (${first.state}).`);
      if (first.actionUrl) lines.push(`Open: ${first.actionUrl}`);
  }
  if (org && group.some((r) => !r.admin)) {
    lines.push(`Changing this needs an owner of ${first.owner} (or an app manager). If you are not one, GitHub lets you send them a request from that page.`);
  }
  lines.push(`GitHub may ask you to confirm your password, passkey or two-factor code first; that check stays on GitHub.`);
  return lines;
}

/** Human-readable report: one block per GitHub page to open. */
export function describeAccess(results: RepositoryAccess[], all = false): string {
  const lines: string[] = [];
  for (const r of results.filter((r) => r.state === ACCESS_GRANTED)) {
    lines.push(`${r.repository}: Ditto Code can access it.`);
  }
  for (const r of results.filter((r) => r.state === "repository_not_visible")) {
    lines.push(
      `${r.repository}: your connected GitHub account cannot see this repository.`,
      `  Check the name, or connect the GitHub account that can see it in Ditto settings.`,
    );
  }
  const groups = new Map<string, RepositoryAccess[]>();
  for (const r of results) {
    if (r.state === ACCESS_GRANTED || r.state === "repository_not_visible") continue;
    // One block per owner: the App's install page is shared by every owner,
    // and the instructions name the account to choose.
    const key = `${r.owner.toLowerCase()} ${r.state} ${r.actionUrl ?? r.repository}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const group of groups.values()) {
    lines.push(`${group.map((r) => r.repository).join(", ")}: Ditto Code cannot access ${group.length === 1 ? "this repository" : "these repositories"}.`);
    for (const line of instructions(group, all)) lines.push(`  ${line}`);
  }
  return `${lines.join("\n")}\n`;
}

function pending(results: RepositoryAccess[]): RepositoryAccess[] {
  return results.filter((r) => r.state !== ACCESS_GRANTED);
}

/** The distinct GitHub pages that would fix the pending repositories. */
function actionUrls(results: RepositoryAccess[]): string[] {
  return [...new Set(pending(results).map((r) => r.actionUrl).filter((u): u is string => Boolean(u)))];
}

export interface AccessOptions {
  all?: boolean;
  open?: boolean;
  wait?: boolean;
  interval?: string;
  timeout?: string;
  output?: string;
}

function seconds(flag: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} must be a whole number of seconds from ${min} to ${max}`);
  return n;
}

/** Waits for the person to come back from GitHub (Enter), on a terminal only. */
async function promptReturn(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    await rl.question(message);
    return true;
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

/**
 * Re-checks until every repository is granted or the deadline passes. GitHub
 * applies a saved selection immediately, so a short interval is enough.
 */
async function waitForAccess(names: string[], first: RepositoryAccess[], intervalSec: number, timeoutSec: number, quiet: boolean): Promise<RepositoryAccess[]> {
  const deadline = Date.now() + timeoutSec * 1000;
  let results = first;
  while (pending(results).length > 0 && Date.now() < deadline) {
    if (!quiet) process.stderr.write(`Waiting for GitHub access to ${pending(results).map((r) => r.repository).join(", ")}; re-checking in ${intervalSec}s (Ctrl-C to stop)\n`);
    await delay(Math.min(intervalSec * 1000, Math.max(0, deadline - Date.now())));
    try {
      results = await fetchRepositoryAccess(names);
    } catch (error) {
      // A failed re-check is not an answer: keep the last one and try again
      // until the deadline.
      if (!quiet) process.stderr.write(`Re-check failed (${error instanceof Error ? error.message : String(error)}); trying again\n`);
    }
  }
  return results;
}

/**
 * `heyditto review access [repositories...]`: report the Ditto Code app's
 * access, print (and optionally open) the GitHub page that grants it, and
 * re-check after the person returns. Exits 2 while any repository is still
 * without access, so a script can branch on it.
 */
export async function cmdReviewAccess(repositories: string[], options: AccessOptions): Promise<void> {
  const json = options.output === "json" || options.output === "raw";
  const names = repositories.length ? repositories.map((r) => r.trim()) : [await currentCheckoutRepository()];
  for (const name of names) if (!REPO_NAME.test(name)) throw new Error(`${name} is not a repository; pass owner/name`);
  if (names.length > 20) throw new Error("check at most 20 repositories at a time");
  const intervalSec = seconds("--interval", options.interval, 5, 1, 60);
  const timeoutSec = seconds("--timeout", options.timeout, 600, 1, 3600);

  let results = await fetchRepositoryAccess(names);
  if (pending(results).length > 0 && options.open) for (const url of actionUrls(results)) openInBrowser(url);
  if (!json) process.stdout.write(describeAccess(results, options.all));

  if (pending(results).length > 0 && actionUrls(results).length > 0) {
    if (options.wait) {
      results = await waitForAccess(names, results, intervalSec, timeoutSec, json);
      if (!json) process.stdout.write(`\nAfter re-checking:\n${describeAccess(results, options.all)}`);
    } else if (!json && (await promptReturn("\nFinish on GitHub, then press Enter to re-check (Ctrl-C to stop): "))) {
      results = await fetchRepositoryAccess(names);
      process.stdout.write(`\nAfter re-checking:\n${describeAccess(results, options.all)}`);
    }
  }
  if (json) process.stdout.write(`${JSON.stringify({ repositories: results, allGranted: pending(results).length === 0 }, null, 2)}\n`);
  else if (pending(results).length === 0) {
    process.stdout.write(`\nThis is GitHub App access only. To have Ditto Review pull requests, run: heyditto review add <owner/name>\n`);
  }
  if (pending(results).length > 0) process.exitCode = 2;
}

/**
 * For `review add`: when the backend refused to link a repository, finds out
 * whether missing Ditto Code app access is why. Returns the repository's
 * access when it is not granted, or undefined when access is fine or cannot
 * be checked (an older backend), so the caller keeps the original error.
 */
export async function diagnoseLinkRefusal(name: string, error: unknown): Promise<RepositoryAccess | undefined> {
  if (!(error instanceof ApiError) || error.status !== 400) return undefined;
  let field: unknown;
  try {
    const body = JSON.parse(error.body) as { params?: { field?: unknown }; field?: unknown };
    field = body.params?.field ?? body.field;
  } catch {
    return undefined;
  }
  if (field !== "fullName" && !/fullName/.test(error.body)) return undefined;
  try {
    const [access] = await fetchRepositoryAccess([name]);
    return access && access.state !== ACCESS_GRANTED ? access : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Prints the access guidance for a refused `review add`, offers to open the
 * page, and on a terminal waits for the person to return. Resolves true when
 * a re-check shows access granted, so the caller can retry the add once.
 */
export async function guideAccessForAdd(access: RepositoryAccess, options: { open?: boolean; json: boolean }): Promise<boolean> {
  process.stderr.write(`Ditto Review could not be set up for ${access.repository} because the Ditto Code GitHub App cannot access it.\n`);
  process.stderr.write(describeAccess([access]));
  if (!access.actionUrl) return false;
  if (options.open) openInBrowser(access.actionUrl);
  if (options.json || !(await promptReturn("\nFinish on GitHub, then press Enter to re-check and add the repository (Ctrl-C to stop): "))) {
    process.stderr.write(`After granting access, run the same command again, or check with: heyditto review access ${access.repository} --wait\n`);
    return false;
  }
  let again: RepositoryAccess | undefined;
  try {
    [again] = await fetchRepositoryAccess([access.repository]);
  } catch {
    process.stderr.write(`Could not re-check just now. Run the same command again, or check with: heyditto review access ${access.repository} --wait\n`);
    return false;
  }
  if (again?.state === ACCESS_GRANTED) return true;
  process.stderr.write(`Still no access:\n${describeAccess(again ? [again] : [access])}`);
  return false;
}
