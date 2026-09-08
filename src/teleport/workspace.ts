import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { PROJECT_TYPES, type ProjectType, artifactDirs, detectTypesDetailed } from "./catalog.js";
import { git, isGitRepo } from "./git.js";
import { DEFAULT_EXCLUDES, isExcluded } from "./types.js";
import { DittoConfigNotFound, loadDittoConfig, summarize } from "../dittoconfig/load.js";
import type { DittoConfigSummary, EffectiveConfig } from "../dittoconfig/types.js";

/** Directories never entered while looking for projects (their contents are dependencies, not projects). */
const NEVER_DESCEND = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".hg", ".svn"]);

export type ProjectKind = "repo" | "worktree" | "project";

export interface DiscoveredProject {
  /** "/"-joined path relative to the workspace root; "." for the root itself. */
  relPath: string;
  kind: ProjectKind;
  /** Nearest enclosing repository (relPath) for a non-repo project; equals relPath for repos. */
  repo: string | null;
  types: string[];
  labels: string[];
  /** Project-relative regenerable directories from the catalog. */
  artifacts: string[];
}

export interface SymlinkNote {
  relPath: string;
  target: string;
  status: "kept" | "escapes-root" | "cycle" | "dangling";
}

export interface WorkspaceDiscovery {
  root: string;
  /** "repo" when the root itself is a repository, else "folder". */
  kind: "repo" | "folder";
  projects: DiscoveredProject[];
  repos: string[];
  symlinks: SymlinkNote[];
  /** Root entries (files or directories) that belong to no discovered project. */
  unrelated: string[];
  truncated: boolean;
}

export interface DiscoverOptions {
  /** Maximum depth below the root to look for projects (repos, worktrees, manifests). */
  maxDepth?: number;
  /** Stop scanning after this many directories and report `truncated`. */
  maxDirs?: number;
}

/**
 * Discovers the coding projects under a root: Git repositories and worktrees,
 * nested projects (a package inside a monorepo), and language manifests, with
 * their relative layout preserved. The root itself need not be a repository.
 * Symlinks are recorded but never followed; dependency trees are never entered.
 */
export async function discoverWorkspace(rootInput: string, opts: DiscoverOptions = {}): Promise<WorkspaceDiscovery> {
  const maxDepth = opts.maxDepth ?? 4;
  const maxDirs = opts.maxDirs ?? 20_000;
  const resolved = path.resolve(rootInput);
  const info = await stat(resolved).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`not a directory: ${resolved}`);
  const root = await realpath(resolved).catch(() => resolved);

  const projects: DiscoveredProject[] = [];
  const symlinks: SymlinkNote[] = [];
  const seenDirs = new Set<string>();
  let dirsVisited = 0;
  let truncated = false;

  const visit = async (dir: string, depth: number, repo: string | null, activeTypes: ReadonlySet<string>): Promise<boolean> => {
    if (dirsVisited++ > maxDirs) {
      truncated = true;
      return false;
    }
    const real = await realpath(dir).catch(() => dir);
    if (seenDirs.has(real)) return false;
    seenDirs.add(real);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    const names = new Set(entries.map((e) => e.name));
    const rel = toRel(root, dir);
    let kind: ProjectKind | null = null;
    if (names.has(".git")) {
      const dotGit = entries.find((e) => e.name === ".git");
      kind = dotGit?.isDirectory() ? "repo" : "worktree";
    }
    // A suffix-only match (a stray .py file) inside a project that already has
    // that type is source, not a nested project; a marker file always is one.
    const types = detectTypesDetailed(names)
      .filter((m) => m.byMarker || !activeTypes.has(m.type.id))
      .map((m) => m.type);
    const thisRepo = kind ? rel : repo;
    let found = false;
    if (kind || types.length > 0) {
      projects.push({
        relPath: rel,
        kind: kind ?? "project",
        repo: thisRepo,
        types: types.map((t) => t.id),
        labels: types.map((t) => t.label),
        artifacts: artifactDirs(types),
      });
      found = true;
    }
    if (depth >= maxDepth) return found;
    const nextActive = new Set([...activeTypes, ...types.map((t) => t.id)]);
    const artifactSet = new Set(artifactDirs(types).map((a) => a.split("/")[0]));
    for (const e of entries) {
      if (e.isSymbolicLink()) {
        symlinks.push(await classifySymlink(root, path.join(dir, e.name), seenDirs));
        continue;
      }
      if (!e.isDirectory()) continue;
      if (NEVER_DESCEND.has(e.name) || artifactSet.has(e.name)) continue;
      if (e.name.startsWith(".") && e.name !== ".ditto") continue;
      const childFound = await visit(path.join(dir, e.name), depth + 1, thisRepo, nextActive);
      found = found || childFound;
    }
    return found;
  };
  await visit(root, 0, null, new Set());

  projects.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const repos = projects.filter((p) => p.kind !== "project").map((p) => p.relPath);
  const rootIsRepo = projects.some((p) => p.relPath === "." && p.kind !== "project");

  // Root entries that no project claims: documents and unknown files the user
  // would lose if the whole parent folder were offloaded. A symlink whose target
  // stays inside the workspace is preserved by the target's capture, so it does
  // not count; one that leaves the workspace does.
  const unrelated: string[] = [];
  if (!rootIsRepo) {
    const claimed = new Set(projects.map((p) => p.relPath.split("/")[0]));
    const keptLinks = new Set(symlinks.filter((s) => s.status === "kept" || s.status === "cycle").map((s) => s.relPath));
    for (const e of await readdir(root, { withFileTypes: true })) {
      if (e.name === ".ditto" || e.name === ".DS_Store") continue;
      if (claimed.has(e.name) || keptLinks.has(e.name)) continue;
      unrelated.push(e.name + (e.isDirectory() ? "/" : ""));
    }
    unrelated.sort();
  }
  return { root, kind: rootIsRepo ? "repo" : "folder", projects, repos, symlinks, unrelated, truncated };
}

async function classifySymlink(root: string, linkPath: string, seenDirs: Set<string>): Promise<SymlinkNote> {
  const rel = toRel(root, linkPath);
  let target = "";
  try {
    target = await readlink(linkPath);
  } catch {
    return { relPath: rel, target, status: "dangling" };
  }
  const abs = path.resolve(path.dirname(linkPath), target);
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    return { relPath: rel, target, status: "dangling" };
  }
  if (!real.startsWith(root + path.sep) && real !== root) return { relPath: rel, target, status: "escapes-root" };
  if (seenDirs.has(real) || real === root || path.dirname(linkPath).startsWith(real + path.sep)) return { relPath: rel, target, status: "cycle" };
  return { relPath: rel, target, status: "kept" };
}

function toRel(root: string, p: string): string {
  const rel = path.relative(root, p).split(path.sep).join("/");
  return rel === "" ? "." : rel;
}

// ---------------------------------------------------------------------------
// Capture plan

export interface ExcludeRule {
  /** Gitignore-style pattern as fed to isExcluded (path-anchored when it contains "/"). */
  pattern: string;
  source: "builtin" | "catalog" | "config";
  /** Human reason, e.g. "Node: node_modules is regenerable (npm install)". */
  reason: string;
  bytes: number;
  files: number;
}

export interface RepoPlan {
  relPath: string;
  kind: ProjectKind;
  /** Nested projects inside this repo (relative to the repo). */
  projects: Array<{ relPath: string; types: string[]; labels: string[] }>;
  rules: ExcludeRule[];
  /** Forced back in by .ditto include. */
  includes: string[];
  /** Effective exclude patterns handed to capture (repo-relative). */
  excludes: string[];
  /** Artifact directories that are git-tracked: excluded from the working tree but their bytes stay in history. */
  trackedArtifacts: string[];
  includedBytes: number;
  includedFiles: number;
  excludedBytes: number;
  excludedFiles: number;
  estimatePartial: boolean;
  dittoConfig?: DittoConfigSummary;
  configWarnings: string[];
}

export interface CapturePlan {
  root: string;
  kind: "repo" | "folder";
  repos: RepoPlan[];
  symlinks: SymlinkNote[];
  unrelated: string[];
  conflicts: string[];
  truncated: boolean;
  totals: { includedBytes: number; excludedBytes: number };
}

export interface PlanOptions extends DiscoverOptions {
  /** Cap on files visited per repo while estimating bytes; beyond it estimates are marked partial. */
  maxEstimateFiles?: number;
}

/**
 * Builds the capture plan: per repository, the detected project types, the
 * effective exclusion rules (built-in, per-type catalog scoped to the project's
 * path, `.ditto/` overrides) with byte estimates and reasons, tracked-artifact
 * flags, symlink notes and unrelated root entries. Nothing is uploaded.
 */
export async function planCapture(rootInput: string, opts: PlanOptions = {}): Promise<CapturePlan> {
  const discovery = await discoverWorkspace(rootInput, opts);
  const conflicts: string[] = [];
  const repos: RepoPlan[] = [];
  for (const repoRel of discovery.repos) {
    const repoDir = repoRel === "." ? discovery.root : path.join(discovery.root, repoRel);
    const nested = discovery.projects.filter((p) => p.repo === repoRel);
    const rules: ExcludeRule[] = DEFAULT_EXCLUDES.map((pattern) => ({ pattern, source: "builtin" as const, reason: "built-in: secrets, caches and build output never travel", bytes: 0, files: 0 }));
    for (const p of nested) {
      const base = p.relPath === repoRel ? "" : toRepoRel(repoRel, p.relPath) + "/";
      for (const t of p.types) {
        const type = PROJECT_TYPES.find((x) => x.id === t) as ProjectType;
        for (const a of type.artifacts) {
          rules.push({ pattern: `${base}${a}/`, source: "catalog", reason: `${type.label}: ${a} is regenerable`, bytes: 0, files: 0 });
        }
      }
    }
    let eff: EffectiveConfig | undefined;
    let dittoConfig: DittoConfigSummary | undefined;
    const configWarnings: string[] = [];
    try {
      eff = await loadDittoConfig(repoDir, { workspaceDir: discovery.kind === "folder" ? discovery.root : undefined });
      dittoConfig = summarize(eff);
      configWarnings.push(...eff.warnings);
      for (const ex of eff.config.teleport.exclude ?? []) rules.push({ pattern: ex, source: "config", reason: ".ditto/config.toml teleport.exclude", bytes: 0, files: 0 });
    } catch (err) {
      if (!(err instanceof DittoConfigNotFound)) conflicts.push(`${repoRel}: ${(err as Error).message}`);
    }
    const includes = eff?.config.teleport.include ?? [];
    // Dedupe patterns; when a built-in and a catalog/config rule name the same
    // pattern, keep the more specific reason (config > catalog > builtin).
    const rank = { config: 0, catalog: 1, builtin: 2 } as const;
    const byPattern = new Map<string, ExcludeRule>();
    for (const r of rules) {
      const prev = byPattern.get(r.pattern);
      if (!prev || rank[r.source] < rank[prev.source]) byPattern.set(r.pattern, r);
    }
    const uniqueRules = [...byPattern.values()];
    const excludes = uniqueRules.map((r) => r.pattern).filter((p) => !includes.some((inc) => samePattern(inc, p)));
    const est = await estimate(repoDir, uniqueRules, includes, opts.maxEstimateFiles ?? 250_000);
    const trackedArtifacts: string[] = [];
    if (isGitRepo(repoDir)) {
      for (const r of uniqueRules.filter((r) => r.source === "catalog")) {
        const dir = r.pattern.replace(/\/$/, "");
        const tracked = git(["ls-files", "--error-unmatch", "--", dir], repoDir);
        if (tracked.ok && tracked.stdout.trim()) trackedArtifacts.push(dir);
      }
    }
    repos.push({
      relPath: repoRel,
      kind: nested.find((p) => p.relPath === repoRel)?.kind ?? "repo",
      projects: nested.map((p) => ({ relPath: p.relPath === repoRel ? "." : toRepoRel(repoRel, p.relPath), types: p.types, labels: p.labels })),
      rules: uniqueRules,
      includes,
      excludes,
      trackedArtifacts,
      includedBytes: est.includedBytes,
      includedFiles: est.includedFiles,
      excludedBytes: est.excludedBytes,
      excludedFiles: est.excludedFiles,
      estimatePartial: est.partial,
      dittoConfig,
      configWarnings,
    });
  }
  for (const s of discovery.symlinks) {
    if (s.status === "escapes-root") conflicts.push(`${s.relPath} → ${s.target}: symlink leaves the workspace; not followed`);
    if (s.status === "cycle") conflicts.push(`${s.relPath} → ${s.target}: symlink cycle; not followed`);
  }
  if (discovery.truncated) conflicts.push("scan truncated: too many directories; narrow the root or raise the limit");
  return {
    root: discovery.root,
    kind: discovery.kind,
    repos,
    symlinks: discovery.symlinks,
    unrelated: discovery.unrelated,
    conflicts,
    truncated: discovery.truncated,
    totals: {
      includedBytes: repos.reduce((n, r) => n + r.includedBytes, 0),
      excludedBytes: repos.reduce((n, r) => n + r.excludedBytes, 0),
    },
  };
}

function toRepoRel(repoRel: string, projectRel: string): string {
  return repoRel === "." ? projectRel : projectRel.slice(repoRel.length + 1);
}

function samePattern(a: string, b: string): boolean {
  return a.replace(/\/$/, "") === b.replace(/\/$/, "");
}

interface Estimate {
  includedBytes: number;
  includedFiles: number;
  excludedBytes: number;
  excludedFiles: number;
  partial: boolean;
}

/** Walks the working tree once, attributing every file to the first matching rule (or to "included"). */
async function estimate(repoDir: string, rules: ExcludeRule[], includes: string[], maxFiles: number): Promise<Estimate> {
  const out: Estimate = { includedBytes: 0, includedFiles: 0, excludedBytes: 0, excludedFiles: 0, partial: false };
  let visited = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(repoDir, abs).split(path.sep).join("/");
      if (e.isSymbolicLink()) continue;
      if (++visited > maxFiles) {
        out.partial = true;
        return;
      }
      const forced = includes.some((inc) => isExcluded(rel, [inc]) || rel === inc.replace(/\/$/, ""));
      const rule = forced ? undefined : rules.find((r) => isExcluded(rel + (e.isDirectory() ? "/x" : ""), [r.pattern]));
      if (e.isDirectory()) {
        if (rule) {
          const size = await sizeOf(abs, maxFiles, () => (visited++, visited > maxFiles));
          rule.bytes += size.bytes;
          rule.files += size.files;
          out.excludedBytes += size.bytes;
          out.excludedFiles += size.files;
          if (size.partial) out.partial = true;
          continue;
        }
        await walk(abs);
        continue;
      }
      const s = await lstat(abs).catch(() => undefined);
      const size = s?.size ?? 0;
      if (rule) {
        rule.bytes += size;
        rule.files += 1;
        out.excludedBytes += size;
        out.excludedFiles += 1;
      } else {
        out.includedBytes += size;
        out.includedFiles += 1;
      }
    }
  };
  await walk(repoDir);
  return out;
}

async function sizeOf(dir: string, maxFiles: number, over: () => boolean): Promise<{ bytes: number; files: number; partial: boolean }> {
  let bytes = 0;
  let files = 0;
  let partial = false;
  const walk = async (d: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (partial) return;
      if (over()) {
        partial = true;
        return;
      }
      const abs = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        await walk(abs);
        continue;
      }
      const s = await lstat(abs).catch(() => undefined);
      bytes += s?.size ?? 0;
      files += 1;
    }
  };
  await walk(dir);
  void maxFiles;
  return { bytes, files, partial };
}

// ---------------------------------------------------------------------------
// Offload safety

export interface OffloadBlocker {
  path: string;
  reason: string;
}

/**
 * Files beneath a proposed deletion root that a capture would not preserve:
 * root entries outside every discovered project, and symlinks that leave the
 * workspace. Regenerable exclusions are not blockers (they are approved
 * omissions); everything else unknown is.
 */
export async function offloadBlockers(plan: CapturePlan): Promise<OffloadBlocker[]> {
  const out = new Map<string, OffloadBlocker>();
  const add = (b: OffloadBlocker): void => {
    if (!out.has(b.path)) out.set(b.path, b);
  };
  for (const s of plan.symlinks) {
    if (s.status === "escapes-root") add({ path: s.relPath, reason: `symlink to ${s.target} outside the workspace` });
  }
  for (const u of plan.unrelated) add({ path: u, reason: "not part of any discovered project; it would be lost" });
  for (const r of plan.repos) {
    if (r.estimatePartial) add({ path: r.relPath, reason: "capture estimate is partial; scan the repository fully before offloading" });
  }
  if (plan.truncated) add({ path: ".", reason: "discovery was truncated; some projects may be unaccounted for" });
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}
