import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_ACTIONS,
  CHECKOUT_ACTION,
  UPLOAD_ARTIFACT_ACTION,
} from "../.tsbuild/src/workflow/action-pins.js";
import { renderAgentWorkflow } from "../.tsbuild/src/workflow/templates.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "tests/fixtures/cloud-agent-v1");
mkdirSync(output, { recursive: true });

for (const agent of ["claude", "codex"]) {
  const workflow = renderAgentWorkflow({
    agent,
    credential: "api_key",
    botLogin: "setorra[bot]",
    label: "api-migration",
    checkoutAction: CHECKOUT_ACTION,
    agentAction: AGENT_ACTIONS[agent],
    uploadArtifactAction: UPLOAD_ARTIFACT_ACTION,
  });
  const destination = resolve(output, `${agent}.yml`);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, workflow);
}
