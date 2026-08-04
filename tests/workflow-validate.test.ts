import assert from "node:assert/strict";
import test from "node:test";
import {
  validateAgentWorkflow,
  type WorkflowFindingCode,
  type WorkflowValidationInput,
} from "../src/workflow/workflow-validate.js";

const INPUT: WorkflowValidationInput = {
  agent: "claude",
  botLogin: "setorra[bot]",
  label: "api-migration",
};

const CHECKOUT = `actions/checkout@${"a".repeat(40)}`;
const CLAUDE = `anthropics/claude-code-action@${"b".repeat(40)}`;
const CODEX = `openai/codex-action@${"c".repeat(40)}`;

const GUARD = "github.event.issue.user.login == 'setorra[bot]' && " +
  "contains(github.event.issue.labels.*.name, 'api-migration')";

function workflow(overrides: {
  triggers?: unknown;
  condition?: unknown;
  agentUses?: string;
  agentWith?: Record<string, unknown>;
  extraSteps?: unknown[];
} = {}): Record<string, unknown> {
  return {
    name: "API Migration (Claude)",
    on: overrides.triggers === undefined
      ? { issues: { types: ["opened", "labeled"] } }
      : overrides.triggers,
    jobs: {
      migrate: {
        if: overrides.condition === undefined ? GUARD : overrides.condition,
        "runs-on": "ubuntu-latest",
        steps: [
          { uses: CHECKOUT, with: { "fetch-depth": 0 } },
          {
            uses: overrides.agentUses ?? CLAUDE,
            with: overrides.agentWith ?? {
              anthropic_api_key: "${{ secrets.ANTHROPIC_API_KEY }}",
              allowed_bots: "setorra[bot]",
            },
          },
          ...(overrides.extraSteps ?? []),
        ],
      },
    },
  };
}

function codes(document: unknown, input = INPUT): WorkflowFindingCode[] {
  return validateAgentWorkflow(document, input).findings.map((f) => f.code);
}

test("accepts a correctly configured workflow", () => {
  const result = validateAgentWorkflow(workflow(), INPUT);
  assert.equal(result.valid, true);
  assert.deepEqual(result.findings, []);
});

test("accepts a bare issues trigger, which covers every activity type", () => {
  const result = validateAgentWorkflow(workflow({ triggers: { issues: null } }), INPUT);
  assert.equal(result.valid, true);
});

test("accepts the YAML 1.1 boolean spelling of the on key", () => {
  const document = workflow();
  delete document["on"];
  document["true"] = { issues: { types: ["opened"] } };
  const result = validateAgentWorkflow(document, INPUT);
  assert.equal(result.valid, true);
});

test("rejects a document that is not a mapping", () => {
  assert.deepEqual(codes("name: x"), ["workflow_not_object"]);
  assert.deepEqual(codes([]), ["workflow_not_object"]);
});

test("reports a missing issues trigger", () => {
  assert.ok(
    codes(workflow({ triggers: { push: { branches: ["main"] } } }))
      .includes("missing_issues_trigger"),
  );
});

test("reports an issues trigger that excludes opened", () => {
  assert.ok(
    codes(workflow({ triggers: { issues: { types: ["labeled"] } } }))
      .includes("missing_opened_trigger_type"),
  );
});

test("reports an action that is not pinned to a commit sha", () => {
  const found = codes(workflow({ agentUses: "anthropics/claude-code-action@v1" }));
  assert.ok(found.includes("unpinned_action_reference"));
});

test("reports a workflow with no agent action at all", () => {
  const document = workflow();
  const jobs = document["jobs"] as Record<string, Record<string, unknown>>;
  const migrate = jobs["migrate"] as Record<string, unknown>;
  migrate["steps"] = [{ uses: CHECKOUT }];
  assert.ok(codes(document).includes("missing_agent_action"));
});

test("reports a workflow that runs the other vendor's agent", () => {
  const found = codes(workflow({
    agentUses: CODEX,
    agentWith: { "openai-api-key": "x", "allow-bot-users": "setorra[bot]" },
  }));
  assert.ok(found.includes("unexpected_agent_action"));
  assert.ok(!found.includes("missing_agent_action"));
});

test("reports a missing actor guard", () => {
  const found = codes(workflow({
    condition: "contains(github.event.issue.labels.*.name, 'api-migration')",
  }));
  assert.ok(found.includes("missing_actor_guard"));
});

test("reports a guard naming a different bot", () => {
  const found = codes(workflow({
    condition: "github.event.issue.user.login == 'other[bot]' && " +
      "contains(github.event.issue.labels.*.name, 'api-migration')",
  }));
  assert.ok(found.includes("missing_actor_guard"));
});

test("reports a missing label guard", () => {
  const found = codes(workflow({
    condition: "github.event.issue.user.login == 'setorra[bot]'",
  }));
  assert.ok(found.includes("missing_label_guard"));
});

test("reports an absent job condition", () => {
  const found = codes(workflow({ condition: null }));
  assert.ok(found.includes("missing_actor_guard"));
  assert.ok(found.includes("missing_label_guard"));
});

test("reports a missing bot allowlist input", () => {
  const found = codes(workflow({
    agentWith: { anthropic_api_key: "${{ secrets.ANTHROPIC_API_KEY }}" },
  }));
  assert.ok(found.includes("missing_bot_allowlist_input"));
});

test("reports the wrong bot allowlist input name for Codex", () => {
  const found = codes(
    workflow({
      agentUses: CODEX,
      agentWith: { "openai-api-key": "x", "allow-bots": "setorra[bot]" },
    }),
    { agent: "codex", botLogin: "setorra[bot]", label: "api-migration" },
  );
  assert.ok(found.includes("missing_bot_allowlist_input"));
});

test("reports an allowlist that omits our bot", () => {
  const found = codes(workflow({
    agentWith: {
      anthropic_api_key: "x",
      allowed_bots: "renovate[bot],dependabot[bot]",
    },
  }));
  assert.ok(found.includes("bot_allowlist_mismatch"));
});

test("accepts an allowlist containing our bot among others", () => {
  const result = validateAgentWorkflow(
    workflow({
      agentWith: {
        anthropic_api_key: "x",
        allowed_bots: "renovate[bot], setorra[bot]",
      },
    }),
    INPUT,
  );
  assert.equal(result.valid, true);
});

test("warns but stays valid when every bot is allowed", () => {
  const result = validateAgentWorkflow(
    workflow({ agentWith: { anthropic_api_key: "x", allowed_bots: "*" } }),
    INPUT,
  );
  assert.equal(result.valid, true);
  assert.deepEqual(result.findings.map((f) => f.code), ["bot_allowlist_wildcard"]);
});

test("reports a missing credential input", () => {
  const found = codes(workflow({
    agentWith: { allowed_bots: "setorra[bot]" },
  }));
  assert.ok(found.includes("missing_credential_input"));
});

test("reports an empty credential input", () => {
  const found = codes(workflow({
    agentWith: { anthropic_api_key: "   ", allowed_bots: "setorra[bot]" },
  }));
  assert.ok(found.includes("missing_credential_input"));
});

test("checks pinning across every job, not just the agent job", () => {
  const document = workflow();
  const jobs = document["jobs"] as Record<string, unknown>;
  jobs["lint"] = { steps: [{ uses: "actions/setup-node@v4" }] };
  assert.ok(codes(document).includes("unpinned_action_reference"));
});

test("accepts a workflow authenticated by the subscription token", () => {
  const result = validateAgentWorkflow(
    workflow({
      agentWith: {
        claude_code_oauth_token: "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
        allowed_bots: "setorra[bot]",
      },
    }),
    INPUT,
  );
  assert.equal(result.valid, true);
});
