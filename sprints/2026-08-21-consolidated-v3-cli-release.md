# Consolidated V3 CLI Release Sprint

**Status:** CLI implementation and local review complete; backend AST acceptance digest
authorization is required before the shared gate, version bump, or publication.

## Scope

Complete one release containing V2/V3 provenance compatibility, verified V3 sources,
correct Git parent ancestry, untracked-file enforcement/reporting, regression coverage,
shared backend contract verification, and npm package preparation. Publication and the
consumer-repository PR require the operator's authenticated approval.

## Assumptions

- Existing uncommitted V3 edits are in-scope work and must be preserved.
- `agent-workflow/1` remains the frozen workflow contract.
- V2 accepts its original provenance; additive legacy context is validated when present.
- V3 requires a digest-bound context and verified sources.
- Backend policy behavior is out of scope.

## Architectural Decisions

- Use strict schema-specific validation instead of one superset schema.
- Keep the isolated post-agent Git directory and point its local handoff ref at the
  exact base commit before committing.
- Stage into the isolated index before assessment so tracked and untracked changes use
  one source of truth without executing agent-controlled Git configuration or hooks.
- Publish once only after CLI and backend contract gates pass.

## Tasks

1. Add failing schema-specific provenance tests and implement the minimal fix.
2. Add failing ancestry/untracked tests and implement isolated-index fixes.
3. Regenerate fixtures and pass all local/shared verification.
4. Review the diff and prepare one patch-version package.
5. Hand off Touch ID publication and post-publication sync commands.

## Risks

- A permissive V2 branch could accidentally weaken V3 verification.
- Staging untrusted changes must not run repository hooks or inherited Git config.
- Reusing an unborn isolated `HEAD` creates a root commit unrelated to the handoff base.
- Ignoring untracked files can bypass protected-path policy and produce false results.
- Publishing before cross-repository parity would create an unrecoverable partial release.

## Verification Strategy

- Focused provenance and workflow-runtime regressions fail before fixes and pass after.
- Full CLI tests, typecheck, deterministic fixtures, build, package dry-run, diff check,
  shell syntax checks, and semantic workflow validation pass.
- Backend shared-contract fixtures and tests are byte-identical and green.
- Structured review checks minimality, ancestry, protected paths, source integrity,
  backward compatibility, and package contents.
