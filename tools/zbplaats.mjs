#!/usr/bin/env node
// tools/zbplaats.mjs
//
// M5.5 - Plaatst geleverde bestanden vanuit de downloadmap in de juiste projectmappen.
// Draait vanaf ELKE locatie, ook direct vanuit de downloadmap zelf; niets hoeft eerst
// handmatig overgezet.
//
// Gebruik:
//   cd ~/downloads && node zbplaats.mjs      direct na het downloaden, nul voorbereiding
//   node tools/zbplaats.mjs                  vanuit de projectroot werkt ook
//   node zbplaats.mjs /pad                   pad mag de bronmap OF de projectroot zijn
//   node zbplaats.mjs --verplaats            verwijdert de bron na succesvol plaatsen
//
// Wat hij doet:
//   1. Vindt de PROJECTROOT zelf: eerst de huidige map, dan de onthouden locatie uit
//      ~/.zbplaats, dan een diepte-beperkte zoektocht door Documents en de interne opslag.
//      Eenmaal gevonden wordt de locatie onthouden, dus de zoektocht gebeurt maar 1 keer.
//   2. Vindt de BRONMAP: standaard de map waar dit script zelf staat (dus de downloadmap
//      als je hem daarvandaan draait), anders ~/downloads en de bekende Android-varianten.
//   3. Herkent bekende bestandsnamen via de kaart hieronder plus een live scan van de
//      projectboom. Plaatst ook ZICHZELF in tools/, dus na de eerste run is het script
//      onderdeel van het project.
//   4. Android nummert herdownloads als "main (1).js", "main (2).js". Alle varianten van
//      dezelfde naam worden herkend en de NIEUWSTE (mtime) wint; de rest wordt gemeld.
//   5. Maakt voor elk overschreven bestand eerst een backup in _backup/<tijdstempel>/.
//   6. Draait na het plaatsen automatisch tools/zbcheck.mjs.
//
// Onbekende bestanden (foto's, exports, andere projecten) worden genegeerd en alleen geteld.

import { readdirSync, statSync, mkdirSync, copyFileSync, unlinkSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { homedir } from 'os';

// ── Vaste kaart: bestandsnaam -> plek in het project. Nieuwe modules komen hier bij zodra
// ze geleverd worden; de live scan hieronder vangt alles wat al in de boom staat. ─────────
const KAART = {
  'index.html':          'index.html',
  'package.json':        'package.json',
  'main.js':             'src/main.js',
  'engine.js':           'src/core/engine.js',
  'debug.js':            'src/core/debug.js',
  'log.js':              'src/core/log.js',
  'telemetry.js':        'src/core/telemetry.js',
  'sunSweepTool.js':     'src/core/sunSweepTool.js',
  'sfx.js':              'src/core/sfx.js',
  'controls.js':         'src/input/controls.js',
  'skyRig.js':           'src/environment/skyRig.js',
  'heatFx.js':           'src/environment/heatFx.js',
  'wavesSettings.js':    'src/ocean/wavesSettings.js',
  'wavesGenerator.js':   'src/ocean/wavesGenerator.js',
  'oceanMaterial.js':    'src/ocean/oceanMaterial.js',
  'wakeManager.js':      'src/ocean/wakeManager.js',
  'presets.js':          'src/ocean/presets.js',
  'computeHelper.js':    'src/ocean/computeHelper.js',
  'wavesCascade.js':     'src/ocean/wavesCascade.js',
  'oceanGeometry.js':    'src/ocean/oceanGeometry.js',
  'oceanShaders.js':     'src/ocean/oceanShaders.js',
  'fft.js':              'src/ocean/fft.js',
  'wgsl.js':             'src/ocean/wgsl.js',
  'initialSpectrum.js':  'src/ocean/initialSpectrum.js',
  'swellField.js':       'src/game/swellField.js',
  'ship.js':             'src/game/ship.js',
  'islandTarget.js':     'src/game/islandTarget.js',
  'chaseCamera.js':      'src/game/chaseCamera.js',
  'freeCam.js':          'src/game/freeCam.js',
  'ballistics.js':       'src/game/ballistics.js',
  'targetRegistry.js':   'src/game/targetRegistry.js',
  'emplacement.js':      'src/game/emplacement.js',
  'atlasFx.js':          'src/game/atlasFx.js',
  'smokeCards.js':       'src/game/smokeCards.js',
  'squadron.js':         'src/game/squadron.js',
  'battleAmbience.js':   'src/game/battleAmbience.js',
  'wreckDecor.js':       'src/game/wreckDecor.js',
  'hud.js':              'src/game/hud.js',
  'menu.js':             'src/game/menu.js',
  'turretRig.js':        'src/game/turretRig.js',
  'combatController.js': 'src/game/combatController.js',
  'matchDirector.js':    'src/game/matchDirector.js',
  'trajectoryRenderer.js': 'src/game/trajectoryRenderer.js',
  'overlayUI.js':        'src/ui/overlayUI.js',
  'markerLayer.js':      'src/ui/markerLayer.js',
  'devPanel.js':         'src/ui/devPanel.js',
  'zbcheck.mjs':         'tools/zbcheck.mjs',
  'zbplaats.mjs':        'tools/zbplaats.mjs',
};

const groen = s => `\u001b[32m${s}\u001b[0m`;
const geel  = s => `\u001b[33m${s}\u001b[0m`;
const rood  = s => `\u001b[31m${s}\u001b[0m`;
const dim   = s => `\u001b[2m${s}\u001b[0m`;

// ── M5.5: projectroot zelf vinden ──────────────────────────────────────────
const scriptMap = dirname(fileURLToPath(import.meta.url));
// M5.6: strenge vingerafdruk. index.html plus src/main.js bleek te zwak: een gearchiveerd
// ouder Babylon-project voldeed daar ook aan en kreeg 14 bestanden over zich heen. De
// herkenning eist nu bestanden die alleen de echte ZeeBeslag-boom heeft en die NOOIT via
// downloads geplaatst worden (dus een besmette map kan zich er niet mee vermommen), plus
// het woord ZeeBeslag in de index.
const isRoot = p => {
  try {
    if (!existsSync(join(p, 'index.html'))) return false;
    if (!existsSync(join(p, 'src', 'main.js'))) return false;
    if (!existsSync(join(p, 'src', 'ocean', 'fft.js'))) return false;
    if (!existsSync(join(p, 'src', 'game', 'ship.js'))) return false;
    return /zeebeslag/i.test(readFileSync(join(p, 'index.html'), 'utf8'));
  } catch { return false; }
};
// Diepte-beperkte zoektocht die ALLE kandidaten verzamelt in plaats van bij de eerste te
// stoppen; archief- en backupmappen worden overgeslagen.
const SLA_OVER = new Set(['Android', 'node_modules', '_backup', 'Download', 'DCIM',
  'Pictures', 'Music', 'Movies', 'Archief', 'archief', 'Backup', 'backup', 'oud', 'Oud']);
function zoekRoots(basis, diepte, uit = []) {
  if (diepte < 0 || !existsSync(basis)) return uit;
  if (isRoot(basis)) { uit.push(basis); return uit; }
  let items; try { items = readdirSync(basis); } catch { return uit; }
  for (const f of items) {
    if (f.startsWith('.') || SLA_OVER.has(f)) continue;
    const p = join(basis, f);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) zoekRoots(p, diepte - 1, uit);
  }
  return uit;
}

const args = process.argv.slice(2).filter(a => a !== '--verplaats');
const verplaats = process.argv.includes('--verplaats');
const geheugen = join(homedir(), '.zbplaats');

let root = null;
let bronArg = null;
if (args[0]) {
  // Het meegegeven pad mag de projectroot OF de bronmap zijn; we zien zelf wat het is.
  if (isRoot(args[0])) root = args[0];
  else bronArg = args[0];
}
if (!root && isRoot(process.cwd())) root = process.cwd();
if (!root) {
  try {
    const onthouden = readFileSync(geheugen, 'utf8').trim();
    if (isRoot(onthouden)) root = onthouden;
  } catch (_) {}
}
if (!root) {
  console.log(dim('Projectroot zoeken...'));
  for (const basis of [
    '/storage/emulated/0/Documents',
    '/storage/emulated/0',
    join(homedir(), 'storage', 'shared', 'Documents'),
    join(homedir(), 'storage', 'shared'),
    homedir(),
  ]) {
    const roots = zoekRoots(basis, 4);
    if (roots.length === 1) { root = roots[0]; break; }
    if (roots.length > 1) {
      // M5.6: bij twijfel NOOIT gokken. Twee valide bomen naast elkaar betekent dat de
      // gebruiker moet kiezen; automatisch de verkeerde vullen is erger dan stoppen.
      console.log(rood('Meerdere ZeeBeslag-projectbomen gevonden:'));
      for (const r of roots) console.log('  ' + r);
      console.log('Geef de juiste 1 keer expliciet mee, daarna wordt hij onthouden:');
      console.log('  node zbplaats.mjs ' + roots[0]);
      process.exit(1);
    }
  }
}
if (!root) {
  console.log(rood('Projectroot niet gevonden (map met index.html en src/main.js).'));
  console.log('Geef hem 1 keer expliciet mee, daarna wordt hij onthouden:');
  console.log('  node zbplaats.mjs /pad/naar/ZeebeslagClaude');
  process.exit(1);
}
try { writeFileSync(geheugen, root); } catch (_) {}
process.chdir(root);
console.log(`Project: ${root}`);

// ── Live scan: alles wat al in de boom staat is per definitie bekend. Vult de kaart aan
// zodat een module die na deze scriptversie is toegevoegd toch herkend wordt. ─────────────
function scan(map) {
  for (const f of readdirSync(map)) {
    const p = join(map, f);
    if (statSync(p).isDirectory()) { if (f !== 'node_modules' && f !== '_backup') scan(p); }
    else if ((f.endsWith('.js') || f.endsWith('.mjs')) && !KAART[f]) KAART[f] = p;
  }
}
scan('src');
if (existsSync('tools')) scan('tools');

// ── Bronmap bepalen: expliciet argument wint; anders de map waar dit script zelf staat
// (mits dat niet het project is), anders de bekende downloadlocaties. ─────────────────────
const scriptInProject = scriptMap.startsWith(root);
const kandidaten = bronArg ? [bronArg] : [
  ...(scriptInProject ? [] : [scriptMap]),
  join(homedir(), 'downloads'),
  join(homedir(), 'storage', 'downloads'),
  join(homedir(), 'storage', 'shared', 'Download'),
  '/storage/emulated/0/Download',
];
const bron = kandidaten.find(p => { try { return statSync(p).isDirectory(); } catch { return false; } });
if (!bron) {
  console.log(rood('Geen downloadmap gevonden. Geef hem expliciet mee:'));
  console.log('  node tools/zbplaats.mjs /pad/naar/downloads');
  process.exit(1);
}
console.log(`Bron: ${bron}\n`);

// ── Kandidaten verzamelen: "naam.js", "naam (1).js", "naam (2).js" horen bij elkaar;
// de nieuwste wint. ───────────────────────────────────────────────────────────────────────
const groepen = new Map();   // schone naam -> [{ pad, mtime, origineel }]
let genegeerd = 0;
for (const f of readdirSync(bron)) {
  const p = join(bron, f);
  let st;
  try { st = statSync(p); } catch { continue; }
  if (!st.isFile()) continue;
  const m = f.match(/^(.+?)( \(\d+\))?(\.(js|mjs|html|json))$/);
  if (!m) { genegeerd++; continue; }
  const schoon = m[1] + m[3];
  if (!KAART[schoon]) { genegeerd++; continue; }
  if (!groepen.has(schoon)) groepen.set(schoon, []);
  groepen.get(schoon).push({ pad: p, mtime: st.mtimeMs, origineel: f });
}

if (!groepen.size) {
  console.log(geel('Geen bekende projectbestanden gevonden in de bronmap.'));
  console.log(dim(`${genegeerd} overige bestanden genegeerd.`));
  process.exit(0);
}

// ── Plaatsen, met backup van wat overschreven wordt ───────────────────────
const stempel = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const backupMap = join('_backup', stempel);
let geplaatst = 0, geback = 0;

for (const [schoon, lijst] of [...groepen.entries()].sort()) {
  lijst.sort((a, b) => b.mtime - a.mtime);
  const winnaar = lijst[0];
  const doel = KAART[schoon];

  if (existsSync(doel)) {
    const b = join(backupMap, doel);
    mkdirSync(dirname(b), { recursive: true });
    copyFileSync(doel, b);
    geback++;
  } else {
    mkdirSync(dirname(doel), { recursive: true });
  }

  copyFileSync(winnaar.pad, doel);
  geplaatst++;
  const extra = lijst.length > 1
    ? dim(`  (nieuwste van ${lijst.length}: "${winnaar.origineel}", rest genegeerd)`)
    : '';
  console.log(`${groen('ok')}  ${winnaar.origineel.padEnd(26)} -> ${doel}${extra}`);

  if (verplaats) {
    for (const k of lijst) { try { unlinkSync(k.pad); } catch (_) {} }
  }
}

console.log(`\n${geplaatst} geplaatst, ${geback} backup(s) in ${backupMap}/` +
  (verplaats ? ', bron opgeruimd' : '') +
  dim(`, ${genegeerd} overige bestanden genegeerd`));

// ── Direct controleren ─────────────────────────────────────────────────────
if (existsSync('tools/zbcheck.mjs')) {
  console.log(dim('\nzbcheck draait...\n'));
  spawnSync(process.execPath, ['tools/zbcheck.mjs'], { stdio: 'inherit' });
} else {
  console.log(geel('tools/zbcheck.mjs niet gevonden; controle overgeslagen.'));
}
