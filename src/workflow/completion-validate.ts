import { parseDocument } from "yaml";
import { COMPLETION_MARKER } from "./contracts.js";
import { renderCompletionWorkflow, type CompletionWorkflowInput } from "./templates.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

/** Require the reviewed implementation, not just backend-compatible declarations. */
export function validateCompletionWorkflow(content: string, input: CompletionWorkflowInput): boolean {
  if (!content.startsWith(`${COMPLETION_MARKER}\n`)) return false;
  const actual = parseDocument(content, { uniqueKeys: true });
  if (actual.errors.length !== 0) return false;
  const expected = parseDocument(renderCompletionWorkflow(input));
  return canonical(actual.toJS()) === canonical(expected.toJS());
}
