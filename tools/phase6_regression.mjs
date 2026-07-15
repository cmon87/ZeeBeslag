#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_ASSETS } from './runtime-manifest.mjs';
import { BABYLON_VERSION, VENDOR_FILES } from './vendor-babylon.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
let assertions = 0;
const check = (condition, message) => { assertions++; assert.ok(condition, message); };

async function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const info = await stat(path);
    if (info.isDirectory()) await walk(path, out);
    else out.push(path);
  }
  return out;
}

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
for (const script of ['vendor', 'build', 'build:offline', 'validate:dist', 'test:phase6', 'test:all']) {
  check(typeof packageJson.scripts?.[script] === 'string', `npm-script ontbreekt: ${script}`);
}

const main = await readFile(join(root, 'src/main.js'), 'utf8');
check(main.includes("M6.6.0 mobiele-performance"), 'stabiele runtimebuild M6.6.0 ontbreekt');

const index = await readFile(join(root, 'index.html'), 'utf8');
for (const spec of VENDOR_FILES) check(index.includes(`vendor/${spec.file}`), `index mist lokale vendor ${spec.file}`);
check(index.includes(`cdn.babylonjs.com/v${BABYLON_VERSION}`), 'development-CDN-fallback ontbreekt');

for (const asset of RUNTIME_ASSETS) check(existsSync(join(root, asset)), `runtime-asset ontbreekt: ${asset}`);
check(new Set(RUNTIME_ASSETS).size === RUNTIME_ASSETS.length, 'runtime-manifest bevat duplicaten');

const repoAssets = [
  ...(await walk(join(root, 'models'))),
  ...(await walk(join(root, 'sound'))),
].map((path) => relative(root, path).replaceAll('\\', '/')).sort();
const manifestAssets = [...RUNTIME_ASSETS].sort();
check(JSON.stringify(repoAssets) === JSON.stringify(manifestAssets), 'models/sound bevat assets buiten het expliciete runtime-manifest');

check(!existsSync(join(root, '_backup')), '_backup staat nog in de projectroot');
check(!(await walk(join(root, 'src'))).some((path) => path.endsWith('.bak')), 'src bevat nog .bak-bestanden');

const totalBytes = (await Promise.all(RUNTIME_ASSETS.map(async (asset) => (await stat(join(root, asset))).size)))
  .reduce((sum, bytes) => sum + bytes, 0);
check(totalBytes < 75 * 1024 * 1024, `runtime-assets zijn te groot: ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`);
for (const asset of RUNTIME_ASSETS) {
  const bytes = (await stat(join(root, asset))).size;
  check(bytes < 100_000_000, `GitHub-bestandslimiet overschreden: ${asset}`);
}

for (const tool of [
  'tools/vendor-babylon.mjs',
  'tools/runtime-manifest.mjs',
  'tools/build-production.mjs',
  'tools/validate-production.mjs',
  'tools/phase6_regression.mjs',
]) {
  const parsed = spawnSync(process.execPath, ['--check', join(root, tool)], { encoding: 'utf8' });
  check(parsed.status === 0, `${tool} bevat een syntaxfout: ${parsed.stderr}`);
}

for (const file of [
  'tools/vendor-babylon.mjs',
  'tools/build-production.mjs',
  'tools/validate-production.mjs',
  'THIRD_PARTY_NOTICES.md',
  'docs/ASSET_INVENTORY.md',
  '.github/workflows/validate-build.yml',
]) check(existsSync(join(root, file)), `fase-6-bestand ontbreekt: ${file}`);

console.log(`Fase 6 regressie geslaagd: ${assertions} assertions.`);
