#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  AGENT_WORKFLOW_PATHS,
  type AgentKind,
} from "./workflow/contracts.js";
import {
  managedPaths,
  type PlannedAction,
  planRepositoryAgentFiles,
} from "./workflow/plan.js";
import { stripProvenance } from "./workflow/provenance.js";
import {
  AGENT_ACTION_REPOSITORIES,
  AGENT_CREDENTIALS,
  type CredentialKind,
  type PinnedAction,
} from "./workflow/templates.js";
import { validateAgentWorkflow } from "./workflow/workflow-validate.js";

const BRANCH = "setorra/onboarding";
const BOT_LOGIN = process.env["SETORRA_BOT_LOGIN"] ?? "setorra[bot]";
const LABEL = process.env["SETORRA_LABEL"] ?? "api-migration";

// Deployment data, not domain logic. Bumping these is a reviewable commit, which is the
// point: it decides which third-party code every customer runs.
const CHECKOUT_ACTION: PinnedAction = {
  repository: "actions/checkout",
  sha: "3d3c42e5aac5ba805825da76410c181273ba90b1",
  version: "v7",
};
const AGENT_ACTIONS: Readonly<Record<AgentKind, PinnedAction>> = {
  claude: {
    repository: AGENT_ACTION_REPOSITORIES.claude,
    sha: "be7b93b1907a4abad570368f3c74b6fe3807510b",
    version: "v1",
  },
  codex: {
    repository: AGENT_ACTION_REPOSITORIES.codex,
    sha: "52fe01ec70a42f454c9d2ebd47598f9fd6893d56",
    version: "v1",
  },
};

type Options = {
  command: "init" | "status" | "sync";
  agent: AgentKind | undefined;
  /** Undefined until an agent is known, because the usable default differs per agent. */
  credential: CredentialKind | undefined;
  force: boolean;
  dryRun: boolean;
  root: string;
};

/**
 * Subscription tokens are the shipping default where they exist: early customers onboard
 * a repository or two on seats they already hold, rather than provisioning organization
 * billing. `openai/codex-action` accepts no such token, so Codex defaults to an API key.
 */
const DEFAULT_CREDENTIALS: Readonly<Record<AgentKind, CredentialKind>> = {
  claude: "oauth_token",
  codex: "api_key",
};

class UsageError extends Error {}

function parseArguments(argv: readonly string[]): Options {
  const [command, ...rest] = argv;
  if (command !== "init" && command !== "status" && command !== "sync") {
    throw new UsageError(
      "usage: setorra <init|status|sync> [claude|codex] " +
        "[--credential api_key|oauth_token] [--force] [--dry-run]",
    );
  }

  let agent: AgentKind | undefined;
  let credential: CredentialKind | undefined;
  let force = false;
  let dryRun = false;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "claude" || argument === "codex") {
      agent = argument;
    } else if (argument === "--force") {
      force = true;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--credential") {
      const value = rest[index + 1];
      if (value !== "api_key" && value !== "oauth_token") {
        throw new UsageError("--credential must be api_key or oauth_token");
      }
      credential = value;
      index += 1;
    } else {
      throw new UsageError(`unrecognised argument: ${argument}`);
    }
  }

  return { command, agent, credential, force, dryRun, root: process.cwd() };
}

/**
 * Captures stderr instead of letting it through. Some failures here are expected and
 * handled -- creating the branch when it already exists -- and git's `fatal:` on the way
 * to a successful run reads as a broken tool. Real failures still surface: the message is
 * attached to the thrown error.
 */
function git(root: string, args: readonly string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new Error(`git ${args[0]} failed: ${stderr.trim() || String(error)}`);
  }
}

function readManaged(root: string): Map<string, string> {
  const existing = new Map<string, string>();
  for (const path of managedPaths()) {
    const absolute = join(root, path);
    if (existsSync(absolute)) {
      existing.set(path, readFileSync(absolute, "utf8"));
    }
  }
  return existing;
}

/**
 * The installed workflow is the only record of which agent a repository uses. There is
 * no companion configuration file to disagree with it.
 */
function detectAgent(existing: ReadonlyMap<string, string>): AgentKind | undefined {
  for (const agent of ["claude", "codex"] as const) {
    const workflow = existing.get(AGENT_WORKFLOW_PATHS[agent]);
    if (workflow?.includes(AGENT_ACTION_REPOSITORIES[agent]) === true) {
      return agent;
    }
  }
  return undefined;
}

function describe(action: PlannedAction): string {
  switch (action.kind) {
    case "create":
      return `  create    ${action.path}`;
    case "update":
      return `  update    ${action.path}`;
    case "delete":
      return `  delete    ${action.path}\n            ${action.reason}`;
    case "unchanged":
      return `  unchanged ${action.path}`;
    case "conflict":
      return `  CONFLICT  ${action.path}\n            ${action.reason}`;
  }
}

function applyActions(root: string, actions: readonly PlannedAction[]): string[] {
  const touched: string[] = [];
  for (const action of actions) {
    const absolute = join(root, action.path);
    if (action.kind === "create" || action.kind === "update") {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, action.contents);
      touched.push(action.path);
    } else if (action.kind === "delete") {
      rmSync(absolute, { force: true });
      touched.push(action.path);
    }
  }
  return touched;
}

/**
 * Runs before the first mutation rather than at the `gh pr create` call. By that point
 * the tool has already branched, committed, and force-pushed, so a missing prerequisite
 * would strand a pushed branch with no pull request and no explanation.
 */
function preflight(root: string): string | undefined {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: root, stdio: "ignore" });
  } catch {
    return "not a git repository; run this from a checkout of the repository to onboard";
  }
  // Covers both "not installed" (spawn fails) and "installed but signed out" (exit 1),
  // which need the same two-step remedy from the customer.
  try {
    execFileSync("gh", ["auth", "status"], { cwd: root, stdio: "ignore" });
  } catch {
    return "GitHub CLI is unavailable or not signed in. Install it from " +
      "https://cli.github.com, then run `gh auth login`.";
  }
  return undefined;
}

function openPullRequest(
  root: string,
  agent: AgentKind,
  credential: CredentialKind,
  touched: readonly string[],
): void {
  const secret = AGENT_CREDENTIALS[agent][credential]?.secret ?? "";
  // Restricted to the files this run wrote. Staging `.github` wholesale sweeps up any
  // work in progress the customer happens to have there -- CODEOWNERS and their other
  // workflows live in that directory -- and puts it in a pull request titled as ours.
  // The `--` and the pathspec on commit keep an already-dirty index out of it too.
  git(root, ["add", "--all", "--", ...touched]);
  git(root, [
    "commit",
    "-m",
    `chore: configure automated API migration (${agent})`,
    "-m",
    "Adds the workflow that runs the coding agent. Merging authorizes the platform to\n" +
    "run it in this repository.",
    "--",
    ...touched,
  ]);
  git(root, ["push", "-u", "origin", BRANCH, "--force"]);

  const body = [
    "Generated by `setorra init`.",
    "",
    `- \`${AGENT_WORKFLOW_PATHS[agent]}\` — runs the ${agent} coding agent, gated on`,
    `  issues opened by \`${BOT_LOGIN}\` carrying the \`${LABEL}\` label. Nothing else`,
    "  can trigger it.",
    "",
    "This is the only file the platform adds. Which packages to migrate, which paths",
    "the agent may modify, and the analysis it works from are all sent with each",
    "issue, so there is no configuration here to maintain or to drift.",
    "",
    "Actions are pinned to full commit SHAs.",
    "",
    `**This needs a secret named \`${secret}\`.** If your organization already`,
    "provides it, nothing further is needed. Otherwise add it under",
    "Settings -> Secrets and variables -> Actions.",
    "",
    "Merging authorizes the platform. Deleting this workflow revokes it.",
  ].join("\n");

  try {
    const url = execFileSync("gh", [
      "pr",
      "create",
      "--head",
      BRANCH,
      "--title",
      `Configure automated API migration (${agent})`,
      "--body",
      body,
    ], { cwd: root, encoding: "utf8" }).trim();
    console.log(`\npull request: ${url}`);
  } catch {
    const url = execFileSync("gh", [
      "pr",
      "view",
      BRANCH,
      "--json",
      "url",
      "--jq",
      ".url",
    ], { cwd: root, encoding: "utf8" }).trim();
    console.log(`\npull request updated: ${url}`);
  }
}

function runStatus(options: Options): number {
  const existing = readManaged(options.root);

  const present = (["claude", "codex"] as const)
    .filter((agent) => existing.has(AGENT_WORKFLOW_PATHS[agent]));
  if (present.length === 0) {
    console.error("no migration workflow; run `setorra init <agent>` first");
    return 1;
  }

  let failures = 0;
  if (present.length > 1) {
    console.error(
      `error: ${present.length} migration workflows exist (${present.join(", ")}). ` +
        "Both would run on the same issue.",
    );
    failures += 1;
  }

  const agent = detectAgent(existing) ?? present[0];
  if (agent === undefined) {
    console.error("error: could not determine which agent the workflow runs.");
    return failures + 1;
  }

  const workflowPath = AGENT_WORKFLOW_PATHS[agent];
  const workflow = existing.get(workflowPath);
  if (workflow === undefined) {
    console.error(`error: ${workflowPath} is missing.`);
    return failures + 1;
  }

  console.log(`agent:     ${agent}`);
  console.log(`workflow:  ${workflowPath}`);
  console.log(`trigger:   issues opened by ${BOT_LOGIN} labelled ${LABEL}`);

  const result = validateAgentWorkflow(parseYaml(stripProvenance(workflow)), {
    agent,
    botLogin: BOT_LOGIN,
    label: LABEL,
  });
  for (const finding of result.findings) {
    console.error(`${finding.severity}: ${finding.code} — ${finding.message}`);
    if (finding.severity === "error") {
      failures += 1;
    }
  }

  if (failures === 0) {
    console.log("\nok: the workflow will run when a migration issue is opened.");
    console.log(
      "note: this cannot verify the repository secret, which is only readable by " +
        "Actions at run time.",
    );
  }
  return failures === 0 ? 0 : 1;
}

function runReconcile(options: Options): number {
  const existing = readManaged(options.root);

  // `sync` regenerates whatever is already installed -- after a pinned action SHA moves,
  // say -- so it never picks an agent. `init` takes the argument, falling back to the
  // installed workflow so re-running it without one is not a silent agent switch.
  const agent = options.command === "sync"
    ? detectAgent(existing)
    : options.agent ?? detectAgent(existing);
  if (agent === undefined) {
    console.error(
      options.command === "sync"
        ? "no migration workflow; run `setorra init <agent>` first"
        : "could not determine the agent; pass `claude` or `codex`",
    );
    return 1;
  }

  const credential = options.credential ?? DEFAULT_CREDENTIALS[agent];
  if (AGENT_CREDENTIALS[agent][credential] === undefined) {
    const supported = Object.keys(AGENT_CREDENTIALS[agent]).join(", ");
    console.error(
      `${agent} does not accept a ${credential} credential; it supports: ${supported}`,
    );
    return 1;
  }

  const plan = planRepositoryAgentFiles({
    agent,
    credential,
    botLogin: BOT_LOGIN,
    label: LABEL,
    checkoutAction: CHECKOUT_ACTION,
    agentAction: AGENT_ACTIONS[agent],
    existing,
    force: options.force,
  });

  console.log(`plan (${agent}):`);
  for (const action of plan.actions) {
    console.log(describe(action));
  }

  if (plan.blocked) {
    console.error(
      "\nblocked: a managed file was edited outside this tool. " +
        "Re-run with --force to overwrite it.",
    );
    return 2;
  }
  if (plan.clean) {
    console.log("\nalready configured; nothing to do.");
    return 0;
  }
  if (options.dryRun) {
    console.log("\ndry run: no files written.");
    return 0;
  }
  const blocker = preflight(options.root);
  if (blocker !== undefined) {
    console.error(`\n${blocker}`);
    return 1;
  }

  try {
    git(options.root, ["checkout", "-b", BRANCH]);
  } catch {
    git(options.root, ["checkout", BRANCH]);
  }
  const touched = applyActions(options.root, plan.actions);
  openPullRequest(options.root, agent, credential, touched);
  return 0;
}

export function main(argv: readonly string[]): number {
  let options: Options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(error instanceof UsageError ? error.message : String(error));
    return 1;
  }
  return options.command === "status" ? runStatus(options) : runReconcile(options);
}
