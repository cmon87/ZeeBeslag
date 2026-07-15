#!/usr/bin/env node
import assert from 'node:assert/strict';

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setAll(v) { this.x = v; this.y = v; this.z = v; return this; }
  copyFrom(v) { return this.set(v.x, v.y, v.z); }
  clone() { return new Vector3(this.x, this.y, this.z); }
  add(v) { return new Vector3(this.x + v.x, this.y + v.y, this.z + v.z); }
  scale(v) { return new Vector3(this.x * v, this.y * v, this.z * v); }
  scaleInPlace(v) { this.x *= v; this.y *= v; this.z *= v; return this; }
  normalize() { const l = Math.hypot(this.x, this.y, this.z) || 1; return this.scaleInPlace(1 / l); }
  static DistanceSquared(a, b) { const x = a.x-b.x, y = a.y-b.y, z = a.z-b.z; return x*x+y*y+z*z; }
  static TransformCoordinatesFromFloatsToRef(x, y, z, _m, out) { out.set(x, y, z); }
}
Vector3.Zero = () => new Vector3();

class TransformNode {
  constructor(name) {
    this.name = name;
    this.position = new Vector3();
    this.rotation = new Vector3();
    this.scaling = new Vector3(1, 1, 1);
    this.enabled = true;
    this._disposed = false;
  }
  setEnabled(v) { this.enabled = v; }
  dispose() { this._disposed = true; }
  isDisposed() { return this._disposed; }
}

function mesh(name) {
  return {
    name,
    position: new Vector3(),
    rotation: new Vector3(),
    parent: null,
    material: null,
    isPickable: true,
    disposed: false,
    dispose() { this.disposed = true; },
    getWorldMatrix() { return {}; },
  };
}

class StandardMaterial { constructor(name) { this.name = name; } }
class Color3 { constructor(r=0,g=0,b=0){ this.r=r; this.g=g; this.b=b; } }

globalThis.BABYLON = {
  Vector3,
  TransformNode,
  StandardMaterial,
  Color3,
  Quaternion: { Identity: () => ({}) },
  MeshBuilder: {
    CreateBox: (name) => mesh(name),
    CreateCylinder: (name) => mesh(name),
  },
};

const { Emplacement } = await import('../src/game/emplacement.js');
const { TargetRegistry } = await import('../src/game/targetRegistry.js');
const { CombatController } = await import('../src/game/combatController.js');
const { IslandTarget } = await import('../src/game/islandTarget.js');
const { FX_PATHS } = await import('../src/game/atlasFx.js');

const scene = {};

// Capabilities en labels zijn typegedreven. Alleen een batterij heeft een wapen.
const battery = new Emplacement(scene, 'battery', { id: 'B1', pos: new Vector3(0, 0, 0) });
const radar = new Emplacement(scene, 'radar', { id: 'R1', pos: new Vector3(100, 0, 0) });
const depot = new Emplacement(scene, 'depot', { id: 'D1', pos: new Vector3(200, 0, 0) });
assert.equal(battery.canFire, true);
assert.equal(radar.canFire, false);
assert.equal(depot.canFire, false);
assert.equal(battery.label, 'KUSTBATTERIJ');
assert.equal(radar.label, 'RADAR');
assert.equal(depot.label, 'MUNITIEDEPOT');
assert.ok(battery._gunMesh, 'batterij moet een kanonmesh hebben');
assert.equal(radar._gunMesh, null, 'radar mag geen kanonmesh hebben');
assert.equal(depot._gunMesh, null, 'depot mag geen kanonmesh hebben');
battery.lastFireT = 123;
battery.reset();
assert.equal(battery.lastFireT, -Infinity, 'reset moet de batterijcooldown wissen');

// Zichtstatus beïnvloedt UI/targeting, niet fysieke treffers.
const registry = new TargetRegistry(scene);
registry.add(radar);
const radarCenter = new Vector3(100, radar.visibilityHeight, 0);
assert.equal(radar.state, 'unknown');
assert.equal(registry.hitTest(radarCenter, null), radar, 'unknown doel moet fysiek raakbaar zijn');
registry.applyBlast(radarCenter, 1000, 50);
assert.equal(radar.alive, false, 'unknown doel moet door explosies vernietigd kunnen worden');

// JSON-import is transactioneel: een fout mag de actieve registry niet half vervangen.
assert.throws(() => registry.loadJSON({ emplacements: [
  { id: 'OK', type: 'bunker', pos: { x: 1, y: 2, z: 3 } },
  { id: 'FOUT', type: 'radar', pos: { x: 1, y: 'geen getal', z: 3 } },
] }), /Ongeldige emplacementpositie/);
assert.equal(registry.list.length, 1);
assert.equal(registry.list[0], radar);

// De vuurcontroller heeft zelf ook een capability-slot tegen regressie in de hoofdloop.
const cfg = {
  enemyFireInterval: 2.2,
  engageRange: 3200,
  muzzleVelocity: 300,
  enemySpreadMrad: 0,
  fireCooldown: 8,
};
const controller = new CombatController(cfg, {});
const player = { alive: true, heading: 0, speed: 0, root: new TransformNode('player') };
player.root.position.set(500, 0, 0);
let fired = 0;
const ballistics = { fire() { fired++; } };
const fakeRadar = {
  alive: true, canFire: false, lastFireT: -Infinity,
  root: new TransformNode('fakeRadar'),
  getMuzzle(out) { out.copyFrom(this.root.position); },
};
assert.equal(controller.enemyFire(10, fakeRadar, player, ballistics, null), false);
assert.equal(fired, 0);
const fakeBattery = { ...fakeRadar, canFire: true, root: new TransformNode('fakeBattery') };
assert.equal(controller.enemyFire(10, fakeBattery, player, ballistics, null), true);
assert.equal(fired, 1);

// LOS gebruikt de heightmap, niet Babylon picking.
const island = new IslandTarget(scene);
island._hmRes = 5;
island._hmX0 = 0;
island._hmZ0 = 0;
island._hmSpan = 100;
island._hm = new Float32Array(25).fill(0);
for (let z = 0; z < 5; z++) island._hm[z * 5 + 2] = 25;
assert.equal(
  island.hasLineOfSight(new Vector3(0, 10, 50), new Vector3(100, 10, 50), { startMargin: 0, endMargin: 0, step: 4 }),
  false,
  'bergrug moet zicht blokkeren',
);
island._hm.fill(0);
assert.equal(
  island.hasLineOfSight(new Vector3(0, 10, 50), new Vector3(100, 10, 50), { startMargin: 0, endMargin: 0, step: 4 }),
  true,
  'vlak terrein onder de zichtlijn moet zicht toelaten',
);

// De ontbrekende legacy-atlas wordt niet meer standaard aangevraagd.
assert.equal(FX_PATHS.smoke2, null);

console.log('Phase 1 regression tests: 20 assertions passed.');
