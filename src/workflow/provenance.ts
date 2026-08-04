import { createHash } from "node:crypto";

export const PROVENANCE_PREFIX = "# setorra-managed: sha256:";

const PROVENANCE_LINE = /^# setorra-managed: sha256:([a-f0-9]{64})$/u;

function digest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Prefixes generated content with a hash of that content.
 *
 * This is what makes overwriting safe. Without it the tool cannot tell a file it wrote
 * from one a customer has since edited, so every regeneration risks silently discarding
 * their work. With it, a mismatch is a positive signal to stop and ask.
 */
export function stampProvenance(body: string): string {
  return `${PROVENANCE_PREFIX}${digest(body)}\n${body}`;
}

export type ProvenanceState = "managed" | "modified" | "unmanaged";

/**
 * `managed` — we wrote it and nobody has touched it.
 * `modified` — we wrote it and it has since been edited.
 * `unmanaged` — it carries no stamp, so it was never ours.
 */
export function inspectProvenance(content: string): ProvenanceState {
  const newlineIndex = content.indexOf("\n");
  if (newlineIndex === -1) {
    return "unmanaged";
  }
  const match = PROVENANCE_LINE.exec(content.slice(0, newlineIndex));
  if (match === null) {
    return "unmanaged";
  }
  return match[1] === digest(content.slice(newlineIndex + 1)) ? "managed" : "modified";
}

/** Removes the stamp so the content can be compared or re-rendered. */
export function stripProvenance(content: string): string {
  const newlineIndex = content.indexOf("\n");
  if (newlineIndex === -1 || !PROVENANCE_LINE.test(content.slice(0, newlineIndex))) {
    return content;
  }
  return content.slice(newlineIndex + 1);
}
