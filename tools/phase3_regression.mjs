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
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copyFrom(v) { return this.set(v.x, v.y, v.z); }
  clone() { return new Vector3(this.x, this.y, this.z); }
  static DistanceSquared(a, b) { const x=a.x-b.x, y=a.y-b.y, z=a.z-b.z; return x*x+y*y+z*z; }
}

globalThis.BABYLON = { Vector3 };

const { segmentSphereHitT, pointOnSegment } = await import('../src/game/collisionMath.js');
const { WorldCollision } = await import('../src/game/worldCollision.js');
const { TargetRegistry } = await import('../src/game/targetRegistry.js');
const { Ballistics } = await import('../src/game/ballistics.js');

// Exacte segment-boltest: beide eindpunten liggen buiten de bol, maar het segment gaat erdoor.
const tSphere = segmentSphereHitT(
  new Vector3(-20, 0, 0), new Vector3(20, 0, 0), new Vector3(0, 0, 0), 3,
);
check(tSphere !== null, 'segment detecteert een doorkruiste bol');
near(tSphere, 17 / 40, 1e-9, 'segment-bol geeft het eerste raakpunt');
const pSphere = pointOnSegment(new Vector3(-20, 0, 0), new Vector3(20, 0, 0), tSphere, new Vector3());
near(pSphere.x, -3, 1e-9, 'raakpunt ligt op de voorzijde van de bol');
equal(segmentSphereHitT(new Vector3(-20, 5, 0), new Vector3(20, 5, 0), new Vector3(), 3), null, 'parallel segment buiten bol mist');

// Heightmap-navigatie: boeg mag de ondiepe kust niet binnendringen.
const coast = { sample(x) { return x >= 10 ? 0 : null; } };
const navigator = new WorldCollision(coast, {
  underKeelClearance: 1.5,
  sweepStep: 2,
  bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
});
const ship = { heading: Math.PI / 2, length: 4, beam: 2, draft: 1 };
const blocked = navigator.resolveShipMove(ship, { x: 0, z: 0 }, { x: 20, z: 0 });
check(blocked.blocked && blocked.terrain, 'kust blokkeert het schip');
check(blocked.x < 10, 'schip stopt vóór de landhoogte');
check(blocked.x > 7, 'sweep stopt dicht bij de kust en niet bij het startpunt');
const contact = navigator.consumeContact();
equal(contact.reason, 'terrain', 'eerste contact wordt éénmaal als terrain gemeld');
equal(navigator.consumeContact(), null, 'contactevent wordt na consumptie gewist');
const reverse = navigator.resolveShipMove(ship, { x: blocked.x, z: 0 }, { x: 0, z: 0 });
check(!reverse.blocked && reverse.x < blocked.x, 'achteruitvaren vanaf de kust blijft mogelijk');

// Een handmatig in ondiep water geplaatst schip mag naar dieper water ontsnappen.
const escape = navigator.resolveShipMove(ship, { x: 12, z: 0 }, { x: 5, z: 0 });
check(escape.x < 12, 'beweging die gronding vermindert wordt niet vastgezet');

// Missiegrens klemt één as en laat beweging langs de grens toe.
const boundaryNav = new WorldCollision(null, { bounds: { minX: -5, maxX: 5, minZ: -5, maxZ: 5 } });
const boundary = boundaryNav.resolveShipMove(ship, { x: 4, z: 0 }, { x: 10, z: 3 });
equal(boundary.x, 5, 'missiegrens klemt x');
near(boundary.z, 3, 1e-9, 'beweging langs de missiegrens blijft behouden');
check(boundary.boundary && boundary.slid, 'grenscontact wordt als glijden gerapporteerd');

// TargetRegistry gebruikt dezelfde swept test, onafhankelijk van spottingstatus.
const registry = new TargetRegistry({});
const hiddenTarget = {
  alive: true,
  state: 'unknown',
  radius: 2,
  visibilityHeight: 0,
  root: { position: new Vector3(0, 0, 0) },
};
registry.add(hiddenTarget);
const regHit = registry.hitTestSegment(new Vector3(-10, 0, 0), new Vector3(10, 0, 0), null, 0);
equal(regHit.target, hiddenTarget, 'onontdekt doel is fysiek swept-raakbaar');
near(regHit.t, 0.4, 1e-9, 'register retourneert vroegste segmenttreffer');

function makeBallistics({ targets = [], registry = null, terrain = null, water = -1000 } = {}) {
  const b = Object.create(Ballistics.prototype);
  b.g = 0;
  b.projectiles = [];
  b.targets = targets;
  b.registry = registry;
  b.terrain = terrain;
  b._swell = { getHeight: typeof water === 'function' ? water : () => water };
  b.armDist = 0;
  b._armDist2 = 0;
  b._prev = new Vector3();
  b._next = new Vector3();
  b._impactPoint = new Vector3();
  b._targetCenter = new Vector3();
  b._placeTracer = () => {};
  b._kill = p => { p.killed = (p.killed || 0) + 1; };
  b.onImpactWater = null;
  b.onImpactShip = null;
  b.onImpactGround = null;
  b.onImpactTarget = null;
  return b;
}

function projectile(pos, vel, owner = null) {
  return { pos: pos.clone(), vel: vel.clone(), origin: pos.clone(), alive: true, age: 0, tracer: null, owner };
}

// Snelle granaat eindigt voorbij het schip, maar moet onderweg raken.
const victim = { alive: true, root: { position: new Vector3(0, 0, 0) } };
const bShip = makeBallistics({ targets: [{ ship: victim, radius: 5 }] });
let shipHits = 0;
bShip.onImpactShip = (shipHit, pos) => { equal(shipHit, victim, 'juiste schip geraakt'); check(pos.x <= -4.9, 'impact ligt op voorzijde scheepsbol'); shipHits++; };
bShip.projectiles.push(projectile(new Vector3(-100, 0, 0), new Vector3(1000, 0, 0)));
bShip.update(0.2);
equal(shipHits, 1, 'swept projectiel raakt schip exact éénmaal');
equal(bShip.projectiles.length, 0, 'geraakt projectiel wordt direct opgeruimd');

// Direct doel ligt vóór de terreinwand. Alleen het eerste fysieke contact mag afgaan.
const directRegistry = new TargetRegistry({});
const directTarget = { alive: true, state: 'unknown', radius: 3, visibilityHeight: 0, root: { position: new Vector3(-5, 10, 0) } };
directRegistry.add(directTarget);
const hill = {
  bakeStats: { meterPerTexel: 8 },
  sample(x) { return Math.abs(x) < 6 ? 20 : 0; },
};
const bPriority = makeBallistics({ registry: directRegistry, terrain: hill });
let targetHits = 0, groundHits = 0;
bPriority.onImpactTarget = target => { equal(target, directTarget, 'vroegste doel wordt gekozen'); targetHits++; };
bPriority.onImpactGround = () => { groundHits++; };
bPriority.projectiles.push(projectile(new Vector3(-20, 10, 0), new Vector3(200, 0, 0)));
bPriority.update(0.2);
equal(targetHits, 1, 'direct doel krijgt één impact');
equal(groundHits, 0, 'latere terreinimpact wordt niet óók uitgevoerd');

// Een hoogtepie k midden tussen twee frames wordt gevonden, ook als beide eindpunten vrij zijn.
const bTerrain = makeBallistics({ terrain: hill });
let terrainHits = 0;
bTerrain.onImpactGround = pos => { check(Math.abs(pos.x) <= 6.2, 'terreintreffer ligt op de hoogtewand'); terrainHits++; };
bTerrain.projectiles.push(projectile(new Vector3(-20, 10, 0), new Vector3(200, 0, 0)));
bTerrain.update(0.2);
equal(terrainHits, 1, 'heightfield-sweep vindt midden-frame terrein');
equal(bTerrain.projectiles.length, 0, 'terreinprojectiel wordt opgeruimd');

// Wateroppervlak wordt eveneens gesweept.
const bWater = makeBallistics({ water: 0 });
let waterHits = 0;
bWater.onImpactWater = pos => { near(pos.y, 0, 1e-9, 'waterimpact wordt op waterhoogte gezet'); waterHits++; };
bWater.projectiles.push(projectile(new Vector3(0, 10, 0), new Vector3(0, -100, 0)));
bWater.update(0.2);
equal(waterHits, 1, 'dalend projectiel kruist water exact éénmaal');

// Integratiehandtekeningen tegen regressie.
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const shipSrc = fs.readFileSync(path.join(root, 'src/game/ship.js'), 'utf8');
const ballisticsSrc = fs.readFileSync(path.join(root, 'src/game/ballistics.js'), 'utf8');
const directorSrc = fs.readFileSync(path.join(root, 'src/game/matchDirector.js'), 'utf8');
check(main.includes('new WorldCollision(island'), 'main koppelt de fysieke wereld');
check(main.includes('playerShip.setNavigationCollision(worldCollision)'), 'schip ontvangt de navigatiecollision');
check(shipSrc.includes('resolveShipMove'), 'scheepsbeweging loopt via swept resolver');
check(ballisticsSrc.includes('hitTestSegment') && ballisticsSrc.includes('_findSurfaceImpact'), 'ballistiek gebruikt swept doelen en oppervlakken');
check(directorSrc.includes("'wereldcollision'"), 'missiereset wist collisionstatus');

console.log(`Phase 3 regression tests: ${passed} assertions passed.`);
