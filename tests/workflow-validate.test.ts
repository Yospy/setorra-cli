import assert from "node:assert/strict";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  renderAgentWorkflow,
  type PinnedAction,
  type WorkflowTemplateInput,
} from "../src/workflow/templates.js";
import {
  validateAgentWorkflow,
  type WorkflowFindingCode,
} from "../src/workflow/workflow-validate.js";

const CHECKOUT: PinnedAction = {
  repository: "actions/checkout",
  sha: "a".repeat(40),
  version: "v4",
};
const CLAUDE: PinnedAction = {
  repository: "anthropics/claude-code-action",
  sha: "b".repeat(40),
  version: "v1",
};
const UPLOAD: PinnedAction = {
  repository: "actions/upload-artifact",
  sha: "d".repeat(40),
  version: "v4",
};
const INPUT = { agent: "claude" as const, botLogin: "setorra[bot]", label: "api-migration" };

function document(): Record<string, unknown> {
  const input: WorkflowTemplateInput = {
    ...INPUT,
    checkoutAction: CHECKOUT,
    agentAction: CLAUDE,
    uploadArtifactAction: UPLOAD,
  };
  return parseYaml(renderAgentWorkflow(input)) as Record<string, unknown>;
}

function migration(document: Record<string, unknown>): Record<string, unknown> {
  const jobs = document["jobs"] as Record<string, Record<string, unknown>>;
  return jobs["migrate"] as Record<string, unknown>;
}

function step(document: Record<string, unknown>, id: string): Record<string, unknown> {
  const steps = migration(document)["steps"] as Record<string, unknown>[];
  const found = steps.find((candidate) => candidate["id"] === id);
  assert.ok(found !== undefined, `step '${id}' is missing`);
  return found;
}

function codes(document: unknown): WorkflowFindingCode[] {
  return validateAgentWorkflow(document, INPUT).findings.map((finding) => finding.code);
}

test("accepts the generated workflow", () => {
  const result = validateAgentWorkflow(document(), INPUT);
  assert.equal(result.valid, true);
  assert.deepEqual(result.findings, []);
});

test("rejects every trigger except issues.opened", () => {
  const value = document();
  value["on"] = { issues: { types: ["opened", "labeled"] } };
  assert.ok(codes(value).includes("non_exact_issues_trigger"));
});

test("requires the deterministic run name", () => {
  const value = document();
  value["run-name"] = "migration";
  assert.ok(codes(value).includes("missing_or_wrong_run_name"));
});

test("requires provenance, exact checkout, and HEAD proof in order", () => {
  const value = document();
  const steps = migration(value)["steps"] as Record<string, unknown>[];
  steps.splice(0, 1);
  assert.ok(codes(value).includes("missing_or_duplicate_provenance_validation"));

  const checkout = step(value, "checkout");
  (checkout["with"] as Record<string, unknown>)["ref"] = "main";
  assert.ok(codes(value).includes("missing_exact_sha_checkout"));

  const proof = step(value, "checkout_proof");
  proof["run"] = "git switch --force-create \"$HANDOFF_BRANCH\" \"$BASE_SHA\"";
  assert.ok(codes(value).includes("missing_checkout_head_proof"));
});

test("requires the deterministic handoff branch", () => {
  const value = document();
  (step(value, "checkout_proof")["env"] as Record<string, unknown>)["HANDOFF_BRANCH"] = "agent/work";
  assert.ok(codes(value).includes("non_deterministic_branch"));
});

test("requires isolated post-agent Git state", () => {
  const value = document();
  const safeGit = step(value, "safe_git");
  safeGit["run"] = "git fetch origin main";
  assert.ok(codes(value).includes("missing_isolated_git_state"));
});

test("isolates agents from later workflow environments", () => {
  const value = document();
  delete (step(value, "agent")["env"] as Record<string, unknown>)["GITHUB_ENV"];
  assert.ok(codes(value).includes("agent_environment_not_isolated"));
});

test("requires both cancellation fences and PR adoption", () => {
  const value = document();
  const push = step(value, "push");
  push["run"] = String(push["run"]).replaceAll("setorra_source_issue_open", "source_issue_open");
  assert.ok(codes(value).includes("missing_first_cancellation_fence"));

  const pullRequest = step(value, "pull_request");
  pullRequest["run"] = String(pullRequest["run"])
    .replace("setorra_source_issue_open", "source_issue_open")
    .replace("gh pr edit", "gh pr view");
  const found = codes(value);
  assert.ok(found.includes("missing_second_cancellation_fence"));
  assert.ok(found.includes("missing_or_ambiguous_pr_adoption"));
});

test("blocks adoption of a ready-for-review pull request", () => {
  const value = document();
  const pullRequest = step(value, "pull_request");
  pullRequest["run"] = String(pullRequest["run"]).replace("pullRequest.isDraft !== true || ", "");
  assert.ok(codes(value).includes("missing_or_ambiguous_pr_adoption"));
});

test("requires the exact pinned result artifact", () => {
  const value = document();
  const steps = migration(value)["steps"] as Record<string, unknown>[];
  const artifact = steps.find((candidate) => String(candidate["uses"] ?? "").startsWith("actions/upload-artifact@"));
  assert.ok(artifact !== undefined);
  (artifact["with"] as Record<string, unknown>)["name"] = "other";
  artifact["uses"] = "actions/upload-artifact@v4";
  const found = codes(value);
  assert.ok(found.includes("missing_or_wrong_result_artifact"));
  assert.ok(found.includes("unpinned_action_reference"));
});

test("rejects merge authority", () => {
  const value = document();
  const pullRequest = step(value, "pull_request");
  pullRequest["run"] = `${String(pullRequest["run"])}\ngh pr merge 1`;
  assert.ok(codes(value).includes("workflow_merge_authority"));
});

test("rejects extra jobs, duplicate artifacts, and mutation tokens in agent steps", () => {
  const value = document();
  const jobs = value["jobs"] as Record<string, unknown>;
  jobs["other"] = {
    steps: [
      {
        uses: `actions/upload-artifact@${"d".repeat(40)}`,
        if: "always()",
        with: {
          name: "cloud-agent-result",
          path: "${{ runner.temp }}/cloud-agent-result.json",
          "if-no-files-found": "error",
          "retention-days": 7,
        },
      },
      {
        uses: `anthropics/claude-code-action@${"b".repeat(40)}`,
        env: { GH_TOKEN: "${{ github.token }}" },
        with: { anthropic_api_key: "x", allowed_bots: "setorra[bot]" },
      },
      { run: "gh pr merge 1" },
    ],
  };
  const found = codes(value);
  assert.ok(found.includes("multiple_migration_jobs"));
  assert.ok(found.includes("agent_receives_mutation_token"));
  assert.ok(found.includes("missing_or_wrong_result_artifact"));
  assert.ok(found.includes("workflow_merge_authority"));
});

test("keeps bot and agent-action validation", () => {
  const value = document();
  migration(value)["if"] = "true";
  const agent = step(value, "agent");
  (agent["with"] as Record<string, unknown>)["allowed_bots"] = "*";
  const found = codes(value);
  assert.ok(found.includes("missing_actor_guard"));
  assert.ok(found.includes("missing_label_guard"));
  assert.ok(found.includes("bot_allowlist_wildcard"));
});
