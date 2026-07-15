#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RUNTIME_ASSETS, SOURCE_DIRECTORIES } from './runtime-manifest.mjs';
import { ensureBabylonVendor, VENDOR_FILES } from './vendor-babylon.mjs';
import { validateProduction } from './validate-production.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'dist');

async function walk(dir, out = []) {
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const info = await stat(path);
    if (info.isDirectory()) await walk(path, out);
    else out.push(path);
  }
  return out;
}

function productionIndex(source) {
  const withoutDevComment = source.replace(
    /<!-- Babylon GEPIND[\s\S]*?-->/u,
    '<!-- Productionbuild: Babylon 9.14.0 en de glTF-loaders worden uitsluitend lokaal geladen. -->',
  );
  return withoutDevComment
    .split('\n')
    .filter((line) => !line.includes('document.write('))
    .join('\n');
}

async function copyFile(relativePath) {
  const source = join(ROOT, relativePath);
  const destination = join(DIST, relativePath);
  await mkdir(resolve(destination, '..'), { recursive: true });
  await cp(source, destination);
}

async function buildManifest() {
  const files = (await walk(DIST))
    .filter((path) => !path.endsWith('build-manifest.json'))
    .sort();
  const entries = [];
  for (const path of files) {
    const data = await readFile(path);
    entries.push({
      path: relative(DIST, path).replaceAll('\\', '/'),
      bytes: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
  }
  const mainSource = await readFile(join(ROOT, 'src/main.js'), 'utf8');
  const build = mainSource.match(/export const BUILD\s*=\s*['"]([^'"]+)['"]/u)?.[1] ?? 'onbekend';
  return {
    schema: 'zeebeslag-build-manifest/1',
    build,
    babylon: '9.14.0',
    generatedAt: new Date().toISOString(),
    files: entries,
  };
}

export async function buildProduction({ offline = false, log = console.log } = {}) {
  await ensureBabylonVendor({ root: ROOT, offline, log });
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  const index = productionIndex(await readFile(join(ROOT, 'index.html'), 'utf8'));
  await writeFile(join(DIST, 'index.html'), index);
  for (const directory of SOURCE_DIRECTORIES) await cp(join(ROOT, directory), join(DIST, directory), { recursive: true });
  for (const asset of RUNTIME_ASSETS) await copyFile(asset);
  for (const spec of VENDOR_FILES) await copyFile(`vendor/${spec.file}`);
  await copyFile('THIRD_PARTY_NOTICES.md');

  const manifest = await buildManifest();
  await writeFile(join(DIST, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await validateProduction({ root: ROOT, dist: DIST, log });

  const totalBytes = manifest.files.reduce((sum, entry) => sum + entry.bytes, 0);
  log(`Productionbuild gereed: ${manifest.files.length} bestanden, ${(totalBytes / 1024 / 1024).toFixed(1)} MiB.`);
  return manifest;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  buildProduction({ offline: process.argv.includes('--offline') }).catch((error) => {
    console.error(`Buildfout: ${error.message}`);
    process.exitCode = 1;
  });
}
