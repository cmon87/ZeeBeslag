#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RUNTIME_ASSETS, FORBIDDEN_PRODUCTION_PARTS } from './runtime-manifest.mjs';
import { VENDOR_FILES, validateVendorFile } from './vendor-babylon.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function walk(dir, out = []) {
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const info = await stat(path);
    if (info.isDirectory()) await walk(path, out);
    else out.push(path);
  }
  return out;
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function validateProduction({ root = ROOT, dist = join(root, 'dist'), log = console.log } = {}) {
  const errors = [];
  const assert = (condition, message) => { if (!condition) errors.push(message); };
  assert(existsSync(dist), `dist ontbreekt: ${dist}`);
  if (!existsSync(dist)) throw new Error(errors.join('\n'));

  const indexPath = join(dist, 'index.html');
  assert(existsSync(indexPath), 'dist/index.html ontbreekt');
  if (existsSync(indexPath)) {
    const html = await readFile(indexPath, 'utf8');
    assert(!html.includes('cdn.babylonjs.com'), 'production index bevat nog CDN-verwijzingen');
    assert(!html.includes('document.write('), 'production index bevat nog document.write-fallbacks');
    for (const spec of VENDOR_FILES) assert(html.includes(`vendor/${spec.file}`), `production index mist ${spec.file}`);
  }

  for (const asset of RUNTIME_ASSETS) assert(existsSync(join(dist, asset)), `runtime-asset ontbreekt: ${asset}`);
  for (const spec of VENDOR_FILES) {
    const result = await validateVendorFile(join(dist, 'vendor', spec.file), spec);
    assert(result.ok, `vendor ongeldig: ${spec.file}: ${result.reason}`);
  }

  const allFiles = await walk(dist);
  for (const file of allFiles) {
    const rel = relative(dist, file).replaceAll('\\', '/');
    for (const forbidden of FORBIDDEN_PRODUCTION_PARTS) {
      assert(!rel.split('/').some((part) => part === forbidden || part.endsWith(forbidden)), `verboden productiepad: ${rel}`);
    }
  }

  const manifestPath = join(dist, 'build-manifest.json');
  assert(existsSync(manifestPath), 'build-manifest.json ontbreekt');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert(Array.isArray(manifest.files), 'build-manifest.files is geen array');
    if (Array.isArray(manifest.files)) {
      for (const entry of manifest.files) {
        const path = join(dist, entry.path);
        assert(existsSync(path), `manifestbestand ontbreekt: ${entry.path}`);
        if (existsSync(path)) {
          const info = await stat(path);
          assert(info.size === entry.bytes, `bestandsgrootte wijkt af: ${entry.path}`);
          assert(await sha256(path) === entry.sha256, `SHA-256 wijkt af: ${entry.path}`);
        }
      }
    }
  }

  if (errors.length) throw new Error(`Productionvalidatie mislukt:\n- ${errors.join('\n- ')}`);
  log(`Productionvalidatie geslaagd: ${allFiles.length} bestanden.`);
  return { files: allFiles.length };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  validateProduction().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
