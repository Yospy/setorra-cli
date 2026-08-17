export type AgentKind = "claude" | "codex";

export const WORKFLOW_CONTRACT_VERSION = "agent-workflow/1";
export const RESULT_CONTRACT_VERSION = "cloud-agent-result/v1";
export const RESULT_ARTIFACT_NAME = "cloud-agent-result";
export const RESULT_ARTIFACT_FILE = "cloud-agent-result.json";

/**
 * The only file this platform puts in a customer repository.
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
};
