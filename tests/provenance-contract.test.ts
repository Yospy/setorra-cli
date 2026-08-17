import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseIssueProvenance,
  ProvenanceContractError,
} from "../src/workflow/provenance-contract.js";

const FIXTURE = readFileSync(new URL("../../tests/fixtures/cloud-agent-v1/issue-body.md", import.meta.url), "utf8");

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
