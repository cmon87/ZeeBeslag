#!/usr/bin/env node
// ZeeBeslag modulecontrole. Draait zonder browser, zonder Babylon, zonder afhankelijkheden.
//
//   node tools/zbcheck.mjs
//
// Wat hij controleert:
//   1. verwachte bestanden aanwezig, en dode bestanden afwezig
//   2. syntax van elk .js bestand (node --check)
//   3. elke relatieve import verwijst naar een bestaand bestand
//   4. elke benoemde import bestaat ook echt als export in dat bestand
//   5. handtekeningen die eerder stil zijn misgegaan (fireSalvo met twee argumenten, enz.)
//   6. of er twee versies van hetzelfde bestand rondslingeren
//   7. welke BUILD er in main.js staat
//
// Exit 0 = schoon. Exit 1 = er is iets mis. De uitvoer is bedoeld om te plakken.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join, relative } from 'node:path';

const ROOT = process.cwd();
let fouten = 0, waarschuwingen = 0;

const RED = '\x1b[31m', YEL = '\x1b[33m', GRN = '\x1b[32m', DIM = '\x1b[2m', OFF = '\x1b[0m';
const ok   = (m) => console.log(`${GRN}  ok${OFF}   ${m}`);
const warn = (m) => { waarschuwingen++; console.log(`${YEL}  let op${OFF} ${m}`); };
const bad  = (m) => { fouten++; console.log(`${RED}  FOUT${OFF} ${m}`); };
const kop  = (m) => console.log(`\n${m}`);

// ── manifest ────────────────────────────────────────────────────────────────
const VERWACHT = [
  'index.html', 'package.json',
  'src/main.js',
  'src/core/engine.js', 'src/core/debug.js', 'src/core/log.js', 'src/core/telemetry.js',
  'src/core/performanceProfile.js', 'src/core/meshOptimizer.js',
  'src/core/sunSweepTool.js',   // M4.8: Sun Sweep als losse klasse
  'src/input/controls.js',
  'src/environment/skyRig.js',
  'src/ocean/wavesSettings.js', 'src/ocean/wavesGenerator.js', 'src/ocean/oceanMaterial.js',
  'src/ocean/wakeManager.js', 'src/ocean/presets.js', 'src/ocean/computeHelper.js',
  'src/ocean/wavesCascade.js', 'src/ocean/oceanGeometry.js', 'src/ocean/oceanShaders.js',
  'src/ocean/fft.js', 'src/ocean/wgsl.js', 'src/ocean/initialSpectrum.js',
  'src/game/swellField.js', 'src/game/ship.js', 'src/game/islandTarget.js',
  'src/game/collisionMath.js', 'src/game/worldCollision.js',
  'src/game/chaseCamera.js', 'src/game/ballistics.js', 'src/game/targetRegistry.js',
  'src/game/emplacement.js', 'src/game/atlasFx.js', 'src/game/hud.js', 'src/game/menu.js',
  'src/game/turretRig.js', 'src/game/combatController.js', 'src/game/defenseNetwork.js', 'src/game/matchDirector.js',
  'src/game/trajectoryRenderer.js',
  'src/ui/overlayUI.js', 'src/ui/markerLayer.js',
  'src/ui/devPanel.js',         // M4.9: het hoofdmenu, tevens registry voor alle modules
];

const DOOD = [
  'src/game/combatControler.js',   // typefout, oude versie met drie argumenten
  '0', 'compute',
];

// bestand, patroon dat MOET voorkomen, uitleg als het ontbreekt
const HANDTEKENINGEN = [
  ['src/game/combatController.js', /fireSalvo\(simTime,\s*playerShip\)/,
    'oude CombatController: fireSalvo verwacht nog een derde argument (ballistics) en stapt er meteen uit. Geen enkel schot.'],
  ['src/game/combatController.js', /playerAimReady\(playerShip,\s*target\)/,
    'oude playerAimReady: verwacht een schip in plaats van een mikpunt. Baanlijn blijft rood.'],
  ['src/game/ship.js', /aimError\s*\(/,
    'oude ship.js: geen aimError, dus geen richtfout en geen toreneleevatie.'],
  ['src/game/ship.js', /elevNode/,
    'oude ship.js: geen elevatie-node. De loop blijft horizontaal terwijl de granaat een boog vliegt.'],
  ['src/game/islandTarget.js', /sample\s*\(\s*x\s*,\s*z\s*\)/,
    'oude islandTarget.js: geen terreinsampling. main.js gooit elke frame een TypeError en de renderloop stopt.'],
  ['src/game/islandTarget.js', /^(?!.*scale\(2\)).*$/s,
    'islandTarget.js bevat nog .scale(2): het eiland staat op dubbele afstand.'],
  ['src/game/ballistics.js', /export function solveElevation/,
    'oude ballistics.js: geen solveElevation. ship.js kan hem niet importeren.'],
  ['src/game/ballistics.js', /setRegistry/,
    'ballistics.js kent het doelregister niet: geen trefferdetectie op verdedigingswerken.'],
  ['src/game/matchDirector.js', /onObjectiveComplete/,
    'oude matchDirector.js: geen winconditie op het doelregister.'],
  ['src/game/defenseNetwork.js', /export class DefenseNetwork/,
    'defenseNetwork.js ontbreekt: radar, depots en onafhankelijke vijanddetectie vallen terug naar generiek gedrag.'],
  ['src/game/emplacement.js', /damageTakenMultiplier/,
    'emplacement.js mist typeweerstand: bunkers en kwetsbare doelen verwerken weer identieke schade.'],
  ['src/game/matchDirector.js', /m !== 'free'/,
    "matchDirector.setMode kent 'free' niet: de CAM-knop doet niets."],
  ['src/game/trajectoryRenderer.js', /update\(playerShip,\s*muzzleVelocity,\s*isReady\)/,
    'oude trajectoryRenderer.js: verwacht nog een targetPos-argument.'],
  // M4.9: getLogBuffer komt sinds de log.js-splitsing als re-export binnen; beide vormen zijn goed.
  ['src/core/debug.js', /export\s+(function\s+getLogBuffer|\{[^}]*getLogBuffer[^}]*\})/,
    'debug.js mist getLogBuffer (los noch als re-export). Telemetrie valt terug op localStorage.'],
];

// ── hulpjes ─────────────────────────────────────────────────────────────────
function alleJs(dir, uit = []) {
  if (!existsSync(dir)) return uit;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) alleJs(p, uit);
    else if (f.endsWith('.js')) uit.push(p);
  }
  return uit;
}

// Commentaar weghalen, anders vindt de handtekeningcontrole zijn eigen changelog-regels terug.
function zonderCommentaar(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function exportsVan(src) {
  const namen = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) namen.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) namen.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (let stuk of m[1].split(',')) {
      stuk = stuk.trim(); if (!stuk) continue;
      const als = stuk.split(/\s+as\s+/i);
      namen.add((als[1] || als[0]).trim());
    }
  }
  if (/export\s+default/.test(src)) namen.add('default');
  return namen;
}

function importsVan(raw) {
  const src = zonderCommentaar(raw);
  const uit = [];
  // side-effect import: import './x.js';
  for (const m of src.matchAll(/import\s+['"]([^'"]+)['"]/g)) uit.push({ pad: m[1], namen: [] });
  const re = /import\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    const clause = m[1].trim(), pad = m[2];
    const namen = [];
    const bracket = clause.match(/\{([^}]*)\}/);
    if (bracket) {
      for (let s of bracket[1].split(',')) {
        s = s.trim(); if (!s) continue;
        namen.push(s.split(/\s+as\s+/i)[0].trim());
      }
    }
    const standaard = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim();
    if (standaard && !standaard.startsWith('*')) namen.push('default');
    uit.push({ pad, namen });
  }
  return uit;
}

// ── 1. bestanden ────────────────────────────────────────────────────────────
kop('1. Bestanden');
for (const f of VERWACHT) {
  if (existsSync(resolve(ROOT, f))) ok(f);
  else bad(`${f} ontbreekt`);
}
for (const f of DOOD) {
  if (existsSync(resolve(ROOT, f))) bad(`${f} bestaat nog en hoort weg`);
}
if (!existsSync(resolve(ROOT, 'vendor')) ) warn('geen vendor/ map: Babylon komt van de CDN');

// ── 2. syntax ───────────────────────────────────────────────────────────────
kop('2. Syntax');
const bestanden = alleJs(resolve(ROOT, 'src'));
let syntaxOk = 0;
for (const p of bestanden) {
  const r = spawnSync('node', ['--check', p], { encoding: 'utf8' });
  if (r.status === 0) syntaxOk++;
  else bad(`${relative(ROOT, p)}\n${DIM}${(r.stderr || '').split('\n').slice(0, 4).join('\n')}${OFF}`);
}
ok(`${syntaxOk}/${bestanden.length} bestanden parsen schoon`);

// ── 3 en 4. imports en exports ──────────────────────────────────────────────
kop('3. Imports en exports');
let importsOk = 0, importsTot = 0;
for (const p of bestanden) {
  const src = readFileSync(p, 'utf8');
  for (const imp of importsVan(src)) {
    if (!imp.pad.startsWith('.')) continue;
    importsTot++;
    const doel = resolve(dirname(p), imp.pad);
    if (!existsSync(doel)) { bad(`${relative(ROOT, p)} importeert ${imp.pad} maar dat bestand bestaat niet`); continue; }
    const beschikbaar = exportsVan(readFileSync(doel, 'utf8'));
    const missend = imp.namen.filter(n => !beschikbaar.has(n));
    if (missend.length) bad(`${relative(ROOT, p)} importeert ${missend.join(', ')} uit ${imp.pad}, maar die worden daar niet geexporteerd`);
    else importsOk++;
  }
}
ok(`${importsOk}/${importsTot} relatieve imports resolven, inclusief hun benoemde exports`);

// ── 5. handtekeningen ───────────────────────────────────────────────────────
kop('4. Versiehandtekeningen');
for (const [f, re, uitleg] of HANDTEKENINGEN) {
  const p = resolve(ROOT, f);
  if (!existsSync(p)) continue;   // al gemeld bij stap 1
  const src = zonderCommentaar(readFileSync(p, 'utf8'));
  if (re.test(src)) ok(`${f}`);
  else bad(`${f}\n         ${uitleg}`);
}

// ── 6. dubbele modules ──────────────────────────────────────────────────────
kop('5. Dubbele of verweesde modules');
const basisnamen = new Map();
for (const p of bestanden) {
  const b = p.split('/').pop().toLowerCase().replace(/[^a-z]/g, '');
  if (!basisnamen.has(b)) basisnamen.set(b, []);
  basisnamen.get(b).push(relative(ROOT, p));
}
let dubbel = 0;
for (const [b, lijst] of basisnamen) {
  if (lijst.length > 1) { warn(`bijna gelijke namen: ${lijst.join('  en  ')}`); dubbel++; }
}
if (!dubbel) ok('geen bijna-gelijke bestandsnamen');

// welke modules importeert niemand
const geimporteerd = new Set();
for (const p of bestanden) {
  for (const imp of importsVan(readFileSync(p, 'utf8'))) {
    if (imp.pad.startsWith('.')) geimporteerd.add(resolve(dirname(p), imp.pad));
  }
}
for (const p of bestanden) {
  if (p.endsWith('src/main.js')) continue;
  if (!geimporteerd.has(p)) warn(`${relative(ROOT, p)} wordt door niemand geimporteerd`);
}

// ── 7. build ────────────────────────────────────────────────────────────────
kop('6. Build');
try {
  const m = readFileSync(resolve(ROOT, 'src/main.js'), 'utf8').match(/export const BUILD\s*=\s*['"]([^'"]+)['"]/);
  ok(m ? `main.js meldt: ${m[1]}` : 'geen BUILD-constante gevonden');
  const idx = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
  const pin = idx.match(/babylon-([\d.]+)\.js/);
  ok(pin ? `Babylon gepind op ${pin[1]}` : 'geen gepinde Babylon in index.html');
} catch (e) { bad('main.js of index.html onleesbaar: ' + e.message); }

// ── slot ────────────────────────────────────────────────────────────────────
console.log('');
if (fouten) {
  console.log(`${RED}${fouten} fout(en)${OFF}, ${waarschuwingen} waarschuwing(en). Los de fouten op voor je laadt.`);
  process.exit(1);
} else {
  console.log(`${GRN}Alles schoon${OFF} (${waarschuwingen} waarschuwing(en)).`);
  console.log(`${DIM}Statische controle. Een groene uitslag sluit runtime-fouten zoals een verloren WebGPU-device niet uit.${OFF}`);
  process.exit(0);
}
