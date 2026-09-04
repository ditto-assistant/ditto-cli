import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import {
  type InferenceEndpoint,
  type InferenceKey,
  createKey,
  listEndpoints,
  revokeKey,
} from "../api.js";
import { readStoredAuth } from "../store.js";
import { planClaude } from "./claude.js";
import { planCodex } from "./codex.js";
import { type SessionRecord, latestSession, readSession, writeSession } from "./sessions.js";
import {
  type Harness,
  type HarnessPlan,
  KEY_EXPIRIES,
  type KeyExpiry,
  type PlanInput,
  childEnv,
  maskKey,
  stripSeparator,
} from "./types.js";
import { defaultWorktreeName, ensureWorktree } from "./worktree.js";

export interface LaunchOptions {
  endpoint?: string;
  budget?: string;
  expires?: string;
  keepKey?: boolean;
  session?: string;
  resume?: string | boolean;
  continue?: boolean;
  yolo?: boolean;
  yellow?: boolean;
  plan?: boolean;
  prompt?: string;
  model?: string;
  worktree?: string | boolean;
  name?: string;
  dryRun?: boolean;
}

const DRY_RUN_KEY = "ditto_inf_<minted-at-launch>";

function log(line: string): void {
  process.stderr.write(`ditto: ${line}\n`);
}

function planFor(harness: Harness, input: PlanInput): HarnessPlan {
  return harness === "claude" ? planClaude(input) : planCodex(input);
}

function binaryAvailable(command: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [command], { stdio: "ignore" }).status === 0;
}

function parseBudget(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/[_,]/g, ""));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--budget must be a positive integer token count, got "${raw}"`);
  return n;
}

function parseExpiry(raw: string | undefined): KeyExpiry {
  const value = (raw ?? "1d").trim();
  if ((KEY_EXPIRIES as readonly string[]).includes(value)) return value as KeyExpiry;
  throw new Error(`--expires must be one of: ${KEY_EXPIRIES.join(", ")}`);
}

function formatSpend(e: InferenceEndpoint): string {
  const used = e.spentTokens ?? 0;
  if (e.spendLimitTokens == null || e.spendLimitTokens < 0) return `${used.toLocaleString()} tokens used, no limit`;
  return `${used.toLocaleString()} / ${e.spendLimitTokens.toLocaleString()} tokens${e.spendPeriod && e.spendPeriod !== "never" ? ` per ${e.spendPeriod.replace(/ly$/, "")}` : ""}`;
}

async function pickEndpoint(endpoints: InferenceEndpoint[]): Promise<InferenceEndpoint> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(
      "no endpoint selected. Pass --endpoint <slug>, or set a default with `heyditto endpoints --set-default <slug>`.",
    );
  }
  process.stderr.write("Ditto inference endpoints:\n\n");
  endpoints.forEach((e, i) => {
    process.stderr.write(`  ${i + 1}) ${e.slug}  ${e.name !== e.slug ? `(${e.name})  ` : ""}model=${e.model}\n`);
    process.stderr.write(`     ${formatSpend(e)}${e.recordTrace ? "  · traces on" : "  · traces off"}\n`);
  });
  process.stderr.write("\n");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const answer = (await rl.question(`Connect to which endpoint? [1-${endpoints.length}] `)).trim();
      const idx = Number(answer);
      if (Number.isInteger(idx) && idx >= 1 && idx <= endpoints.length) return endpoints[idx - 1];
      const bySlug = endpoints.find((e) => e.slug === answer || e.id === answer);
      if (bySlug) return bySlug;
      process.stderr.write("Pick a number from the list.\n");
    }
  } finally {
    rl.close();
  }
}

async function resolveEndpoint(
  wanted: string | undefined,
  endpoints: InferenceEndpoint[],
): Promise<InferenceEndpoint> {
  if (endpoints.length === 0) {
    throw new Error(
      "you have no inference endpoints yet. Create one in the Ditto app: Settings → Developer → Inference endpoints.",
    );
  }
  const stored = (await readStoredAuth())?.defaultEndpoint;
  const target = wanted?.trim() || stored?.trim();
  if (target) {
    const match = endpoints.find((e) => e.slug === target || e.id === target);
    if (match) return match;
    if (wanted) {
      throw new Error(`no endpoint named "${target}". Available: ${endpoints.map((e) => e.slug).join(", ")}`);
    }
    log(`default endpoint "${target}" no longer exists; pick another`);
  }
  if (endpoints.length === 1) return endpoints[0];
  return pickEndpoint(endpoints);
}

function forwardSignals(child: ChildProcess): () => void {
  // Ctrl+C reaches the child directly through the shared terminal; the
  // wrapper only has to survive it so it can revoke the key afterwards.
  const onInt = () => {
    /* keep running until the harness exits */
  };
  const onTerm = () => child.kill("SIGTERM");
  const onHup = () => child.kill("SIGHUP");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onHup);
  return () => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    process.off("SIGHUP", onHup);
  };
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : null)));
  });
}

/** Launches a coding harness against a Ditto inference endpoint with a temporary key. */
export async function launchHarness(harness: Harness, rawArgs: string[], options: LaunchOptions): Promise<void> {
  const passthrough = stripSeparator(rawArgs);
  const budget = parseBudget(options.budget);
  const expiresIn = parseExpiry(options.expires);
  if (options.plan && harness !== "claude") throw new Error("--plan is only supported for claude");
  if ([options.yolo, options.yellow, options.plan].filter(Boolean).length > 1) {
    throw new Error("choose only one of --yolo, --yellow, --plan");
  }
  if (options.resume !== undefined && options.continue) throw new Error("use either --resume or --continue");
  if (options.resume !== undefined && options.session) throw new Error("--session cannot be combined with --resume");

  if (!options.dryRun && !binaryAvailable(harness)) {
    const hint = planFor(harness, {
      baseUrl: "",
      apiKey: "",
      sessionId: "",
      passthrough: [],
      env: {},
    }).installHint;
    throw new Error(`"${harness}" is not on your PATH; ${hint}`);
  }

  // Resume: reuse the local record's Ditto session id so the traces stay in
  // the same thread; a fresh key is minted every launch.
  let record: SessionRecord | undefined;
  let resumeLast = Boolean(options.continue);
  if (options.resume !== undefined) {
    record =
      typeof options.resume === "string"
        ? await readSession(options.resume)
        : await latestSession(harness, process.cwd());
    if (!record) {
      throw new Error(
        typeof options.resume === "string"
          ? `no local session "${options.resume}"; see \`heyditto sessions\``
          : `no previous ${harness} session to resume; see \`heyditto sessions\``,
      );
    }
    if (record.harness !== harness) throw new Error(`session ${record.id} was a ${record.harness} session`);
    if (!record.harnessSessionId) resumeLast = true;
  }

  const catalog = await listEndpoints();
  const endpoint = await resolveEndpoint(options.endpoint ?? record?.endpointSlug, catalog.endpoints);

  let cwd = record?.worktree ?? process.cwd();
  let worktreePath: string | undefined = record?.worktree;
  if (options.worktree !== undefined && options.worktree !== false) {
    const name = typeof options.worktree === "string" ? options.worktree : defaultWorktreeName(harness);
    if (options.dryRun) {
      log(`would create worktree .worktrees/${name}`);
    } else {
      const wt = await ensureWorktree(process.cwd(), name);
      log(`${wt.created ? "created" : "reusing"} worktree ${wt.path} (branch ${wt.branch})`);
      cwd = wt.path;
      worktreePath = wt.path;
    }
  }

  const sessionId = record?.id ?? options.session?.trim() ?? randomUUID();
  if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(sessionId)) {
    throw new Error("--session must match ^[A-Za-z0-9._:@-]{1,128}$");
  }
  const harnessSessionId = record?.harnessSessionId ?? (harness === "claude" && !resumeLast ? sessionId : undefined);
  const model = options.model ?? record?.model ?? (harness === "codex" ? endpoint.slug : undefined);
  const now = new Date().toISOString();

  const keyName = options.name?.trim() || `cli:${harness}:${os.hostname()}`;
  let key: InferenceKey | undefined;
  if (!options.dryRun) {
    key = await createKey(endpoint.id, {
      name: keyName,
      expiresIn,
      ...(budget !== undefined ? { spendLimitTokens: budget, spendPeriod: "never" } : {}),
    });
  }

  const plan = planFor(harness, {
    baseUrl: catalog.baseUrl,
    apiKey: key?.key ?? DRY_RUN_KEY,
    sessionId,
    model,
    resumeId: record ? record.harnessSessionId : undefined,
    resumeLast,
    prompt: options.prompt,
    yolo: options.yolo,
    yellow: options.yellow,
    plan: options.plan,
    passthrough,
    env: process.env,
  });

  const banner = [
    `endpoint=${endpoint.slug}`,
    `model=${model ?? "(harness default → endpoint routes)"}`,
    `key=${key ? `…${key.keyHint || maskKey(key.key ?? "")}` : "(dry run)"}`,
    `expires=${expiresIn}${options.keepKey ? "" : " (revoked on exit)"}`,
    budget !== undefined ? `budget=${budget.toLocaleString()} tokens` : undefined,
    `session=${sessionId}`,
  ]
    .filter(Boolean)
    .join("  ");
  log(banner);
  log(`traces: Ditto app → Settings → Developer → Inference endpoints → ${endpoint.slug}`);

  if (options.dryRun) {
    const env = Object.fromEntries(
      Object.entries(plan.envSet).map(([k, v]) => [k, v === DRY_RUN_KEY ? "<key>" : v]),
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          harness,
          command: plan.command,
          args: plan.args,
          env,
          unsetEnv: plan.envUnset,
          cwd,
          endpoint: { id: endpoint.id, slug: endpoint.slug, model: endpoint.model },
          sessionId,
          key: { name: keyName, expiresIn, spendLimitTokens: budget ?? null },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (!key) throw new Error("internal: key was not minted");

  const nextRecord: SessionRecord = {
    id: sessionId,
    harness,
    endpointId: endpoint.id,
    endpointSlug: endpoint.slug,
    keyId: key.id,
    keyHint: key.keyHint,
    harnessSessionId,
    cwd: record?.cwd ?? process.cwd(),
    worktree: worktreePath,
    model,
    createdAt: record?.createdAt ?? now,
    lastLaunchedAt: now,
    launches: (record?.launches ?? 0) + 1,
  };
  await writeSession(nextRecord);

  const child = spawn(plan.command, plan.args, {
    stdio: "inherit",
    env: childEnv(plan, process.env),
    cwd,
  });
  const restore = forwardSignals(child);
  let exitCode: number | null = null;
  try {
    exitCode = await waitForExit(child);
  } finally {
    restore();
    if (options.keepKey) {
      log(`kept key …${key.keyHint} (expires ${expiresIn}); revoke it from the Ditto app when done`);
    } else {
      try {
        await revokeKey(endpoint.id, key.id);
        log(`revoked session key …${key.keyHint}; thread kept (resume with: heyditto ${harness} --resume ${sessionId})`);
      } catch (err) {
        log(`could not revoke key …${key.keyHint} (${err instanceof Error ? err.message : String(err)}); it expires in ${expiresIn}`);
      }
    }
    await writeSession({ ...nextRecord, endedAt: new Date().toISOString(), exitCode });
  }
  process.exitCode = exitCode ?? 1;
}
