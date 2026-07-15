import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
let passed = 0;
const check = (v, m) => { assert.ok(v, m); passed++; };
const equal = (a, b, m) => { assert.equal(a, b, m); passed++; };
const near = (a, b, e, m) => { assert.ok(Math.abs(a-b) <= e, `${m}: ${a} != ${b}`); passed++; };

class Vector3 {
  constructor(x=0,y=0,z=0){ this.x=x; this.y=y; this.z=z; }
  set(x,y,z){ this.x=x; this.y=y; this.z=z; return this; }
  setAll(v){ return this.set(v,v,v); }
  copyFrom(v){ return this.set(v.x,v.y,v.z); }
  clone(){ return new Vector3(this.x,this.y,this.z); }
  scaleInPlace(v){ this.x*=v; this.y*=v; this.z*=v; return this; }
  normalize(){ const l=Math.hypot(this.x,this.y,this.z)||1; return this.scaleInPlace(1/l); }
  static TransformCoordinatesFromFloatsToRef(x,y,z,_m,out){ out.set(x,y,z); }
}
class TransformNode {
  constructor(name){ this.name=name; this.position=new Vector3(); this.rotation=new Vector3(); this.scaling=new Vector3(1,1,1); this.enabled=true; this._disposed=false; this.parent=null; }
  setEnabled(v){ this.enabled=v; }
  dispose(){ this._disposed=true; }
  isDisposed(){ return this._disposed; }
}
function mesh(name){ return { name, position:new Vector3(), rotation:new Vector3(), parent:null, material:null, isPickable:true, isVisible:true, dispose(){}, getWorldMatrix(){return{};}, computeWorldMatrix(){} }; }
class StandardMaterial { constructor(name){this.name=name;} }
class Color3 { constructor(r=0,g=0,b=0){this.r=r;this.g=g;this.b=b;} }

globalThis.BABYLON = {
  Vector3, TransformNode, StandardMaterial, Color3,
  MeshBuilder:{ CreateBox:n=>mesh(n), CreateCylinder:n=>mesh(n) },
};

const { Emplacement, EMPLACEMENT_PROFILES } = await import('../src/game/emplacement.js');
const { TargetRegistry } = await import('../src/game/targetRegistry.js');
const { DefenseNetwork, DIFFICULTY_PROFILES } = await import('../src/game/defenseNetwork.js');
const { CombatController } = await import('../src/game/combatController.js');

const scene = {};
const battery = new Emplacement(scene, 'battery', { id:'B1', pos:new Vector3(0,0,0) });
const bunker = new Emplacement(scene, 'bunker', { id:'K1', pos:new Vector3(100,0,0) });
const radar = new Emplacement(scene, 'radar', { id:'R1', pos:new Vector3(200,0,0) });
const depot = new Emplacement(scene, 'depot', { id:'D1', pos:new Vector3(300,0,0) });

equal(battery.maxHp, 110, 'batterij gebruikt profiel-hp');
equal(bunker.maxHp, 150, 'bunker gebruikt hogere profiel-hp');
equal(radar.maxHp, 70, 'radar is relatief kwetsbaar');
equal(depot.maxHp, 90, 'depot gebruikt profiel-hp');
equal(battery.fireInterval, 4.8, 'batterij heeft eigen herlaadtijd');
check(battery.root.enabled, 'onbekende batterijroot blijft actief voor AI-mondingsmatrix');
check(battery._meshes.every(m => m.isVisible === false), 'onbekende batterij blijft visueel verborgen');
battery.spot();
check(battery._meshes.every(m => m.isVisible === true), 'spotting maakt alle batterijmeshes zichtbaar');

bunker.damage(100);
near(bunker.hp, 85, 1e-9, 'bunker reduceert explosieschade met profielmultiplicator');

equal(battery.aimAt(new Vector3(100,0,0), 1, Math.PI/4, 0.001), false, 'kanon kan niet instant 90 graden draaien');
near(battery._gunYaw.rotation.y, Math.PI/4, 1e-9, 'eerste richtstap respecteert draaisnelheid');
equal(battery.aimAt(new Vector3(100,0,0), 1, Math.PI/4, 0.001), true, 'kanon bereikt doel na voldoende richttijd');

battery.clearContact();
equal(battery.setContact(0, 'radar', 8, new Vector3(2500,0,0)), true, 'eerste radarcontact alarmeert batterij');
equal(battery.alertSince, 0, 'reactietijd start op eerste contact');
battery.expireContact(1);
equal(battery.contactSource, 'memory', 'contact gaat na sensorsample over in geheugen');
check(battery.hasContact(7), 'contactgeheugen blijft tijdelijk geldig');
battery.expireContact(9);
equal(battery.contactSource, 'none', 'contactgeheugen verloopt volledig');

const spottedRegistry = new TargetRegistry(scene);
const spottedRadar = new Emplacement(scene, 'radar', { id:'RS', pos:new Vector3() });
spottedRegistry.add(spottedRadar);
let spottedEvents = 0;
spottedRegistry.onSpotted = (e, source) => { equal(e, spottedRadar, 'spottingevent geeft juiste doel'); equal(source, 'zichtlijn', 'spottingevent bewaart bron'); spottedEvents++; };
equal(spottedRegistry.spot(spottedRadar, 'zichtlijn'), true, 'registry spot onbekend doel');
equal(spottedRegistry.spot(spottedRadar, 'zichtlijn'), false, 'registry vuurt spottingevent niet dubbel');
equal(spottedEvents, 1, 'exact één spottingevent');

const objectiveRegistry = new TargetRegistry(scene);
const objective = new Emplacement(scene, 'radar', { id:'OBJ', pos:new Vector3(), hp:10 });
const decor = new Emplacement(scene, 'bunker', { id:'DEC', pos:new Vector3(500,0,0), objective:false });
objectiveRegistry.add(objective); objectiveRegistry.add(decor);
equal(objectiveRegistry.objectiveCount, 1, 'niet-objectief telt niet mee voor missie');
let completed = 0; objectiveRegistry.onObjectiveComplete = () => completed++;
objectiveRegistry.applyBlast(new Vector3(0, objective.visibilityHeight, 0), 100, 50);
equal(completed, 1, 'missie voltooit zodra laatste objectief uitgeschakeld is');
equal(objectiveRegistry.objectiveRemaining, 0, 'objectiefteller bereikt nul');
objectiveRegistry.applyBlast(new Vector3(0, objective.visibilityHeight, 0), 100, 50);
equal(completed, 1, 'objectiefcallback wordt niet herhaald');

const netRegistry = new TargetRegistry(scene);
const netBattery = new Emplacement(scene, 'battery', { id:'NB', pos:new Vector3(0,0,0), turnRate:100, aimTolerance:Math.PI });
const netRadar = new Emplacement(scene, 'radar', { id:'NR', pos:new Vector3(200,0,0) });
const netDepot = new Emplacement(scene, 'depot', { id:'ND', pos:new Vector3(300,0,0) });
netRegistry.add(netBattery); netRegistry.add(netRadar); netRegistry.add(netDepot);
const clearIsland = { hasLineOfSight(){ return true; } };
const player = { alive:true, heading:0, speed:0, root:new TransformNode('player') };
player.root.position.set(2500,0,0);
const network = new DefenseNetwork(netRegistry, clearIsland, { difficulty:'normal', sensorInterval:0.1, contactMemory:8 });
network.update(0, player);
equal(netBattery.contactSource, 'radar', 'radar geeft batterij contact buiten visueel bereik');
let control = network.getFireControl(netBattery, 0);
equal(control.canEngage, false, 'batterij respecteert reactietijd');
control = network.getFireControl(netBattery, 2);
equal(control.canEngage, true, 'radarcontact is na reactietijd inzetbaar');
near(control.fireInterval, 4.8, 1e-9, 'levend depot houdt normale herlaadtijd');

netDepot.damage(1000); network.refreshStatus();
control = network.getFireControl(netBattery, 2);
near(control.fireInterval, 4.8 * 1.55, 1e-9, 'vernietigd depot vertraagt alle batterijen');
netRadar.damage(1000);
network.update(2.2, player);
equal(netBattery.contactSource, 'memory', 'na radarverlies blijft alleen tijdelijk contactgeheugen over');
check(network.getFireControl(netBattery, 2.2).spreadMrad > 11, 'geheugenvuur is aantoonbaar onnauwkeuriger');
network.update(10.5, player);
equal(netBattery.contactSource, 'none', 'zonder radar of zicht vervalt vijandelijk contact');

const blockedRegistry = new TargetRegistry(scene);
const blockedBattery = new Emplacement(scene, 'battery', { id:'BB', pos:new Vector3() });
const blockedRadar = new Emplacement(scene, 'radar', { id:'BR', pos:new Vector3(100,0,0) });
blockedRegistry.add(blockedBattery); blockedRegistry.add(blockedRadar);
const blockedNetwork = new DefenseNetwork(blockedRegistry, { hasLineOfSight(){return false;} }, { sensorInterval:0.1 });
blockedNetwork.update(0, player);
equal(blockedBattery.contactSource, 'none', 'terrein blokkeert zowel radar- als visueel contact');

const hardNetwork = new DefenseNetwork(netRegistry, clearIsland, { difficulty:'hard' });
equal(hardNetwork.difficulty, DIFFICULTY_PROFILES.hard, 'moeilijkheid komt uit centrale profielen');
check(DIFFICULTY_PROFILES.hard.spreadMultiplier < DIFFICULTY_PROFILES.normal.spreadMultiplier, 'hard maakt vijand nauwkeuriger');
check(DIFFICULTY_PROFILES.hard.reloadMultiplier < DIFFICULTY_PROFILES.normal.reloadMultiplier, 'hard laat vijand sneller herladen');

// Combat gebruikt netwerkcontact en vuurt niet omdat de speler het doel al dan niet heeft gespot.
const fireRegistry = new TargetRegistry(scene);
const fireBattery = new Emplacement(scene, 'battery', {
  id:'FB', pos:new Vector3(), reactionTime:0, turnRate:100, aimTolerance:Math.PI,
  fireInterval:1, spreadMrad:0, engageRange:3200,
});
const fireRadar = new Emplacement(scene, 'radar', { id:'FR', pos:new Vector3(100,0,0) });
fireRegistry.add(fireBattery); fireRegistry.add(fireRadar);
const fireNetwork = new DefenseNetwork(fireRegistry, clearIsland, { sensorInterval:0.1 });
const closePlayer = { alive:true, heading:0, speed:0, root:new TransformNode('closePlayer') };
closePlayer.root.position.set(500,0,0);
fireNetwork.update(0, closePlayer);
const cfg = { enemyFireInterval:4.8, engageRange:3200, muzzleVelocity:300, enemySpreadMrad:12, fireCooldown:8 };
const combat = new CombatController(cfg, {}); combat.setDefenseNetwork(fireNetwork);
let fired = 0;
const ballistics = { fire(){ fired++; } };
equal(fireBattery.state, 'unknown', 'AI-testbatterij is niet door speler gespot');
equal(combat.enemyFire(0.1, 0, fireBattery, closePlayer, ballistics, null), true, 'onbekende batterij vuurt met eigen geldig contact');
equal(fired, 1, 'netwerkgestuurd schot wordt éénmaal aangemaakt');
equal(combat.enemyFire(0.1, 0.5, fireBattery, closePlayer, ballistics, null), false, 'batterij respecteert eigen cooldown');
fireBattery.clearContact();
equal(combat.enemyFire(0.1, 2, fireBattery, closePlayer, ballistics, null), false, 'batterij vuurt nooit zonder contact');

// Scatter gebruikt typeprofielen in plaats van generieke hp=100.
const scatterRegistry = new TargetRegistry(scene);
const fakeIsland = { root:{position:new Vector3()}, hitRadius:3000, bounds(){return{x0:-2000,z0:-2000,span:4000};}, sample(){return 20;} };
equal(scatterRegistry.scatter(fakeIsland, { count:4, minDist:50, mix:['battery','bunker','radar','depot'] }), 4, 'scatter plaatst alle profieltypen');
equal(scatterRegistry.list[0].maxHp, EMPLACEMENT_PROFILES.battery.hp, 'scatter behoudt batterijprofiel-hp');
equal(scatterRegistry.list[1].maxHp, EMPLACEMENT_PROFILES.bunker.hp, 'scatter behoudt bunkerprofiel-hp');

const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const director = fs.readFileSync(path.join(root, 'src/game/matchDirector.js'), 'utf8');
check(main.includes("new DefenseNetwork(registry, island"), 'main maakt één verdedigingsnetwerk');
check(main.includes('defenseNetwork.update(simTime, playerShip)'), 'hoofdloop werkt vijandelijke sensoren bij');
check(!main.includes("emp.state === 'spotted' || matchDirector.autoSpot"), 'vijandelijk vuur is niet meer gekoppeld aan speler-spotting');
check(main.includes('combatController.enemyFire(cdt, simTime'), 'AI ontvangt frame-dt voor draaisnelheid');
check(director.includes("'verdedigingsnetwerk'"), 'missiereset wist vijandelijk contact');

console.log(`Phase 4 regression tests: ${passed} assertions passed.`);
