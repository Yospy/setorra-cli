import { renderProvenanceValidationScript } from "./provenance-contract.js";

/** Standalone, dependency-free code: the customer repository is never checked out. */
export function renderCompletionScript(): string {
  return String.raw`
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fail = (reason) => { throw new Error('action_required:' + reason); };
const exact = (v, keys, optional = []) => v && typeof v === 'object' && !Array.isArray(v) && keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => keys.includes(k) || optional.includes(k));
const string = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
const sha = v => typeof v === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(v);
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const id = v => typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v);
const url = v => { try { return string(v, 1, 2048) && Boolean(new URL(v)); } catch { return false; } };
const path = v => string(v, 1, 512) && !v.startsWith('/') && !v.includes('\\') && !v.split('/').includes('..') && !v.includes('\0');
// Reconstruct in CloudAgentResultSchema field order, including nested objects.
// This is schema serialization + JSON.stringify, NOT alphabetically sorted JSON.
function canonicalResult(r) {
  if (!exact(r, ['schemaVersion','handoffId','outcome','summary','repository','baseSha','headSha','changedFiles','checks','risks','blockers','pullRequest','mergePerformed']) || r.schemaVersion !== 'cloud-agent-result/v1' || !uuid(r.handoffId) || !['changed','no_change','blocked','failed'].includes(r.outcome) || !string(r.summary, 1, 2000) || !exact(r.repository, ['provider','repositoryId']) || r.repository.provider !== 'github' || !string(r.repository.repositoryId, 1, 128) || !sha(r.baseSha) || !sha(r.headSha) || r.mergePerformed !== false) fail('invalid_original_result');
  if (!Array.isArray(r.changedFiles) || r.changedFiles.length > 500 || !Array.isArray(r.checks) || r.checks.length > 100 || ![r.risks, r.blockers].every(a => Array.isArray(a) && a.length <= 100 && a.every(v => string(v, 1, 1000)))) fail('invalid_original_result');
  const changedFiles = r.changedFiles.map(f => {
    if (!exact(f, ['path','status'], ['previousPath']) || !path(f.path) || !['added','modified','deleted','renamed'].includes(f.status) || (f.status === 'renamed') !== Object.hasOwn(f, 'previousPath') || (Object.hasOwn(f, 'previousPath') && !path(f.previousPath))) fail('invalid_original_result');
    return { path: f.path, status: f.status, ...(f.previousPath === undefined ? {} : { previousPath: f.previousPath }) };
  });
  const checks = r.checks.map(c => {
    if (!exact(c, ['name','status'], ['url']) || !string(c.name, 1, 255) || !['passed','failed','skipped'].includes(c.status) || (Object.hasOwn(c, 'url') && !url(c.url))) fail('invalid_original_result');
    return { name: c.name, status: c.status, ...(c.url === undefined ? {} : { url: c.url }) };
  });
  if (r.pullRequest !== null && (!exact(r.pullRequest, ['number','url']) || !Number.isSafeInteger(r.pullRequest.number) || r.pullRequest.number <= 0 || !url(r.pullRequest.url))) fail('invalid_original_result');
  if (r.outcome === 'changed' && (!changedFiles.length || r.headSha === r.baseSha)) fail('invalid_original_result');
  if (r.outcome === 'no_change' && (changedFiles.length || r.headSha !== r.baseSha || r.pullRequest !== null)) fail('invalid_original_result');
  return { schemaVersion: r.schemaVersion, handoffId: r.handoffId, outcome: r.outcome, summary: r.summary, repository: { provider: r.repository.provider, repositoryId: r.repository.repositoryId }, baseSha: r.baseSha, headSha: r.headSha, changedFiles, checks, risks: r.risks, blockers: r.blockers, pullRequest: r.pullRequest === null ? null : { number: r.pullRequest.number, url: r.pullRequest.url }, mergePerformed: false };
}
const inputs = JSON.parse(process.env.RECOVERY_INPUTS);
if (!exact(inputs, ['recovery_id','handoff_id','issue_number','original_run_id','original_attempt','original_result_digest','expected_head_sha','expected_base_sha','expected_execution_sha']) || !uuid(inputs.recovery_id) || !uuid(inputs.handoff_id) || !['issue_number','original_run_id','original_attempt'].every(k => id(inputs[k])) || !/^[a-f0-9]{64}$/.test(inputs.original_result_digest) || !['expected_head_sha','expected_base_sha','expected_execution_sha'].every(k => sha(inputs[k]))) fail('invalid_inputs');
if (process.env.GITHUB_SHA !== inputs.expected_execution_sha || process.env.GITHUB_RUN_ATTEMPT !== '1') fail('execution_identity_mismatch');
const repoName = process.env.GITHUB_REPOSITORY;
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoName) || !id(process.env.GITHUB_REPOSITORY_ID)) fail('invalid_repository');
const prefix = 'repos/' + repoName;
const branch = 'setorra/' + inputs.handoff_id;
function request(endpoint, body, binary = false) {
  const args = ['api', '--hostname', 'github.com', '-H', 'X-GitHub-Api-Version: 2022-11-28', '-H', 'Accept: application/vnd.github+json', endpoint];
  if (body !== undefined) args.push('--method', 'POST', '--input', '-');
  const output = execFileSync('gh', args, { input: body === undefined ? undefined : JSON.stringify(body), maxBuffer: 4 * 1024 * 1024, timeout: 60000, stdio: ['pipe','pipe','pipe'] });
  return binary ? output : JSON.parse(output.toString('utf8'));
}
const repository = request(prefix);
if (String(repository.id) !== process.env.GITHUB_REPOSITORY_ID || repository.full_name !== repoName || repository.archived || repository.disabled || !string(repository.default_branch, 1, 255)) fail('repository_changed');
const baseBranch = repository.default_branch;
const run = request(prefix + '/actions/runs/' + inputs.original_run_id);
const attempt = request(prefix + '/actions/runs/' + inputs.original_run_id + '/attempts/' + inputs.original_attempt);
for (const r of [run, attempt]) {
  if (String(r.id) !== inputs.original_run_id || String(r.run_attempt) !== inputs.original_attempt || r.status !== 'completed' || r.event !== 'issues' || r.head_sha !== inputs.expected_base_sha || String(r.repository?.id) !== process.env.GITHUB_REPOSITORY_ID || r.display_title !== 'api-migration-' + inputs.issue_number || !/^\.github\/workflows\/api-migration-(claude|codex|cursor)\.yml$/.test(r.path)) fail('original_workflow_changed');
}
if (run.workflow_id !== attempt.workflow_id || run.path !== attempt.path) fail('original_workflow_changed');
function validateIssue(issue) {
  if (issue.state !== 'open' || String(issue.number) !== inputs.issue_number || issue.pull_request || issue.user?.login !== process.env.EXPECTED_BOT_LOGIN || !issue.labels?.some(l => l.name === process.env.EXPECTED_LABEL)) fail('source_issue_closed_or_changed');
  process.env.ISSUE_BODY = issue.body;
  process.env.EXPECTED_REPOSITORY_ID = process.env.GITHUB_REPOSITORY_ID;
  process.env.EXPECTED_WORKFLOW_PATH = run.path;
` + renderProvenanceValidationScript().join("\n") + String.raw`
  if (!modern || provenance.handoffId !== inputs.handoff_id || provenance.baseSha !== inputs.expected_base_sha || provenance.workflowId !== String(run.workflow_id)) fail('original_provenance_mismatch');
  return marker[0];
}
const correlation = validateIssue(request(prefix + '/issues/' + inputs.issue_number));
const started = Date.parse(attempt.run_started_at);
if (!Number.isFinite(started)) fail('original_attempt_time_missing');
const listing = request(prefix + '/actions/runs/' + inputs.original_run_id + '/artifacts?per_page=100');
if (!Array.isArray(listing.artifacts) || listing.total_count !== listing.artifacts.length || listing.total_count > 100) fail('original_artifact_ambiguous');
const artifacts = listing.artifacts.filter(a => a.name === 'cloud-agent-result' && Date.parse(a.created_at) >= started);
if (artifacts.length === 0 || (artifacts.length === 1 && artifacts[0].expired)) fail('original_artifact_missing_or_expired; no approved durable-result fallback');
if (artifacts.length !== 1) fail('original_artifact_ambiguous');
const artifact = artifacts[0];
if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0 || artifact.size_in_bytes > 4 * 1024 * 1024 || (artifact.workflow_run && (String(artifact.workflow_run.id) !== inputs.original_run_id || artifact.workflow_run.head_sha !== inputs.expected_base_sha))) fail('original_artifact_identity_mismatch');
const archive = request(prefix + '/actions/artifacts/' + artifact.id + '/zip', undefined, true);
// Read one bounded ZIP member in memory. Never extract files or execute artifact content.
const json = execFileSync('python3', ['-c', 'import io,sys,zipfile\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\nn=z.infolist()\nassert len(n)==1 and n[0].filename=="cloud-agent-result.json" and n[0].file_size<=1048576 and not n[0].is_dir(), "invalid result archive"\nsys.stdout.buffer.write(z.read(n[0]))'], { input: archive, maxBuffer: 1048576, timeout: 10000 }).toString('utf8');
const original = canonicalResult(JSON.parse(json));
if (createHash('sha256').update(JSON.stringify(original)).digest('hex') !== inputs.original_result_digest) fail('original_result_digest_mismatch');
if (original.outcome !== 'failed' || !original.blockers.includes('pull_request_failed') || original.handoffId !== inputs.handoff_id || original.repository.repositoryId !== process.env.GITHUB_REPOSITORY_ID || original.baseSha !== inputs.expected_base_sha || original.headSha !== inputs.expected_head_sha || original.headSha === original.baseSha || original.pullRequest !== null) fail('original_result_identity_mismatch');
function fence() {
  const latestRun = request(prefix + '/actions/runs/' + inputs.original_run_id);
  if (String(latestRun.id) !== inputs.original_run_id || String(latestRun.run_attempt) !== inputs.original_attempt || latestRun.workflow_id !== run.workflow_id || latestRun.status !== 'completed' || latestRun.head_sha !== inputs.expected_base_sha) fail('original_workflow_changed');
  const currentRepo = request(prefix);
  if (String(currentRepo.id) !== process.env.GITHUB_REPOSITORY_ID || currentRepo.default_branch !== baseBranch || currentRepo.archived || currentRepo.disabled) fail('repository_changed');
  if (validateIssue(request(prefix + '/issues/' + inputs.issue_number)) !== correlation) fail('source_issue_changed');
  const ref = request(prefix + '/git/ref/heads/' + branch);
  if (ref.ref !== 'refs/heads/' + branch || ref.object?.type !== 'commit' || ref.object.sha !== inputs.expected_head_sha) fail('branch_head_changed');
}
fence();
const diff = request(prefix + '/compare/' + inputs.expected_base_sha + '...' + inputs.expected_head_sha);
if (!Array.isArray(diff.files) || diff.files.length === 0 || diff.files.length >= 300 || !['ahead','diverged'].includes(diff.status)) fail('invalid_or_unbounded_diff');
const changedFiles = diff.files.map(f => {
  if (!path(f.filename) || !['added','removed','modified','renamed'].includes(f.status) || (f.status === 'renamed') !== (f.previous_filename !== undefined) || (f.previous_filename !== undefined && !path(f.previous_filename))) fail('invalid_diff_path');
  return { path: f.filename, status: f.status === 'removed' ? 'deleted' : f.status, ...(f.previous_filename === undefined ? {} : { previousPath: f.previous_filename }) };
});
const fileIdentity = files => files.map(f => JSON.stringify([f.path, f.status, f.previousPath ?? ''])).sort();
if (new Set(changedFiles.map(f => f.path)).size !== changedFiles.length || JSON.stringify(fileIdentity(changedFiles)) !== JSON.stringify(fileIdentity(original.changedFiles))) fail('original_diff_changed');
function verifyPr(pr) {
  if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || pr.html_url !== 'https://github.com/' + repoName + '/pull/' + pr.number || pr.head?.ref !== branch || pr.head.sha !== inputs.expected_head_sha || String(pr.head.repo?.id) !== process.env.GITHUB_REPOSITORY_ID || pr.base?.ref !== baseBranch || String(pr.base.repo?.id) !== process.env.GITHUB_REPOSITORY_ID || pr.user?.login !== 'github-actions[bot]' || typeof pr.body !== 'string' || !pr.body.includes(correlation)) fail('invalid_existing_pull_request');
  if (pr.draft !== false) fail('existing_draft_pull_request; human action required; no automatic promotion or duplicate PR');
  if (pr.state !== 'open') fail('closed_or_merged_pull_request');
  return pr;
}
function findPr() {
  // Include closed PRs and every base to prevent replacing a closed or retargeted PR.
  const prs = request(prefix + '/pulls?state=all&head=' + encodeURIComponent(repoName.split('/')[0] + ':' + branch) + '&per_page=100');
  if (!Array.isArray(prs) || prs.length > 1) fail('ambiguous_pull_request');
  return prs.length === 0 ? null : verifyPr(request(prefix + '/pulls/' + prs[0].number));
}
let pr = findPr();
if (pr === null) {
  fence();
  try {
    // One POST only. A lost response is resolved by lookup, never by another POST.
    request(prefix + '/pulls', { head: branch, base: baseBranch, draft: false, title: 'API migration ' + inputs.handoff_id, body: 'Completes the existing migration branch.\n\nCloses #' + inputs.issue_number + '\n\n' + correlation });
  } catch {
    // Network failure may mean the PR was created. Only authoritative reads decide.
  }
  pr = findPr();
  if (pr === null) fail('pull_request_creation_unresolved; companion will not be automatically resubmitted');
}
fence();
pr = verifyPr(request(prefix + '/pulls/' + pr.number));
const result = canonicalResult({ ...original, outcome: 'changed', summary: 'Created or adopted the existing migration pull request without changing code.', changedFiles, checks: [], blockers: [], pullRequest: { number: pr.number, url: pr.html_url } });
fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify(result) + '\n', { mode: 0o600 });
`;
}
