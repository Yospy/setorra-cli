import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import {
  AGENT_ACTIONS,
  CHECKOUT_ACTION,
  UPLOAD_ARTIFACT_ACTION,
} from "../src/workflow/action-pins.js";
import { renderAgentWorkflow } from "../src/workflow/templates.js";

function workflow(): Record<string, unknown> {
  return parseYaml(renderAgentWorkflow({
    agent: "claude",
    credential: "api_key",
    botLogin: "setorra[bot]",
    label: "api-migration",
    checkoutAction: CHECKOUT_ACTION,
    agentAction: AGENT_ACTIONS.claude,
    uploadArtifactAction: UPLOAD_ARTIFACT_ACTION,
  })) as Record<string, unknown>;
}

function step(document: Record<string, unknown>, id: string): Record<string, unknown> {
  const jobs = document["jobs"] as Record<string, Record<string, unknown>>;
  const steps = jobs["migrate"]?.["steps"] as Record<string, unknown>[];
  const found = steps.find((candidate) => candidate["id"] === id);
  assert.ok(found !== undefined, `step '${id}' is missing`);
  return found;
}

test("every generated shell step parses in bash", () => {
  const jobs = workflow()["jobs"] as Record<string, Record<string, unknown>>;
  const steps = jobs["migrate"]?.["steps"] as Record<string, unknown>[];
  for (const candidate of steps) {
    if (typeof candidate["run"] !== "string") continue;
    const result = spawnSync("bash", ["-n"], { input: candidate["run"], encoding: "utf8" });
    assert.equal(result.status, 0, `${candidate["name"]}: ${result.stderr}`);
  }
});

test("generated provenance parser ignores unrelated JSON and emits checked outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "setorra-provenance-"));
  try {
    const issueBody = readFileSync(
      new URL("../../tests/fixtures/cloud-agent-v1/issue-body.md", import.meta.url),
      "utf8",
    );
    const result = spawnSync("bash", ["-c", String(step(workflow(), "provenance")["run"])], {
      encoding: "utf8",
      env: {
        ...process.env,
        ISSUE_BODY: `\`\`\`json\n{"untrusted":true}\n\`\`\`\n${issueBody}`,
        EXPECTED_REPOSITORY_ID: "123456789",
        EXPECTED_WORKFLOW_PATH: ".github/workflows/api-migration-claude.yml",
        TASK_FILE: join(root, "task.md"),
        AGENT_PROMPT_FILE: join(root, "prompt.md"),
        GITHUB_OUTPUT: join(root, "output"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(root, "output"), "utf8"), /base_sha=cccc/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated result writer reports uncommitted blocked changes", () => {
  const root = mkdtempSync(join(tmpdir(), "setorra-result-"));
  try {
    const workspace = join(root, "workspace");
    const safeGit = join(root, "safe.git");
    const runnerTemp = join(root, "runner");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(runnerTemp, { recursive: true });
    execFileSync("git", ["init", workspace], { stdio: "ignore" });
    execFileSync("git", ["-C", workspace, "config", "user.name", "test"]);
    execFileSync("git", ["-C", workspace, "config", "user.email", "test@example.com"]);
    writeFileSync(join(workspace, "client.ts"), "export const version = 1;\n");
    execFileSync("git", ["-C", workspace, "add", "--all"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    const baseSha = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(join(workspace, "client.ts"), "export const version = 2;\n");

    const helpers = spawnSync("bash", ["-c", String(step(workflow(), "workflow_helpers")["run"])], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: runnerTemp },
    });
    assert.equal(helpers.status, 0, helpers.stderr);
    execFileSync("git", ["init", "--bare", safeGit], { stdio: "ignore" });
    execFileSync("git", [`--git-dir=${safeGit}`, "fetch", workspace, baseSha], { stdio: "ignore" });
    execFileSync("git", [`--git-dir=${safeGit}`, "update-ref", "refs/heads/handoff", baseSha]);
    execFileSync("git", [`--git-dir=${safeGit}`, "symbolic-ref", "HEAD", "refs/heads/handoff"]);
    execFileSync("git", [`--git-dir=${safeGit}`, `--work-tree=${workspace}`, "read-tree", baseSha]);

    const resultFile = join(root, "result.json");
    const writer = spawnSync(process.execPath, [join(runnerTemp, "write-cloud-agent-result.cjs")], {
      encoding: "utf8",
      env: {
        ...process.env,
        SAFE_GIT_DIR: safeGit,
        GITHUB_WORKSPACE: workspace,
        BASE_SHA: baseSha,
        HANDOFF_ID: "11111111-1111-4111-8111-111111111111",
        REPOSITORY_ID: "123456789",
        RESULT_FILE: resultFile,
        RESULT_OUTCOME: "blocked",
        RESULT_SUMMARY: "blocked",
        RESULT_RISKS: "[]",
        RESULT_BLOCKERS: "[\"source_issue_closed\"]",
      },
    });
    assert.equal(writer.status, 0, writer.stderr);
    const result = JSON.parse(readFileSync(resultFile, "utf8")) as { changedFiles: { path: string }[] };
    assert.deepEqual(result.changedFiles, [{ path: "client.ts", status: "modified" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
