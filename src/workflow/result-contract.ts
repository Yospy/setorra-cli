import { z } from "zod";
import { RESULT_CONTRACT_VERSION } from "./contracts.js";

const Sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
const Path = z.string().min(1).max(512);

export const CloudAgentResultSchema = z.object({
  schemaVersion: z.literal(RESULT_CONTRACT_VERSION),
  handoffId: z.string().uuid(),
  outcome: z.enum(["changed", "no_change", "blocked", "failed"]),
  summary: z.string().max(1024),
  repository: z.object({
    provider: z.literal("github"),
    repositoryId: z.string().regex(/^[0-9]+$/u),
  }).strict(),
  baseSha: Sha,
  headSha: Sha,
  changedFiles: z.array(z.object({
    path: Path,
    status: z.enum(["added", "modified", "deleted", "renamed"]),
    previousPath: Path.optional(),
  }).strict()).max(200),
  checks: z.tuple([]),
  risks: z.array(z.string().max(256)).max(20),
  blockers: z.array(z.string().max(256)).max(20),
  pullRequest: z.object({
    number: z.number().int().positive(),
    url: z.url().max(2048),
  }).strict().nullable(),
  mergePerformed: z.literal(false),
}).strict();

export type CloudAgentResult = z.infer<typeof CloudAgentResultSchema>;
