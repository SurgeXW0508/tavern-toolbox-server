#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function sourceFiles(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await sourceFiles(file));
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(file);
        else if (entry.isSymbolicLink()) throw new Error(`Syntax discovery does not support source symlinks: ${relative(root, file)}`);
    }
    return files;
}

const files = [join(root, 'index.js'), ...(await sourceFiles(join(root, 'src'))).sort()];
for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        console.error(`Syntax check failed: ${relative(root, file)}`);
        process.exit(result.status ?? 1);
    }
}
console.log(`Syntax checks passed: ${files.length} JavaScript files (index.js + src/**/*.js).`);
