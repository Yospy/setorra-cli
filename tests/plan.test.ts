import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_WORKFLOW_PATHS, COMPLETION_WORKFLOW_PATH, COMPLETION_MARKER } from "../src/workflow/contracts.js";
import {
  managedPaths,
  type PlannedAction,
  planRepositoryAgentFiles,
  type ReconcileInput,
} from "../src/workflow/plan.js";
import {
  inspectProvenance,
  stampProvenance,
  stripProvenance,
} from "../src/workflow/provenance.js";
import type { PinnedAction } from "../src/workflow/templates.js";

type ActionReconcileInput = Extract<ReconcileInput, { agentAction: unknown }>;

const CHECKOUT: PinnedAction = {
  repository: "actions/checkout",
  sha: "a".repeat(40),
  version: "v4",
};

const UPLOAD_ARTIFACT: PinnedAction = {
  repository: "actions/upload-artifact",
  sha: "d".repeat(40),
  version: "v4",
};

function agentAction(agent: "claude" | "codex"): PinnedAction {
  return agent === "claude"
    ? {
      repository: "anthropics/claude-code-action",
      sha: "b".repeat(40),
      version: "v1",
    }
    : { repository: "openai/codex-action", sha: "c".repeat(40), version: "v1" };
}

function input(overrides: Partial<ActionReconcileInput> = {}): ReconcileInput {
  const agent = overrides.agent ?? "claude";
  return {
    agent,
    credential: "api_key",
    botLogin: "setorra[bot]",
    label: "api-migration",
    checkoutAction: CHECKOUT,
    agentAction: agentAction(agent),
    uploadArtifactAction: UPLOAD_ARTIFACT,
    existing: new Map(),
    force: false,
    ...overrides,
  };
}

function byPath(actions: readonly PlannedAction[], path: string): PlannedAction {
  const found = actions.find((action) => action.path === path);
  assert.ok(found !== undefined, `no action for ${path}`);
  return found;
}

test("manages the agent choices and shared completion workflow", () => {
  assert.deepEqual(managedPaths(), [
    AGENT_WORKFLOW_PATHS.claude,
    AGENT_WORKFLOW_PATHS.codex,
    AGENT_WORKFLOW_PATHS.cursor,
    COMPLETION_WORKFLOW_PATH,
  ]);
});

test("creates agent and completion workflows in an empty repository", () => {
  const plan = planRepositoryAgentFiles(input());
  assert.equal(plan.clean, false);
  assert.equal(plan.blocked, false);
  assert.equal(plan.actions.length, 2);
  assert.equal(byPath(plan.actions, COMPLETION_WORKFLOW_PATH).kind, "create");
  assert.equal(byPath(plan.actions, AGENT_WORKFLOW_PATHS.claude).kind, "create");
});

test("writes no configuration file alongside the workflow", () => {
  const plan = planRepositoryAgentFiles(input());
  // The repository holds only what GitHub must execute. Everything the agent acts on
  // arrives in the issue, so a committed copy would have no reader.
  assert.equal(
    plan.actions.some((action) => !action.path.startsWith(".github/workflows/")),
    false,
  );
});

test("is a no-op when everything already matches", () => {
  const first = planRepositoryAgentFiles(input());
  const existing = new Map<string, string>();
  for (const action of first.actions) {
    if (action.kind === "create") {
      existing.set(action.path, action.contents);
    }
  }
  const second = planRepositoryAgentFiles(input({ existing }));
  assert.equal(
    byPath(second.actions, AGENT_WORKFLOW_PATHS.claude).kind,
    "unchanged",
  );
  assert.equal(second.clean, true);
});

test("switching agent deletes the workflow that would otherwise still fire", () => {
  const codexPlan = planRepositoryAgentFiles(input({ agent: "codex" }));
  const existing = new Map<string, string>();
  for (const action of codexPlan.actions) {
    if (action.kind === "create") {
      existing.set(action.path, action.contents);
    }
  }

  const plan = planRepositoryAgentFiles(input({ agent: "claude", existing }));

  assert.equal(byPath(plan.actions, AGENT_WORKFLOW_PATHS.claude).kind, "create");
  assert.equal(byPath(plan.actions, AGENT_WORKFLOW_PATHS.codex).kind, "delete");
});

test("switching to Cursor writes its workflow and deletes the action workflow", () => {
  const claudePlan = planRepositoryAgentFiles(input());
  const existing = new Map<string, string>();
  for (const action of claudePlan.actions) {
    if (action.kind === "create") {
      existing.set(action.path, action.contents);
    }
  }

  const plan = planRepositoryAgentFiles({
    agent: "cursor",
    credential: "api_key",
    botLogin: "setorra[bot]",
    label: "api-migration",
    checkoutAction: CHECKOUT,
    cursorCli: { version: "2026.10.01-e373342", sha256: "e".repeat(64) },
    uploadArtifactAction: UPLOAD_ARTIFACT,
    existing,
    force: false,
  });

  assert.equal(byPath(plan.actions, AGENT_WORKFLOW_PATHS.cursor).kind, "create");
  assert.equal(byPath(plan.actions, AGENT_WORKFLOW_PATHS.claude).kind, "delete");
  assert.equal(byPath(plan.actions, COMPLETION_WORKFLOW_PATH).kind, "unchanged");
});

test("refuses to overwrite a hand-edited managed file", () => {
  const generated = planRepositoryAgentFiles(input());
  const workflow = byPath(generated.actions, AGENT_WORKFLOW_PATHS.claude);
  assert.ok(workflow.kind === "create");
  const edited = `${workflow.contents}\n# customer addition\n`;

  const plan = planRepositoryAgentFiles(input({
    existing: new Map([[AGENT_WORKFLOW_PATHS.claude, edited]]),
  }));
  const action = byPath(plan.actions, AGENT_WORKFLOW_PATHS.claude);
  assert.equal(action.kind, "conflict");
  assert.equal(plan.blocked, true);
});

test("overwrites a hand-edited file only with force", () => {
  const plan = planRepositoryAgentFiles(input({
    existing: new Map([[AGENT_WORKFLOW_PATHS.claude, "name: mine\n"]]),
    force: true,
  }));
  assert.equal(byPath(plan.actions, AGENT_WORKFLOW_PATHS.claude).kind, "update");
  assert.equal(plan.blocked, false);
});

test("treats an unstamped file as unmanaged", () => {
  const plan = planRepositoryAgentFiles(input({
    existing: new Map([[AGENT_WORKFLOW_PATHS.claude, "name: hand written\n"]]),
  }));
  const action = byPath(plan.actions, AGENT_WORKFLOW_PATHS.claude);
  assert.ok(action.kind === "conflict");
  assert.match(action.reason, /not generated by this tool/u);
});

test("provenance distinguishes generated, edited and foreign content", () => {
  const stamped = stampProvenance("name: generated\n");
  assert.equal(inspectProvenance(stamped), "managed");
  assert.equal(inspectProvenance(`${stamped}extra\n`), "modified");
  assert.equal(inspectProvenance("name: foreign\n"), "unmanaged");
  assert.equal(stripProvenance(stamped), "name: generated\n");
  assert.equal(stripProvenance("name: foreign\n"), "name: foreign\n");
});

test("stamping is deterministic and survives a round trip", () => {
  const body = "a: 1\nb: 2\n";
  assert.equal(stampProvenance(body), stampProvenance(body));
  assert.equal(stripProvenance(stampProvenance(body)), body);
});


test("upgrades an agent-only install and preserves the companion across agent switches", () => {
  const first = planRepositoryAgentFiles(input());
  const agent = byPath(first.actions, AGENT_WORKFLOW_PATHS.claude);
  assert.ok(agent.kind === "create");
  const existing = new Map([[agent.path, agent.contents]]);
  const upgraded = planRepositoryAgentFiles(input({ existing }));
  assert.equal(byPath(upgraded.actions, AGENT_WORKFLOW_PATHS.claude).kind, "unchanged");
  const companion = byPath(upgraded.actions, COMPLETION_WORKFLOW_PATH);
  assert.ok(companion.kind === "create");
  assert.equal(companion.contents.split("\n")[0], COMPLETION_MARKER);
  assert.match(companion.contents.split("\n")[1]!, /^# setorra-managed: sha256:/u);
  existing.set(companion.path, companion.contents);
  const switched = planRepositoryAgentFiles(input({ agent: "codex", existing }));
  assert.equal(byPath(switched.actions, COMPLETION_WORKFLOW_PATH).kind, "unchanged");
  assert.equal(planRepositoryAgentFiles(input({ existing })).clean, true);
  existing.set(companion.path, companion.contents + "# edited\n");
  assert.equal(planRepositoryAgentFiles(input({ existing })).blocked, true);
  assert.equal(planRepositoryAgentFiles(input({ existing, force: true })).blocked, false);
});

test("completion management stamp authenticates the marker and entire workflow", () => {
  const body = `${COMPLETION_MARKER}\nname: completion\n`;
  const stamped = stampProvenance(body);
  assert.equal(inspectProvenance(stamped), "managed");
  assert.equal(stripProvenance(stamped), body);
  assert.equal(inspectProvenance(stamped.replace("name: completion", "name: edited")), "modified");
  assert.notEqual(inspectProvenance(stamped.replace("/v1", "/v2")), "managed");
  assert.equal(inspectProvenance(stamped.slice(stamped.indexOf("\n") + 1)), "modified");
});
