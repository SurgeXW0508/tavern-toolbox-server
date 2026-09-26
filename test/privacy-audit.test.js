import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/privacy-audit.mjs');
const noreply = '329357869+SurgeXW0508@users.noreply.github.com';

function repo(t) {
    const dir = mkdtempSync(join(tmpdir(), 'ttb-privacy-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    function git(...args) { return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }); }
    git('init', '-q');
    git('config', 'user.name', 'SurgeXW');
    git('config', 'user.email', noreply);
    function commit(contents) {
        writeFileSync(join(dir, 'fixture.txt'), contents);
        git('add', '.');
        git('commit', '-qm', 'Synthetic test fixture');
    }
    function audit() { return spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' }); }
    return { git, commit, audit };
}

test('valid pseudonymous history and reserved fixture pass', t => {
    const r = repo(t);
    r.commit('https://example.invalid/fixture\nhttp://127.0.0.1\ntest-secret\n');
    const result = r.audit();
    assert.equal(result.status, 0, result.stderr);
});

test('removed secret in an old commit remains a failure; output never prints it', t => {
    const r = repo(t);
    const fakeToken = `ghp_${'Z'.repeat(40)}`;
    r.commit(`apiKey = ${fakeToken}\n`);
    r.commit('fixture reset\n');
    const result = r.audit();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /credential/);
    assert.ok(!result.stderr.includes(fakeToken));
});

test('a non-current branch and original private email are rejected', t => {
    const r = repo(t);
    r.commit('safe\n');
    r.git('branch', 'old-copy');
    r.git('checkout', '-q', 'old-copy');
    const privateEmail = ['private-person', 'personal.test'].join('@');
    const privateIp = ['192', '168', '30', '42'].join('.');
    r.git('config', 'user.email', privateEmail);
    r.commit(`${privateIp}\n`);
    r.git('checkout', '-q', '-');
    const result = r.audit();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unapproved identity/);
    assert.match(result.stderr, /private or overlay IP/);
    assert.ok(!result.stderr.includes(privateEmail));
});
