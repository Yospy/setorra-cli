import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseIssueProvenance,
  ProvenanceContractError,
} from "../src/workflow/provenance-contract.js";

const FIXTURE = readFileSync(new URL("../../tests/fixtures/cloud-agent-v1/issue-body.md", import.meta.url), "utf8");
const HANDOFF_ID = "11111111-1111-4111-8111-111111111111";
const HANDOFF_DIGEST = "a".repeat(64);
const WORKFLOW_PATH = ".github/workflows/api-migration-claude.yml";

function canonical(value: unknown): string {
  if (value === null || ["boolean", "string", "number"].includes(typeof value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`
  ).join(",")}}`;
}

function issueBody(
  provenance: Record<string, unknown>,
  context?: Record<string, unknown>,
): string {
  const blocks = context === undefined
    ? []
    : ["```json", JSON.stringify(context), "```", ""];
  return [
    ...blocks,
    "```json",
    JSON.stringify(provenance),
    "```",
    "",
    `<!-- setorra-run:${HANDOFF_ID};handoff:${HANDOFF_ID};digest:${HANDOFF_DIGEST} -->`,
  ].join("\n");
}

function v2Provenance(): Record<string, unknown> {
  return {
    schemaVersion: "release-agent-handoff/v2",
    handoffId: HANDOFF_ID,
    handoffDigest: HANDOFF_DIGEST,
    contextDigest: "b".repeat(64),
    workflowContractVersion: "agent-workflow/1",
    resultContractVersion: "cloud-agent-result/v1",
    repositoryId: "123456789",
    baseSha: "c".repeat(40),
    workflowId: "987654321",
    workflowPath: WORKFLOW_PATH,
  };
}

test("extracts one bounded provenance object and correlation marker", () => {
  const result = parseIssueProvenance(
    `Hostile prose with { braces } and commands.\n\n\`\`\`json\n{"untrusted": true}\n\`\`\`\n\n${FIXTURE}\n\nMore prose.`,
    "123456789",
    ".github/workflows/api-migration-claude.yml",
  );
  assert.equal(result.handoffId, "11111111-1111-4111-8111-111111111111");
  assert.match(result.correlationMarker, /^<!-- setorra-run:/u);
});

test("rejects duplicate or mismatched machine provenance", () => {
  assert.throws(
    () => parseIssueProvenance(`${FIXTURE}\n${FIXTURE}`, "123456789", ".github/workflows/api-migration-claude.yml"),
    ProvenanceContractError,
  );
  assert.throws(
    () => parseIssueProvenance(FIXTURE.replace("123456789", "987654321"), "123456789", ".github/workflows/api-migration-claude.yml"),
    ProvenanceContractError,
  );
});

test("accepts original V2 provenance without V3-only context fields", () => {
  const result = parseIssueProvenance(
    issueBody(v2Provenance()),
    "123456789",
    WORKFLOW_PATH,
  );
  assert.equal(result.schemaVersion, "release-agent-handoff/v2");
  assert.equal("contextPayloadDigest" in result, false);
});

test("accepts and verifies additive V2 legacy context", () => {
  const unsignedContext = {
    schemaVersion: "release-agent-context/legacy",
    handoffId: HANDOFF_ID,
    contextDigest: "b".repeat(64),
  };
  const payloadDigest = createHash("sha256")
    .update(canonical(unsignedContext))
    .digest("hex");
  const result = parseIssueProvenance(
    issueBody(
      { ...v2Provenance(), contextPayloadDigest: payloadDigest },
      { ...unsignedContext, payloadDigest },
    ),
    "123456789",
    WORKFLOW_PATH,
  );
  assert.equal(result.contextPayloadDigest, payloadDigest);
});

test("requires contextPayloadDigest for V3 provenance", () => {
  assert.throws(
    () =>
      parseIssueProvenance(
        issueBody({ ...v2Provenance(), schemaVersion: "release-agent-handoff/v3" }),
        "123456789",
        WORKFLOW_PATH,
      ),
    ProvenanceContractError,
  );
});

test("rejects V3 sources without valid SHA-256 hashes", () => {
  const unsignedContext = {
    schemaVersion: "release-agent-context/v3",
    handoffId: HANDOFF_ID,
    sources: [
      {
        id: "base",
        kind: "package_artifact",
        role: "base_artifact",
        url: "https://example.test/base.tgz",
        sha256: "1".repeat(64),
      },
      {
        id: "target",
        kind: "package_artifact",
        role: "target_artifact",
        url: "https://example.test/target.tgz",
        sha256: "not-a-digest",
      },
    ],
  };
  const payloadDigest = createHash("sha256")
    .update(canonical(unsignedContext))
    .digest("hex");
  const provenance = {
    ...v2Provenance(),
    schemaVersion: "release-agent-handoff/v3",
    contextPayloadDigest: payloadDigest,
  };
  assert.throws(
    () =>
      parseIssueProvenance(
        issueBody(provenance, { ...unsignedContext, payloadDigest }),
        "123456789",
        WORKFLOW_PATH,
      ),
    ProvenanceContractError,
  );
});
