/** Public receipt metadata only. Engine artifacts and source caches stay server-side. */
export interface ReviewWorkUnit {
  path: string;
  lens: number;
  model: string;
  reason?: string;
  scope?: "selected" | "affected_historical";
}
export interface ReviewReuse {
  version: 1;
  sourceRunId?: string;
  analysisScope?: "anchored_selected_files" | "selected_diff";
  reused?: ReviewWorkUnit[];
  reviewed?: ReviewWorkUnit[];
  unfinished?: ReviewWorkUnit[];
  retained?: ReviewWorkUnit[];
  findings?: { id: string; path: string; state: string; sourceRunId?: string; previousPath?: string; reason?: string; scope?: string }[];
  historicalCostUsd?: number;
  currentCostUsd?: number;
  round?: number;
  roundLimit?: number;
  escalationSuggested?: boolean;
  suggestedProfile?: string;
  publicationScope?: "linked_author_code" | "local_only_private_context";
}
export interface LocalReviewScope {
  workspaceKind: "personal" | "company";
  scopeKey: string;
  companyId?: string;
  userId?: string;
  repositoryId: string;
  repository: string;
  requesterId: string;
  policyFingerprint?: string;
  engineIdentity?: string;
}

export function formatReviewReuse(reuse: ReviewReuse | undefined): string {
  if (!reuse) return "";
  const lines: string[] = [];
  if (reuse.sourceRunId) lines.push(`Prior receipt: ${reuse.sourceRunId}`);
  if (reuse.analysisScope) lines.push(`Analysis scope: ${reuse.analysisScope === "anchored_selected_files" ? "accumulated anchored changes in selected files" : "selected diff"}`);
  for (const [name, units] of [["Reused", reuse.reused], ["Reviewed", reuse.reviewed], ["Unfinished", reuse.unfinished]] as const) {
    const selected = units?.filter(unit => unit.scope !== "affected_historical").length ?? 0;
    const historical = units?.filter(unit => unit.scope === "affected_historical").length ?? 0;
    lines.push(`${name}: ${selected} selected work units; ${historical} affected historical work units`);
    for (const unit of units ?? []) lines.push(`  ${unit.path} · lens ${unit.lens} · ${unit.model}${unit.scope === "affected_historical" ? " · affected historical scope" : ""}${unit.reason ? ` · ${unit.reason}` : ""}`);
  }
  lines.push(`Retained historical evidence: ${reuse.retained?.length ?? 0} work units (outside current coverage)`);
  for (const unit of reuse.retained ?? []) lines.push(`  ${unit.path} · lens ${unit.lens} · ${unit.model}${unit.reason ? ` · ${unit.reason}` : ""}`);
  for (const finding of reuse.findings ?? []) lines.push(`Finding lineage: ${finding.path} · ${finding.state}${finding.scope ? ` · ${finding.scope}` : ""}${finding.previousPath ? ` · previously ${finding.previousPath}` : ""}${finding.reason ? ` · ${finding.reason}` : ""}`);
  if (reuse.currentCostUsd !== undefined) lines.push(`Current inference cost: $${reuse.currentCostUsd.toFixed(6)}`);
  if (reuse.historicalCostUsd !== undefined) lines.push(`Historical inference cost: $${reuse.historicalCostUsd.toFixed(6)} (not a new charge)`);
  if (reuse.round !== undefined) lines.push(`Reuse round: ${reuse.round}${reuse.roundLimit !== undefined ? `/${reuse.roundLimit}` : ""}`);
  if (reuse.escalationSuggested) lines.push(`Suggested next review: ${reuse.suggestedProfile ?? "standard"}; run it explicitly to authorize another review.`);
  if (reuse.publicationScope === "local_only_private_context") lines.push("Publication scope: private local context; this receipt cannot be inherited by a PR review.");
  else if (reuse.publicationScope) lines.push("Publication scope: linked authored code, subject to current server policy and dependency checks.");
  return lines.join("\n") + "\n";
}
