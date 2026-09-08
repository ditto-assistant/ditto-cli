import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { DittoConfigError, DittoConfigNotFound, loadDittoConfig, summarize } from "./load.js";
import { CONFIG_FILE, DITTO_DIR, MISE_FILE } from "./types.js";
import { MISE_TOOL_FOR_TYPE } from "../teleport/catalog.js";
import { type CapturePlan, discoverWorkspace } from "../teleport/workspace.js";
import { formatBytes } from "../teleport/types.js";

function out(line: string): void {
  process.stdout.write(line + "\n");
}
function err(line: string): void {
  process.stderr.write(line + "\n");
}

/** `heyditto repo init|validate|show` — the repository's `.ditto/` contract. */
export function registerConfigCommands(program: Command, addExamples: (c: Command, ex: string) => Command): void {
  const config = program.command("repo").description("scaffold, validate and inspect a repository's .ditto/ configuration");
  addExamples(
    config
      .command("init [path]")
      .description("write a starter .ditto/ (config.toml + mise.toml) from the projects detected in a repository")
      .option("--force", "overwrite existing .ditto files")
      .action(cmdInit),
    `  heyditto repo init              scaffold .ditto/ for the current repository
  heyditto repo init ~/code/app   scaffold for another checkout`,
  );
  config
    .command("validate [path]")
    .description("validate .ditto/config.toml, .ditto/endpoints/*.toml and the mise choice; exit 1 on any problem")
    .option("--workspace <dir>", "parent folder whose .ditto/ supplies defaults")
    .action(async (pathArg: string | undefined, options: { workspace?: string }) => {
      const dir = path.resolve(pathArg ?? process.cwd());
      try {
        const eff = await loadDittoConfig(dir, { workspaceDir: options.workspace });
        for (const w of eff.warnings) err(`warning: ${w}`);
        out(`ok: ${path.join(DITTO_DIR, CONFIG_FILE)} is valid (schema v${eff.config.version}, ${Object.keys(eff.endpoints).length} endpoint(s), mise: ${eff.misePath || "none"}, digest ${summarize(eff).digest.slice(0, 12)})`);
      } catch (e) {
        if (e instanceof DittoConfigNotFound) {
          err(`no ${DITTO_DIR}/${CONFIG_FILE} in ${dir}; run \`heyditto repo init\` to create one`);
        } else if (e instanceof DittoConfigError) {
          err(e.message);
        } else {
          throw e;
        }
        process.exitCode = 1;
      }
    });
  config
    .command("show [path]")
    .description("print the effective configuration with the layer each table came from")
    .option("--workspace <dir>", "parent folder whose .ditto/ supplies defaults")
    .option("--json", "machine-readable output")
    .action(async (pathArg: string | undefined, options: { workspace?: string; json?: boolean }) => {
      const dir = path.resolve(pathArg ?? process.cwd());
      try {
        const eff = await loadDittoConfig(dir, { workspaceDir: options.workspace });
        if (options.json) {
          out(JSON.stringify({ ...eff, summary: summarize(eff) }, null, 2));
          return;
        }
        out(`repository: ${eff.config.repository.name}   digest: ${summarize(eff).digest.slice(0, 12)}   layers: ${eff.layers.join(" < ") || "defaults"}`);
        for (const [table, src] of Object.entries(eff.sources).sort()) {
          out(`  ${table.padEnd(24)} ${src.layer}${src.path ? `  (${path.relative(dir, src.path)})` : ""}`);
        }
        out(`  mise: ${eff.misePath || "none"}`);
        for (const w of eff.warnings) err(`warning: ${w}`);
      } catch (e) {
        if (e instanceof DittoConfigNotFound || e instanceof DittoConfigError) {
          err(e.message);
          process.exitCode = 1;
          return;
        }
        throw e;
      }
    });
}

async function cmdInit(pathArg: string | undefined, options: { force?: boolean }): Promise<void> {
  const dir = path.resolve(pathArg ?? process.cwd());
  const discovery = await discoverWorkspace(dir, { maxDepth: 2 });
  const types = [...new Set(discovery.projects.flatMap((p) => p.types))];
  const tools = [...new Set(types.map((t) => MISE_TOOL_FOR_TYPE[t]).filter(Boolean))];
  const dittoDir = path.join(dir, DITTO_DIR);
  await mkdir(path.join(dittoDir, "endpoints"), { recursive: true });
  const configPath = path.join(dittoDir, CONFIG_FILE);
  const misePath = path.join(dittoDir, MISE_FILE);
  const rootMise = path.join(dir, MISE_FILE);
  if (!options.force && (await exists(configPath))) {
    err(`${path.relative(process.cwd(), configPath)} exists; pass --force to overwrite`);
    process.exitCode = 1;
    return;
  }
  const name = path.basename(dir).toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  const labels = discovery.projects.filter((p) => p.labels.length).map((p) => `${p.relPath}: ${p.labels.join(", ")}`);
  const config = `# Ditto repository configuration — see https://heyditto.ai/docs/ditto-config
version = 1

[repository]
name = "${name}"
# default_endpoint = "work"   # a name from .ditto/endpoints/ or an existing endpoint slug

[teleport]
# capture_roots = ["."]
# exclude = ["fixtures/large/"]     # on top of the built-in and per-language rules
# include = ["vendor/"]             # force a path back in
# required_mirrors = ["ditto-primary", "ditto-secondary"]

[teleport.harness]
kind = "auto"          # auto | claude-code | codex | none
session = "latest"     # latest | explicit

[teleport.offload]
unpushed = "refuse"    # refuse | acknowledge

[environment]
${(await exists(rootMise)) ? 'mise_config = "mise.toml"' : `mise_config = "${DITTO_DIR}/${MISE_FILE}"`}
# [environment.vars]
# DITTO_ENV = "local"
# [environment.secrets]
# OPENAI_API_KEY = "secret://openai/api-key"   # references only, never values

[tasks]
# setup = "mise:setup"
# test = "npm test"

[policy.repair]
max_attempts = 3
install_only = true
`;
  await writeFile(configPath, config);
  out(`wrote ${path.relative(process.cwd(), configPath)}`);
  if (!(await exists(rootMise)) && (options.force || !(await exists(misePath)))) {
    const toolLines = tools.length ? tools.map((t) => `${t} = "latest"   # pin a version before relying on it`).join("\n") : "# node = \"22\"";
    await writeFile(
      misePath,
      `# Tools, environment and tasks for this repository (https://mise.jdx.dev).
# Detected: ${labels.join("; ") || "no known project types"}
[tools]
${toolLines}

[env]
# NON-secret values only; secrets live in Ditto Secrets and are referenced from .ditto/config.toml

[tasks.setup]
run = "echo 'declare your setup here'"
`,
    );
    out(`wrote ${path.relative(process.cwd(), misePath)}`);
  } else if (await exists(rootMise)) {
    out(`kept existing ${MISE_FILE} (declared as environment.mise_config)`);
  }
  await writeFile(path.join(dittoDir, ".gitignore"), "local.toml\n");
  out(`wrote ${path.relative(process.cwd(), path.join(dittoDir, ".gitignore"))}`);
  for (const l of labels) out(`  detected ${l}`);
  out("next: review .ditto/config.toml, then `heyditto repo validate` and `heyditto teleport plan`");
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

/** Human rendering of a capture plan. */
export function formatCapturePlan(plan: CapturePlan): string[] {
  const lines: string[] = [];
  lines.push(`${plan.kind === "repo" ? "repository" : "folder"} ${plan.root}: ${plan.repos.length} repo(s), ${formatBytes(plan.totals.includedBytes)} to capture, ${formatBytes(plan.totals.excludedBytes)} excluded`);
  for (const r of plan.repos) {
    const kinds = r.projects.map((p) => `${p.relPath === "." ? "" : p.relPath + ": "}${p.labels.join("/") || "unknown"}`).join(", ");
    lines.push(`  ${r.relPath}  [${r.kind}]  ${kinds}`);
    lines.push(`    include ${formatBytes(r.includedBytes)} in ${r.includedFiles} files${r.estimatePartial ? " (estimate partial)" : ""}`);
    for (const rule of r.rules.filter((x) => x.bytes > 0 || x.source === "config").sort((a, b) => b.bytes - a.bytes)) {
      lines.push(`    exclude ${rule.pattern.padEnd(40)} ${formatBytes(rule.bytes).padStart(10)}  ${rule.reason}`);
    }
    for (const inc of r.includes) lines.push(`    force-include ${inc}  (.ditto teleport.include)`);
    for (const t of r.trackedArtifacts) lines.push(`    note: ${t} is git-tracked; excluded from the working tree but its bytes remain in history packs`);
    if (r.dittoConfig) lines.push(`    .ditto: digest ${r.dittoConfig.digest.slice(0, 12)} (${(r.dittoConfig.layers ?? []).join(" < ") || "defaults"})${r.dittoConfig.misePath ? `, mise ${r.dittoConfig.misePath}` : ""}`);
    for (const w of r.configWarnings) lines.push(`    warning: ${w}`);
  }
  for (const s of plan.symlinks) lines.push(`  symlink ${s.relPath} → ${s.target}: ${s.status}`);
  for (const u of plan.unrelated) lines.push(`  unrelated: ${u}  (not part of any project; blocks a whole-folder offload)`);
  for (const c of plan.conflicts) lines.push(`  conflict: ${c}`);
  if (plan.repos.length === 0) lines.push("  no repositories found");
  return lines;
}

/** Read helper for tests and scripts. */
export async function readText(p: string): Promise<string> {
  return readFile(p, "utf8");
}
