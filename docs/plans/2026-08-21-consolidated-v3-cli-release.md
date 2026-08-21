# Consolidated V3 CLI Release Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship one backward-compatible Setorra CLI release that safely consumes V2 and V3 handoffs, preserves Git ancestry, accounts for untracked files, and passes the shared backend contract gate.

**Architecture:** Keep the existing `agent-workflow/1` template and semantic validator. Branch provenance parsing by handoff schema, materialize verified sources only for V3, and retain the isolated Git directory while attaching its `HEAD` to the exact handoff base before diffing or committing. Use an explicit index refresh so tracked and untracked files share one authoritative diff for policy checks, commits, and results.

**Tech Stack:** TypeScript, Node.js 20+, generated GitHub Actions YAML, Bash, Git, Node test runner, Zod.

---

### Task 1: Lock schema-specific provenance behavior

**Files:**
- Modify: `tests/provenance-contract.test.ts`
- Modify: `tests/workflow-runtime.test.ts`
- Modify: `src/workflow/provenance-contract.ts`

**Steps:**
1. Add failing tests proving original V2 provenance works without V3-only fields, additive V2 legacy context is validated when present, and V3 requires its context digest and source hashes.
2. Run the focused provenance/runtime tests and confirm the regressions fail.
3. Replace the single handoff schema with a strict V2/V3 discriminated union and schema-specific context validation.
4. Mirror the same bounded behavior in the embedded workflow parser.
5. Rerun the focused tests.

### Task 2: Preserve ancestry and include untracked files

**Files:**
- Modify: `tests/workflow-runtime.test.ts`
- Modify: `src/workflow/templates.ts`

**Steps:**
1. Add failing runtime tests proving a generated commit has `BASE_SHA` as its sole parent and an untracked `.github/workflows/*` file is blocked and reported as added.
2. Run the focused runtime tests and confirm both failures.
3. Attach isolated `HEAD` to a deterministic local handoff ref at `BASE_SHA`.
4. Refresh the isolated index with `git add --all` before diff/policy evaluation so untracked files participate.
5. Ensure blocked result generation reads the same refreshed index without mutating the source checkout.
6. Rerun the focused tests.

### Task 3: Regenerate and validate the workflow contract

**Files:**
- Modify: `tests/fixtures/cloud-agent-v1/claude.yml`
- Modify: `tests/fixtures/cloud-agent-v1/codex.yml`
- Modify: `tests/fixtures/cloud-agent-v1/issue-body.md`

**Steps:**
1. Regenerate both workflow fixtures deterministically.
2. Run CLI tests, typecheck, build, `npm pack --dry-run`, shell parsing, fixture validation, and `git diff --check`.
3. Run the backend shared CLI-contract gate with this checkout as `SETORRA_CLI_ROOT`.
4. Review the complete diff, side effects, edge cases, and contract alignment.

### Task 4: Prepare the single npm release

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

**Steps:**
1. Select the next patch version only after every verification gate is green.
2. Update package metadata once without publishing.
3. Rebuild and inspect the packed artifact.
4. Stop before `npm publish` and provide the operator the exact Touch ID publication and post-publication verification commands.

### Task 5: Post-publication rollout handoff

**Files:** None in this repository before publication.

**Steps:**
1. After the operator publishes, verify the public npm version.
2. Run that exact published CLI version in `Yospy/long-running-agent` with `setorra sync`.
3. Inspect the generated workflow PR, prove it is the reviewed fixture, and merge only after checks pass.
