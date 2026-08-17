# Cloud-Agent Workflow Sprint

## Scope

Implement `docs/plans/2026-08-17-setorra-cli-cloud-agent-workflow.md` in this repository: deterministic generated workflows, contract validation, fixtures, CLI documentation and distribution. Backend and live canaries remain out of scope.

## Assumptions

- V1 uses the job-scoped `${{ github.token }}` after the repository enables the required Actions permissions.
- Existing Claude and Codex actions can leave edits uncommitted; a failure before deterministic post-processing produces no repository mutation.
- The workflow's Node runtime is the GitHub-hosted Node runtime; provenance parsing is embedded in the generated workflow to avoid a runtime dependency.

## Architecture decisions

- Keep one template and one semantic validator; add no service or framework layer.
- Parse the untrusted issue body once in Node, validate the bounded handoff contract, write only safe outputs, and materialize the agent task file there.
- Shell owns deterministic GitHub mutation and result generation; the agent only edits the working tree.

## Tasks

1. Add contract constants and failing/negative tests for the frozen workflow contract.
2. Add provenance contract parsing and exact-SHA checkout/branch setup.
3. Render edit-only agent steps and deterministic push/PR/result shell steps.
4. Extend parsed-YAML validation with relationship-aware findings.
5. Add deterministic fixture generator, CLI messaging and distribution updates.
6. Run the complete local verification suite, inspect the diff, and request independent review.

## Risks

- GitHub expressions and multi-line shell source can accidentally interpolate untrusted issue text.
- An agent failure, workflow cancellation, or malformed existing PR must still yield a bounded artifact without a mutation.
- Generated YAML validation must inspect structure and step ordering, not matching prose.
- The shell currently resolves Node 18.15.0 although this project requires Node 20+; validation must use a compatible bundled runtime rather than changing the project toolchain.
- The shared npm cache is root-owned; package verification must use an isolated temporary npm cache rather than altering user-owned cache permissions.
- Independent review found that agent-controlled Git hooks/config could execute after `GH_TOKEN` is introduced; post-agent mutation must use a fresh isolated Git directory with hooks and inherited configuration disabled.

## Verification

- Focused tests fail before implementation, then pass after it.
- Run `npm run typecheck`, `npm test`, fixture generation, `npm run build`, `npm pack --dry-run`, and `git diff --check`.
- Parse and validate both generated fixtures, then independently review the final diff.

## Result

- All 48 local tests pass; generated Claude and Codex fixtures pass `setorra status` with no warnings.
- Build and package dry-run pass using Node 20+ and an isolated temporary npm cache.
- Independent review findings were incorporated: isolated post-agent Git state, whole-workflow validation, tolerant provenance selection, truthful blocked-result diffs, draft-only PR adoption, and runtime generation tests.
