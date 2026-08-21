import type { AgentKind } from "./contracts.js";
import {
  AGENT_ACTION_REPOSITORIES,
  AGENT_BOT_ALLOWLIST_INPUTS,
  agentCredentialInputs,
  CHECKOUT_ACTION_REPOSITORY,
  UPLOAD_ARTIFACT_ACTION_REPOSITORY,
} from "./templates.js";

export type WorkflowFindingCode =
  | "workflow_not_object"
  | "missing_issues_trigger"
  | "non_exact_issues_trigger"
  | "missing_agent_action"
  | "unexpected_agent_action"
  | "missing_actor_guard"
  | "missing_label_guard"
  | "unpinned_action_reference"
  | "missing_bot_allowlist_input"
  | "bot_allowlist_mismatch"
  | "bot_allowlist_wildcard"
  | "missing_credential_input"
  | "missing_or_wrong_run_name"
  | "missing_exact_sha_checkout"
  | "missing_checkout_head_proof"
  | "missing_or_duplicate_provenance_validation"
  | "non_deterministic_branch"
  | "missing_first_cancellation_fence"
  | "missing_second_cancellation_fence"
  | "missing_or_ambiguous_pr_adoption"
  | "missing_or_wrong_result_artifact"
  | "workflow_merge_authority"
  | "multiple_migration_jobs"
  | "agent_receives_mutation_token"
  | "missing_isolated_git_state"
  | "agent_environment_not_isolated";

export type WorkflowFinding = {
  code: WorkflowFindingCode;
  severity: "error" | "warning";
  message: string;
};

export type WorkflowValidationInput = {
  agent: AgentKind;
  botLogin: string;
  label: string;
};

export type WorkflowValidationResult = {
  valid: boolean;
  findings: readonly WorkflowFinding[];
};

const PINNED_ACTION = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[^@\s]+@[a-f0-9]{40}$/u;
const BASE_SHA_OUTPUT = "${{ steps.provenance.outputs.base_sha }}";
const HANDOFF_BRANCH = "setorra/${{ steps.provenance.outputs.handoff_id }}";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readTriggers(workflow: Record<string, unknown>): unknown {
  return workflow["on"] ?? workflow["true"];
}

function stepUses(step: unknown): string | undefined {
  return asString(asRecord(step)?.["uses"]);
}

function stepId(step: unknown): string | undefined {
  return asString(asRecord(step)?.["id"]);
}

function stepRun(step: unknown): string {
  return asString(asRecord(step)?.["run"]) ?? "";
}

function stepWith(step: unknown): Record<string, unknown> | undefined {
  return asRecord(asRecord(step)?.["with"]);
}

function stepEnv(step: unknown): Record<string, unknown> | undefined {
  return asRecord(asRecord(step)?.["env"]);
}

function push(
  findings: WorkflowFinding[],
  code: WorkflowFindingCode,
  message: string,
  severity: "error" | "warning" = "error",
): void {
  findings.push({ code, severity, message });
}

function collectJobs(workflow: Record<string, unknown>): {
  jobId: string;
  job: Record<string, unknown>;
  steps: readonly unknown[];
}[] {
  const jobs = asRecord(workflow["jobs"]) ?? {};
  return Object.entries(jobs).flatMap(([jobId, rawJob]) => {
    const job = asRecord(rawJob);
    return job === undefined ? [] : [{ jobId, job, steps: asArray(job["steps"]) ?? [] }];
  });
}

function checkTriggers(workflow: Record<string, unknown>, findings: WorkflowFinding[]): void {
  const triggers = asRecord(readTriggers(workflow));
  if (triggers === undefined || !("issues" in triggers)) {
    push(findings, "missing_issues_trigger", "The workflow must trigger on issues.opened.");
    return;
  }
  const issues = asRecord(triggers["issues"]);
  const types = issues === undefined ? undefined : asArray(issues["types"]);
  if (
    Object.keys(triggers).length !== 1 ||
    issues === undefined ||
    Object.keys(issues).length !== 1 ||
    types === undefined ||
    types.length !== 1 ||
    types[0] !== "opened"
  ) {
    push(
      findings,
      "non_exact_issues_trigger",
      "The workflow must have exactly `on.issues.types: [opened]` and no other trigger.",
    );
  }
}

function checkPinning(steps: readonly unknown[], findings: WorkflowFinding[]): void {
  for (const step of steps) {
    const uses = stepUses(step);
    if (uses !== undefined && !PINNED_ACTION.test(uses)) {
      push(
        findings,
        "unpinned_action_reference",
        `Action '${uses}' is not pinned to a full commit SHA.`,
      );
    }
  }
}

function checkGuards(
  job: Record<string, unknown>,
  input: WorkflowValidationInput,
  findings: WorkflowFinding[],
): void {
  const condition = asString(job["if"]) ?? "";
  if (!condition.includes("github.event.issue.user.login") || !condition.includes(input.botLogin)) {
    push(findings, "missing_actor_guard", `The workflow must restrict issues to '${input.botLogin}'.`);
  }
  if (!condition.includes(input.label)) {
    push(findings, "missing_label_guard", `The workflow must require the '${input.label}' label.`);
  }
}

function checkAgentInputs(
  step: unknown,
  input: WorkflowValidationInput,
  findings: WorkflowFinding[],
): void {
  const withInputs = stepWith(step);
  const allowlistInput = AGENT_BOT_ALLOWLIST_INPUTS[input.agent];
  const allowlist = asString(withInputs?.[allowlistInput]);
  if (allowlist === undefined) {
    push(findings, "missing_bot_allowlist_input", `The agent step must set '${allowlistInput}'.`);
  } else if (allowlist.trim() === "*") {
    push(
      findings,
      "bot_allowlist_wildcard",
      `'${allowlistInput}' allows every bot.`,
      "warning",
    );
  } else if (!allowlist.split(",").map((entry) => entry.trim()).includes(input.botLogin)) {
    push(findings, "bot_allowlist_mismatch", `'${allowlistInput}' must list '${input.botLogin}'.`);
  }
  const credentialInputs = agentCredentialInputs(input.agent);
  if (!credentialInputs.some((name) => (asString(withInputs?.[name]) ?? "").trim() !== "")) {
    push(findings, "missing_credential_input", "The agent step has no supported credential input.");
  }
}

function oneStep(steps: readonly unknown[], id: string): unknown | undefined {
  const matches = steps.filter((step) => stepId(step) === id);
  return matches.length === 1 ? matches[0] : undefined;
}

function stepIndex(steps: readonly unknown[], step: unknown | undefined): number {
  return step === undefined ? -1 : steps.indexOf(step);
}

function checkContractControls(
  workflow: Record<string, unknown>,
  steps: readonly unknown[],
  allSteps: readonly unknown[],
  findings: WorkflowFinding[],
): void {
  if (asString(workflow["run-name"]) !== "api-migration-${{ github.event.issue.number }}") {
    push(findings, "missing_or_wrong_run_name", "The workflow run name is not deterministic.");
  }

  const provenanceMatches = steps.filter((step) => stepId(step) === "provenance");
  const provenance = oneStep(steps, "provenance");
  if (
    provenanceMatches.length !== 1 ||
    provenance === undefined ||
    !stepRun(provenance).includes("invalid_provenance") ||
    asString(stepEnv(provenance)?.["ISSUE_BODY"]) !== "${{ github.event.issue.body }}"
  ) {
    push(
      findings,
      "missing_or_duplicate_provenance_validation",
      "The workflow must parse exactly one bounded provenance block before checkout.",
    );
  }

  const checkoutMatches = steps.filter((step) =>
    stepUses(step)?.startsWith(`${CHECKOUT_ACTION_REPOSITORY}@`) === true
  );
  const checkout = checkoutMatches.length === 1 ? checkoutMatches[0] : undefined;
  const checkoutWith = stepWith(checkout);
  if (
    checkout === undefined ||
    asString(checkoutWith?.["ref"]) !== BASE_SHA_OUTPUT ||
    String(checkoutWith?.["fetch-depth"] ?? "") !== "0" ||
    checkoutWith?.["persist-credentials"] !== false
  ) {
    push(
      findings,
      "missing_exact_sha_checkout",
      "Checkout must use the validated provenance base SHA with full history and no persisted credentials.",
    );
  }

  const proof = oneStep(steps, "checkout_proof");
  const proofRun = stepRun(proof);
  if (
    proof === undefined ||
    stepIndex(steps, proof) <= stepIndex(steps, checkout) ||
    !proofRun.includes("git rev-parse HEAD") ||
    !proofRun.includes('test "$(git rev-parse HEAD)" = "$BASE_SHA"')
  ) {
    push(findings, "missing_checkout_head_proof", "Checkout must prove HEAD equals the validated base SHA.");
  }
  if (
    asString(stepEnv(proof)?.["HANDOFF_BRANCH"]) !== HANDOFF_BRANCH ||
    !proofRun.includes('git switch --force-create "$HANDOFF_BRANCH" "$BASE_SHA"')
  ) {
    push(findings, "non_deterministic_branch", "The handoff branch must be exactly `setorra/<handoffId>`.");
  }

  const agent = oneStep(steps, "agent");
  const safeGit = oneStep(steps, "safe_git");
  const safeGitRun = stepRun(safeGit);
  const prepare = oneStep(steps, "prepare");
  const prepareRun = stepRun(prepare);
  if (
    agent === undefined ||
    safeGit === undefined ||
    stepIndex(steps, safeGit) <= stepIndex(steps, agent) ||
    stepIndex(steps, safeGit) >= stepIndex(steps, prepare) ||
    !safeGitRun.includes("git init --bare") ||
    !safeGitRun.includes("fetch --no-tags --depth=1 origin") ||
    !safeGitRun.includes("core.hooksPath=/dev/null") ||
    !safeGitRun.includes('update-ref refs/heads/setorra-handoff "$BASE_SHA"') ||
    !safeGitRun.includes("symbolic-ref HEAD refs/heads/setorra-handoff") ||
    !prepareRun.includes("--git-dir=\"$SAFE_GIT_DIR\"") ||
    !prepareRun.includes('"${SAFE_GIT[@]}" add --all -- .') ||
    !prepareRun.includes("diff --cached --no-ext-diff --quiet") ||
    !prepareRun.includes("diff --cached --no-ext-diff --name-only")
  ) {
    push(
      findings,
      "missing_isolated_git_state",
      "Post-agent Git must use a base-anchored, hook-free directory and stage all files before policy checks.",
    );
  }

  const pushStep = oneStep(steps, "push");
  const pushRun = stepRun(pushStep);
  const pushFenceIndex = pushRun.indexOf("setorra_source_issue_open");
  const pushMutationIndex = pushRun.indexOf('"${SAFE_GIT[@]}" push');
  if (
    pushStep === undefined ||
    asString(stepEnv(pushStep)?.["GH_TOKEN"]) !== "${{ github.token }}" ||
    pushFenceIndex < 0 ||
    pushMutationIndex < 0 ||
    pushFenceIndex >= pushMutationIndex ||
    !pushRun.includes("--force-with-lease") ||
    !pushRun.includes("--git-dir=\"$SAFE_GIT_DIR\"")
  ) {
    push(findings, "missing_first_cancellation_fence", "Push must re-read the source issue immediately before mutation.");
  }

  const pullRequestStep = oneStep(steps, "pull_request");
  const pullRequestRun = stepRun(pullRequestStep);
  const pullRequestFenceIndex = pullRequestRun.indexOf("setorra_source_issue_open");
  const pullRequestLookupIndex = pullRequestRun.indexOf("gh pr list");
  if (
    pullRequestStep === undefined ||
    asString(stepEnv(pullRequestStep)?.["GH_TOKEN"]) !== "${{ github.token }}" ||
    pullRequestFenceIndex < 0 ||
    pullRequestLookupIndex < 0 ||
    pullRequestFenceIndex >= pullRequestLookupIndex
  ) {
    push(findings, "missing_second_cancellation_fence", "PR mutation must re-read the source issue immediately before lookup.");
  }
  if (
    pullRequestStep === undefined ||
    !pullRequestRun.includes("gh pr list") ||
    !pullRequestRun.includes('--head "$HANDOFF_BRANCH"') ||
    !pullRequestRun.includes('--base "$BASE_BRANCH"') ||
    !pullRequestRun.includes("gh pr edit") ||
    !pullRequestRun.includes("gh pr create") ||
    !pullRequestRun.includes("CORRELATION_MARKER") ||
    !pullRequestRun.includes("pullRequest.isDraft !== true")
  ) {
    push(findings, "missing_or_ambiguous_pr_adoption", "PR handling must adopt or create exactly one correlated draft PR.");
  }

  const artifactSteps = allSteps.filter((step) =>
    stepUses(step)?.startsWith(`${UPLOAD_ARTIFACT_ACTION_REPOSITORY}@`) === true
  );
  const artifact = artifactSteps.length === 1 ? artifactSteps[0] : undefined;
  const artifactWith = stepWith(artifact);
  if (
    artifact === undefined ||
    asString(artifactWith?.["name"]) !== "cloud-agent-result" ||
    asString(artifactWith?.["path"]) !== "${{ runner.temp }}/cloud-agent-result.json" ||
    asString(artifactWith?.["if-no-files-found"]) !== "error" ||
    String(artifactWith?.["retention-days"] ?? "") !== "7" ||
    asString(asRecord(artifact)?.["if"]) !== "always()"
  ) {
    push(findings, "missing_or_wrong_result_artifact", "The current result artifact must be uploaded exactly once.");
  }

  const allRun = allSteps.map(stepRun).join("\n");
  if (/\bgh pr merge\b|enable-auto-merge|--auto\b/u.test(allRun)) {
    push(findings, "workflow_merge_authority", "The workflow must never merge or enable auto-merge.");
  }

}

export function validateAgentWorkflow(
  document: unknown,
  input: WorkflowValidationInput,
): WorkflowValidationResult {
  const findings: WorkflowFinding[] = [];
  const workflow = asRecord(document);
  if (workflow === undefined) {
    return {
      valid: false,
      findings: [{
        code: "workflow_not_object",
        severity: "error",
        message: "The workflow document is not a mapping.",
      }],
    };
  }

  checkTriggers(workflow, findings);
  const jobs = collectJobs(workflow);
  const allSteps = jobs.flatMap((entry) => entry.steps);
  for (const { steps } of jobs) {
    checkPinning(steps, findings);
  }

  const expectedRepository = AGENT_ACTION_REPOSITORIES[input.agent];
  const otherRepositories = Object.entries(AGENT_ACTION_REPOSITORIES)
    .filter(([agent]) => agent !== input.agent)
    .map(([, repository]) => repository);
  const expectedMatches: { job: Record<string, unknown>; steps: readonly unknown[]; step: unknown }[] = [];
  const agentSteps: unknown[] = [];
  let foundOther = false;
  for (const entry of jobs) {
    for (const step of entry.steps) {
      const uses = stepUses(step);
      if (uses?.startsWith(`${expectedRepository}@`)) {
        expectedMatches.push({ ...entry, step });
        agentSteps.push(step);
      } else if (uses !== undefined && otherRepositories.some((repository) => uses.startsWith(`${repository}@`))) {
        foundOther = true;
        agentSteps.push(step);
      }
    }
  }
  if (jobs.length !== 1 || expectedMatches.length !== 1 || agentSteps.length !== 1) {
    push(
      findings,
      "multiple_migration_jobs",
      "The workflow must contain exactly one migration job and one agent action.",
    );
  }
  if (agentSteps.some((step) => /github\.token|GH_TOKEN|GITHUB_TOKEN/u.test(JSON.stringify(step)))) {
    push(
      findings,
      "agent_receives_mutation_token",
      "An agent step must not receive the repository mutation token.",
    );
  }
  if (agentSteps.some((step) =>
    asString(stepEnv(step)?.["GITHUB_ENV"]) !== "/dev/null" ||
    asString(stepEnv(step)?.["GITHUB_PATH"]) !== "/dev/null"
  )) {
    push(
      findings,
      "agent_environment_not_isolated",
      "Agent steps must not be able to alter later workflow environments.",
    );
  }
  const matched = expectedMatches[0];
  if (matched === undefined) {
    push(
      findings,
      foundOther ? "unexpected_agent_action" : "missing_agent_action",
      foundOther ? "The workflow runs the wrong agent action." : `No step uses '${expectedRepository}'.`,
    );
    return { valid: false, findings };
  }

  checkGuards(matched.job, input, findings);
  checkAgentInputs(matched.step, input, findings);
  checkContractControls(workflow, matched.steps, allSteps, findings);
  return { valid: !findings.some((finding) => finding.severity === "error"), findings };
}
