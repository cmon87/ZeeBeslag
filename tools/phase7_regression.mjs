import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
let passed = 0;
const check = (value, message) => { assert.ok(value, message); passed++; };
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); passed++; };

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setAll(v) { this.x = v; this.y = v; this.z = v; return this; }
  copyFrom(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  normalize() { const l = Math.hypot(this.x, this.y, this.z) || 1; this.x /= l; this.y /= l; this.z /= l; return this; }
  static TransformCoordinatesToRef(v, _m, out) { out.copyFrom(v); }
  static TransformNormalToRef(v, _m, out) { out.copyFrom(v); }
  static TransformCoordinatesFromFloatsToRef(x, y, z, _m, out) { out.set(x, y, z); }
}
class TransformNode {
  constructor(name) {
    this.name = name;
    this.position = new Vector3();
    this.rotation = { x: 0, y: 0, z: 0 };
    this.scaling = new Vector3(1, 1, 1);
    this.parent = null;
    this.enabled = true;
  }
  setEnabled(v) { this.enabled = v; }
  getWorldMatrix() { return {}; }
  getAbsolutePosition() { return this.position.clone(); }
  dispose() { this.disposed = true; }
}
class Mesh extends TransformNode {
  constructor(name) { super(name); this.material = null; this.isVisible = true; }
  computeWorldMatrix() {}
}
class StandardMaterial { constructor(name) { this.name = name; } }
class Color3 { constructor(r, g, b) { this.r = r; this.g = g; this.b = b; } }

globalThis.BABYLON = {
  Vector3,
  TransformNode,
  StandardMaterial,
  Color3,
  MeshBuilder: {
    CreateBox: name => new Mesh(name),
    CreateCylinder: name => new Mesh(name),
  },
  Quaternion: { Identity: () => ({}) },
  Axis: { X: new Vector3(1, 0, 0), Y: new Vector3(0, 1, 0), Z: new Vector3(0, 0, 1) },
  Scalar: { Clamp: (v, a, b) => Math.max(a, Math.min(b, v)) },
};
Object.defineProperty(globalThis, 'navigator', { value: { vibrate() {} }, configurable: true });

const { LEVEL_1 } = await import('../src/levels/level1.js');
equal(LEVEL_1.movementMode, 'anchored', 'level 1 verankert het schip');
equal(LEVEL_1.objectives.length, 3, 'level 1 heeft exact drie vuurmissies');
equal(LEVEL_1.salvo.roundsPerTurret, 1, 'tutorialsalvo gebruikt één granaat per toren');
check(LEVEL_1.objectives.every(o => o.timeLimit >= 90), 'mobiele tutorial gebruikt royale timers');

const { setupBtn } = await import('../src/input/controls.js');
class FakeElement {
  constructor() { this.listeners = new Map(); this.classList = { add() {}, remove() {} }; this.style = {}; this.disabled = false; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type) { this.listeners.delete(type); }
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() { return true; }
  emit(type, pointerId = 1) {
    const fn = this.listeners.get(type);
    if (fn) fn({ pointerId, pointerType: 'touch', preventDefault() {}, stopPropagation() {} });
  }
}
const button = new FakeElement();
let actions = 0;
setupBtn(button, () => actions++);
button.emit('pointerdown');
button.emit('pointercancel');
button.emit('pointerup');
equal(actions, 0, 'pointercancel vuurt geen salvo af');
button.emit('pointerdown', 2);
button.emit('pointerup', 2);
equal(actions, 1, 'geldige touch-up voert precies één actie uit');

const { FireSupportShip } = await import('../src/game/fireSupportShip.js');
const ship = new FireSupportShip({}, { getHeight: () => 0 }, { position: new Vector3(), heading: 0 });
ship.addTurret(new Vector3(0, 6, 0), { barrel: 6, muzzleY: 1 });
const aim = new Vector3(1000, 0, 0);
for (let i = 0; i < 180; i++) ship.aimTurretsAt(aim, 0.05, 300);
const turretStatus = ship.getTurretReadiness(aim, 300);
equal(turretStatus.length, 1, 'logische turret krijgt een gereedstatus');
check(turretStatus[0].ready, 'logische turret kan zonder GLB-node volledig op doel komen');
const muzzle = new Vector3(), direction = new Vector3();
ship.getMuzzle(muzzle, direction, 0);
check(direction.x > 0.95, 'logische turret vuurt in de berekende doelrichting');

const { Emplacement } = await import('../src/game/emplacement.js');
const inactive = new Emplacement({}, 'battery', {
  id: 'TEST', pos: new Vector3(10, 2, 10), hp: 50,
  missionControlled: true, missionState: 'inactive',
});
equal(inactive.damage(500), false, 'inactief toekomstig doel kan niet worden vernietigd');
equal(inactive.hp, 50, 'inactief doel verliest geen hp');
inactive.setMissionState('active');
equal(inactive.damage(500), true, 'actief missiedoel kan worden vernietigd');

const { TargetRegistry } = await import('../src/game/targetRegistry.js');
const registry = new TargetRegistry({});
let activeHits = 0, inactiveHits = 0;
registry.list = [
  { alive: true, missionControlled: true, missionState: 'active', root: { position: new Vector3() }, visibilityHeight: 0, damage() { activeHits++; return false; } },
  { alive: true, missionControlled: true, missionState: 'inactive', root: { position: new Vector3() }, visibilityHeight: 0, damage() { inactiveHits++; return false; } },
];
registry.applyBlast(new Vector3(), 10, 50);
equal(activeHits, 1, 'explosie raakt het actieve doel');
equal(inactiveHits, 0, 'explosie slaat toekomstige doelen over');

const { CombatController } = await import('../src/game/combatController.js');
const combat = new CombatController({
  fireCooldown: 5, roundsPerTurret: 1, burstGap: 0.1, turretGap: 0.1,
  muzzleVelocity: 300, aimReadyRad: 0.01, aimReadyElevRad: 0.014,
}, null);
combat.setPlayerFirePolicy({ readyOnly: true, roundsPerTurret: 1 });
combat.setPlayerAimTarget(new Vector3(1000, 0, 0));
const fakeShip = {
  turrets: [{}, {}, {}],
  getTurretReadiness() {
    return [
      { index: 0, ready: true },
      { index: 1, ready: false },
      { index: 2, ready: true },
    ];
  },
};
check(combat.fireSalvo(10, fakeShip), 'salvo start wanneer minimaal één turret gereed is');
equal(combat.pendingShots.length, 2, 'alleen twee gereedstaande turrets worden ingepland');
equal(combat.lastSalvoTurretCount, 2, 'HUD kan het werkelijk vurende aantal rapporteren');

const { MissionDirector } = await import('../src/game/missionDirector.js');
const fakeTargets = LEVEL_1.objectives.map((def, i) => ({
  alive: true,
  root: { position: new Vector3(1000 + i * 100, 10, i * 50) },
  setMissionState(state) { this.missionState = state; },
  reset() { this.alive = true; },
}));
const mission = Object.create(MissionDirector.prototype);
Object.assign(mission, {
  level: LEVEL_1,
  targets: fakeTargets,
  state: 'active',
  objectiveIndex: 0,
  completedCount: 0,
  timeRemaining: 20,
  transitionRemaining: 0,
  combatController: { pendingShots: [] },
  ballistics: { projectiles: [] },
  playerShip: { root: { position: new Vector3() } },
  chaseCam: { setEnemy() {} },
  aimTarget: new Vector3(),
  island: { sample: () => 10 },
  markers: { announce() {} },
  hud: { announce() {}, reset() {} },
  matchDirector: { finishMission(success) { mission.finished = success; } },
});
check(mission.onTargetDestroyed(fakeTargets[0]), 'vernietiging van actief doel start overgang');
equal(mission.state, 'transition', 'missie wacht op uitvliegende granaten');
mission.update(2);
equal(mission.objectiveIndex, 1, 'missie activeert doel twee na afgerond salvo');
equal(mission.state, 'active', 'volgende vuurmissie is actief');
mission.timeRemaining = 0.01;
mission.update(0.02);
equal(mission.finished, false, 'afgelopen ondersteuningstijd faalt de missie');

const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const controls = fs.readFileSync(path.join(root, 'src/input/controls.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
check(/playerShip\.floatOnly\((?:cdt|gameDt)\)/.test(main), 'runtime gebruikt verankerde golfbeweging');
check(main.includes('missionDirector.showBriefing'), 'missie start pas via briefing');
check(!main.includes("from './core/sfx.js'"), 'level 1 laadt geen audio-engine');
check(!controls.includes("addEventListener('keydown'"), 'mobiele input bevat geen keyboardbediening');
check(!index.includes('joyBaseR'), 'rechter vaarjoystick is uit de mobiele UI verwijderd');
check(index.includes('orientation-warning'), 'portretstand toont een landscape-instructie');

console.log(`Phase 7 regression tests: ${passed} assertions passed.`);
