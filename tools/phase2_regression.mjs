import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
let passed = 0;
const check = (condition, message) => { assert.ok(condition, message); passed++; };
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); passed++; };
const near = (actual, expected, eps, message) => { assert.ok(Math.abs(actual - expected) <= eps, `${message}: ${actual} != ${expected}`); passed++; };

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  subtract(v) { return new Vector3(this.x - v.x, this.y - v.y, this.z - v.z); }
  add(v) { return new Vector3(this.x + v.x, this.y + v.y, this.z + v.z); }
  scale(s) { return new Vector3(this.x * s, this.y * s, this.z * s); }
  normalize() {
    const n = Math.hypot(this.x, this.y, this.z) || 1;
    this.x /= n; this.y /= n; this.z /= n;
    return this;
  }
  copyFrom(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  static Up() { return new Vector3(0, 1, 0); }
  static Cross(a, b) { return new Vector3(a.y*b.z-a.z*b.y, a.z*b.x-a.x*b.z, a.x*b.y-a.y*b.x); }
}

class Color3 { constructor(r = 0, g = 0, b = 0) { this.r = r; this.g = g; this.b = b; } }

globalThis.BABYLON = { Vector3, Color3 };
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
};
const fakeButton = { onclick: null };
globalThis.document = {
  body: { appendChild() {} },
  createElement() {
    return {
      style: {},
      innerHTML: '',
      setAttribute() {},
      querySelector() { return fakeButton; },
    };
  },
};

const { GameClock, GAME_STATES } = await import('../src/game/gameClock.js');
const { MatchDirector } = await import('../src/game/matchDirector.js');
const { CombatController } = await import('../src/game/combatController.js');
const { AtlasFX } = await import('../src/game/atlasFx.js');
const { WavesGenerator } = await import('../src/ocean/wavesGenerator.js');

// GameClock: alleen PLAYING mag gameplaytijd laten lopen.
const clock = new GameClock({ state: GAME_STATES.LOADING, timeScale: 1 });
equal(clock.tick(0.05).gameDt, 0, 'loading bevriest gameplay');
clock.setState(GAME_STATES.PLAYING);
near(clock.tick(0.05).gameTime, 0.05, 1e-9, 'playing telt gameplaytijd');
clock.setState(GAME_STATES.PAUSED);
near(clock.tick(0.08).gameTime, 0.05, 1e-9, 'pauze houdt gameplaytijd vast');
clock.setState(GAME_STATES.PLAYING);
clock.setTimeScale(2);
near(clock.tick(0.05).gameTime, 0.15, 1e-9, 'tijdschaal werkt via centrale klok');
clock.setState(GAME_STATES.GAME_OVER);
equal(clock.tick(0.05).gameDt, 0, 'game-over bevriest gameplay');
clock.reset();
equal(clock.gameTime, 0, 'klok reset naar nul');

// MatchDirector: state, runtime scaling, game-over en herhaalde volledige reset.
const calls = new Map();
const hit = name => calls.set(name, (calls.get(name) || 0) + 1);
const scaleHistory = [];
const playerShip = { respawn(pos, heading) { hit('ship'); this.pos = pos; this.heading = heading; } };
const md = new MatchDirector({ aiThrottle: 0.4, aiRudderAmp: 0, aiRudderRate: 1 });
md.bind({
  fx: { setTimeScale(v) { scaleHistory.push(v); }, resetTransient() { hit('fx'); } },
  megaPlume: { setTimeScale(v) { scaleHistory.push(v); }, reset() { hit('plume'); } },
  sfx: { stopAll() { hit('sfx'); } },
  combatController: { cancelPending() { hit('cancelPending'); }, reset() { hit('combat'); } },
  ballistics: { clear() { hit('ballistics'); } },
  battle: { reset() { hit('battle'); } },
  registry: { reset() { hit('registry'); } },
  playerShip,
  wakeManager: { reset() { hit('wake'); } },
  markers: { reset() { hit('markers'); } },
  hud: { reset() { hit('hud'); }, setMode() { hit('hudMode'); } },
  heatFx: { reset() { hit('heat'); } },
  squadron: { reset() { hit('squadron'); } },
  onReset() { hit('context'); },
});
check(md.completeLoading(), 'loading kan exact eenmaal naar playing');
equal(md.state, GAME_STATES.PLAYING, 'director start playing na completeLoading');
md.tick(0.04);
check(md.pause(), 'pauze vanuit playing lukt');
equal(md.state, GAME_STATES.PAUSED, 'state is paused');
near(md.tick(0.1).gameTime, 0.04, 1e-9, 'director-tijd staat stil in pauze');
equal(scaleHistory.at(-1), 0, 'visuele runtime-systemen krijgen schaal nul');
check(md.resume(), 'hervatten vanuit paused lukt');
md.setTimeScale(2);
near(md.tick(0.03).gameTime, 0.10, 1e-9, 'director gebruikt ingestelde tijdschaal');
md.onShipSank();
equal(md.state, GAME_STATES.GAME_OVER, 'schip zinken zet game-over');
check((calls.get('cancelPending') || 0) >= 1, 'game-over annuleert resterende salvo’s');
const frozenAt = md.gameTime;
near(md.tick(0.1).gameTime, frozenAt, 1e-9, 'game-over laat geen timers doorlopen');
check(md.resetMatch(), 'eerste volledige reset zonder fout');
equal(md.state, GAME_STATES.PLAYING, 'reset keert terug naar playing');
equal(md.gameTime, 0, 'reset wist gameplaytijd');
equal(md.mode, 'ship', 'reset herstelt scheepsmodus');
check(md.resetMatch(), 'tweede reset is idempotent');
equal(calls.get('ship'), 2, 'schip wordt per reset eenmaal hersteld');
equal(calls.get('combat'), 2, 'combat wordt per reset eenmaal hersteld');
equal(calls.get('ballistics'), 2, 'projectielen worden per reset eenmaal gewist');
equal(calls.get('wake'), 2, 'wake wordt per reset eenmaal gewist');
equal(calls.get('plume'), 2, 'achtergrondpluim wordt per reset hersteld');
equal(calls.get('context'), 2, 'main-context wordt per reset eenmaal hersteld');

// CombatController: geplande schoten zijn expliciet annuleerbaar.
const combat = new CombatController({ fireCooldown: 4, roundsPerTurret: 2, burstGap: 0.1, turretGap: 0.2 }, null);
combat.pendingShots.push({ turret: 0, at: 1 }, { turret: 1, at: 2 });
combat.cancelPending();
equal(combat.pendingShots.length, 0, 'cancelPending leegt de salvo-wachtrij');
combat.lastFireT = 99;
combat.reset();
equal(combat.lastFireT, -10, 'combat-reset wist cooldown');

// AtlasFX: schaal nul is echt nul, geen verborgen 0.0001-update meer.
const atlas = Object.create(AtlasFX.prototype);
atlas._embers = { updateSpeed: 1 };
atlas._spray = { updateSpeed: 1 };
atlas.setTimeScale(0);
equal(atlas._embers.updateSpeed, 0, 'embers bevriezen exact');
equal(atlas._spray.updateSpeed, 0, 'spray bevriest exact');
atlas.setTimeScale(1.5);
near(atlas._embers.updateSpeed, 0.015, 1e-12, 'particle-schaal herstelt correct');

// WavesGenerator: geen performance.now; tijd loopt uitsluitend op update-delta.
const waveCalls = [[], [], []];
const wg = Object.create(WavesGenerator.prototype);
wg._prewarmTime = 10000;
wg._simTime = 10000;
wg._tick = 0;
wg._c0Accum = 0;
wg._cascades = waveCalls.map(bucket => ({ calculateWavesAtTime(t, dt) { bucket.push({ t, dt }); } }));
wg.update(0);
equal(waveCalls[1].length, 0, 'nul-delta werkt de oceaan niet bij');
wg.update(0.1);
near(waveCalls[1][0].t, 10000.1, 1e-9, 'oceaantijd gebruikt gesimuleerde delta');
wg.update(0.1);
near(waveCalls[0][0].t, 10000.2, 1e-9, 'verre cascade gebruikt dezelfde simulatieklok');
wg.reset();
equal(wg._simTime, 10000, 'oceaanreset herstelt pre-warmtijd');
equal(wg._tick, 0, 'oceaanreset wist cascade-tick');

// Integratiehandtekeningen tegen regressie door latere refactors.
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const overlay = fs.readFileSync(path.join(root, 'src/ui/overlayUI.js'), 'utf8');
const wake = fs.readFileSync(path.join(root, 'src/ocean/wakeManager.js'), 'utf8');
check(main.includes('const frame = matchDirector.tick(dts);'), 'main gebruikt centrale klok');
check(main.includes('if (gameplayActive) {'), 'main gate gameplay-systemen op lifecycle');
check(main.includes('matchDirector.completeLoading()'), 'main beëindigt loading expliciet');
check(overlay.includes('this.md.isPaused') && overlay.includes('this.md.resume()'), 'pauzeknop hervat via state');
check(wake.includes('cdt <= 0) return'), 'wake plaatst niets bij pauze');

console.log(`Phase 2 regression tests: ${passed} assertions passed.`);
