import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { UPLOAD_ARTIFACT_ACTION } from "../src/workflow/action-pins.js";
import { COMPLETION_INPUTS, COMPLETION_MARKER } from "../src/workflow/contracts.js";
import { renderCompletionWorkflow } from "../src/workflow/templates.js";
import { stampProvenance, inspectProvenance } from "../src/workflow/provenance.js";
import { validateCompletionWorkflow } from "../src/workflow/completion-validate.js";

const templateInput = { botLogin: "setorra[bot]", label: "api-migration", uploadArtifactAction: UPLOAD_ARTIFACT_ACTION };
const template = renderCompletionWorkflow(templateInput);
const doc = parseYaml(template);
const shell: string = doc.jobs.complete.steps[0].run;
const script = shell.replace(/^node <<'SETORRA_COMPLETION'\n/u, "").replace(/\nSETORRA_COMPLETION\n?$/u, "");
const body = readFileSync(new URL("../../tests/fixtures/cloud-agent-v1/issue-body.md", import.meta.url), "utf8");
const handoff = "11111111-1111-4111-8111-111111111111";
const head = "d".repeat(40);
const base = "c".repeat(40);
const marker = body.match(/<!-- setorra-run:.* -->/u)![0];
const original = {
  schemaVersion: "cloud-agent-result/v1", handoffId: handoff, outcome: "failed", summary: "pull request mutation failed",
  repository: { provider: "github", repositoryId: "123456789" }, baseSha: base, headSha: head,
  changedFiles: [{ path: "src/client.ts", status: "modified" }], checks: [], risks: [], blockers: ["pull_request_failed"], pullRequest: null, mergePerformed: false,
};
const inputs = {
  recovery_id: "22222222-2222-4222-8222-222222222222", handoff_id: handoff, issue_number: "42", original_run_id: "123", original_attempt: "2",
  original_result_digest: createHash("sha256").update(JSON.stringify(original)).digest("hex"), expected_head_sha: head, expected_base_sha: base, expected_execution_sha: "e".repeat(40),
};
const repository = { id: 123456789, full_name: "example/consumer", default_branch: "main", archived: false, disabled: false };
const originalRun = { id: 123, run_attempt: 2, status: "completed", event: "issues", head_sha: base, repository, display_title: "api-migration-42", path: ".github/workflows/api-migration-claude.yml", workflow_id: 987654321, run_started_at: "2026-09-08T00:00:00Z" };
const pr = {
  number: 99, html_url: "https://github.com/example/consumer/pull/99", head: { ref: "setorra/" + handoff, sha: head, repo: repository },
  base: { ref: "main", repo: repository }, user: { login: "github-actions[bot]" }, body: marker, draft: false, state: "open",
};
const artifact = { id: 77, name: "cloud-agent-result", created_at: "2026-09-08T00:01:00Z", expired: false, size_in_bytes: 1000, workflow_run: { id: 123, head_sha: base } };

function zip(json: string, filename = "cloud-agent-result.json"): Buffer {
  return execFileSync("python3", ["-c", "import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z: z.writestr(sys.argv[1], sys.stdin.buffer.read())\nsys.stdout.buffer.write(b.getvalue())", filename], { input: json });
}
const archive = zip(JSON.stringify(original));
type Options = {
  existing?: Record<string, unknown>[];
  inputs?: Partial<typeof inputs>;
  env?: Record<string, string>;
  archive?: Buffer;
  loseResponse?: boolean;
  refuseCreate?: boolean;
  respond?: (endpoint: string, value: unknown, read: number) => unknown;
};
function simulate(options: Options = {}) {
  const calls: { endpoint: string; body?: Record<string, unknown> }[] = [];
  let prs = options.existing ?? [];
  let result = "";
  let stderr = "";
  const reads = new Map<string, number>();
  const proc = { env: { RECOVERY_INPUTS: JSON.stringify({ ...inputs, ...options.inputs }), GITHUB_SHA: inputs.expected_execution_sha, GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: "example/consumer", GITHUB_REPOSITORY_ID: "123456789", EXPECTED_BOT_LOGIN: "setorra[bot]", EXPECTED_LABEL: "api-migration", RESULT_FILE: "/result.json", ...options.env }, exitCode: 0, stderr: { write: (value: string) => { stderr += value; } } };
  runInNewContext(script, {
    process: proc, Buffer, URL,
    require: (name: string) => {
      if (name === "node:crypto") return { createHash };
      if (name === "node:fs") return { writeFileSync: (path: string, data: string) => { assert.equal(path, "/result.json"); result = data; } };
      assert.equal(name, "node:child_process");
      return { execFileSync: (binary: string, args: string[], opts: { input?: string | Buffer }) => {
        if (binary === "python3") return execFileSync(binary, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });
        assert.equal(binary, "gh", "no Git, coding agent, or other process is permitted");
        assert.deepEqual(Array.from(args.slice(0, 3)), ["api", "--hostname", "github.com"]);
        const endpoint = args[7]!;
        const payload = opts.input === undefined ? undefined : JSON.parse(String(opts.input));
        calls.push({ endpoint, ...(payload === undefined ? {} : { body: payload }) });
        if (payload !== undefined) {
          assert.equal(endpoint, "repos/example/consumer/pulls", "only PR creation is permitted");
          assert.equal(payload.draft, false);
          assert.equal(payload.head, "setorra/" + handoff);
          if (!options.refuseCreate) prs = [{ ...pr, body: payload.body }];
          if (options.loseResponse || options.refuseCreate) throw new Error("provider error");
          return Buffer.from(JSON.stringify(prs[0]));
        }
        const count = (reads.get(endpoint) ?? 0) + 1;
        reads.set(endpoint, count);
        let value: unknown;
        if (endpoint === "repos/example/consumer") value = repository;
        else if (endpoint.endsWith("/issues/42")) value = { number: 42, state: "open", body, user: { login: "setorra[bot]" }, labels: [{ name: "api-migration" }] };
        else if (endpoint.endsWith("/runs/123") || endpoint.endsWith("/attempts/2")) value = originalRun;
        else if (endpoint.includes("/artifacts?")) value = { total_count: 1, artifacts: [artifact] };
        else if (endpoint.endsWith("/zip")) return options.archive ?? archive;
        else if (endpoint.includes("/git/ref/")) value = { ref: "refs/heads/setorra/" + handoff, object: { type: "commit", sha: head } };
        else if (endpoint.includes("/compare/")) value = { status: "ahead", files: [{ filename: "src/client.ts", status: "modified" }] };
        else if (endpoint.includes("/pulls?")) value = prs;
        else if (endpoint.endsWith("/pulls/99")) value = prs[0];
        else assert.fail("unexpected endpoint: " + endpoint);
        return Buffer.from(JSON.stringify(options.respond?.(endpoint, value, count) ?? value));
      } };
    },
  }, { timeout: 10000 });
  return { calls, mutations: calls.filter(c => c.body !== undefined), result: JSON.parse(result), stderr, status: proc.exitCode };
}

test("generated companion matches backend declarations and has only the reviewed runtime and pinned upload", () => {
  assert.equal(template.split("\n")[0], COMPLETION_MARKER);
  assert.deepEqual(Object.keys(doc.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(doc.on.workflow_dispatch.inputs), [...COMPLETION_INPUTS]);
  for (const input of Object.values(doc.on.workflow_dispatch.inputs)) assert.deepEqual(input, { required: true, type: "string" });
  assert.equal(doc["run-name"], "setorra-recovery-${{ inputs.recovery_id }}");
  assert.deepEqual(doc.permissions, { contents: "read", issues: "read", actions: "read", "pull-requests": "write" });
  assert.deepEqual(doc.concurrency, { group: "setorra-${{ inputs.handoff_id }}", "cancel-in-progress": false });
  assert.equal(doc.jobs.complete.if, "${{ github.sha == inputs.expected_execution_sha }}");
  assert.equal(Object.keys(doc.jobs).length, 1);
  assert.equal(doc.jobs.complete.permissions, undefined);
  assert.equal(doc.jobs.complete.steps.length, 2);
  assert.equal(doc.jobs.complete.steps[0].env.GH_TOKEN, "${{ github.token }}");
  assert.equal(doc.jobs.complete.steps[1].if, "always()");
  assert.equal(doc.jobs.complete.steps[1].uses, `actions/upload-artifact@${UPLOAD_ARTIFACT_ACTION.sha}`);
  assert.equal(doc.jobs.complete.steps[1].with.name, "cloud-agent-result");
  assert.equal(doc.jobs.complete.steps[1].with.path, "${{ runner.temp }}/cloud-agent-result.json");
  assert.ok(!shell.includes("${{"), "inputs must never interpolate into executable code");
  execFileSync("bash", ["-n"], { input: shell });
  assert.equal(inspectProvenance(stampProvenance(template)), "managed");
  assert.equal(validateCompletionWorkflow(stampProvenance(template), templateInput), true);
  for (const modified of [template.replace("draft: false", "draft: true"), template.replace("contents: read", "contents: write"), template.replace("actions: read", "actions: read\n  actions: write"), template.replace("    timeout-minutes: 10", "    permissions: write-all"), "# extra\n" + template]) {
    assert.equal(validateCompletionWorkflow(modified, templateInput), false);
  }
});

test("creates one ready PR and publishes the original base/head with authoritative paths", () => {
  const r = simulate();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.mutations.length, 1);
  assert.equal(r.result.outcome, "changed");
  assert.equal(r.result.baseSha, base);
  assert.equal(r.result.headSha, head);
  assert.deepEqual(r.result.changedFiles, original.changedFiles);
  assert.deepEqual(r.result.pullRequest, { number: 99, url: pr.html_url });
  assert.equal(r.result.mergePerformed, false);
  assert.deepEqual(r.result.blockers, []);
});

test("adopts an exact existing ready PR without editing it", () => {
  const r = simulate({ existing: [pr] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.mutations.length, 0);
});

test("reconciles a lost create response without repeating the POST", () => {
  const r = simulate({ loseResponse: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.mutations.length, 1);
});

test("failed create becomes action-required with no resubmission", () => {
  const r = simulate({ refuseCreate: true });
  assert.equal(r.status, 1);
  assert.equal(r.mutations.length, 1);
  assert.match(r.stderr, /will not be automatically resubmitted/u);
});

for (const [name, overrides, reason] of [
  ["draft", { draft: true }, /existing_draft/u],
  ["closed", { state: "closed" }, /closed_or_merged/u],
  ["wrong author", { user: { login: "someone" } }, /invalid_existing/u],
  ["wrong correlation", { body: "another migration" }, /invalid_existing/u],
  ["changed head", { head: { ...pr.head, sha: "f".repeat(40) } }, /invalid_existing/u],
  ["retargeted", { base: { ...pr.base, ref: "release" } }, /invalid_existing/u],
] as const) {
  test(`stops before mutation for an existing ${name} PR`, () => {
    const r = simulate({ existing: [{ ...pr, ...overrides }] });
    assert.equal(r.status, 1);
    assert.match(r.stderr, reason);
    assert.equal(r.mutations.length, 0);
  });
}

test("rejects ambiguous existing PRs without mutation", () => {
  const r = simulate({ existing: [pr, { ...pr, number: 100 }] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ambiguous_pull_request/u);
  assert.equal(r.mutations.length, 0);
});

for (const [name, change] of [
  ["missing", { total_count: 0, artifacts: [] }],
  ["expired", { total_count: 1, artifacts: [{ ...artifact, expired: true }] }],
  ["older attempt", { total_count: 1, artifacts: [{ ...artifact, created_at: "2026-09-07T00:00:00Z" }] }],
  ["ambiguous", { total_count: 2, artifacts: [artifact, artifact] }],
  ["truncated listing", { total_count: 101, artifacts: [artifact] }],
] as const) {
  test(`${name} original artifact stops before any PR mutation or branch reconstruction`, () => {
    const r = simulate({ respond: (endpoint, value) => endpoint.includes("/artifacts?") ? change : value });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /original_artifact/u);
    assert.equal(r.mutations.length, 0);
    assert.equal(r.calls.some(c => c.endpoint.includes("/compare/")), false);
  });
}

for (const [name, options, reason] of [
  ["invalid input", { inputs: { issue_number: "42; touch /tmp/injected" } }, /invalid_inputs/u],
  ["wrong execution SHA", { env: { GITHUB_SHA: head } }, /execution_identity/u],
  ["companion rerun", { env: { GITHUB_RUN_ATTEMPT: "2" } }, /execution_identity/u],
  ["digest mismatch", { inputs: { original_result_digest: "0".repeat(64) } }, /digest_mismatch/u],
  ["invalid archive member", { archive: zip(JSON.stringify(original), "../cloud-agent-result.json") }, /evidence_or_provider_unavailable/u],
] satisfies [string, Options, RegExp][]) {
  test(`${name} cannot cause mutation`, () => {
    const r = simulate(options);
    assert.equal(r.status, 1);
    assert.match(r.stderr, reason);
    assert.equal(r.mutations.length, 0);
  });
}

for (const phase of [1, 2, 3]) {
  test(`issue cancellation on read ${phase} stops before creation`, () => {
    const r = simulate({ respond: (endpoint, value, n) => endpoint.endsWith("/issues/42") && n === phase ? { ...(value as object), state: "closed" } : value });
    assert.equal(r.status, 1);
    assert.equal(r.mutations.length, 0);
  });
}
for (const phase of [1, 2]) {
  test(`branch drift on fence ${phase} stops before creation`, () => {
    const r = simulate({ respond: (endpoint, value, n) => endpoint.includes("/git/ref/") && n === phase ? { ...(value as object), object: { type: "commit", sha: "f".repeat(40) } } : value });
    assert.equal(r.status, 1);
    assert.equal(r.mutations.length, 0);
  });
}

test("branch drift after creation prevents a success result", () => {
  const r = simulate({ respond: (endpoint, value, n) => endpoint.includes("/git/ref/") && n === 3 ? { ...(value as object), object: { type: "commit", sha: "f".repeat(40) } } : value });
  assert.equal(r.status, 1);
  assert.equal(r.mutations.length, 1);
  assert.equal(r.result.outcome, "failed");
});

test("schema canonicalization accepts reordered JSON fields and nested fields", () => {
  const reordered = Object.fromEntries(Object.entries({ ...original, repository: { repositoryId: "123456789", provider: "github" }, changedFiles: [{ status: "modified", path: "src/client.ts" }] }).reverse());
  const r = simulate({ archive: zip(JSON.stringify(reordered)) });
  assert.equal(r.status, 0, r.stderr);
});

test("different original workflow attempt is rejected", () => {
  const r = simulate({ respond: (endpoint, value) => endpoint.endsWith("/runs/123") ? { ...originalRun, run_attempt: 3 } : value });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /original_workflow_changed/u);
  assert.equal(r.mutations.length, 0);
});

for (const [name, patch] of [
  ["wrong handoff", { handoffId: "33333333-3333-4333-8333-333333333333" }],
  ["wrong repository", { repository: { provider: "github", repositoryId: "123" } }],
  ["wrong base", { baseSha: "a".repeat(40) }],
  ["wrong head", { headSha: "a".repeat(40) }],
  ["unsupported failure", { blockers: ["agent_failed"] }],
  ["unexpected field", { extra: true }],
  ["invalid rename", { changedFiles: [{ path: "src/new.ts", status: "renamed" }] }],
  ["unsafe path", { changedFiles: [{ path: "../outside", status: "modified" }] }],
] as const) {
  test(`${name} in a digest-matching original result prevents mutation`, () => {
    const changed = { ...original, ...patch };
    const r = simulate({ archive: zip(JSON.stringify(changed)), inputs: { original_result_digest: createHash("sha256").update(JSON.stringify(changed)).digest("hex") } });
    assert.equal(r.status, 1);
    assert.equal(r.mutations.length, 0);
  });
}

test("normalizes deletions and preserves rename identities from GitHub", () => {
  const changed = { ...original, changedFiles: [{ path: "src/deleted.ts", status: "deleted" }, { path: "src/new.ts", status: "renamed", previousPath: "src/old.ts" }] };
  const r = simulate({ archive: zip(JSON.stringify(changed)), inputs: { original_result_digest: createHash("sha256").update(JSON.stringify(changed)).digest("hex") }, respond: (endpoint, value) => endpoint.includes("/compare/") ? { status: "ahead", files: [{ filename: "src/new.ts", status: "renamed", previous_filename: "src/old.ts" }, { filename: "src/deleted.ts", status: "removed" }] } : value });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.result.changedFiles, [changed.changedFiles[1], changed.changedFiles[0]]);
});

for (const [name, diff] of [
  ["different paths", { status: "ahead", files: [{ filename: "src/other.ts", status: "modified" }] }],
  ["truncated paths", { status: "ahead", files: Array.from({ length: 300 }, () => ({ filename: "src/client.ts", status: "modified" })) }],
  ["no changes", { status: "identical", files: [] }],
] as const) {
  test(`${name} from GitHub prevents PR mutation`, () => {
    const r = simulate({ respond: (endpoint, value) => endpoint.includes("/compare/") ? diff : value });
    assert.equal(r.status, 1);
    assert.equal(r.mutations.length, 0);
  });
}

test("a superseded original attempt immediately before creation prevents mutation", () => {
  const r = simulate({ respond: (endpoint, value, n) => endpoint.endsWith("/runs/123") && n === 3 ? { ...originalRun, run_attempt: 3 } : value });
  assert.equal(r.status, 1);
  assert.equal(r.mutations.length, 0);
  assert.match(r.stderr, /original_workflow_changed/u);
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}
for (const agent of ["claude", "codex", "cursor"] as const) {
  test(`recovers a ${agent} V4 handoff without fetching or executing its reference sources`, () => {
    const blocks = [...body.matchAll(/```json\n([\s\S]*?)\n```/gu)].map(m => JSON.parse(m[1]!));
    const context = blocks.find(b => b.schemaVersion === "release-agent-context/v3");
    const provenance = blocks.find(b => b.schemaVersion === "release-agent-handoff/v3");
    context.schemaVersion = "release-agent-context/v4";
    context.target.agentKind = agent;
    context.target.readiness.workflowPath = `.github/workflows/api-migration-${agent}.yml`;
    context.sources = ["base_artifact", "target_artifact"].map(role => ({ id: role, kind: "package_release_catalog", role, access: "reference_only", contentInspected: false, source: "PyPI", registryUrl: "https://pypi.org/pypi/example/json", snapshotSha256: "a".repeat(64), artifactCount: 2 }));
    delete context.payloadDigest;
    context.payloadDigest = createHash("sha256").update(canonicalJson(context)).digest("hex");
    provenance.schemaVersion = "release-agent-handoff/v4";
    provenance.contextPayloadDigest = context.payloadDigest;
    provenance.workflowPath = `.github/workflows/api-migration-${agent}.yml`;
    const v4body = [context, provenance].map(value => "```json\n" + JSON.stringify(value) + "\n```").join("\n") + "\n" + marker;
    const r = simulate({ respond: (endpoint, value) => {
      if (endpoint.endsWith("/issues/42")) return { ...(value as object), body: v4body };
      if (endpoint.endsWith("/runs/123") || endpoint.endsWith("/attempts/2")) return { ...(value as object), path: provenance.workflowPath };
      return value;
    } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.calls.every(c => c.endpoint.startsWith("repos/example/consumer")));
  });
}

test("template options cannot introduce GitHub expressions", () => {
  assert.throws(() => renderCompletionWorkflow({ ...templateInput, botLogin: "${{ secrets.TOKEN }}" }));
  assert.throws(() => renderCompletionWorkflow({ ...templateInput, label: "${{ secrets.TOKEN }}" }));
});

test("PR drift on the final reread prevents a success result", () => {
  const r = simulate({ existing: [pr], respond: (endpoint, value, n) => endpoint.endsWith("/pulls/99") && n === 2 ? { ...pr, draft: true } : value });
  assert.equal(r.status, 1);
  assert.equal(r.result.outcome, "failed");
  assert.equal(r.mutations.length, 0);
});
