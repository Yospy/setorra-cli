# setorra

Onboards a GitHub repository for automated API migration. It installs two workflow files
and opens a pull request for you to review.

```bash
npx setorra init claude    # or: codex
```

## What it writes

One agent workflow (Claude shown; Codex uses `api-migration-codex.yml`) and a shared
completion workflow:

```
.github/workflows/api-migration-claude.yml
.github/workflows/setorra-pr-completion.yml
```

The agent workflow runs a coding agent, and it runs only for issues opened by the platform's
GitHub App carrying the `api-migration` label. Nothing else can trigger it. Third-party
actions are pinned to full commit SHAs.

The completion workflow is dispatched by the backend when an agent pushed a migration
branch but failed to create its PR. It verifies the original workflow attempt, result
artifact/digest, issue provenance and unchanged branch before creating one ready-for-review
PR or adopting an existing correlated ready PR. It uses only `github.token`, never
checks out customer code, reruns the agent, commits, pushes, rebases or merges.

An existing draft PR, changed branch, ambiguous PR identity, or missing/expired original
artifact requires human action. Artifacts expire after seven days; there is no approved
fallback to the backend's retained result. Failure stops before PR mutation when evidence
is unavailable. Failed companion executions become action-required and are **not
automatically resubmitted** after a prerequisite is repaired. Do not manually rerun the
companion: backend v1 accepts only its first attempt.

Nothing else is added to your repository. Which packages to migrate, which paths the
agent may modify, and the analysis it works from are sent with each issue, so there is no
configuration file here to maintain or to drift out of date.

For releases whose distributable files are too large for bounded analysis, the workflow
passes a digest-bound PyPI catalog URL and artifact count to the agent instead of
embedding or downloading every binary. Those entries are marked `reference_only` and
uninspected; any artifact the agent chooses to inspect must be downloaded selectively,
checked against PyPI's SHA-256 metadata, and never executed.

## After merging

The workflow needs the selected agent credential:

| Agent | Secret |
| --- | --- |
| `claude` | `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY` with `--credential api_key`) |
| `codex` | `OPENAI_API_KEY` |

Add it under **Settings → Secrets and variables → Actions**.

For V1 repository mutations, GitHub Actions uses its job-scoped built-in
`${{ github.token }}`. Under **Settings → Actions → General**, set **Workflow
permissions** to **Read and write permissions** and enable **Allow GitHub Actions to
create and approve pull requests**. No custom PAT or GitHub App token is required.

GitHub may require approval for CI triggered by the automation-created PR. A custom
token for unattended CI is intentionally deferred to a later hardening release.

Merging the pull request authorizes these workflows. Delete both workflow files to
revoke execution. Removing the agent secret alone does not disable PR completion.

## Commands

| Command | Purpose |
| --- | --- |
| `setorra init <claude\|codex>` | Install both workflows and open a pull request. |
| `setorra status` | Check the agent workflow and reviewed completion contract. |
| `setorra sync` | Upgrade both workflows, including adding a missing companion. |

Existing installations must merge a `setorra sync` update before they can accept
reference-only release handoffs or PR-completion dispatches. The companion must be on
the default branch. Backend rollout also requires its FIFO recovery migration and
installation-owner approval of GitHub App Actions write; Administration write remains
required for automatic PR-setting repair.

Flags: `--credential api_key\|oauth_token`, `--force` to overwrite a hand-edited managed
file, `--dry-run` to print the plan without writing.

## Requirements

- Node.js 20 or newer
- `git`, and [GitHub CLI](https://cli.github.com) authenticated (`gh auth login`) — used
  to open the pull request

`init` checks both before it touches your repository, so a missing prerequisite fails
before anything is committed or pushed.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Development

```bash
npm install
npm run typecheck
npm test
npm run build     # bundles to dist/setorra.js
```

Releases publish from a tag: `git tag v0.1.0 && git push origin v0.1.0`.
