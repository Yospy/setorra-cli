# PR Completion Implementation Plan

**Goal:** Install a completion-only workflow that creates or adopts a PR from an unchanged existing branch, without executing customer code or pushing.

**Architecture:** Render a standalone inline Node script with GitHub CLI reads and one PR-create operation. Reuse issue provenance validation, strictly canonicalize the historical result in backend schema order, and fail closed before mutation on missing evidence, cancellation, drift, draft PRs, or ambiguity. Install the companion alongside either agent through the existing reconciliation plan and management hash.

**Tech Stack:** TypeScript, Node built-ins, GitHub CLI, YAML, node:test.

## Contract and decisions

Source: backend PR #18, commit deb2ec340bd43de0dfc5667e7cae10a60cfc5967, docs/fifo-workflow-recovery.md; backend clarifications supplied by the user.
- First line contract marker, second line CLI management stamp.
- Exactly nine dispatch inputs, read-only contents/issues/actions, PR write, execution-SHA guard, handoff concurrency.
- New PRs ready for review. Existing correlated drafts require action; never promote or duplicate them.
- Missing/expired original artifacts require action before PR mutation; no branch-based reconstruction.
- Existing correlated ready PRs are adopted without edits. Ambiguous create responses are reconciled with reads, not repeated creates.
- Failed companions are action-required; prerequisite repair does not cause automatic resubmission.

## Tasks

1. Add completion script/template and shared provenance validation rendering. Strictly validate inputs, original workflow/attempt/artifact/digest, repository, source issue and branch. Compare original base/head through GitHub for authoritative paths. Re-read issue/head before creating and verify returned PR before recording success.
2. Extend management stamping for the required first-line marker. Add companion to managed paths and reconciliation; validate it in status. Update setup PR copy and README.
3. Add offline runtime simulations for create/adopt, lost create response, drafts, cancellation, branch drift, identity/digest failures, missing/expired artifacts and ambiguity. Verify generated workflow declarations and install/upgrade/agent-switch/idempotency/conflict handling.
4. Run npm test, npm run typecheck, npm run build, review diff and side effects. Keep work local on the current branch; no push or customer workflow dispatch.

## Risks and verification limits

Artifact expiry is intentionally unrecoverable under v1. GitHub has no atomic branch-head precondition on PR creation: re-read immediately before and after mutation, reject drift, and leave final GitHub verification to backend. Offline provider simulations verify execution logic; live installation and controlled FIFO canary require later rollout. Backend migration and GitHub App permission approvals remain backend/operator responsibilities.

## Verification and self-review (completed)

- `npm test`: 116 passed, 0 failed. Includes real ZIP decoding, offline GitHub runtime simulations, and init/sync/status integration with temporary local Git repositories and a mocked GitHub CLI.
- `npm run typecheck`, `npm run build`, and `git diff --check`: passed. Existing Claude/Codex golden workflow fixtures remain byte-for-byte unchanged.
- Read-only GitHub inspection confirmed exact-attempt responses include path, workflow identity, repository identity and run start time. No customer workflow was dispatched.
- Reviewed baseline diff, management-marker tamper handling, agent switching, missing companion upgrades, mutation boundaries and failure outcomes. Customer edits remain protected by reconciliation conflicts. The companion cannot execute Git or an agent; its only provider mutation is one PR-creation POST with `draft: false`.
- Failure results use an explicit failed outcome with placeholder provenance when evidence cannot be trusted; they cannot authorize adoption. Original artifacts are never modified. Backend remains authoritative for successful recovery, human merge and FIFO advancement.
- Work remains local. Publishing, installation-owner permission approval and the controlled backend FIFO canary remain rollout work.
