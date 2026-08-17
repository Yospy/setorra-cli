import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  AGENT_ACTIONS,
  CHECKOUT_ACTION,
  UPLOAD_ARTIFACT_ACTION,
} from "../src/workflow/action-pins.js";
import { renderAgentWorkflow } from "../src/workflow/templates.js";
import { validateAgentWorkflow } from "../src/workflow/workflow-validate.js";

for (const agent of ["claude", "codex"] as const) {
  test(`${agent} golden fixture is current and semantically valid`, () => {
    const expected = renderAgentWorkflow({
      agent,
      credential: "api_key",
      botLogin: "setorra[bot]",
      label: "api-migration",
      checkoutAction: CHECKOUT_ACTION,
      agentAction: AGENT_ACTIONS[agent],
      uploadArtifactAction: UPLOAD_ARTIFACT_ACTION,
    });
    const fixture = readFileSync(
      new URL(`../../tests/fixtures/cloud-agent-v1/${agent}.yml`, import.meta.url),
      "utf8",
    );
    assert.equal(fixture, expected);
    assert.deepEqual(
      validateAgentWorkflow(parseYaml(fixture), {
        agent,
        botLogin: "setorra[bot]",
        label: "api-migration",
      }).findings,
      [],
    );
  });
}
