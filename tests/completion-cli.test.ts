import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { COMPLETION_WORKFLOW_PATH } from "../src/workflow/contracts.js";

const cli = fileURLToPath(new URL("../src/bin.js", import.meta.url));
for (const agent of ["claude", "codex"] as const) {
  test(`${agent}: init installs both workflows, sync upgrades an old install, status detects missing or edited companion`, () => {
    const root = mkdtempSync(join(tmpdir(), "setorra-completion-cli-"));
    const repository = join(root, "customer");
    const origin = join(root, "origin.git");
    const bin = join(root, "bin");
    mkdirSync(repository);
    mkdirSync(bin);
    const env = { ...process.env, PATH: bin + ":" + process.env["PATH"], GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid", SETORRA_BOT_LOGIN: "setorra[bot]", SETORRA_LABEL: "api-migration" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: repository, env, encoding: "utf8" });
    try {
      writeFileSync(join(bin, "gh"), '#!/bin/sh\ncase "$1" in\n auth) exit 0 ;;\n pr) echo https://github.com/example/consumer/pull/1 ;;\n *) exit 1 ;;\nesac\n', { mode: 0o755 });
      git("init", "--initial-branch=main");
      git("config", "core.hooksPath", "/dev/null");
      git("init", "--bare", origin);
      git("remote", "add", "origin", origin);
      writeFileSync(join(repository, "README.md"), "customer\n");
      git("add", "README.md");
      git("commit", "-m", "initial");
      const dry = run("init", agent, "--dry-run");
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /create.*setorra-pr-completion/u);
      assert.equal(git("status", "--porcelain"), "");
      const installed = run("init", agent);
      assert.equal(installed.status, 0, installed.stderr);
      const completion = readFileSync(join(repository, COMPLETION_WORKFLOW_PATH), "utf8");
      assert.match(completion, /^# setorra-pr-completion\/v1\n# setorra-managed: sha256:/u);
      assert.equal(git("status", "--porcelain"), "");
      assert.equal(run("status").status, 0);
      assert.match(run("sync").stdout, /already configured/u);
      git("rm", COMPLETION_WORKFLOW_PATH);
      git("commit", "-m", "simulate pre-companion installation");
      assert.equal(run("status").status, 1);
      const upgrade = run("sync");
      assert.equal(upgrade.status, 0, upgrade.stderr);
      assert.equal(readFileSync(join(repository, COMPLETION_WORKFLOW_PATH), "utf8"), completion);
      assert.equal(run("status").status, 0);
      writeFileSync(join(repository, COMPLETION_WORKFLOW_PATH), completion.replace("draft: false", "draft: true"));
      assert.equal(run("status").status, 1);
      assert.equal(run("sync", "--dry-run").status, 2);
      assert.equal(run("sync", "--force", "--dry-run").status, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
