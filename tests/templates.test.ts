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

const UPLOAD_ARTIFACT: PinnedAction = {
  repository: "actions/upload-artifact",
  sha: "d".repeat(40),
  version: "v4",
};

type ActionTemplateInput = Extract<WorkflowTemplateInput, { agentAction: unknown }>;
type CursorTemplateInput = Extract<WorkflowTemplateInput, { agent: "cursor" }>;

function workflowInput(
  overrides: Partial<ActionTemplateInput> = {},
): ActionTemplateInput {
  return {
    agent: "claude",
    botLogin: "setorra[bot]",
    label: "api-migration",
    checkoutAction: CHECKOUT,
    uploadArtifactAction: UPLOAD_ARTIFACT,
    agentAction: {
      repository: "anthropics/claude-code-action",
      sha: "b".repeat(40),
      version: "v1.0.0",
    },
    ...overrides,
  };
}

const CURSOR_CLI = {
  version: "2026.10.01-e373342",
  sha256: "e".repeat(64),
};

function cursorInput(overrides: Partial<CursorTemplateInput> = {}): CursorTemplateInput {
  return {
    agent: "cursor",
    botLogin: "setorra[bot]",
    label: "api-migration",
    checkoutAction: CHECKOUT,
    uploadArtifactAction: UPLOAD_ARTIFACT,
    cursorCli: CURSOR_CLI,
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

test("states that deterministic workflow steps own repository mutations", () => {
  const rendered = renderAgentWorkflow(workflowInput());
  assert.match(rendered, /agent can edit only/u);
  assert.match(rendered, /deterministic workflow steps own GitHub mutations/u);
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
  assert.ok(rendered.includes("    types: [opened]"));
  assert.ok(rendered.includes("run-name: api-migration-${{ github.event.issue.number }}"));
  assert.ok(rendered.includes("id: provenance"));
  assert.ok(rendered.includes("ref: ${{ steps.provenance.outputs.base_sha }}"));
  assert.ok(rendered.includes("git rev-parse HEAD"));
  assert.ok(rendered.includes("cloud-agent-result.json"));
  assert.ok(rendered.includes("id: sources"));
  assert.ok(rendered.includes("source.access === 'reference_only'"));
  assert.ok(rendered.includes("file: null"));
  assert.ok(rendered.includes("contents were not inspected"));
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
  assert.ok(rendered.includes("ISSUE_BODY: ${{ github.event.issue.body }}"));
  assert.ok(rendered.includes("prompt-file: ${{ runner.temp }}/agent-prompt.md"));
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

test("puts the Claude action into edit-only agent mode", () => {
  const rendered = renderAgentWorkflow(workflowInput());
  assert.ok(rendered.includes("          prompt: |"));
  assert.ok(rendered.includes("Modify the working tree only"));
  assert.ok(!rendered.includes("Then commit to a new branch"));
});

test("grants the agent tools it needs to edit and test, but not mutate GitHub", () => {
  const rendered = renderAgentWorkflow(workflowInput());
  assert.ok(rendered.includes("--allowedTools"));
  // The allowlist is exclusive: omitting the file tools leaves the agent unable to
  // change anything, and the run succeeds having done nothing.
  for (const tool of ["Read", "Edit", "Write", "Glob", "Grep"]) {
    assert.ok(rendered.includes(tool), `missing ${tool}`);
  }
  assert.ok(!rendered.includes("Bash(gh:*)"));
  assert.ok(!rendered.includes("Bash(git:*)"));
  assert.ok(rendered.includes("Bash(python3:*)"));
});

test("passes the untrusted issue body only through the provenance environment", () => {
  const rendered = renderAgentWorkflow(workflowInput());
  assert.ok(rendered.includes("ISSUE_BODY: ${{ github.event.issue.body }}"));
  assert.ok(!rendered.includes("prompt: ${{ github.event.issue.body }}"));
});

test("serializes one-shot runs and gives shell steps exclusive mutation authority", () => {
  const rendered = renderAgentWorkflow(workflowInput());
  assert.ok(rendered.includes("    concurrency:"));
  assert.ok(
    rendered.includes("      group: api-migration-${{ github.event.issue.number }}"),
  );
  assert.ok(rendered.includes("      cancel-in-progress: true"));
  assert.ok(rendered.includes("--force-with-lease"));
  assert.ok(rendered.includes("gh pr list"));
  assert.ok(rendered.includes("if: always()"));
  assert.ok(rendered.includes("persist-credentials: false"));
  assert.ok(rendered.includes("GIT_AUTH_KEY"));
});

test("runs the pinned Cursor CLI on the prompt file with the customer key", () => {
  const rendered = renderAgentWorkflow(cursorInput());
  assert.ok(rendered.includes("name: API Migration (Cursor)"));
  assert.ok(rendered.includes("      - name: Run the Cursor coding agent"));
  assert.ok(rendered.includes("          CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}"));
  assert.ok(rendered.includes(
    'CURSOR_CLI_URL: "https://downloads.cursor.com/lab/2026.10.01-e373342/linux/x64/agent-cli-package.tar.gz"',
  ));
  assert.ok(rendered.includes(`CURSOR_CLI_SHA256: "${"e".repeat(64)}"`));
  assert.ok(rendered.includes("| sha256sum --check --strict --quiet"));
  // Sudo is dropped and proven gone before anything is downloaded or run.
  assert.ok(
    rendered.indexOf("if sudo -n true 2>/dev/null; then") <
      rendered.indexOf('CURSOR_CLI_DIR="$(mktemp'),
  );
  // The prompt arrives on stdin: a full issue body can exceed one argv entry.
  assert.ok(rendered.includes(
    '"$CURSOR_CLI_DIR/dist-package/cursor-agent" --print --force --disable-auto-update < "$AGENT_PROMPT_FILE"',
  ));
  assert.ok(!rendered.includes("uses: anthropics/") && !rendered.includes("uses: openai/"));
});

test("denies Cursor git, PR, network and workflow-path tools", () => {
  const rendered = renderAgentWorkflow(cursorInput());
  const line = rendered.split("\n").find((candidate) => candidate.includes("cli-config.json\""));
  assert.ok(line !== undefined);
  const config = JSON.parse(line.slice(line.indexOf("'{") + 1, line.lastIndexOf("}'") + 1));
  assert.deepEqual(config.permissions.allow, []);
  for (const rule of ["Shell(git)", "Shell(gh)", "Shell(curl)", "Write(.github/**)", "Write(.git/**)"]) {
    assert.ok(config.permissions.deny.includes(rule), rule);
  }
});

test("gives the Cursor job no OIDC token and the agent step no GitHub token", () => {
  const rendered = renderAgentWorkflow(cursorInput());
  assert.ok(!rendered.includes("id-token: write"));
  const agentStep = rendered.slice(
    rendered.indexOf("      - name: Run the Cursor coding agent"),
    rendered.indexOf("      - name: Install deterministic workflow helpers"),
  );
  assert.ok(agentStep.length > 0);
  assert.doesNotMatch(agentStep, /github\.token|GH_TOKEN|GITHUB_TOKEN/u);
  assert.ok(agentStep.includes("GITHUB_ENV: /dev/null"));
  assert.ok(agentStep.includes("GITHUB_PATH: /dev/null"));
});

test("rejects a Cursor workflow without one exact CLI pin", () => {
  expectTemplateError(cursorInput({ cursorCli: { version: "latest", sha256: "e".repeat(64) } }));
  expectTemplateError(cursorInput({ cursorCli: { version: CURSOR_CLI.version, sha256: "E".repeat(64) } }));
  expectTemplateError(cursorInput({ credential: "oauth_token" }));
  expectTemplateError({ ...cursorInput(), agentAction: CODEX_ACTION } as unknown as WorkflowTemplateInput);
  expectTemplateError({ ...workflowInput(), cursorCli: CURSOR_CLI } as unknown as WorkflowTemplateInput);
});
