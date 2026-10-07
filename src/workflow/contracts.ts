export const AGENT_KINDS = ["claude", "codex", "cursor"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const WORKFLOW_CONTRACT_VERSION = "agent-workflow/1";
export const RESULT_CONTRACT_VERSION = "cloud-agent-result/v1";
export const RESULT_ARTIFACT_NAME = "cloud-agent-result";
export const RESULT_ARTIFACT_FILE = "cloud-agent-result.json";

/**
 * Agent workflows installed alongside the PR-completion companion.
 *
 * It exists because a workflow is the one thing that cannot be installed remotely:
 * GitHub runs Actions only from `.github/workflows`, and only a human merging a pull
 * request can put one there. Everything the agent needs in order to work -- the packages
 * involved, the paths it may modify, the policy for the change, the analysis itself --
 * arrives at run time in the issue the platform opens, so none of it is duplicated here.
 * A repository-side copy of that data has no reader and could only go stale against the
 * database that owns it.
 */
export const AGENT_WORKFLOW_PATHS: Readonly<Record<AgentKind, string>> = {
  claude: ".github/workflows/api-migration-claude.yml",
  codex: ".github/workflows/api-migration-codex.yml",
  cursor: ".github/workflows/api-migration-cursor.yml",
};

export const COMPLETION_WORKFLOW_PATH = ".github/workflows/setorra-pr-completion.yml";
export const COMPLETION_MARKER = "# setorra-pr-completion/v1";
export const COMPLETION_INPUTS = [
  "recovery_id", "handoff_id", "issue_number", "original_run_id", "original_attempt",
  "original_result_digest", "expected_head_sha", "expected_base_sha", "expected_execution_sha",
] as const;
