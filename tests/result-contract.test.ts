import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CloudAgentResultSchema } from "../src/workflow/result-contract.js";

for (const name of ["result-changed.json", "result-blocked.json"]) {
  test(`accepts ${name}`, () => {
    const json = readFileSync(new URL(`../../tests/fixtures/cloud-agent-v1/${name}`, import.meta.url), "utf8");
    assert.equal(CloudAgentResultSchema.safeParse(JSON.parse(json)).success, true);
  });
}
