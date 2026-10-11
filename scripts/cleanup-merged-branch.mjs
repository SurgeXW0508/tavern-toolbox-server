import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Only the PR which produced this successful release is eligible. Never scan
// old branches, and never delete a branch which advanced after its PR merged.
export async function cleanupMergedBranch({ repository, releaseSha, api, remove }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !/^[a-f0-9]{40}$/.test(releaseSha || '')) throw new Error('Invalid release identity');
  const base = `repos/${repository}`;
  const repo = await api(base);
  if (repo.default_branch !== 'main') throw new Error('Unexpected default branch');
  const main = await api(`${base}/git/ref/heads/main`);
  if (main.object.sha !== releaseSha) return [];
  const candidates = await api(`${base}/commits/${releaseSha}/pulls?per_page=100`);
  const deleted = [];
  for (const pr of candidates) {
    if (!pr.merged_at || pr.merge_commit_sha !== releaseSha || pr.base.ref !== 'main'
      || pr.base.repo.full_name !== repository || pr.head.repo?.full_name !== repository || pr.head.ref === 'main') continue;
    const branch = pr.head.ref, expected = pr.head.sha;
    const current = await api(`${base}/git/ref/heads/${branch}`, { allowMissing: true });
    if (!current || current.object.sha !== expected) continue;
    const comparison = await api(`${base}/compare/${expected}...${releaseSha}`);
    if (!['ahead', 'identical'].includes(comparison.status) || comparison.behind_by !== 0) continue;
    // A later main/branch update must not be mistaken for the reviewed release.
    if ((await api(`${base}/git/ref/heads/main`)).object.sha !== releaseSha) continue;
    await remove(branch, expected);
    deleted.push(branch);
  }
  return deleted;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const api = async (endpoint, { allowMissing = false } = {}) => {
    try { return JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
    catch (error) {
      let status; try { status = JSON.parse(String(error.stdout)).status; } catch {}
      if (allowMissing && String(status) === '404') return null;
      throw new Error('GitHub verification failed');
    }
  };
  const deleted = await cleanupMergedBranch({ repository: process.env.GITHUB_REPOSITORY, releaseSha: process.env.RELEASE_SHA, api,
    remove: async (branch, expected) => {
      execFileSync('git', ['check-ref-format', `refs/heads/${branch}`]);
      execFileSync('git', ['push', `--force-with-lease=refs/heads/${branch}:${expected}`, 'origin', `:refs/heads/${branch}`], { stdio: 'inherit' });
    } });
  console.log(`Verified release cleanup: ${deleted.length} branch(es) deleted.`);
}
