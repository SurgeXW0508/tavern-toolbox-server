import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-syntax.mjs', import.meta.url));

function project(t) {
    const root = mkdtempSync(join(tmpdir(), 'ttb-syntax-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'src', 'new feature', 'nested'), { recursive: true });
    copyFileSync(script, join(root, 'scripts', 'check-syntax.mjs'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(root, 'index.js'), "throw new Error('Syntax checks must not execute the entry point');\n");
    const source = join(root, 'src', 'new feature', 'nested', 'future module.js');
    writeFileSync(source, "import missing from './not-installed.js';\nexport const value = missing;\n");
    const run = () => spawnSync(process.execPath, [join(root, 'scripts', 'check-syntax.mjs')], {
        cwd: tmpdir(), encoding: 'utf8',
    });
    return { root, source, run };
}

test('syntax gate checks a project from another working directory without executing or resolving its imports', t => {
    const fixture = project(t);
    const result = fixture.run();
    assert.equal(result.status, 0, result.stderr);
});

test('syntax gate rejects a newly added unimported nested module with a filename containing spaces', t => {
    const fixture = project(t);
    writeFileSync(fixture.source, 'export const broken = ;\n');
    const result = fixture.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SyntaxError/);
    assert.ok(result.stderr.includes('future module.js'));
});

test('syntax gate fails when the required entry point is missing', t => {
    const fixture = project(t);
    rmSync(join(fixture.root, 'index.js'));
    const result = fixture.run();
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes('index.js'));
});
