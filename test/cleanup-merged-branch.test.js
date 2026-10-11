import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupMergedBranch } from '../scripts/cleanup-merged-branch.mjs';

const repository = 'example/toolbox', releaseSha = 'a'.repeat(40), head = 'b'.repeat(40);
function fixture(change = {}) {
  const pr = { merged_at: '2026-01-01', merge_commit_sha: releaseSha, base: { ref: 'main', repo: { full_name: repository } }, head: { ref: 'stage/current', sha: head, repo: { full_name: repository } }, ...change };
  const deleted = [], reads = [];
  const api = async endpoint => {
    reads.push(endpoint);
    if (endpoint === `repos/${repository}`) return { default_branch: 'main' };
    if (endpoint.endsWith('/git/ref/heads/main')) return { object: { sha: releaseSha } };
    if (endpoint.includes('/pulls?')) return [pr];
    if (endpoint.includes('/git/ref/heads/')) return { object: { sha: head } };
    if (endpoint.includes('/compare/')) return { status: 'ahead', behind_by: 0 };
    throw new Error('Unexpected request');
  };
  return { repository, releaseSha, api, remove: async (...args) => deleted.push(args), deleted, reads, pr };
}
test('only the exact merged head covered by released main is passed to lease-protected deletion', async () => {
  const f = fixture(); assert.deepEqual(await cleanupMergedBranch(f), ['stage/current']); assert.deepEqual(f.deleted, [['stage/current', head]]);
});
test('unmerged, foreign, default-branch and unrelated PRs are preserved', async () => {
  for (const change of [{ merged_at: null }, { merge_commit_sha: 'c'.repeat(40) }, { head: { ref: 'main', sha: head, repo: { full_name: repository } } }, { head: { ref: 'stage/current', sha: head, repo: { full_name: 'other/fork' } } }, { base: { ref: 'other', repo: { full_name: repository } } }]) {
    const f = fixture(change); assert.deepEqual(await cleanupMergedBranch(f), []); assert.equal(f.deleted.length, 0);
  }
});
test('missing branches, new branch commits and unmerged ancestry are preserved', async () => {
  for (const mode of ['missing', 'advanced', 'diverged']) {
    const f = fixture(), original = f.api;
    f.api = async (endpoint, options) => {
      if (endpoint.endsWith('/heads/stage/current')) { assert.equal(options.allowMissing, true); return mode === 'missing' ? null : { object: { sha: mode === 'advanced' ? 'c'.repeat(40) : head } }; }
      if (endpoint.includes('/compare/') && mode === 'diverged') return { status: 'diverged', behind_by: 1 };
      return original(endpoint);
    };
    assert.deepEqual(await cleanupMergedBranch(f), []); assert.equal(f.deleted.length, 0);
  }
});
test('main advancing during verification preserves the branch', async () => {
  const f = fixture(), original = f.api; let count = 0;
  f.api = endpoint => endpoint.endsWith('/heads/main') && ++count === 2 ? { object: { sha: 'c'.repeat(40) } } : original(endpoint);
  assert.deepEqual(await cleanupMergedBranch(f), []); assert.equal(f.deleted.length, 0);
});
test('API and deletion failures remain failures, never an apparent successful cleanup', async () => {
  const f = fixture(); f.api = async () => { throw new Error('auth failed'); }; await assert.rejects(cleanupMergedBranch(f), /auth failed/);
  const g = fixture(); g.remove = async () => { throw new Error('lease rejected'); }; await assert.rejects(cleanupMergedBranch(g), /lease rejected/);
});
