// src/main.js
//
// M6.5 - Tactische doeltypen en vijandelijk verdedigingsnetwerk.
// Behoudt de fysieke wereld uit M6.4 en voegt onafhankelijke vijanddetectie, typeprofielen,
// batterijvuurleiding, tactische spottingfeedback en expliciete missieobjectieven toe.

import { boot } from './core/engine.js';
import { pushLog, updateDebugStats, stats, Debug, toggleHud, hudEnabled } from './core/debug.js';
import { setupBtn, joyState, altState } from './input/controls.js';
import { WavesSettings } from './ocean/wavesSettings.js';
import { WavesGenerator } from './ocean/wavesGenerator.js';
import { buildOcean } from './ocean/oceanMaterial.js';
import { WakeManager } from './ocean/wakeManager.js';
import { PRESETS } from './ocean/presets.js';
import { SwellField } from './game/swellField.js';
import { Ship } from './game/ship.js';
import { WorldCollision } from './game/worldCollision.js';
import { IslandTarget } from './game/islandTarget.js';
import { ChaseCamera } from './game/chaseCamera.js';
import { Ballistics, maxRange } from './game/ballistics.js';
import { TargetRegistry } from './game/targetRegistry.js';
import { BattleAmbience } from './game/battleAmbience.js';
import { AtlasFX } from './game/atlasFx.js';
import { HUD } from './game/hud.js';
import { MarkerLayer } from './ui/markerLayer.js';
import { Menu } from './game/menu.js';
import { TurretRig } from './game/turretRig.js';
import { Squadron } from './game/squadron.js';
import { FreeCam } from './game/freeCam.js';
import { Sfx } from './core/sfx.js';
import { CombatController } from './game/combatController.js';
import { DefenseNetwork } from './game/defenseNetwork.js';
import { MatchDirector } from './game/matchDirector.js';
import { OverlayUI } from './ui/overlayUI.js';
import { DevPanel } from './ui/devPanel.js';
import { SkyRig } from './environment/skyRig.js';
import { HeatFx } from './environment/heatFx.js';
import { TrajectoryRenderer } from './game/trajectoryRenderer.js';
import { Telemetry } from './core/telemetry.js';
import { createPerformanceProfile, applyRenderResolution } from './core/performanceProfile.js';
import { SunSweepTool } from './core/sunSweepTool.js';
import { SmokeSweepTool } from './core/smokeSweepTool.js';
import { buildWreck } from './game/wreckDecor.js';
import { buildMegaPlume } from './environment/megaPlume.js';

export const BUILD = 'M6.6.0 mobiele-performance';

const FFT_SIZE = 128;
const SIM_HZ = 30;
const PERF = createPerformanceProfile();

const MUZZLE_VELOCITY = 300;

const CFG = {
  shipHp:            100,
  shipDamagePerHit:  3.2,     

  shellDamage:       34,      
  blastRadius:       45,      
                              
  targetCount:       14,
  targetSeed:        1337,
  targetMinDist:     260,     

  roundsPerTurret:   3,
  burstGap:          0.18,    
  turretGap:         0.12,    
  fireCooldown:      8.0,     

  muzzleVelocity:    MUZZLE_VELOCITY,
  playerSpreadMrad:  3.5,
  enemySpreadMrad:   12,
  aimReadyRad:       0.008,

  enemyFireInterval: 4.8,
  enemyDifficulty:   'normal',
  enemySensorInterval: 0.30,
  enemyRadarRange:   3800,
  enemyContactMemory: 8,

  engageRange:       3200,

  aimSpeed:          320,    
  aimMinRange:       300,
  aimMaxRange:       maxRange(MUZZLE_VELOCITY) * 0.92,

  camStyle:          'doel',   
  aiThrottle:        0.5,
  aiRudderAmp:       0.5,
  aiRudderRate:      0.15,

  contactFoam:       1.0,
  contactWidth:      6.0,
  wakeStrength:      0.8,
  wakeFlatten:       0.8,
  wakeMinSpeed:      1.0,
  wakeTau:           4.5,
  wakeResolution:    PERF.wakeResolution,
  wakeUpdateHz:      PERF.wakeUpdateHz,
  wakeMaxParts:      PERF.wakeMaxParts,
  wakeMaxInterpolationStamps: PERF.wakeMaxInterpolationStamps,

  collisionUnderKeel: 1.5,
  collisionSweepStep: 6,
  missionMinX:       -2200,
  missionMaxX:        6800,
  missionMinZ:       -4300,
  missionMaxZ:        4300,
};

Telemetry.init({ build: BUILD, cfg: CFG });
Telemetry.bind({ Debug, joyState, altState, matchDirector: null });

Debug.pushLog('BUILD', `ZeeBeslag ${BUILD} (v0=${CFG.muzzleVelocity}m/s blast=${CFG.blastRadius}m doelen=${CFG.targetCount})`, false);
Debug.setBuild && Debug.setBuild(BUILD);

const matchDirector = new MatchDirector(CFG);
Telemetry.bind({ matchDirector });

let history=['calm'], historyIndex=0;
try{const s=localStorage.getItem('oceanFFTv7');if(s)history=JSON.parse(s);historyIndex=parseInt(localStorage.getItem('oceanFFTv7Idx')||'0');historyIndex=Math.min(historyIndex,history.length-1);}catch(_){}
function saveState(id){history=history.slice(0,historyIndex+1);history.push(id);historyIndex=history.length-1;try{localStorage.setItem('oceanFFTv7',JSON.stringify(history));localStorage.setItem('oceanFFTv7Idx',String(historyIndex));}catch(_){}}

Debug.setLoading(0, 'WebGPU initialiseren...');

boot().then(async ({ engine, scene, cam, sun, amb, isWebGPU }) => {   

  Debug.attachEngine(engine); Debug.registerScene(scene);
  window.__zbScene = scene;

  let gpuLost = false;
  function haltOnGpuLoss(reason) {
    if (gpuLost) return;
    gpuLost = true;
    try { engine.stopRenderLoop(); } catch (_) {}
    pushLog('WEBGPU', 'device verloren, renderloop gestopt (' + reason + ')', true);
    Debug.fatal(
      new Error('WebGPU device verloren (' + reason + '). De GPU raakte de submit kwijt, ' +
                'meestal door een te zware frame of geheugendruk bij het opstarten.'),
      { title: 'GPU device verloren', phase: 'render', tag: 'WEBGPU' });
  }
  if (engine.onContextLostObservable) engine.onContextLostObservable.add(() => haltOnGpuLoss('onContextLost'));
  try { const _dev = engine._device; if (_dev && _dev.lost) _dev.lost.then(info => haltOnGpuLoss((info && info.reason) || 'device.lost')); } catch (_) {}
  window.__zbHaltOnGpuLoss = haltOnGpuLoss;

  const renderResolution = applyRenderResolution(engine, PERF, window);
  pushLog(
    'PERF',
    `profiel ${PERF.id}: ${renderResolution.renderWidth}x${renderResolution.renderHeight}, ` +
    `${(renderResolution.nativeFraction * 100).toFixed(0)}% fysiek, pixelratio ${renderResolution.pixelRatio.toFixed(2)}`,
    false,
  );

  Debug.setLoading(15, isWebGPU ? 'WebGPU actief' : 'WebGL2 fallback');

  if (!isWebGPU) {
    Debug.fatal(new Error('Geen WebGPU op dit toestel/deze browser. ComputeShader vereist, dus de oceaan can niet laden.'),
      { title:'WebGPU vereist', phase:'engine-init', tag:'ENGINE' });
    return;
  }

  scene.skipPointerMovePicking = true;

  let oceanRig = null, wavesGen = null, wavesSettings = null, wakeManager = null, skyRig = null;
  const swell = new SwellField();
  let playerShip = null, island = null, chaseCam = null, ballistics = null, fx = null, combatController = null;
  let worldCollision = null;
  let registry = null, markers = null, battle = null, defenseNetwork = null;
  let heatFx = null;
  let sunSweep = null;
  let megaPlume = null;
  let rookSweep = null;
  let hud = null, menu = null, turretRig = null, trajectoryRenderer = null;
  let squadron = null, freeCam = null, followSquad = false, _prevMode = null, overlay = null;
  let depthRenderList = [];
  let depthMap = null;

  let aimCursor = null;
  let activeTarget = null;
  const playerAimTarget = new BABYLON.Vector3(CFG.engageRange, 0, 0);

  const _camFwd = new BABYLON.Vector3();
  const _camRight = new BABYLON.Vector3();
  const _hudPos = new BABYLON.Vector3();
  const _spotEye = new BABYLON.Vector3();
  const _spotTarget = new BABYLON.Vector3();
  const _noTarget = { hp: 0, maxHp: 1, alive: false, state: 'unknown', root: { position: new BABYLON.Vector3(CFG.engageRange, 0, 0) } };

  function syncDepthRenderList() {
    if (!depthMap) return;
    const list = [];
    const add = (mesh) => {
      if (!mesh || (mesh.isDisposed && mesh.isDisposed()) || !mesh.getTotalVertices || mesh.getTotalVertices() <= 0) return;
      if (!list.includes(mesh)) list.push(mesh);
    };
    if (playerShip && Array.isArray(playerShip.meshes)) playerShip.meshes.forEach(add);
    if (island && Array.isArray(island._pickables)) island._pickables.forEach(add);
    depthRenderList = list;
    depthMap.renderList = depthRenderList;
  }

  function initGame() {
    playerShip = new Ship(scene, swell, {
      position: new BABYLON.Vector3(0, 0, 0), heading: 0, maxHp: CFG.shipHp,
      optimizeVisualModel: PERF.mergeStaticMeshes,
      freezeStaticMaterials: PERF.freezeStaticMaterials,
      maxMergeVertices: PERF.maxMergeVertices,
    });
    island     = new IslandTarget(scene, { position: new BABYLON.Vector3(CFG.engageRange, 0, 0) });
    worldCollision = new WorldCollision(island, {
      underKeelClearance: CFG.collisionUnderKeel,
      sweepStep: CFG.collisionSweepStep,
      bounds: {
        minX: CFG.missionMinX, maxX: CFG.missionMaxX,
        minZ: CFG.missionMinZ, maxZ: CFG.missionMaxZ,
      },
    });
    playerShip.setNavigationCollision(worldCollision);

    playerShip.addTurret(new BABYLON.Vector3(0, 6.5,  17), { barrel: 6, muzzleY: 1.2 });
    playerShip.addTurret(new BABYLON.Vector3(0, 6.5,   2), { barrel: 6, muzzleY: 1.2 });
    playerShip.addTurret(new BABYLON.Vector3(0, 6.5, -13), { barrel: 6, muzzleY: 1.2 });

    chaseCam = new ChaseCamera(cam, playerShip, { enemy: island, style: CFG.camStyle });
    freeCam = new FreeCam(cam);
    ballistics = new Ballistics(scene, swell);
    combatController = new CombatController(CFG, swell);
    trajectoryRenderer = new TrajectoryRenderer(scene, ballistics, swell);
    registry = new TargetRegistry(scene);
    markers = new MarkerLayer();
    defenseNetwork = new DefenseNetwork(registry, island, {
      difficulty: CFG.enemyDifficulty,
      sensorInterval: CFG.enemySensorInterval,
      radarRange: CFG.enemyRadarRange,
      contactMemory: CFG.enemyContactMemory,
    });
    combatController.setDefenseNetwork(defenseNetwork);

    ballistics.addTarget(playerShip, 32);
    ballistics.setTerrain(island);
    ballistics.setRegistry(registry);

    registry.onSpotted = (emp, source) => {
      const effect = defenseNetwork ? defenseNetwork.tacticalEffectFor(emp) : emp.tacticalHint;
      pushLog('SPOT', `${emp.id} ${emp.label} geïdentificeerd via ${source}. ${effect}`, false);
      if (markers) markers.announce(`${emp.id}  ${emp.label}`, effect, emp.type);
    };
    registry.onDestroyed = (emp) => {
      if (defenseNetwork) defenseNetwork.refreshStatus();
      pushLog('GAME', `${emp.id} ${emp.label} vernietigd  (${registry.objectiveRemaining}/${registry.objectiveCount} objectieven over)`, false);
      if (fx) { _hudPos.copyFrom(emp.root.position); _hudPos.y += 2; fx.emplacementDestroyed(_hudPos.clone()); }
      if (markers && (emp.type === 'radar' || emp.type === 'depot')) {
        const msg = emp.type === 'radar' ? 'VIJANDELIJKE RADAR UITGESCHAKELD' : 'VIJANDELIJKE BEVOORRADING VERSTOORD';
        markers.announce(msg, defenseNetwork ? defenseNetwork.tacticalEffectFor(emp) : '', emp.type);
      }
      if (navigator.vibrate) navigator.vibrate([25, 40, 25]);
    };
    registry.onObjectiveComplete = () => matchDirector.onObjectiveComplete();

    fx = new AtlasFX(scene);   
    fx.setMuzzleChannels(playerShip.turrets.length);
    matchDirector.bind({ fx });

    aimCursor = BABYLON.MeshBuilder.CreateGround('aimCursor', { width: 170, height: 170 }, scene);
    const aimMat = new BABYLON.StandardMaterial('aimMat', scene);
    aimMat.emissiveColor = new BABYLON.Color3(1.0, 0.25, 0.2);
    aimMat.alpha = 0.6;
    aimMat.wireframe = true;
    aimMat.disableLighting = true;
    aimCursor.material = aimMat;
    aimCursor.isPickable = false;
    aimCursor.position.copyFrom(playerAimTarget);

    const aimPole = BABYLON.MeshBuilder.CreateCylinder('aimPole', { height: 130, diameter: 2.4, tessellation: 6 }, scene);
    aimPole.material = aimMat;
    aimPole.isPickable = false;
    aimPole.parent = aimCursor;
    aimPole.position.y = 65;

    matchDirector.bind({ cam, playerShip, enemyShip: island, chaseCam, ballistics, combatController, fx, registry, markers, wakeManager, worldCollision, defenseNetwork });
    matchDirector.placeCinematicCam();

    scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
    scene.fogDensity = 1.6e-4;
    scene.fogColor = new BABYLON.Color3(0.62, 0.75, 0.90);

    function detonate(pos) {
      if (markers) markers.duckAt(pos);   
      if (heatFx) heatFx.pulse(0.9);      
      if (matchDirector.gameOver || matchDirector.mode === 'regie') return;
      
      if (!matchDirector.enemyGodMode) {
        registry.applyBlast(pos, CFG.shellDamage, CFG.blastRadius);
      } else {
        pushLog('BAL', 'Doel onkwetsbaar (Vijand Godmode actief)', false);
      }
    }

    ballistics.onImpactWater  = pos => { fx.waterImpact(pos); };
    ballistics.onImpactGround = pos => { fx.shipShatter(pos); detonate(pos); };
    ballistics.onImpactTarget = (emp, pos) => { fx.shipShatter(pos); detonate(pos); };

    ballistics.onImpactShip = (ship, pos) => {
      if (ship !== playerShip) { fx.shipShatter(pos); return; }
      if (matchDirector.mode === 'regie' || matchDirector.gameOver) return;
      if (matchDirector.playerGodMode) { pushLog('BAL', 'TREFFER op speler geblokkeerd (Speler Godmode)', false); return; }

      const sank = ship.damage(CFG.shipDamagePerHit);
      if (hud) hud.damageFlash();
      pushLog('BAL', `TREFFER op speler (hp ${ship.hp})`, false);
      if (sank) matchDirector.onShipSank(ship);
    };

    pushLog('GAME', 'Artillerie-opstelling geinitialiseerd', false);

    Telemetry.bind({
      engine, scene, cam, playerShip, island, ballistics, combatController, worldCollision, defenseNetwork,
      registry, markers, chaseCam, fx, oceanRig, wakeManager, hud: null,
      getSimTime: () => matchDirector.gameTime,
      getOceanTime: () => oceanTime,
      getAimTarget: () => playerAimTarget,
      performanceProfile: PERF,
      getRenderResolution: () => renderResolution,
      getDepthRenderCount: () => depthRenderList.length,
    });
    Telemetry.instrument();

    playerShip.loadGLB('./models/', 'Schip1.glb')
      .then(r => {
        pushLog(
          'GLB',
          `Schip1.glb geladen: ${r.sourceMeshCount ?? r.meshCount} -> ${r.meshCount} meshes, schaal ${r.modelScale.toFixed(5)}, lengte ${r.modelLength.toFixed(1)}m, ${r.turretsBound} echte turrets gekoppeld`,
          false,
        );
        syncDepthRenderList();
        if (r.optimization) pushLog('PERF', `schip: ${r.optimization.sourceMeshes} -> ${r.optimization.resultMeshes} meshes, ${r.optimization.frozenMaterials} materialen bevroren`, r.optimization.failedGroups > 0);
        if (r.turretsBound === 0) {
          pushLog('RIG', 'Geen benoemde koepelmeshes gevonden; logische turrets op vaste scheepsposities actief', false);
        }
        Telemetry.event('glb', {
          bestand: 'Schip1.glb', meshes: r.meshCount, bronMeshes: r.sourceMeshCount, turrets: r.turretsBound,
          optimalisatie: r.optimization,
          schaal: r.modelScale, lengteM: r.modelLength, hoogteM: r.modelHeight,
        });
        try { turretRig = new TurretRig(scene, playerShip, pushLog, cam); }
        catch (e) { pushLog('RIG', 'turret-rig init faalde', true); }
      })
      .catch(e => { pushLog('GLB', 'Schip1.glb laden mislukt: ' + (e.message || e), true); Telemetry.event('glbFout', { bestand: 'Schip1.glb', msg: String(e.message || e) }); });

    island.loadGLB('./models/land/', 'ocean_rocky_island.glb', {
      optimizeMeshes: PERF.mergeStaticMeshes,
      freezeStaticMaterials: PERF.freezeStaticMaterials,
      maxMergeVertices: PERF.maxMergeVertices,
    })
      .then(r => {
        pushLog('GLB', `eiland geladen: ${r.sourceMeshCount ?? r.meshCount} -> ${r.meshCount} meshes, voetafdruk r=${Math.round(r.hitRadius)}m`, false);
        syncDepthRenderList();
        if (r.optimization) pushLog('PERF', `eiland: ${r.optimization.sourceMeshes} -> ${r.optimization.resultMeshes} meshes`, r.optimization.failedGroups > 0);
        const n = registry.scatter(island, {
          count: CFG.targetCount, seed: CFG.targetSeed, minDist: CFG.targetMinDist,
        });
        if (defenseNetwork) defenseNetwork.refreshStatus();
        const tc = registry.typeCounts();
        pushLog('GAME', `${n} verdedigingswerken geplaatst: ${tc.battery || 0} batterijen, ${tc.radar || 0} radars, ${tc.depot || 0} depots, ${tc.bunker || 0} bunkers`, n < CFG.targetCount);
        
        battle = new BattleAmbience(scene, island, fx, { seed: CFG.targetSeed + 7, registry });
        const sites = battle.build();
        pushLog('GAME', `slagvelddecor: ${sites} stellingen`, sites < 8);
        Telemetry.bind({ battle });
        matchDirector.bind({ battle });

        const wb = island.bounds ? island.bounds() : null;
        const wCenter = wb ? new BABYLON.Vector3(wb.x0 + wb.span * 0.5, 0, wb.z0 + wb.span * 0.5) : null;
        buildWreck({ scene, fx, pushLog, islandCenter: wCenter });
        megaPlume = buildMegaPlume({ scene, islandCenter: wCenter, pushLog });
        matchDirector.bind({ megaPlume });

        squadron = new Squadron(scene, { island });
        matchDirector.bind({ squadron });
        squadron.load()
          .then(() => { pushLog('LUCHT', `eskader geladen uit ${squadron._rootUrl}: ${squadron.planes.length} toestellen`, false); if (overlay) overlay.showFollow(true); })
          .catch(e => pushLog('LUCHT', 'eskader laden mislukt: ' + (e.message || e), true));
      })
      .catch(e => pushLog('GLB', 'eiland laden mislukt: ' + (e.message || e), true));
  }

  function buildMenu() {
    menu = new Menu({
      onPreset: id => applyState(id),
      onUndo:  () => { if (historyIndex > 0) applyState(history[--historyIndex], false); },
      onRedo:  () => { if (historyIndex < history.length - 1) applyState(history[++historyIndex], false); },
      onMode:  m => matchDirector.setMode(m),
      onTime:  s => matchDirector.setTimeScale(s),
      onGod:   () => matchDirector.toggleGodMode(),
      onFilm:  () => matchDirector.toggleFilmLook(),
      onReset: () => matchDirector.resetMatch(),
      onDebugLog: () => toggleHud(),
      onTurretRig: () => { if (turretRig) turretRig.toggle(); },
      onToggleTuner: () => { if (island) island.toggleTuner(); },
      onSpawnMove: (modeOption) => {
        if (!playerShip) return;
        const newPos = new BABYLON.Vector3(0, 0, 0);
        if (modeOption === 'left')  newPos.set(CFG.engageRange * 0.4, 0,  CFG.engageRange * 0.5);
        if (modeOption === 'right') newPos.set(CFG.engageRange * 0.4, 0, -CFG.engageRange * 0.5);

        playerShip.respawn(newPos, 0);
        if (worldCollision) worldCollision.reset();
        playerAimTarget.copyFrom(island ? island.root.position : newPos);
        if (ballistics) ballistics.clear();
      },
      getState: () => ({
        preset: history[historyIndex] || 'calm',
        canUndo: historyIndex > 0,
        canRedo: historyIndex < history.length - 1,
        mode: matchDirector.mode,
        god: matchDirector.playerGodMode,
        timeScale: matchDirector.timeScale,
        film: matchDirector.filmLook,
      }),
    });
  }

  function buildWorld() {
    Debug.setLoading(40, 'Oceaan opbouwen...');
    try {
      oceanRig = buildOcean(scene, engine, null, { rings: PERF.oceanRings, segments: PERF.oceanSegments });
      oceanRig.ocean.alwaysSelectAsActiveMesh = true;
      oceanRig.ocean.doNotSyncBoundingInfo = true;
      oceanRig.ocean.isPickable = false;

      try {
        const dr = scene.enableDepthRenderer(cam, false);
        depthMap = dr.getDepthMap();
        depthMap.renderList = depthRenderList;
        oceanRig.mat.setTexture('uDepthTex', depthMap);
        oceanRig.mat.setFloat('uCamFar', cam.maxZ);
        oceanRig.mat.setFloat('uContactFoam', CFG.contactFoam);
        oceanRig.mat.setFloat('uContactWidth', CFG.contactWidth);
      } catch (e) {}

      try { wakeManager = new WakeManager(scene, oceanRig, CFG); matchDirector.bind({ wakeManager }); } catch (e) {}

      Debug.setRenderViewHandler(m => { if (oceanRig) oceanRig.mat.setFloat('uDebugView', m); });
      wavesSettings = new WavesSettings();
      wavesGen = new WavesGenerator(FFT_SIZE, wavesSettings, engine, { deferInitialBake: true });

      applyState(history[historyIndex] || 'calm', false);
      if (!wavesGen.baked) wavesGen.rebake();

      const c0 = wavesGen.getCascade(0), c1 = wavesGen.getCascade(1), c2 = wavesGen.getCascade(2);
      oceanRig.mat.setTexture('uDisp0', c0.displacement); oceanRig.mat.setTexture('uDisp1', c1.displacement); oceanRig.mat.setTexture('uDisp2', c2.displacement);
      oceanRig.mat.setTexture('uDeriv0', c0.derivatives); oceanRig.mat.setTexture('uDeriv1', c1.derivatives); oceanRig.mat.setTexture('uDeriv2', c2.derivatives);
      oceanRig.mat.setTexture('uTurb0', c0.turbulence); oceanRig.mat.setTexture('uTurb1', c1.turbulence); oceanRig.mat.setTexture('uTurb2', c2.turbulence);
      oceanRig.mat.setFloat('uLen0', wavesGen.lengthScale[0]);
      oceanRig.mat.setFloat('uLen1', wavesGen.lengthScale[1]);
      oceanRig.mat.setFloat('uLen2', wavesGen.lengthScale[2]);

      skyRig = new SkyRig(scene, sun);
      skyRig.build();
      skyRig.applySky(oceanRig);

      window.zbSun = (az, hoogte, intensiteit) => skyRig.setSun(az, hoogte, intensiteit);
      window.zbSunGet = () => skyRig.getSun();
      window.zbLicht = (zon, ibl, ambient) => {
        if (zon != null && sun) sun.intensity = zon;
        if (ibl != null) scene.environmentIntensity = ibl;
        if (ambient != null && amb) amb.intensity = ambient;
        pushLog('SKY', `lichtbalans zon=${sun ? sun.intensity : '-'} ibl=${scene.environmentIntensity} amb=${amb ? amb.intensity : '-'}`, false);
      };
      window.zbSky = (mode) => skyRig.setSkyMode(mode);   

      sunSweep = new SunSweepTool({ engine, scene, cam, skyRig, sun, amb, matchDirector, pushLog });
      window.zbSunSweep = (opties) => sunSweep.run(opties);
      rookSweep = new SmokeSweepTool({ engine, scene, cam, skyRig, sun, amb, matchDirector, pushLog,
                                       smokeCards: () => fx ? fx.smokeCardsRef : null });
      window.zbRookSweep = (opties) => rookSweep.run(opties);

      initGame();
      hud = new HUD();
      buildMenu();

      matchDirector.bind({ hud, menu });
      matchDirector.setMode(matchDirector.mode);

      overlay = new OverlayUI(matchDirector);
      overlay.setFollowHandler(() => {
        followSquad = !followSquad;
        if (freeCam) freeCam.seedFromCam(cam);
        overlay.setFollowActive(followSquad);
        if (followSquad && (!squadron || !squadron.enabled)) {
          pushLog('CAM', 'eskader nog niet geladen, volgt zodra het er is', false);
        } else {
          pushLog('CAM', 'eskader volgen ' + (followSquad ? 'AAN' : 'UIT'), false);
        }
      });

      DevPanel.mount();

      DevPanel.toggle({ id: 'devmode', group: 'SANDBOX', label: 'Dev Modus Actief', get: () => matchDirector.devMode, set: () => matchDirector.toggleSandbox('devMode') });
      DevPanel.toggle({ id: 'godplayer', group: 'SANDBOX', label: 'Speler Godmode', get: () => matchDirector.playerGodMode, set: () => matchDirector.toggleSandbox('playerGodMode') });
      DevPanel.toggle({ id: 'godenemy', group: 'SANDBOX', label: 'Vijand Godmode', get: () => matchDirector.enemyGodMode, set: () => matchDirector.toggleSandbox('enemyGodMode') });
      DevPanel.toggle({ id: 'infammo', group: 'SANDBOX', label: 'Oneindig Munitie', get: () => matchDirector.infiniteAmmo, set: () => matchDirector.toggleSandbox('infiniteAmmo') });
      DevPanel.toggle({ id: 'autospot', group: 'SANDBOX', label: 'Forceer Auto-Spot', get: () => matchDirector.autoSpot, set: () => matchDirector.toggleSandbox('autoSpot') });

      DevPanel.tool({ id: 'tweakreset', group: 'LICHT', label: 'Herstel codedefaults', hint: 'wist onthouden sliders', onTap: () => DevPanel.resetTweaks() });
      DevPanel.toggle({ id: 'zon', group: 'LICHT', label: 'Zon (licht + glinstering)', get: () => skyRig ? skyRig.sunOn : true, set: (v) => skyRig && skyRig.setSunEnabled(v) });
      DevPanel.slider({ id: 'zonlicht', group: 'LICHT', label: 'Zonlicht', min: 0, max: 5, step: 0.1, persist: true, get: () => sun ? sun.intensity : 0, set: (v) => skyRig && skyRig.setLightIntensity(v) });
      DevPanel.slider({ id: 'ibl', group: 'LICHT', label: 'IBL (HDR)', min: 0, max: 1.2, step: 0.05, persist: true, get: () => scene.environmentIntensity, set: (v) => { scene.environmentIntensity = v; } });
      DevPanel.slider({ id: 'ambient', group: 'LICHT', label: 'Ambient', min: 0, max: 3.0, step: 0.05, persist: true, get: () => amb ? amb.intensity : 0, set: (v) => { if (amb) amb.intensity = v; } });
      DevPanel.slider({ id: 'zonaz', group: 'LICHT', label: 'Zon azimut', min: 0, max: 360, step: 5, persist: true, fmt: (v) => Math.round(v) + '\u00b0', get: () => skyRig ? skyRig.azDeg : 0, set: (v) => skyRig && skyRig.setSun(v, skyRig.elDeg, skyRig.intensity) });
      DevPanel.slider({ id: 'zonel', group: 'LICHT', label: 'Zon hoogte', min: 2, max: 88, step: 1, persist: true, fmt: (v) => Math.round(v) + '\u00b0', get: () => skyRig ? skyRig.elDeg : 0, set: (v) => skyRig && skyRig.setSun(skyRig.azDeg, v, skyRig.intensity) });

      DevPanel.toggle({ id: 'film', group: 'WEERGAVE', label: 'WO2 filmlook', get: () => matchDirector.filmLook, set: () => matchDirector.toggleFilmLook() });
      DevPanel.slider({ id: 'damp', group: 'WEERGAVE', label: 'Slagvelddamp', min: 0, max: 2, step: 0.1, persist: true, get: () => fx ? fx.getHazeOpacity() : 1, set: (v) => fx && fx.setHazeOpacity(v) });
      DevPanel.toggle({ id: 'megapluim', group: 'WEERGAVE', label: 'Achtergrondpluim (2 km)', get: () => megaPlume ? megaPlume.enabled : true, set: (v) => megaPlume && megaPlume.setEnabled(v) });

      let foamBias = 2.72, foamScale = 2.4;
      DevPanel.slider({ id: 'schuimdrempel', group: 'WEERGAVE', label: 'Schuimdrempel', min: 1.6, max: 3.4, step: 0.02, persist: true, fmt: (v) => v.toFixed(2), get: () => foamBias, set: (v) => { foamBias = v; if (oceanRig) oceanRig.mat.setFloat('uFoamBias2', v); } });
      DevPanel.slider({ id: 'schuimsterkte', group: 'WEERGAVE', label: 'Schuimsterkte', min: 0.5, max: 6, step: 0.1, persist: true, get: () => foamScale, set: (v) => { foamScale = v; if (oceanRig) oceanRig.mat.setFloat('uFoamScale', v); } });
      DevPanel.toggle({ id: 'lucht', group: 'WEERGAVE', label: 'Blauwe lucht i.p.v. HDR', get: () => skyRig && skyRig.skyMode === 'blauw', set: (v) => skyRig && skyRig.setSkyMode(v ? 'blauw' : 'hdr') });

      DevPanel.toggle({ id: 'decor', group: 'SPEL', label: 'Slagvelddecor', get: () => !!(battle && battle.enabled), set: (v) => battle && battle.setEnabled(v) });

      DevPanel.tool({ id: 'tuner', group: 'PANELEN', label: 'Eiland tuner', hint: 'sleepbaar', onTap: () => island && island.toggleTuner() });
      DevPanel.tool({ id: 'rig', group: 'PANELEN', label: 'Turret rig', hint: 'kalibratie', onTap: () => turretRig && turretRig.toggle() });

      DevPanel.toggle({ id: 'ribbon', group: 'DIAGNOSE', label: 'Perf-ribbon (fps overlay)', get: () => hudEnabled(), set: () => toggleHud() });
      DevPanel.cycle({ id: 'zee', group: 'DIAGNOSE', label: 'Oceaan renderweergave', names: Debug.renderViewNames, get: () => Debug.getRenderView(), set: (i) => Debug.setRenderView(i) });

      DevPanel.sweep({ id: 'zon', group: 'DIAGNOSE', label: 'Zon Sweep (12 standen)', hint: 'atmosfeer + PBR', onTap: () => window.zbSunSweep && window.zbSunSweep() });
      DevPanel.sweep({ id: 'rook', group: 'DIAGNOSE', label: 'Rook Sweep (12 profielen)', hint: 'dekking x karakter', onTap: () => window.zbRookSweep && window.zbRookSweep() });

      DevPanel.exportItem({ id: 'island', group: 'EXPORT', label: 'Eiland-configuratie', hint: 'Voor islandTarget.js', run: () => island && island.exportConfigJSON() });
      DevPanel.exportItem({ id: 'targets', group: 'EXPORT', label: 'Doelen coördinaten', hint: 'Voor TargetRegistry scatter', run: () => registry && registry.exportJSON() });
      DevPanel.exportItem({ id: 'zon', group: 'EXPORT', label: 'Lichtbalans', hint: 'Azimut en PBR instellingen', run: () => {
        const s = skyRig ? skyRig.getSun() : null;
        pushLog('SKY', s ? `zon ${JSON.stringify(s)}` : 'geen skyRig', !s);
        try { if (s) navigator.clipboard.writeText(JSON.stringify(s, null, 2)); } catch (_) {}
      } });
      DevPanel.exportItem({ id: 'telemetry', group: 'EXPORT', label: 'Systeem Telemetrie', hint: 'Inclusief fouten en hardware-limieten', run: () => Telemetry.download() });

      Telemetry.bind({ wavesGen, hud, menu, sunSweep });
      Debug.loadingDone();
    } catch (err) {
      Debug.fatal(err, { title:'Oceaan-init mislukt', phase:'wavesGenerator', tag:'FFT' });
    }
  }
  buildWorld();

  scene.setRenderingAutoClearDepthStencil(1, true, true, false);

  const ipc = scene.imageProcessingConfiguration;
  ipc.applyByPostProcess = false;
  ipc.toneMappingEnabled = true;
  ipc.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
  ipc.contrast = 1.05;
  ipc.exposure = 1.05;
  ipc.vignetteEnabled = true;
  ipc.vignetteWeight = 1.4;

  ipc.colorCurvesEnabled = true;
  const _cc = new BABYLON.ColorCurves();
  _cc.globalSaturation = 90;
  _cc.highlightsHue = 40;  _cc.highlightsSaturation = 16; _cc.highlightsDensity = 55;
  _cc.midtonesHue  = 200;  _cc.midtonesSaturation  = 6;
  _cc.shadowsHue   = 210;  _cc.shadowsSaturation   = 22;  _cc.shadowsDensity   = 50;
  ipc.colorCurves = _cc;

  const pipeline = { imageProcessing: scene.imageProcessingConfiguration };

  try {
    heatFx = new HeatFx(scene, cam, engine, {
      enabled: true,
      amount: 0.0016,          
      bloomThreshold: 0.72,    
      bloomIntensity: 0.55,
      grain: 0.045,
      bandLo: 0.18,            
      bandHi: 0.92,
      ratio: PERF.postProcessRatio,
      bloomSamples: PERF.bloomSamples,
    });
    pushLog('PP', 'HeatFx WGSL-pass actief (shimmer, bloom, grain).', false);
    matchDirector.bind({ heatFx });
  } catch (e) {
    pushLog('PP', 'HeatFx kon niet worden aangemaakt: ' + (e.message || e), true);
  }

  matchDirector.bind({ pipeline });
  matchDirector.applyFilmLook();

  function applyState(id, write=true) {
    const p = PRESETS[id]; if(!p) return;
    if (wavesSettings && wavesGen) {
      wavesSettings.lambda = p.lambda;
      wavesSettings.local.windSpeed = p.windSpeed;
      wavesSettings.local.fetch = p.fetch;
      wavesSettings.local.windDirection = p.windDir;
      wavesSettings.swell.windSpeed = p.windSpeed * 0.7;
      wavesSettings.swell.fetch = p.fetch * 1.6;
      wavesSettings.swell.windDirection = p.windDir + 15;
      wavesGen.rebake();
      swell.setFromPreset(p.windSpeed, p.fetch, p.windDir);
      if (fx) {
        const wr = p.windDir * Math.PI / 180;
        fx.setWind(new BABYLON.Vector3(Math.sin(wr) * p.windSpeed * 0.06, 0, Math.cos(wr) * p.windSpeed * 0.06));
      }
      if (oceanRig && oceanRig.mat && p.foam !== undefined) oceanRig.mat.setFloat('uFoamScale', 2.4 * p.foam);
    }
    if (write) saveState(id);
    if (menu) menu.refresh();
  }

  const sfx = new Sfx();
  sfx.load('fire', './sound/SFX/firemainguns.mp3');
  matchDirector.bind({
    sfx,
    onReset: () => {
      activeTarget = null;
      followSquad = false;
      if (overlay) overlay.setFollowActive(false);
      if (turretRig && typeof turretRig.hide === 'function') turretRig.hide();
      if (trajectoryRenderer && typeof trajectoryRenderer.hide === 'function') trajectoryRenderer.hide();

      joyState.left.x = 0; joyState.left.y = 0;
      joyState.right.x = 0; joyState.right.y = 0;
      altState.up = false; altState.down = false;

      oceanTime = 0;
      simAccum = 0;
      uiAccum = 0;
      if (wavesGen && typeof wavesGen.reset === 'function') wavesGen.reset();

      if (playerShip) {
        playerAimTarget.set(playerShip.root.position.x + CFG.engageRange, 0, playerShip.root.position.z);
        const ground = island ? island.sample(playerAimTarget.x, playerAimTarget.z) : null;
        playerAimTarget.y = ground !== null && ground !== undefined
          ? ground
          : swell.getHeight(playerAimTarget.x, playerAimTarget.z);
      }
      if (aimCursor) {
        aimCursor.position.copyFrom(playerAimTarget);
        aimCursor.setEnabled(true);
      }
    },
  });

  // Alle synchronische systemen zijn nu gekoppeld. Asynchrone modellen mogen later aansluiten;
  // bind() synchroniseert hun tijdschaal direct met de actuele lifecycle-state.
  if (playerShip && combatController && registry) {
    matchDirector.completeLoading();
  } else {
    pushLog('GAME', 'Lifecycle blijft op loading: kernsystemen ontbreken.', true);
  }

  function tryFireSalvo() {
    if (!combatController || !playerShip) { pushLog('VUUR', 'geweigerd: geen schip of vuurleiding', true); return; }
    if (!matchDirector.canAcceptInput()) { pushLog('VUUR', `geweigerd: state=${matchDirector.state}, modus=${matchDirector.mode}`, false); return; }

    if (matchDirector.infiniteAmmo) combatController.lastFireT = -10;

    const nowGame = matchDirector.gameTime;
    const ok = combatController.fireSalvo(nowGame, playerShip);
    if (ok) sfx.play('fire');
    pushLog('VUUR', ok
      ? `salvo: ${playerShip.turrets.length} torens x ${CFG.roundsPerTurret} granaten`
      : `geweigerd: herladen (${Math.max(0, CFG.fireCooldown - (nowGame - combatController.lastFireT)).toFixed(2)}s)`, false);
    if (ok && navigator.vibrate) navigator.vibrate(35);
  }
  setupBtn(document.getElementById('btnFire'), tryFireSalvo);

  function updateAim(dts) {
    const jx = joyState.left.x, jy = joyState.left.y;
    const mag = Math.hypot(jx, jy);

    if (mag > 0.01) {
      _camFwd.copyFrom(cam.getDirection(BABYLON.Axis.Z)); _camFwd.y = 0;
      if (_camFwd.lengthSquared() < 1e-6) _camFwd.set(0, 0, 1);
      _camFwd.normalize();
      _camRight.copyFrom(cam.getDirection(BABYLON.Axis.X)); _camRight.y = 0;
      if (_camRight.lengthSquared() < 1e-6) _camRight.set(1, 0, 0);
      _camRight.normalize();

      const gain = CFG.aimSpeed * Math.pow(Math.min(mag, 1), 1.6) * dts / mag;
      const sx = jx * gain, sf = -jy * gain;
      playerAimTarget.x += _camRight.x * sx + _camFwd.x * sf;
      playerAimTarget.z += _camRight.z * sx + _camFwd.z * sf;
    }

    const p = playerShip.root.position;
    let dx = playerAimTarget.x - p.x, dz = playerAimTarget.z - p.z;
    let d = Math.hypot(dx, dz);
    if (d < 1e-3) { dx = 1; dz = 0; d = 1; }
    const clamped = Math.max(CFG.aimMinRange, Math.min(CFG.aimMaxRange, d));
    if (clamped !== d) {
      playerAimTarget.x = p.x + dx / d * clamped;
      playerAimTarget.z = p.z + dz / d * clamped;
    }

    const gh = island ? island.sample(playerAimTarget.x, playerAimTarget.z) : null;
    playerAimTarget.y = (gh !== null && gh !== undefined) ? gh : swell.getHeight(playerAimTarget.x, playerAimTarget.z);
  }

  let wakeLock = null;
  async function keepAwake(){ try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch(_) {} }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
  keepAwake();

  let lastT = performance.now(), lastStats = 0;
  let oceanTime = 0;
  let simAccum = 0;
  let uiAccum = 0;
  const SIM_STEP = 1 / SIM_HZ;
  const UI_STEP = 1 / PERF.uiUpdateHz;

  Debug.setStatusProvider(() => [
    `preset: ${history[historyIndex]}`,
    `state: ${matchDirector.state}  modus: ${matchDirector.mode}  tijd: ${matchDirector.isGameplayActive ? matchDirector.timeScale + 'x' : 'STOP'}`,
    `backend: ${isWebGPU?'WebGPU':'WebGL2'} profiel: ${PERF.id} render: ${(renderResolution.nativeFraction * 100).toFixed(0)}%`,
    `oceaanmesh: ${PERF.oceanRings}x${PERF.oceanSegments}  wake: ${PERF.wakeResolution}px @ ${PERF.wakeUpdateHz}Hz`,
    `sim: ${matchDirector.gameTime.toFixed(1)}s  oceaan: ${oceanTime.toFixed(1)}s`,
    ...(playerShip ? [
      `v0: ${CFG.muzzleVelocity} m/s  maxbereik: ${Math.round(CFG.aimMaxRange)} m`,
      `mikpunt: ${playerAimTarget.x.toFixed(0)},${playerAimTarget.z.toFixed(0)}`,
      `elevatie t0: ${(playerShip.turrets[0] ? playerShip.turrets[0].elev * 57.2958 : 0).toFixed(1)} graden`,
      `actief doel: ${activeTarget ? activeTarget.id + ' ' + activeTarget.label + ' hp ' + Math.round(activeTarget.hp) : '-'}`,
      `objectieven: ${registry ? registry.objectiveRemaining + '/' + registry.objectiveCount : '-'}`,
      `netwerk: ${defenseNetwork ? (defenseNetwork.status.radarOperational ? 'radar actief' : 'radar uit') + ', ' + (defenseNetwork.status.supplyOperational ? 'bevoorraad' : 'bevoorrading uit') : '-'}`,
      `projectielen: ${ballistics ? ballistics.projectiles.length : 0}`,
      `hp speler: ${playerShip.hp}`,
      `navigatie: ${playerShip.navigationContact ? playerShip.navigationContact.reason.toUpperCase() : 'vrij'}  x/z ${playerShip.root.position.x.toFixed(0)},${playerShip.root.position.z.toFixed(0)}`,
    ] : []),
  ]);

  engine.runRenderLoop(() => {
    const now = performance.now();
    const dt = Math.min(now - lastT, 80);
    lastT = now; stats.frameCount++;
    const dts = dt * 0.001;
    const frame = matchDirector.tick(dts);
    const cdt = frame.gameDt;
    const simTime = frame.gameTime;
    const gameplayActive = frame.running;
    oceanTime += cdt;

    Telemetry.frame(dt);
    uiAccum += dts;
    const updateUi = uiAccum >= UI_STEP;
    if (updateUi) uiAccum %= UI_STEP;

    stats.fpsHistory.push(dt); if (stats.fpsHistory.length > 60) stats.fpsHistory.shift();
    stats.currentFps = 1000 / (stats.fpsHistory.reduce((a,b)=>a+b,0) / stats.fpsHistory.length);
    if (dt > 200 && stats.frameCount > 120) stats.gpuWarnCount++;

    if (wavesGen) {
      simAccum += cdt;
      if (simAccum >= SIM_STEP) {
        try { wavesGen.update(simAccum); } catch(err) {}
        if (oceanRig) {
          oceanRig.mat.setTexture('uTurb0', wavesGen.getCascade(0).turbulence);
          oceanRig.mat.setTexture('uTurb1', wavesGen.getCascade(1).turbulence);
          oceanRig.mat.setTexture('uTurb2', wavesGen.getCascade(2).turbulence);
        }
        simAccum = 0;
      }
    }

    swell.update(oceanTime);

    let aimReady = false;
    let aimTarget = null;

    if (playerShip) {
      if (matchDirector.mode === 'ship') {
        
        if (gameplayActive) {
          playerShip.throttle = -joyState.right.y;
          playerShip.rudder = joyState.right.x;
        }

        if (gameplayActive) updateAim(cdt);
        aimTarget = playerAimTarget;
        if (aimCursor) { aimCursor.position.copyFrom(playerAimTarget); aimCursor.setEnabled(true); }

      } else if (matchDirector.mode === 'regie') {
        matchDirector.aiDrive(playerShip, cdt);
        aimTarget = activeTarget ? activeTarget.root.position : (island ? island.root.position : null);
        if (aimCursor) aimCursor.setEnabled(false);

      } else {
        playerShip.throttle = 0; playerShip.rudder = 0;
        if (aimCursor) aimCursor.setEnabled(false);
      }

      if (registry) {
        const ref = (matchDirector.mode === 'ship') ? playerAimTarget : playerShip.root.position;
        activeTarget = registry.list.find(e => e.alive && e.state === 'spotted' && 
                       Math.hypot(e.root.position.x - ref.x, e.root.position.z - ref.z) < 150) || null;
      }

      if (aimTarget && !(turretRig && turretRig.enabled)) {
        playerShip.aimTurretsAt(aimTarget, cdt, CFG.muzzleVelocity);
      }
      if (aimTarget && combatController) {
        aimReady = combatController.playerAimReady(playerShip, aimTarget);
      }

      if (gameplayActive) {
        playerShip.update(cdt);
        if (worldCollision) {
          const contact = worldCollision.consumeContact();
          if (contact) {
            const label = contact.reason === 'boundary' ? 'missiegrens' : 'ondiep water/kust';
            pushLog('NAV', `Schip geblokkeerd door ${label}${contact.slid ? ' (glijdt langs obstakel)' : ''}`, false);
            Telemetry.event('navigationContact', contact);
            try { if (navigator.vibrate) navigator.vibrate([18, 35, 18]); } catch (_) {}
          }
        }
      }
    }

    if (gameplayActive && stats.frameCount % 15 === 0 && registry && playerShip && island && matchDirector.mode !== 'free') {
      const pPos = playerShip.root.position;
      _spotEye.set(pPos.x, pPos.y + 18, pPos.z);
      registry.list.forEach(emp => {
        if (!emp || !emp.alive || emp.state !== 'unknown' || !emp.root) return;
        if (matchDirector.autoSpot) {
          registry.spot(emp, 'sandbox');
          return;
        }

        const ePos = emp.root.position;
        const dist = Math.hypot(ePos.x - _spotEye.x, ePos.z - _spotEye.z);
        if (!Number.isFinite(dist) || dist >= CFG.engageRange * 1.1) return;

        _spotTarget.set(ePos.x, ePos.y + (emp.visibilityHeight ?? 12), ePos.z);
        const visible = typeof island.hasLineOfSight === 'function'
          ? island.hasLineOfSight(_spotEye, _spotTarget, {
              endMargin: Math.max(18, emp.radius ?? 24),
              clearance: 1.5,
            })
          : true;
        if (visible && registry.spot(emp, 'zichtlijn') && navigator.vibrate) navigator.vibrate([20, 30, 20]);
      });
    }

    if (gameplayActive && defenseNetwork && playerShip && playerShip.alive && matchDirector.mode !== 'free') {
      defenseNetwork.update(simTime, playerShip);
    }

    if (gameplayActive && registry && playerShip && playerShip.alive && combatController && matchDirector.mode !== 'free') {
      registry.list.forEach(emp => {
        if (emp && emp.alive && emp.canFire === true) {
          combatController.enemyFire(cdt, simTime, emp, playerShip, ballistics, fx);
        }
      });
    }

    if (gameplayActive) {
      if (island) island.update(cdt);
      if (battle) battle.update(cdt);
      if (squadron) squadron.update(cdt);
      if (heatFx) heatFx.update(cdt);
      if (combatController) combatController.update(cdt, simTime, playerShip, null, ballistics, fx, false);
      if (wakeManager) wakeManager.update(cdt, playerShip, null);
      if (ballistics) ballistics.update(cdt);
    }

    if (trajectoryRenderer) trajectoryRenderer.hide();

    if (matchDirector.mode !== _prevMode) {
      if (matchDirector.mode === 'free') {
        if (followSquad) { followSquad = false; if (overlay) overlay.setFollowActive(false); }
        if (freeCam) freeCam.seedFromCam(cam);
      }
      _prevMode = matchDirector.mode;
    }

    if (followSquad && squadron && squadron.enabled) {
      squadron.followCam(cam, dts);
    } else if (matchDirector.mode === 'free' && freeCam) {
      freeCam.update(dts, joyState, altState);
    } else if (chaseCam && (matchDirector.mode === 'ship' || matchDirector.mode === 'regie')
        && !(turretRig && turretRig.enabled)) {
      chaseCam.update(dts);
    }

    if (oceanRig) {
      oceanRig.ocean.position.x = cam.position.x;
      oceanRig.ocean.position.z = cam.position.z;
      oceanRig.mat.setVector3('uCamPos', cam.position);
      oceanRig.mat.setFloat('uTime', oceanTime);
    }

    if (skyRig) skyRig.update(cam.position);

    if (gpuLost) return;
    try { scene.render(); }
    catch (e) { haltOnGpuLoss('render: ' + ((e && e.message) || e)); return; }

    if (updateUi && markers && playerShip) markers.update(cam, registry, activeTarget, playerShip.root.position, cdt, defenseNetwork);

    if (updateUi && hud && playerShip) {
      const t = activeTarget || _noTarget;
      const e = t.root.position;
      _hudPos.set(e.x, e.y + 14, e.z);
      const range = Math.hypot(e.x - playerShip.root.position.x, e.z - playerShip.root.position.z);

      hud.update({
        camera: cam,
        playerHp: playerShip.hp, playerMax: playerShip.maxHp,
        enemyHp: t.hp, enemyMax: t.maxHp,
        enemyPos: _hudPos, enemyAlive: !!t.alive, enemyLabel: t.label || 'GEEN DOEL',
        range,
        aimReady,
        fireReady: combatController ? combatController.getFireReady(simTime) : 0,
        reloadSec: combatController ? Math.max(0, CFG.fireCooldown - (simTime - combatController.lastFireT)) : 0,
      });
    }

    if (now - lastStats > 1000) {
      lastStats = now;
      updateDebugStats();
    }
  });

  let resT;
  window.addEventListener('resize', ()=>{ clearTimeout(resT); resT=setTimeout(()=>engine.resize(),150); });
  window.addEventListener('beforeunload', () => {
    try {
      if (wakeLock) wakeLock.release().catch(()=>{});
      if (hud) hud.dispose();
      if (markers) markers.dispose();
      if (menu) menu.dispose();
      if (turretRig) turretRig.dispose();
      if (squadron) squadron.dispose();
      if (ballistics) ballistics.dispose();
      if (fx) fx.dispose();
      if (battle) battle.dispose();
      if (registry) registry.dispose();
      if (wavesGen) wavesGen.dispose();
      if (wakeManager) wakeManager.dispose();
      if (trajectoryRenderer) trajectoryRenderer.dispose();
      if (heatFx) heatFx.dispose();
      if (skyRig) skyRig.dispose();
      if (oceanRig) { if (oceanRig.envPlaceholder) oceanRig.envPlaceholder.dispose(); oceanRig.mat.dispose(); oceanRig.ocean.dispose(); }
      scene.dispose(); engine.dispose();
    } catch(_) {}
  });

  window.zbExportTargets = () => registry && registry.exportJSON();
  window.zbCam = (n) => chaseCam && chaseCam.setStyle(n, true);

}).catch(err => {
  Debug.fatal(err, { title:'Opstartfout', phase:'boot', tag:'BOOT' });
});

window.addEventListener('pointerdown', (e) => {
  if (!window.__zbScene) return;
  const pick = window.__zbScene.pick(e.clientX, e.clientY);
  if (pick && pick.hit && pick.pickedMesh) {
    const n = pick.pickedMesh.name;
    if (window.pushLog) window.pushLog('TIK', 'onderdeel: ' + n, false);
    console.log('TIK onderdeel:', n);
    try { navigator.clipboard.writeText(n); } catch(_) {}
  }
}, true);
