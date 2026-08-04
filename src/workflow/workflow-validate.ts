import type { AgentKind } from "./contracts.js";
import {
  AGENT_ACTION_REPOSITORIES,
  AGENT_BOT_ALLOWLIST_INPUTS,
  agentCredentialInputs,
} from "./templates.js";

export type WorkflowFindingCode =
  | "workflow_not_object"
  | "missing_issues_trigger"
  | "missing_opened_trigger_type"
  | "missing_agent_action"
  | "unexpected_agent_action"
  | "missing_actor_guard"
  | "missing_label_guard"
  | "unpinned_action_reference"
  | "missing_bot_allowlist_input"
  | "bot_allowlist_mismatch"
  | "bot_allowlist_wildcard"
  | "missing_credential_input";

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

/**
 * YAML 1.1 parsers resolve the bare key `on` to the boolean `true`, while YAML 1.2
 * parsers keep it as the string `on`. A workflow is valid either way, so both spellings
 * are accepted rather than assuming which parser the caller used.
 */
function readTriggers(workflow: Record<string, unknown>): unknown {
  return workflow["on"] ?? workflow["true"];
}

function stepUses(step: unknown): string | undefined {
  const record = asRecord(step);
  return record === undefined ? undefined : asString(record["uses"]);
}

function collectSteps(
  jobs: Record<string, unknown>,
): { jobId: string; job: Record<string, unknown>; steps: readonly unknown[] }[] {
  const collected: {
    jobId: string;
    job: Record<string, unknown>;
    steps: readonly unknown[];
  }[] = [];
  for (const [jobId, rawJob] of Object.entries(jobs)) {
    const job = asRecord(rawJob);
    if (job === undefined) {
      continue;
    }
    collected.push({ jobId, job, steps: asArray(job["steps"]) ?? [] });
  }
  return collected;
}

function checkTriggers(
  workflow: Record<string, unknown>,
  findings: WorkflowFinding[],
): void {
  const triggers = asRecord(readTriggers(workflow));
  if (triggers === undefined || !("issues" in triggers)) {
    findings.push({
      code: "missing_issues_trigger",
      severity: "error",
      message: "The workflow does not trigger on issue events.",
    });
    return;
  }

  // A bare `issues:` key subscribes to every issue activity type, which includes
  // `opened`. Only an explicit `types` list can exclude it.
  const issues = asRecord(triggers["issues"]);
  const types = issues === undefined ? undefined : asArray(issues["types"]);
  if (types !== undefined && !types.includes("opened")) {
    findings.push({
      code: "missing_opened_trigger_type",
      severity: "error",
      message:
        "The issues trigger does not include the 'opened' type, so a newly opened " +
        "migration issue will not start the agent.",
    });
  }
}

function checkPinning(
  steps: readonly unknown[],
  findings: WorkflowFinding[],
): void {
  for (const step of steps) {
    const uses = stepUses(step);
    if (uses !== undefined && !PINNED_ACTION.test(uses)) {
      findings.push({
        code: "unpinned_action_reference",
        severity: "error",
        message:
          `Action '${uses}' is not pinned to a full-length commit SHA, which some ` +
          "enterprise Actions policies reject.",
      });
    }
  }
}

function checkGuards(
  job: Record<string, unknown>,
  input: WorkflowValidationInput,
  findings: WorkflowFinding[],
): void {
  const condition = asString(job["if"]) ?? "";
  if (
    !condition.includes("github.event.issue.user.login") ||
    !condition.includes(input.botLogin)
  ) {
    findings.push({
      code: "missing_actor_guard",
      severity: "error",
      message: `The job does not restrict execution to issues opened by ` +
        `'${input.botLogin}'.`,
    });
  }
  if (!condition.includes(input.label)) {
    findings.push({
      code: "missing_label_guard",
      severity: "error",
      message: `The job does not require the '${input.label}' label.`,
    });
  }
}

function checkAgentInputs(
  step: unknown,
  input: WorkflowValidationInput,
  findings: WorkflowFinding[],
): void {
  const record = asRecord(step);
  const withInputs = record === undefined ? undefined : asRecord(record["with"]);
  const allowlistInput = AGENT_BOT_ALLOWLIST_INPUTS[input.agent];
  const credentialInputs = agentCredentialInputs(input.agent);

  const allowlist = withInputs === undefined
    ? undefined
    : asString(withInputs[allowlistInput]);
  if (allowlist === undefined) {
    findings.push({
      code: "missing_bot_allowlist_input",
      severity: "error",
      message:
        `The agent step does not set '${allowlistInput}', so the action will ignore ` +
        "issues opened by a GitHub App.",
    });
  } else if (allowlist.trim() === "*") {
    findings.push({
      code: "bot_allowlist_wildcard",
      severity: "warning",
      message:
        `'${allowlistInput}' allows every bot. On a public repository this lets ` +
        "unrelated parties invoke the agent.",
    });
  } else if (
    !allowlist.split(",").map((entry) => entry.trim()).includes(input.botLogin)
  ) {
    findings.push({
      code: "bot_allowlist_mismatch",
      severity: "error",
      message: `'${allowlistInput}' does not list '${input.botLogin}'.`,
    });
  }

  // Any supported credential shape satisfies this: an API key and a subscription token
  // are alternatives, not both required.
  const hasCredential = withInputs !== undefined &&
    credentialInputs.some((name) => (asString(withInputs[name]) ?? "").trim() !== "");
  if (!hasCredential) {
    findings.push({
      code: "missing_credential_input",
      severity: "error",
      message: `The agent step sets none of: ${credentialInputs.join(", ")}.`,
    });
  }
}

/**
 * Verifies that an already-parsed workflow document will actually run the expected
 * agent when the platform App opens a labelled issue.
 *
 * Findings are returned rather than thrown so onboarding can surface every problem at
 * once. A dispatcher must treat any `error` finding as "do not open the issue": an
 * issue that no workflow will act on looks like success to the platform and like
 * pending work to the customer.
 */
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

  const jobs = asRecord(workflow["jobs"]) ?? {};
  const entries = collectSteps(jobs);
  for (const entry of entries) {
    checkPinning(entry.steps, findings);
  }

  const expectedRepository = AGENT_ACTION_REPOSITORIES[input.agent];
  const otherRepositories = Object.entries(AGENT_ACTION_REPOSITORIES)
    .filter(([agent]) => agent !== input.agent)
    .map(([, repository]) => repository);

  let matched: { job: Record<string, unknown>; step: unknown } | undefined;
  let foundOther = false;
  for (const entry of entries) {
    for (const step of entry.steps) {
      const uses = stepUses(step);
      if (uses === undefined) {
        continue;
      }
      if (uses.startsWith(`${expectedRepository}@`)) {
        matched ??= { job: entry.job, step };
      } else if (
        otherRepositories.some((repository) => uses.startsWith(`${repository}@`))
      ) {
        foundOther = true;
      }
    }
  }

  if (matched === undefined) {
    findings.push(
      foundOther
        ? {
          code: "unexpected_agent_action",
          severity: "error",
          message:
            `The workflow runs a different agent action; the configuration selects ` +
            `'${input.agent}' which requires '${expectedRepository}'.`,
        }
        : {
          code: "missing_agent_action",
          severity: "error",
          message: `No step uses '${expectedRepository}'.`,
        },
    );
    return { valid: false, findings };
  }

  checkGuards(matched.job, input, findings);
  checkAgentInputs(matched.step, input, findings);

  return {
    valid: !findings.some((finding) => finding.severity === "error"),
    findings,
  };
}
