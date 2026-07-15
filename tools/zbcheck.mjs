#!/usr/bin/env node
// ZeeBeslag modulecontrole. Draait zonder browser, zonder Babylon en zonder dependencies.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join, relative } from 'node:path';

const ROOT = process.cwd();
let fouten = 0, waarschuwingen = 0;
const RED='\x1b[31m',YEL='\x1b[33m',GRN='\x1b[32m',DIM='\x1b[2m',OFF='\x1b[0m';
const ok=m=>console.log(`${GRN}  ok${OFF}   ${m}`);
const warn=m=>{waarschuwingen++;console.log(`${YEL}  let op${OFF} ${m}`);};
const bad=m=>{fouten++;console.log(`${RED}  FOUT${OFF} ${m}`);};
const kop=m=>console.log(`\n${m}`);

const VERWACHT = [
  'index.html','package.json','src/main.js',
  'src/core/engine.js','src/core/debug.js','src/core/log.js','src/core/telemetry.js',
  'src/core/performanceProfile.js','src/core/meshOptimizer.js','src/core/sunSweepTool.js',
  'src/input/controls.js','src/levels/level1.js',
  'src/environment/skyRig.js',
  'src/ocean/wavesSettings.js','src/ocean/wavesGenerator.js','src/ocean/oceanMaterial.js',
  'src/ocean/wakeManager.js','src/ocean/presets.js','src/ocean/computeHelper.js',
  'src/ocean/wavesCascade.js','src/ocean/oceanGeometry.js','src/ocean/oceanShaders.js',
  'src/ocean/fft.js','src/ocean/wgsl.js','src/ocean/initialSpectrum.js',
  'src/game/swellField.js','src/game/ship.js','src/game/fireSupportShip.js','src/game/islandTarget.js',
  'src/game/collisionMath.js','src/game/worldCollision.js','src/game/chaseCamera.js',
  'src/game/ballistics.js','src/game/targetRegistry.js','src/game/emplacement.js',
  'src/game/atlasFx.js','src/game/hud.js','src/game/menu.js','src/game/turretRig.js',
  'src/game/combatController.js','src/game/defenseNetwork.js','src/game/matchDirector.js',
  'src/game/levelMatchDirector.js','src/game/missionDirector.js','src/game/trajectoryRenderer.js',
  'src/ui/overlayUI.js','src/ui/markerLayer.js','src/ui/missionHud.js','src/ui/devPanel.js',
];

const DOOD = ['src/game/combatControler.js','0','compute'];
const HANDTEKENINGEN = [
  ['src/game/combatController.js',/fireSalvo\(simTime,\s*playerShip\)/,
    'CombatController.fireSalvo heeft niet de verwachte Level-1-signatuur.'],
  ['src/game/combatController.js',/playerAimStatus\(playerShip/,
    'CombatController mist gereedstatus per turret.'],
  ['src/game/fireSupportShip.js',/getTurretReadiness/,
    'FireSupportShip mist betrouwbare gereedcontrole per turret.'],
  ['src/game/fireSupportShip.js',/class FireSupportShip extends Ship/,
    'Level-1-schip moet de bestaande Ship-basis uitbreiden.'],
  ['src/game/islandTarget.js',/sample\s*\(\s*x\s*,\s*z\s*\)/,
    'IslandTarget mist terreinsampling.'],
  ['src/game/islandTarget.js',/^(?!.*scale\(2\)).*$/s,
    'IslandTarget bevat nog .scale(2).'],
  ['src/game/ballistics.js',/export function solveElevation/,
    'Ballistics mist solveElevation.'],
  ['src/game/ballistics.js',/setRegistry/,
    'Ballistics kent het doelregister niet.'],
  ['src/game/defenseNetwork.js',/missionState !== 'active'/,
    'DefenseNetwork isoleert toekomstige missiedoelen niet.'],
  ['src/game/emplacement.js',/setMissionState/,
    'Emplacement mist missiestatus active/inactive/completed.'],
  ['src/game/targetRegistry.js',/_interactive/,
    'TargetRegistry kan toekomstige doelen nog raken.'],
  ['src/input/controls.js',/class MobileInputController/,
    'Controls mist centrale mobiele inputlaag.'],
  ['src/input/controls.js',/pointercancel/,
    'Controls verwerkt pointercancel niet defensief.'],
  ['src/game/missionDirector.js',/class MissionDirector/,
    'MissionDirector ontbreekt.'],
  ['src/game/levelMatchDirector.js',/finishMission/,
    'LevelMatchDirector mist levelresultaat.'],
  ['src/ui/missionHud.js',/class MissionHUD/,
    'MissionHUD ontbreekt.'],
  ['src/game/trajectoryRenderer.js',/update\(playerShip,\s*muzzleVelocity,\s*isReady\)/,
    'TrajectoryRenderer heeft een onverwachte signatuur.'],
  ['src/core/debug.js',/export\s+(function\s+getLogBuffer|\{[^}]*getLogBuffer[^}]*\})/,
    'debug.js mist getLogBuffer.'],
];

function alleJs(dir, uit=[]) {
  if(!existsSync(dir)) return uit;
  for(const f of readdirSync(dir)) {
    const p=join(dir,f);
    if(statSync(p).isDirectory()) alleJs(p,uit);
    else if(f.endsWith('.js')) uit.push(p);
  }
  return uit;
}
function zonderCommentaar(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^[ \t]*\/\/.*$/gm,'');
}
function exportsVan(src) {
  const namen=new Set();
  for(const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) namen.add(m[1]);
  for(const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) namen.add(m[1]);
  for(const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for(let stuk of m[1].split(',')) {
      stuk=stuk.trim(); if(!stuk) continue;
      const als=stuk.split(/\s+as\s+/i); namen.add((als[1]||als[0]).trim());
    }
  }
  if(/export\s+default/.test(src)) namen.add('default');
  return namen;
}
function importsVan(raw) {
  const src=zonderCommentaar(raw),uit=[];
  for(const m of src.matchAll(/import\s+['"]([^'"]+)['"]/g)) uit.push({pad:m[1],namen:[]});
  for(const m of src.matchAll(/import\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause=m[1].trim(),pad=m[2],namen=[];
    const bracket=clause.match(/\{([^}]*)\}/);
    if(bracket) for(let s of bracket[1].split(',')) {
      s=s.trim(); if(s) namen.push(s.split(/\s+as\s+/i)[0].trim());
    }
    const standaard=clause.replace(/\{[^}]*\}/,'').replace(/,/g,'').trim();
    if(standaard && !standaard.startsWith('*')) namen.push('default');
    uit.push({pad,namen});
  }
  return uit;
}

kop('1. Bestanden');
for(const f of VERWACHT) existsSync(resolve(ROOT,f)) ? ok(f) : bad(`${f} ontbreekt`);
for(const f of DOOD) if(existsSync(resolve(ROOT,f))) bad(`${f} bestaat nog en hoort weg`);
if(!existsSync(resolve(ROOT,'vendor'))) warn('geen vendor/ map: Babylon komt van de CDN');

kop('2. Syntax');
const bestanden=alleJs(resolve(ROOT,'src'));
let syntaxOk=0;
for(const p of bestanden) {
  const r=spawnSync(process.execPath,['--check',p],{encoding:'utf8'});
  if(r.status===0) syntaxOk++;
  else bad(`${relative(ROOT,p)}\n${DIM}${(r.stderr||'').split('\n').slice(0,4).join('\n')}${OFF}`);
}
ok(`${syntaxOk}/${bestanden.length} bestanden parsen schoon`);

kop('3. Imports en exports');
let importsOk=0,importsTot=0;
for(const p of bestanden) {
  const src=readFileSync(p,'utf8');
  for(const imp of importsVan(src)) {
    if(!imp.pad.startsWith('.')) continue;
    importsTot++;
    const doel=resolve(dirname(p),imp.pad);
    if(!existsSync(doel)) { bad(`${relative(ROOT,p)} importeert ${imp.pad}, maar dat bestand bestaat niet`); continue; }
    const beschikbaar=exportsVan(readFileSync(doel,'utf8'));
    const missend=imp.namen.filter(n=>!beschikbaar.has(n));
    if(missend.length) bad(`${relative(ROOT,p)} importeert ${missend.join(', ')} uit ${imp.pad}, maar die exports ontbreken`);
    else importsOk++;
  }
}
ok(`${importsOk}/${importsTot} relatieve imports resolven`);

kop('4. Versiehandtekeningen');
for(const [f,re,uitleg] of HANDTEKENINGEN) {
  const p=resolve(ROOT,f);
  if(!existsSync(p)) continue;
  const src=zonderCommentaar(readFileSync(p,'utf8'));
  re.test(src) ? ok(f) : bad(`${f}\n         ${uitleg}`);
}

kop('5. Dubbele of verweesde modules');
const basisnamen=new Map();
for(const p of bestanden) {
  const b=p.split('/').pop().toLowerCase().replace(/[^a-z]/g,'');
  if(!basisnamen.has(b)) basisnamen.set(b,[]);
  basisnamen.get(b).push(relative(ROOT,p));
}
let dubbel=0;
for(const lijst of basisnamen.values()) if(lijst.length>1) { warn(`bijna gelijke namen: ${lijst.join(' en ')}`); dubbel++; }
if(!dubbel) ok('geen bijna-gelijke bestandsnamen');
const geimporteerd=new Set();
for(const p of bestanden) for(const imp of importsVan(readFileSync(p,'utf8'))) {
  if(imp.pad.startsWith('.')) geimporteerd.add(resolve(dirname(p),imp.pad));
}
for(const p of bestanden) {
  if(p.endsWith('src/main.js')) continue;
  if(!geimporteerd.has(p)) warn(`${relative(ROOT,p)} wordt door niemand geimporteerd`);
}

kop('6. Build');
try {
  const main=readFileSync(resolve(ROOT,'src/main.js'),'utf8');
  const m=main.match(/export const BUILD\s*=\s*['"]([^'"]+)['"]/);
  ok(m ? `main.js meldt: ${m[1]}` : 'geen BUILD-constante gevonden');
  const idx=readFileSync(resolve(ROOT,'index.html'),'utf8');
  const pin=idx.match(/babylon-([\d.]+)\.js/);
  ok(pin ? `Babylon gepind op ${pin[1]}` : 'geen gepinde Babylon in index.html');
  if(!/M7\.0\.0 level1-bruggenhoofd/.test(main)) bad('main.js meldt niet de Level-1-build');
  if(/joyBaseR|btnUp|btnDown/.test(idx)) bad('mobiele pagina bevat nog vaar- of hoogtebediening');
} catch(e) { bad('main.js of index.html onleesbaar: '+e.message); }

console.log('');
if(fouten) {
  console.log(`${RED}${fouten} fout(en)${OFF}, ${waarschuwingen} waarschuwing(en).`);
  process.exit(1);
}
console.log(`${GRN}Alles schoon${OFF} (${waarschuwingen} waarschuwing(en)).`);
console.log(`${DIM}Statische controle sluit runtimefouten op een echt WebGPU-toestel niet uit.${OFF}`);
