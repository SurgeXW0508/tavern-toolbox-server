import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = name => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
test('server release preserves tag identity and verifies published assets even on retry', () => {
  const workflow = read('release.yml');
  assert.match(workflow, /git merge-base --is-ancestor/);
  assert.match(workflow, /LOCK_ROOT_VERSION/);
  assert.match(workflow, /npm run audit:privacy/);
  assert.match(workflow, /npm run check/);
  const verify = workflow.slice(workflow.indexOf('      - name: Verify published release assets'));
  assert.match(verify, /sha256sum -c SHA256SUMS/);
  assert.match(verify, /isDraft/);
  assert.match(verify, /ACTUAL.*EXPECTED/);
  assert.doesNotMatch(verify, /if: steps.release.outputs.publish/);
  assert.doesNotMatch(workflow, /Clean up accepted Phase/);
});
test('cleanup is limited to successful main releases and uses guarded branch deletion', () => {
  const workflow = read('cleanup-merged-branches.yml');
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows: \[Release\]/);
  assert.match(workflow, /conclusion == 'success'/);
  assert.match(workflow, /head_branch == 'main'/);
  assert.match(workflow, /head_repository.full_name == github.repository/);
  assert.match(workflow, /node scripts\/cleanup-merged-branch.mjs/);
  assert.doesNotMatch(workflow, /stage\/phase-/);
});
