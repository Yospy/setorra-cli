import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

const SHA256 = /^[a-f0-9]{64}$/u;
const ORIGINAL_V2_ISSUE = `# API migration handoff

\`\`\`json
{"schemaVersion":"release-agent-handoff/v2","handoffId":"11111111-1111-4111-8111-111111111111","handoffDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","contextDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","workflowContractVersion":"agent-workflow/1","resultContractVersion":"cloud-agent-result/v1","repositoryId":"123456789","baseSha":"cccccccccccccccccccccccccccccccccccccccc","workflowId":"987654321","workflowPath":".github/workflows/api-migration-claude.yml"}
\`\`\`

<!-- setorra-run:11111111-1111-4111-8111-111111111111;handoff:11111111-1111-4111-8111-111111111111;digest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->`;

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

function step(
  document: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  const jobs = document["jobs"] as Record<string, Record<string, unknown>>;
  const steps = jobs["migrate"]?.["steps"] as Record<string, unknown>[];
  const found = steps.find((candidate) => candidate["id"] === id);
  assert.ok(found !== undefined, `step '${id}' is missing`);
  return found;
}

function namedStep(
  document: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const jobs = document["jobs"] as Record<string, Record<string, unknown>>;
  const steps = jobs["migrate"]?.["steps"] as Record<string, unknown>[];
  const found = steps.find((candidate) => candidate["name"] === name);
  assert.ok(found !== undefined, `step '${name}' is missing`);
  return found;
}

function runSourceVerification(options: {
  expectedDigest: string;
  mode: "good" | "mismatch" | "oversized" | "invalid_length";
  github?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "setorra-source-"));
  const contextFile = join(root, "context.json");
  const sourceDirectory = join(root, "sources");
  const preload = join(root, "fetch-mock.cjs");
  writeFileSync(
    contextFile,
    JSON.stringify({
      schemaVersion: "release-agent-context/v3",
      sources: [{
        id: "source-1",
        kind: options.github ? "github_release" : "package_artifact",
        role: options.github ? "release_context" : "target_artifact",
        url: options.github
          ? "https://api.github.com/repos/example/package/releases/tags/v2.0.0"
          : "https://sources.example.test/artifact.tgz",
        sha256: options.expectedDigest,
      }],
    }),
  );
  writeFileSync(
    preload,
    `
const mode = process.env.MOCK_SOURCE_MODE;
global.fetch = async (input) => {
  const good = Buffer.from(process.env.MOCK_GITHUB === '1'
    ? JSON.stringify({ tag_name: 'v2.0.0', name: 'Version 2', body: 'Notes', html_url: 'https://github.com/example/package/releases/tag/v2.0.0', published_at: '2026-08-18T00:00:00Z', download_count: 99 })
    : 'verified source bytes');
  const chunks = mode === 'oversized'
    ? [new Uint8Array(64 * 1024 * 1024), new Uint8Array(1)]
    : [good];
  return {
    ok: true,
    url: String(input),
    headers: new Headers(mode === 'invalid_length'
      ? { 'content-length': '12x' }
      : mode === 'oversized' ? {} : { 'content-length': String(good.length) }),
    body: new ReadableStream({ start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    } }),
  };
};
`,
  );
  const result = spawnSync(
    "bash",
    [
      "-c",
      String(namedStep(workflow(), "Fetch and verify release sources")["run"]),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${preload}`,
        MOCK_SOURCE_MODE: options.mode,
        MOCK_GITHUB: options.github ? "1" : "0",
        RELEASE_CONTEXT_FILE: contextFile,
        RELEASE_SOURCE_DIR: sourceDirectory,
        SOURCE_TOKEN: "test-token",
      },
    },
  );
  if (options.mode === "good") {
    const manifest = JSON.parse(
      readFileSync(join(sourceDirectory, "manifest.json"), "utf8"),
    ) as { sha256: string }[];
    assert.match(manifest[0]?.sha256 ?? "", SHA256);
    rmSync(root, { recursive: true, force: true });
  } else {
    rmSync(root, { recursive: true, force: true });
  }
  return result;
}

function outputValue(file: string, key: string): string {
  const line = readFileSync(file, "utf8").split("\n")
    .find((candidate) => candidate.startsWith(`${key}=`));
  assert.ok(line !== undefined, `output '${key}' is missing`);
  return line.slice(key.length + 1);
}

function setupGitHarness(root: string): {
  workspace: string;
  runnerTemp: string;
  safeGit: string;
  baseSha: string;
} {
  const workspace = join(root, "workspace");
  const remote = join(root, "remote.git");
  const runnerTemp = join(root, "runner");
  const safeOutput = join(root, "safe-output");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "config", "user.name", "test"]);
  execFileSync("git", ["-C", workspace, "config", "user.email", "test@example.com"]);
  writeFileSync(join(workspace, "client.ts"), "export const version = 1;\n");
  execFileSync("git", ["-C", workspace, "add", "--all"]);
  execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
  const baseSha = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["clone", "--bare", workspace, remote], { stdio: "ignore" });
  const prepared = spawnSync("bash", ["-c", String(step(workflow(), "safe_git")["run"])], {
    encoding: "utf8",
    env: {
      ...process.env,
      BASE_SHA: baseSha,
      GH_TOKEN: "test-token",
      GITHUB_REPOSITORY: "remote",
      GITHUB_SERVER_URL: `file://${root}`,
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: safeOutput,
      RUNNER_TEMP: runnerTemp,
    },
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  return {
    workspace,
    runnerTemp,
    safeGit: outputValue(safeOutput, "dir"),
    baseSha,
  };
}

function assessChanges(input: {
  workspace: string;
  safeGit: string;
  baseSha: string;
  output: string;
}) {
  return spawnSync("bash", ["-c", String(step(workflow(), "prepare")["run"])], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_OUTCOME: "success",
      BASE_SHA: input.baseSha,
      SAFE_GIT_DIR: input.safeGit,
      GITHUB_WORKSPACE: input.workspace,
      GITHUB_OUTPUT: input.output,
    },
  });
}

test("every generated shell step parses in bash", () => {
  const jobs = workflow()["jobs"] as Record<string, Record<string, unknown>>;
  const steps = jobs["migrate"]?.["steps"] as Record<string, unknown>[];
  for (const candidate of steps) {
    if (typeof candidate["run"] !== "string") continue;
    const result = spawnSync("bash", ["-n"], {
      input: candidate["run"],
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${candidate["name"]}: ${result.stderr}`);
  }
});

test("generated provenance parser ignores unrelated JSON and emits checked outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "setorra-provenance-"));
  try {
    const issueBody = readFileSync(
      new URL(
        "../../tests/fixtures/cloud-agent-v1/issue-body.md",
        import.meta.url,
      ),
      "utf8",
    );
    const result = spawnSync("bash", [
      "-c",
      String(step(workflow(), "provenance")["run"]),
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        ISSUE_BODY: `\`\`\`json\n{"untrusted":true}\n\`\`\`\n${issueBody}`,
        EXPECTED_REPOSITORY_ID: "123456789",
        EXPECTED_WORKFLOW_PATH: ".github/workflows/api-migration-claude.yml",
        TASK_FILE: join(root, "task.md"),
        AGENT_PROMPT_FILE: join(root, "prompt.md"),
        RELEASE_CONTEXT_FILE: join(root, "context.json"),
        RUNNER_TEMP: root,
        GITHUB_OUTPUT: join(root, "output"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(root, "output"), "utf8"), /base_sha=cccc/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated provenance parser accepts original V2 issues", () => {
  const root = mkdtempSync(join(tmpdir(), "setorra-v2-provenance-"));
  try {
    const result = spawnSync("bash", [
      "-c",
      String(step(workflow(), "provenance")["run"]),
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        ISSUE_BODY: ORIGINAL_V2_ISSUE,
        EXPECTED_REPOSITORY_ID: "123456789",
        EXPECTED_WORKFLOW_PATH: ".github/workflows/api-migration-claude.yml",
        TASK_FILE: join(root, "task.md"),
        AGENT_PROMPT_FILE: join(root, "prompt.md"),
        RELEASE_CONTEXT_FILE: join(root, "context.json"),
        RUNNER_TEMP: root,
        GITHUB_OUTPUT: join(root, "output"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(readFileSync(join(root, "context.json"), "utf8")) as {
      schemaVersion: string;
    };
    assert.equal(context.schemaVersion, "release-agent-context/legacy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated source verifier accepts a streamed body with the expected digest", () => {
  const digest = createHash("sha256").update("verified source bytes").digest(
    "hex",
  );
  const result = runSourceVerification({
    expectedDigest: digest,
    mode: "good",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("generated source verifier hashes the stable GitHub release projection", () => {
  const projection = {
    tag_name: "v2.0.0",
    name: "Version 2",
    body: "Notes",
    html_url: "https://github.com/example/package/releases/tag/v2.0.0",
    published_at: "2026-08-18T00:00:00Z",
  };
  const digest = createHash("sha256").update(JSON.stringify(projection)).digest(
    "hex",
  );
  const result = runSourceVerification({
    expectedDigest: digest,
    mode: "good",
    github: true,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("generated source verifier rejects a digest mismatch", () => {
  const result = runSourceVerification({
    expectedDigest: "0".repeat(64),
    mode: "mismatch",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source_digest_mismatch:source-1/u);
});

test("generated source verifier bounds a chunked body while streaming", () => {
  const result = runSourceVerification({
    expectedDigest: "0".repeat(64),
    mode: "oversized",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source_too_large:source-1/u);
});

test("generated source verifier rejects malformed content-length", () => {
  const result = runSourceVerification({
    expectedDigest: "0".repeat(64),
    mode: "invalid_length",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid_source_length:source-1/u);
});

test("generated commits descend directly from the handoff base SHA", () => {
  const root = mkdtempSync(join(tmpdir(), "setorra-ancestry-"));
  try {
    const harness = setupGitHarness(root);
    writeFileSync(join(harness.workspace, "client.ts"), "export const version = 2;\n");
    const prepareOutput = join(root, "prepare-output");
    const assessed = assessChanges({
      ...harness,
      output: prepareOutput,
    });
    assert.equal(assessed.status, 0, assessed.stderr);
    assert.equal(outputValue(prepareOutput, "outcome"), "changed");

    const helpers = spawnSync("bash", [
      "-c",
      String(step(workflow(), "workflow_helpers")["run"]),
    ], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: harness.runnerTemp },
    });
    assert.equal(helpers.status, 0, helpers.stderr);
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), "#!/bin/sh\nprintf '%s\\n' '{\"state\":\"open\"}'\n");
    chmodSync(join(bin, "gh"), 0o700);
    const pushed = spawnSync("bash", ["-c", String(step(workflow(), "push")["run"])], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        BASE_SHA: harness.baseSha,
        GH_TOKEN: "test-token",
        GITHUB_EVENT_ISSUE_NUMBER: "1",
        GITHUB_REPOSITORY: "remote",
        GITHUB_WORKSPACE: harness.workspace,
        HANDOFF_BRANCH: "setorra/11111111-1111-4111-8111-111111111111",
        HANDOFF_ID: "11111111-1111-4111-8111-111111111111",
        RUNNER_TEMP: harness.runnerTemp,
        SAFE_GIT_DIR: harness.safeGit,
        GITHUB_OUTPUT: join(root, "push-output"),
      },
    });
    assert.equal(pushed.status, 0, pushed.stderr);
    const commit = execFileSync(
      "git",
      [`--git-dir=${harness.safeGit}`, "rev-list", "--parents", "-n", "1", "HEAD"],
      { encoding: "utf8" },
    ).trim().split(" ");
    assert.equal(commit.length, 2);
    assert.equal(commit[1], harness.baseSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("untracked protected files are blocked and reported as added", () => {
  const root = mkdtempSync(join(tmpdir(), "setorra-untracked-"));
  try {
    const harness = setupGitHarness(root);
    const protectedDirectory = join(harness.workspace, ".github", "workflows");
    mkdirSync(protectedDirectory, { recursive: true });
    writeFileSync(join(protectedDirectory, "untracked.yml"), "name: hostile\n");
    const prepareOutput = join(root, "prepare-output");
    const assessed = assessChanges({ ...harness, output: prepareOutput });
    assert.equal(assessed.status, 0, assessed.stderr);
    assert.equal(outputValue(prepareOutput, "outcome"), "blocked");
    assert.equal(outputValue(prepareOutput, "reason"), "protected_path_changed");

    const helpers = spawnSync("bash", [
      "-c",
      String(step(workflow(), "workflow_helpers")["run"]),
    ], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: harness.runnerTemp },
    });
    assert.equal(helpers.status, 0, helpers.stderr);
    const resultFile = join(root, "result.json");
    const writer = spawnSync(process.execPath, [
      join(harness.runnerTemp, "write-cloud-agent-result.cjs"),
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        SAFE_GIT_DIR: harness.safeGit,
        GITHUB_WORKSPACE: harness.workspace,
        BASE_SHA: harness.baseSha,
        HANDOFF_ID: "11111111-1111-4111-8111-111111111111",
        REPOSITORY_ID: "123456789",
        RESULT_FILE: resultFile,
        RESULT_OUTCOME: "blocked",
        RESULT_SUMMARY: "blocked",
        RESULT_RISKS: "[]",
        RESULT_BLOCKERS: '["protected_path_changed"]',
      },
    });
    assert.equal(writer.status, 0, writer.stderr);
    const result = JSON.parse(readFileSync(resultFile, "utf8")) as {
      changedFiles: { path: string; status: string }[];
    };
    assert.deepEqual(result.changedFiles, [{
      path: ".github/workflows/untracked.yml",
      status: "added",
    }]);
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
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "test@example.com",
    ]);
    writeFileSync(join(workspace, "client.ts"), "export const version = 1;\n");
    execFileSync("git", ["-C", workspace, "add", "--all"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    const baseSha = execFileSync(
      "git",
      ["-C", workspace, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    writeFileSync(join(workspace, "client.ts"), "export const version = 2;\n");

    const helpers = spawnSync("bash", [
      "-c",
      String(step(workflow(), "workflow_helpers")["run"]),
    ], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: runnerTemp },
    });
    assert.equal(helpers.status, 0, helpers.stderr);
    execFileSync("git", ["init", "--bare", safeGit], { stdio: "ignore" });
    execFileSync("git", [`--git-dir=${safeGit}`, "fetch", workspace, baseSha], {
      stdio: "ignore",
    });
    execFileSync("git", [
      `--git-dir=${safeGit}`,
      "update-ref",
      "refs/heads/handoff",
      baseSha,
    ]);
    execFileSync("git", [
      `--git-dir=${safeGit}`,
      "symbolic-ref",
      "HEAD",
      "refs/heads/handoff",
    ]);
    execFileSync("git", [
      `--git-dir=${safeGit}`,
      `--work-tree=${workspace}`,
      "read-tree",
      baseSha,
    ]);

    const resultFile = join(root, "result.json");
    const writer = spawnSync(process.execPath, [
      join(runnerTemp, "write-cloud-agent-result.cjs"),
    ], {
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
        RESULT_BLOCKERS: '["source_issue_closed"]',
      },
    });
    assert.equal(writer.status, 0, writer.stderr);
    const result = JSON.parse(readFileSync(resultFile, "utf8")) as {
      changedFiles: { path: string }[];
    };
    assert.deepEqual(result.changedFiles, [{
      path: "client.ts",
      status: "modified",
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
