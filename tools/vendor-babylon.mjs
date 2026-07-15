#!/usr/bin/env node
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BABYLON_VERSION = '9.14.0';
export const VENDOR_FILES = Object.freeze([
  Object.freeze({
    id: 'core',
    file: `babylon-${BABYLON_VERSION}.js`,
    url: `https://cdn.babylonjs.com/v${BABYLON_VERSION}/babylon.js`,
    minBytes: 4_000_000,
    markers: ['BABYLON', BABYLON_VERSION],
  }),
  Object.freeze({
    id: 'loaders',
    file: `babylonjs.loaders-${BABYLON_VERSION}.min.js`,
    url: `https://cdn.babylonjs.com/v${BABYLON_VERSION}/loaders/babylonjs.loaders.min.js`,
    minBytes: 500_000,
    markers: ['BABYLON', 'glTF'],
  }),
]);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function validateVendorFile(filePath, spec) {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size < spec.minBytes) {
      return { ok: false, reason: `te klein (${info.size} bytes; minimaal ${spec.minBytes})` };
    }
    const source = await readFile(filePath, 'utf8');
    for (const marker of spec.markers) {
      if (!source.includes(marker)) return { ok: false, reason: `marker ontbreekt: ${marker}` };
    }
    return { ok: true, bytes: info.size };
  } catch (error) {
    return { ok: false, reason: error.code === 'ENOENT' ? 'ontbreekt' : error.message };
  }
}

async function downloadAtomic(spec, destination) {
  const tmp = `${destination}.download-${process.pid}`;
  await mkdir(dirname(destination), { recursive: true });
  await rm(tmp, { force: true });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(spec.url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': `ZeeBeslag-vendor/${BABYLON_VERSION}` },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(tmp, bytes);
    const check = await validateVendorFile(tmp, spec);
    if (!check.ok) throw new Error(`ongeldig vendorbestand: ${check.reason}`);
    await rename(tmp, destination);
    return check;
  } finally {
    clearTimeout(timeout);
    await rm(tmp, { force: true }).catch(() => {});
  }
}

export async function ensureBabylonVendor({
  root = ROOT,
  offline = false,
  force = false,
  log = console.log,
} = {}) {
  const vendorDir = join(root, 'vendor');
  await mkdir(vendorDir, { recursive: true });
  const result = [];

  for (const spec of VENDOR_FILES) {
    const destination = join(vendorDir, spec.file);
    const existing = force ? { ok: false, reason: 'force' } : await validateVendorFile(destination, spec);
    if (existing.ok) {
      log(`vendor ok: ${spec.file} (${existing.bytes} bytes)`);
      result.push({ ...spec, path: destination, bytes: existing.bytes, downloaded: false });
      continue;
    }
    if (offline) {
      throw new Error(`${spec.file} ${existing.reason}. Voer eerst "npm run vendor" uit met internettoegang.`);
    }
    log(`download: ${spec.url}`);
    const downloaded = await downloadAtomic(spec, destination);
    log(`vendor opgeslagen: ${spec.file} (${downloaded.bytes} bytes)`);
    result.push({ ...spec, path: destination, bytes: downloaded.bytes, downloaded: true });
  }
  return result;
}

function parseArgs(argv) {
  return {
    offline: argv.includes('--offline'),
    force: argv.includes('--force'),
  };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  ensureBabylonVendor(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(`Vendorfout: ${error.message}`);
    process.exitCode = 1;
  });
}
