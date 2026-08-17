# setorra

Onboards a GitHub repository for automated API migration. It installs one workflow file
and opens a pull request for you to review.

```bash
npx setorra init claude    # or: codex
```

## What it writes

Exactly one file:

```
.github/workflows/api-migration-claude.yml
```

That workflow runs a coding agent, and it runs only for issues opened by the platform's
GitHub App carrying the `api-migration` label. Nothing else can trigger it. Third-party
actions are pinned to full commit SHAs.

Nothing else is added to your repository. Which packages to migrate, which paths the
agent may modify, and the analysis it works from are sent with each issue, so there is no
configuration file here to maintain or to drift out of date.

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

Merging the pull request authorizes the platform to run an agent here. Deleting the
workflow, or removing the secret, revokes that: with no workflow, an issue has nothing to
trigger.

## Commands

| Command | Purpose |
| --- | --- |
| `setorra init <claude\|codex>` | Install the workflow and open a pull request. |
| `setorra status` | Check the installed workflow: right agent, gate intact, no duplicates. |
| `setorra sync` | Regenerate the installed workflow, e.g. after a pinned action moves. |

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
