import assert from "node:assert/strict";
import test from "node:test";
import { RepositoryAgentConfigError } from "../src/workflow/errors.js";
import {
  type PinnedAction,
  renderAgentWorkflow,
  type WorkflowTemplateInput,
} from "../src/workflow/templates.js";

const CHECKOUT: PinnedAction = {
  repository: "actions/checkout",
  sha: "a".repeat(40),
  version: "v4.2.2",
};

function workflowInput(
  overrides: Partial<WorkflowTemplateInput> = {},
): WorkflowTemplateInput {
  return {
    agent: "claude",
    botLogin: "setorra[bot]",
    label: "api-migration",
    checkoutAction: CHECKOUT,
    agentAction: {
      repository: "anthropics/claude-code-action",
      sha: "b".repeat(40),
      version: "v1.0.0",
    },
    ...overrides,
  };
}

const CODEX_ACTION: PinnedAction = {
  repository: "openai/codex-action",
  sha: "c".repeat(40),
  version: "v1.0.0",
};

function expectTemplateError(input: WorkflowTemplateInput): void {
  assert.throws(
    () => renderAgentWorkflow(input),
    (error: unknown) => {
      assert.ok(error instanceof RepositoryAgentConfigError);
      assert.equal(error.code, "invalid_template_input");
      return true;
    },
  );
}

test("states in the file that deleting it revokes authorization", () => {
  // The workflow is the authorization: no workflow, nothing for an issue to trigger.
  // An earlier design made this claim in a separate config file that nothing read.
  const rendered = renderAgentWorkflow(workflowInput());
  assert.match(rendered, /Merging this file authorizes/u);
  assert.match(rendered, /Deleting it, or removing the secret below, revokes/u);
});

test("renders a Claude workflow with the pinned action and bot allowlist", () => {
  const rendered = renderAgentWorkflow(workflowInput());
  assert.equal(rendered, renderAgentWorkflow(workflowInput()));
  assert.ok(
    rendered.includes(`uses: anthropics/claude-code-action@${"b".repeat(40)}`),
  );
  assert.ok(rendered.includes('allowed_bots: "setorra[bot]"'));
  assert.ok(
    rendered.includes("anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}"),
  );
  assert.ok(
    rendered.includes("github.event.issue.user.login == 'setorra[bot]'"),
  );
  assert.ok(
    rendered.includes(
      "contains(github.event.issue.labels.*.name, 'api-migration')",
    ),
  );
  assert.ok(rendered.includes("types: [opened, labeled]"));
});

test("renders a Codex workflow using the list-valued bot allowlist input", () => {
  const rendered = renderAgentWorkflow(
    workflowInput({ agent: "codex", agentAction: CODEX_ACTION }),
  );
  assert.ok(rendered.includes('allow-bot-users: "setorra[bot]"'));
  // `allow-bots` is a boolean covering only github-actions[bot]; using it would
  // silently exclude the platform App.
  assert.ok(!rendered.includes("allow-bots:"));
  assert.ok(rendered.includes("openai-api-key: ${{ secrets.OPENAI_API_KEY }}"));
});

test("passes the issue body to Codex through a file, never inline", () => {
  const rendered = renderAgentWorkflow(
    workflowInput({ agent: "codex", agentAction: CODEX_ACTION }),
  );
  assert.ok(rendered.includes("MIGRATION_TASK: ${{ github.event.issue.body }}"));
  assert.ok(rendered.includes("prompt-file: ${{ runner.temp }}/migration-task.md"));
  assert.ok(!rendered.includes("prompt: ${{ github.event.issue.body }}"));
});

test("grants the permissions the agent needs, including OIDC", () => {
  const rendered = renderAgentWorkflow(workflowInput());
  assert.ok(rendered.includes("      contents: write"));
  assert.ok(rendered.includes("      issues: write"));
  assert.ok(rendered.includes("      pull-requests: write"));
  // Omitting this fails the run in setupGitHubToken; it is not an optional extra.
  assert.ok(rendered.includes("      id-token: write"));
});

test("rejects an action reference that is not a full commit sha", () => {
  expectTemplateError(
    workflowInput({
      agentAction: {
        repository: "anthropics/claude-code-action",
        sha: "v1",
        version: "v1.0.0",
      },
    }),
  );
  expectTemplateError(
    workflowInput({
      agentAction: {
        repository: "anthropics/claude-code-action",
        sha: "B".repeat(40),
        version: "v1.0.0",
      },
    }),
  );
});

test("rejects an agent action that does not match the selected agent", () => {
  expectTemplateError(workflowInput({ agentAction: CODEX_ACTION }));
  expectTemplateError(
    workflowInput({ agent: "codex", agentAction: workflowInput().agentAction }),
  );
});

test("rejects a checkout action from another repository", () => {
  expectTemplateError(
    workflowInput({
      checkoutAction: {
        repository: "attacker/checkout",
        sha: "d".repeat(40),
        version: "v4",
      },
    }),
  );
});

test("rejects a bot login or label that could break the expression", () => {
  expectTemplateError(workflowInput({ botLogin: "setorra" }));
  expectTemplateError(workflowInput({ botLogin: "' or true or '[bot]" }));
  expectTemplateError(workflowInput({ label: "api migration" }));
  expectTemplateError(workflowInput({ label: "'; drop" }));
});

test("renders the subscription-token credential when selected", () => {
  const rendered = renderAgentWorkflow(workflowInput({ credential: "oauth_token" }));
  assert.ok(
    rendered.includes(
      "claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    ),
  );
  assert.ok(!rendered.includes("anthropic_api_key"));
});

test("the renderer still defaults to the api key credential", () => {
  const rendered = renderAgentWorkflow(workflowInput());
  assert.ok(rendered.includes("anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}"));
  assert.ok(!rendered.includes("claude_code_oauth_token"));
});

test("rejects a credential the agent does not support", () => {
  expectTemplateError(
    workflowInput({
      agent: "codex",
      agentAction: CODEX_ACTION,
      credential: "oauth_token",
    }),
  );
});

test("puts the Claude action into agent mode so it opens the pull request", () => {
  const rendered = renderAgentWorkflow(workflowInput());
  assert.ok(rendered.includes("          prompt: |"));
  assert.ok(rendered.includes("open a pull"));
  assert.ok(rendered.includes("Closes #${{ github.event.issue.number }}"));
  // Tag mode only returns a "Create PR" link, so the trigger must not select it.
  assert.ok(!rendered.includes("label_trigger:"));
});

test("grants the agent tools it needs to edit, test and open a pull request", () => {
  const rendered = renderAgentWorkflow(workflowInput());
  assert.ok(rendered.includes("--allowedTools"));
  // The allowlist is exclusive: omitting the file tools leaves the agent unable to
  // change anything, and the run succeeds having done nothing.
  for (const tool of ["Read", "Edit", "Write", "Glob", "Grep"]) {
    assert.ok(rendered.includes(tool), `missing ${tool}`);
  }
  assert.ok(rendered.includes("Bash(gh:*)"));
  assert.ok(rendered.includes("Bash(python3:*)"));
});

test("never splices the untrusted issue body into the Claude workflow", () => {
  const rendered = renderAgentWorkflow(workflowInput());
  assert.ok(!rendered.includes("github.event.issue.body"));
  assert.ok(rendered.includes("github.event.issue.number"));
});

test("serializes runs so two events cannot race on one branch", () => {
  const rendered = renderAgentWorkflow(workflowInput());
  assert.ok(rendered.includes("    concurrency:"));
  assert.ok(
    rendered.includes("      group: api-migration-${{ github.event.issue.number }}"),
  );
  assert.ok(rendered.includes("      cancel-in-progress: true"));
});
