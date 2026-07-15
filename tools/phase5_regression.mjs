import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
let passed = 0;
const check = (v, m) => { assert.ok(v, m); passed++; };
const equal = (a, b, m) => { assert.equal(a, b, m); passed++; };
const near = (a, b, e, m) => { assert.ok(Math.abs(a - b) <= e, `${m}: ${a} != ${b}`); passed++; };

const { createPerformanceProfile, calculateRenderResolution } = await import('../src/core/performanceProfile.js');
const mobileEnv = {
  innerWidth: 384,
  innerHeight: 694,
  devicePixelRatio: 3.75,
  navigator: { userAgent: 'Mozilla/5.0 Android Mobile', deviceMemory: 8, hardwareConcurrency: 8 },
};
const profile = createPerformanceProfile(mobileEnv);
equal(profile.id, 'mobile-balanced', 'Android kiest mobiel profiel');
equal(profile.wakeResolution, 256, 'mobiele wake is 256px');
equal(profile.wakeUpdateHz, 20, 'mobiele wake draait 20Hz');
equal(profile.oceanRings, 80, 'mobiele oceaan gebruikt 80 ringen');
equal(profile.oceanSegments, 192, 'mobiele oceaan gebruikt 192 segmenten');
equal(profile.bloomSamples, 8, 'mobiele bloom gebruikt acht samples');
const resolution = calculateRenderResolution(profile, mobileEnv);
near(resolution.pixelRatio, 1.65, 1e-9, 'pixelratio wordt expliciet begrensd');
near(resolution.nativeFraction, 0.44, 1e-9, 'renderfractie is 44 procent van fysiek');
equal(resolution.renderWidth, 634, 'verwachte mobiele renderbreedte');
equal(resolution.renderHeight, 1145, 'verwachte mobiele renderhoogte');
near(resolution.hardwareScaling, 1 / 1.65, 1e-9, 'Babylon hardware scaling is inverse pixelratio');
const lowDprResolution = calculateRenderResolution(profile, { innerWidth:800, innerHeight:600, devicePixelRatio:1 });
equal(lowDprResolution.pixelRatio, 1, 'profiel supersamplet nooit boven fysieke DPR');

const desktop = createPerformanceProfile({ innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1, navigator: { userAgent: 'Desktop', deviceMemory: 16, hardwareConcurrency: 12 } });
equal(desktop.id, 'desktop-high', 'desktop behoudt hoog profiel');
equal(desktop.postProcessRatio, 1, 'desktop postprocess blijft native');

class Vector2 { constructor(x=0,y=0){this.x=x;this.y=y;} set(x,y){this.x=x;this.y=y;return this;} }
class RawTexture {
  constructor(data, width, height){ this.data=data; this.width=width; this.height=height; this.updateCount=0; this.disposed=false; }
  update(data){ this.data=data; this.updateCount++; }
  dispose(){ this.disposed=true; }
}
globalThis.BABYLON = {
  Vector2,
  RawTexture,
  Constants: {
    TEXTUREFORMAT_RG: 1,
    TEXTURE_BILINEAR_SAMPLINGMODE: 2,
    TEXTURETYPE_UNSIGNED_BYTE: 3,
  },
  Mesh: {},
};
const { WakeManager } = await import('../src/ocean/wakeManager.js');
const mat = { setTexture(){}, setVector2(){}, setFloat(){} };
const wake = new WakeManager({}, { mat }, {
  wakeResolution: 256, wakeUpdateHz: 20, wakeMaxParts: 48, wakeMaxInterpolationStamps: 24,
  wakeStrength: 0.8, wakeFlatten: 0.8, wakeMinSpeed: 1, wakeTau: 4.5,
});
equal(wake.data.byteLength, 256 * 256 * 2, 'wakebuffer is viermaal kleiner dan 512px');
const ship = { alive:true, speed:5, length:150, beam:18, heading:0, root:{position:{x:0,z:0}}, _wakeParts:[] };
wake.update(1/60, ship, null);
wake.update(1/60, ship, null);
equal(wake.performanceStats.uploads, 0, 'wake uploadt niet iedere renderframe');
wake.update(1/60, ship, null);
equal(wake.performanceStats.uploads, 1, 'wake uploadt na vaste 20Hz-periode');
equal(wake.performanceStats.bytesPerUpload, 131072, 'wake uploadgrootte klopt');
const beforePause = wake.performanceStats.uploads;
wake.update(0, ship, null);
equal(wake.performanceStats.uploads, beforePause, 'pauze veroorzaakt geen wake-upload');
wake.reset(ship, null);
equal(wake.performanceStats.uploads, beforePause + 1, 'reset uploadt eenmaal een lege map');

class FakeMaterial { constructor(name, bad=false){ this.name=name; this.bad=bad; this.frozen=0; } freeze(){ this.frozen++; } }
class FakeMesh {
  constructor(name, material, vertices=100){ this.name=name; this.material=material; this.vertices=vertices; this.isVisible=true; this.visibility=1; this.renderingGroupId=0; this.parent=null; this.disposed=false; }
  getTotalVertices(){ return this.disposed ? 0 : this.vertices; }
  getChildMeshes(){ return []; }
  computeWorldMatrix(){}
  dispose(){ this.disposed=true; }
  isDisposed(){ return this.disposed; }
}
BABYLON.Mesh.MergeMeshes = (group) => {
  if (group[0].material.bad) throw new Error('synthetische mergefout');
  return new FakeMesh('merged', group[0].material, group.reduce((n,m)=>n+m.vertices,0));
};
const { mergeStaticMeshesByMaterial } = await import('../src/core/meshOptimizer.js');
const good = new FakeMaterial('good');
const bad = new FakeMaterial('bad', true);
const meshes = [new FakeMesh('a',good), new FakeMesh('b',good), new FakeMesh('c',bad), new FakeMesh('d',bad)];
const optimized = mergeStaticMeshesByMaterial(meshes, { enabled:true, holder:{}, freezeMaterials:true, maxVerticesPerMerge:1000 });
equal(optimized.stats.sourceMeshes, 4, 'optimizer telt bronmeshes');
equal(optimized.stats.mergedGroups, 1, 'geldige materiaalgroep wordt samengevoegd');
equal(optimized.stats.failedGroups, 1, 'mislukte groep wordt geregistreerd');
equal(optimized.meshes.length, 3, 'rollback bewaart bronmeshes van mislukte groep');
check(meshes[0].disposed && meshes[1].disposed, 'alleen succesvol samengevoegde bronnen worden verwijderd');
check(!meshes[2].disposed && !meshes[3].disposed, 'mislukte merge verwijdert geen brongeometrie');
check(good.frozen === 1 && bad.frozen === 1, 'statische materialen worden bevroren');

function glbJson(file) {
  const b = fs.readFileSync(file);
  equal(b.toString('ascii', 0, 4), 'glTF', `${path.basename(file)} heeft GLB-header`);
  let off = 12;
  while (off + 8 <= b.length) {
    const len = b.readUInt32LE(off); const type = b.readUInt32LE(off + 4); off += 8;
    if (type === 0x4e4f534a) return JSON.parse(b.subarray(off, off + len).toString('utf8').replace(/[\0 ]+$/g, ''));
    off += len;
  }
  throw new Error('JSON-chunk ontbreekt');
}
const shipGlb = glbJson(path.join(root, 'models/Schip1.glb'));
const islandGlb = glbJson(path.join(root, 'models/land/ocean_rocky_island.glb'));
equal(shipGlb.meshes.length, 474, 'scheepsasset bevat 474 bronmeshes');
equal(shipGlb.materials.length, 84, 'scheepsasset bevat 84 materialen');
equal((shipGlb.animations || []).length, 0, 'scheepsasset heeft geen animaties die merge blokkeren');
equal((shipGlb.skins || []).length, 0, 'scheepsasset heeft geen skins die merge blokkeren');
equal(islandGlb.meshes.length, 14, 'eilandasset bevat 14 bronmeshes');
equal(islandGlb.materials.length, 2, 'eilandasset bevat twee materialen');

function estimatedMergedMeshCount(glb, maxVertices, protectedPattern = null) {
  const namesByMesh = new Map();
  const parentByNode = new Map();
  for (let i = 0; i < (glb.nodes || []).length; i++) {
    const node = glb.nodes[i];
    for (const child of node.children || []) parentByNode.set(child, i);
    if (node.mesh !== undefined) {
      if (!namesByMesh.has(node.mesh)) namesByMesh.set(node.mesh, []);
      namesByMesh.get(node.mesh).push(i);
    }
  }
  const groups = new Map(); let passthrough = 0;
  for (let mi = 0; mi < glb.meshes.length; mi++) {
    const primitive = glb.meshes[mi].primitives[0];
    let protectedMesh = false;
    if (protectedPattern) {
      for (const start of namesByMesh.get(mi) || []) {
        let n = start;
        while (n !== undefined) {
          if (protectedPattern.test(glb.nodes[n].name || '')) { protectedMesh = true; break; }
          n = parentByNode.get(n);
        }
        if (protectedMesh) break;
      }
    }
    if (primitive.material === undefined || protectedMesh) { passthrough++; continue; }
    const vertices = glb.accessors[primitive.attributes.POSITION].count;
    if (!groups.has(primitive.material)) groups.set(primitive.material, []);
    groups.get(primitive.material).push(vertices);
  }
  let result = passthrough;
  for (const values of groups.values()) {
    let count = 0, vertices = 0;
    for (const v of values) {
      if (count && vertices + v > maxVertices) { result++; count = 0; vertices = 0; }
      count++; vertices += v;
    }
    if (count) result++;
  }
  return result;
}
const protectedShipPart = /(?:koepel|turret|gun[_ -]?(?:mount|yaw|elev)|barbette)/i;
equal(estimatedMergedMeshCount(shipGlb, profile.maxMergeVertices, protectedShipPart), 85, 'huidige scheepsasset heeft verwacht budget van 85 meshes');
equal(estimatedMergedMeshCount(islandGlb, profile.maxMergeVertices), 5, 'huidige eilandasset heeft verwacht budget van vijf meshes');

const oldOceanVerts = 1 + 96 * 256;
const newOceanVerts = 1 + profile.oceanRings * profile.oceanSegments;
equal(newOceanVerts, 15361, 'mobiele oceaanvertexbudget klopt');
check(newOceanVerts / oldOceanVerts < 0.63, 'oceaangeometrie daalt met meer dan 37 procent');
const oldWakeBytesPerSec = 512 * 512 * 2 * 60;
const newWakeBytesPerSec = profile.wakeResolution * profile.wakeResolution * 2 * profile.wakeUpdateHz;
check(oldWakeBytesPerSec / newWakeBytesPerSec >= 12, 'wake CPU/uploadbudget daalt minstens factor twaalf');

const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'src/core/engine.js'), 'utf8');
const heat = fs.readFileSync(path.join(root, 'src/environment/heatFx.js'), 'utf8');
const telemetry = fs.readFileSync(path.join(root, 'src/core/telemetry.js'), 'utf8');
const islandSource = fs.readFileSync(path.join(root, 'src/game/islandTarget.js'), 'utf8');
check(/M(?:6\.6\.0 mobiele-performance|7\.0\.0 level1-bruggenhoofd)/.test(main), 'mobiele-performancebasis blijft aanwezig in huidige build');
check(main.includes('depthMap.renderList = depthRenderList'), 'depthprepass heeft expliciete renderlijst');
check(main.includes('syncDepthRenderList()'), 'dieptelijst wordt na GLB-load gesynchroniseerd');
check(main.includes('maxMergeVertices: PERF.maxMergeVertices'), 'runtime merge heeft geheugengrens');
check(main.includes('const UI_STEP = 1 / PERF.uiUpdateHz'), 'mobiele HUD en markers hebben vast updatebudget');
check(engine.match(/adaptToDeviceRatio:\s*false/g)?.length === 2, 'WebGPU en WebGL gebruiken expliciete device ratio');
check(heat.includes('this.ratio'), 'postprocess gebruikt profielratio');
check(heat.includes('this.bloomSamples'), 'bloom samplebudget is configureerbaar');
check(telemetry.includes('engine._drawCalls'), 'telemetrie rapporteert echte drawcalls in plaats van indexaantal');
check(islandSource.indexOf('const sourceBounds') < islandSource.indexOf('mergeStaticMeshesByMaterial(this._pickables'), 'eilandbounds worden vastgelegd voordat lege GLB-root wordt opgeruimd');

console.log(`Phase 5 regression tests: ${passed} assertions passed.`);
