// src/main.js
//
// M7.0 - Level 1 Bruggenhoofd: mobiele artilleriesteun vanaf een verankerd schip.

import { boot } from './core/engine.js';
import { pushLog, updateDebugStats, stats, Debug, toggleHud, hudEnabled } from './core/debug.js';
import { mobileInput, joyState, altState } from './input/controls.js';
import { WavesSettings } from './ocean/wavesSettings.js';
import { WavesGenerator } from './ocean/wavesGenerator.js';
import { buildOcean } from './ocean/oceanMaterial.js';
import { WakeManager } from './ocean/wakeManager.js';
import { PRESETS } from './ocean/presets.js';
import { SwellField } from './game/swellField.js';
import { FireSupportShip } from './game/fireSupportShip.js';
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
import { CombatController } from './game/combatController.js';
import { DefenseNetwork } from './game/defenseNetwork.js';
import { LevelMatchDirector } from './game/levelMatchDirector.js';
import { MissionDirector } from './game/missionDirector.js';
import { LEVEL_1 } from './levels/level1.js';
import { OverlayUI } from './ui/overlayUI.js';
import { MissionHUD } from './ui/missionHud.js';
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

export const BUILD = 'M7.0.0 level1-bruggenhoofd';

const FFT_SIZE = 128;
const SIM_HZ = 30;
const PERF = createPerformanceProfile();
const MUZZLE_VELOCITY = 300;

const CFG = {
  shipHp: 100,
  shipDamagePerHit: 3.2,
  shellDamage: 34,
  blastRadius: 45,
  targetCount: 3,
  targetSeed: 1337,
  targetMinDist: 260,
  roundsPerTurret: LEVEL_1.salvo.roundsPerTurret,
  burstGap: 0.18,
  turretGap: 0.12,
  fireCooldown: LEVEL_1.salvo.fireCooldown,
  muzzleVelocity: MUZZLE_VELOCITY,
  playerSpreadMrad: 3.5,
  enemySpreadMrad: 12,
  aimReadyRad: 0.010,
  aimReadyElevRad: 0.014,
  enemyFireInterval: 4.8,
  enemyDifficulty: 'normal',
  enemySensorInterval: 0.30,
  enemyRadarRange: 3800,
  enemyContactMemory: 8,
  engageRange: 3200,
  aimSpeedFine: LEVEL_1.aim.fineSpeed,
  aimSpeedMax: LEVEL_1.aim.maxSpeed,
  aimCurve: LEVEL_1.aim.curve,
  aimMinRange: 300,
  aimMaxRange: maxRange(MUZZLE_VELOCITY) * 0.92,
  camStyle: 'doel',
  aiThrottle: 0.5,
  aiRudderAmp: 0.5,
  aiRudderRate: 0.15,
  contactFoam: 1.0,
  contactWidth: 6.0,
  wakeStrength: 0.8,
  wakeFlatten: 0.8,
  wakeMinSpeed: 1.0,
  wakeTau: 4.5,
  wakeResolution: PERF.wakeResolution,
  wakeUpdateHz: PERF.wakeUpdateHz,
  wakeMaxParts: PERF.wakeMaxParts,
  wakeMaxInterpolationStamps: PERF.wakeMaxInterpolationStamps,
  collisionUnderKeel: 1.5,
  collisionSweepStep: 6,
  missionMinX: -2200,
  missionMaxX: 6800,
  missionMinZ: -4300,
  missionMaxZ: 4300,
};

Telemetry.init({ build: BUILD, cfg: CFG });
Telemetry.bind({ Debug, joyState, altState, matchDirector: null });
Debug.pushLog('BUILD', `ZeeBeslag ${BUILD} (v0=${CFG.muzzleVelocity}m/s blast=${CFG.blastRadius}m doelen=${CFG.targetCount})`, false);
Debug.setBuild && Debug.setBuild(BUILD);

const matchDirector = new LevelMatchDirector(CFG);
Telemetry.bind({ matchDirector });

let history = ['calm'], historyIndex = 0;
try {
  const s = localStorage.getItem('oceanFFTv7');
  if (s) history = JSON.parse(s);
  historyIndex = parseInt(localStorage.getItem('oceanFFTv7Idx') || '0');
  historyIndex = Math.min(historyIndex, history.length - 1);
} catch (_) {}
function saveState(id) {
  history = history.slice(0, historyIndex + 1);
  history.push(id);
  historyIndex = history.length - 1;
  try {
    localStorage.setItem('oceanFFTv7', JSON.stringify(history));
    localStorage.setItem('oceanFFTv7Idx', String(historyIndex));
  } catch (_) {}
}

Debug.setLoading(0, 'WebGPU initialiseren...');

boot().then(async ({ engine, scene, cam, sun, amb, isWebGPU }) => {
  Debug.attachEngine(engine);
  Debug.registerScene(scene);
  window.__zbScene = scene;

  let gpuLost = false;
  function haltOnGpuLoss(reason) {
    if (gpuLost) return;
    gpuLost = true;
    try { engine.stopRenderLoop(); } catch (_) {}
    pushLog('WEBGPU', 'device verloren, renderloop gestopt (' + reason + ')', true);
    Debug.fatal(
      new Error('WebGPU device verloren (' + reason + '). De GPU raakte de submit kwijt, meestal door een te zware frame of geheugendruk bij het opstarten.'),
      { title: 'GPU device verloren', phase: 'render', tag: 'WEBGPU' },
    );
  }
  if (engine.onContextLostObservable) engine.onContextLostObservable.add(() => haltOnGpuLoss('onContextLost'));
  try {
    const device = engine._device;
    if (device && device.lost) device.lost.then(info => haltOnGpuLoss((info && info.reason) || 'device.lost'));
  } catch (_) {}
  window.__zbHaltOnGpuLoss = haltOnGpuLoss;

  const renderResolution = applyRenderResolution(engine, PERF, window);
  pushLog('PERF', `profiel ${PERF.id}: ${renderResolution.renderWidth}x${renderResolution.renderHeight}, ${(renderResolution.nativeFraction * 100).toFixed(0)}% fysiek, pixelratio ${renderResolution.pixelRatio.toFixed(2)}`, false);
  Debug.setLoading(15, isWebGPU ? 'WebGPU actief' : 'WebGL2 fallback');

  if (!isWebGPU) {
    Debug.fatal(new Error('Geen WebGPU op dit toestel/deze browser. ComputeShader vereist, dus de oceaan kan niet laden.'),
      { title: 'WebGPU vereist', phase: 'engine-init', tag: 'ENGINE' });
    return;
  }

  scene.skipPointerMovePicking = true;

  let oceanRig = null, wavesGen = null, wavesSettings = null, wakeManager = null, skyRig = null;
  const swell = new SwellField();
  let playerShip = null, island = null, chaseCam = null, ballistics = null, fx = null, combatController = null;
  let worldCollision = null;
  let registry = null, markers = null, battle = null, defenseNetwork = null;
  let heatFx = null, sunSweep = null, megaPlume = null, rookSweep = null;
  let hud = null, menu = null, turretRig = null, trajectoryRenderer = null, missionHud = null;
  let missionDirector = null;
  let squadron = null, freeCam = null, followSquad = false, previousMode = null, overlay = null;
  let depthRenderList = [], depthMap = null;
  let aimCursor = null, activeTarget = null;
  const playerAimTarget = new BABYLON.Vector3(CFG.engageRange, 0, 0);
  const camFwd = new BABYLON.Vector3();
  const camRight = new BABYLON.Vector3();
  const hudPos = new BABYLON.Vector3();
  const noTarget = { hp: 0, maxHp: 1, alive: false, state: 'unknown', root: { position: new BABYLON.Vector3(CFG.engageRange, 0, 0) } };
  let shipModelReady = false, missionWorldReady = false, briefingShown = false;

  function tryShowBriefing() {
    if (briefingShown || !shipModelReady || !missionWorldReady || !missionDirector || !missionHud) return;
    briefingShown = true;
    matchDirector.bind({ missionDirector, missionHud });
    missionDirector.showBriefing(() => {
      matchDirector.setMode('ship');
      matchDirector.completeLoading();
      mobileInput.setEnabled(true);
      pushLog('MISSIE', 'Level 1 Bruggenhoofd gestart.', false);
    });
  }

  function syncDepthRenderList() {
    if (!depthMap) return;
    const list = [];
    const add = mesh => {
      if (!mesh || (mesh.isDisposed && mesh.isDisposed()) || !mesh.getTotalVertices || mesh.getTotalVertices() <= 0) return;
      if (!list.includes(mesh)) list.push(mesh);
    };
    if (playerShip && Array.isArray(playerShip.meshes)) playerShip.meshes.forEach(add);
    if (island && Array.isArray(island._pickables)) island._pickables.forEach(add);
    depthRenderList = list;
    depthMap.renderList = depthRenderList;
  }

  function initGame() {
    playerShip = new FireSupportShip(scene, swell, {
      position: new BABYLON.Vector3(0, 0, 0),
      heading: 0,
      maxHp: CFG.shipHp,
      optimizeVisualModel: PERF.mergeStaticMeshes,
      freezeStaticMaterials: PERF.freezeStaticMaterials,
      maxMergeVertices: PERF.maxMergeVertices,
    });
    island = new IslandTarget(scene, { position: new BABYLON.Vector3(CFG.engageRange, 0, 0) });
    worldCollision = new WorldCollision(island, {
      underKeelClearance: CFG.collisionUnderKeel,
      sweepStep: CFG.collisionSweepStep,
      bounds: { minX: CFG.missionMinX, maxX: CFG.missionMaxX, minZ: CFG.missionMinZ, maxZ: CFG.missionMaxZ },
    });
    playerShip.setNavigationCollision(worldCollision);
    playerShip.addTurret(new BABYLON.Vector3(0, 6.5, 17), { barrel: 6, muzzleY: 1.2 });
    playerShip.addTurret(new BABYLON.Vector3(0, 6.5, 2), { barrel: 6, muzzleY: 1.2 });
    playerShip.addTurret(new BABYLON.Vector3(0, 6.5, -13), { barrel: 6, muzzleY: 1.2 });

    chaseCam = new ChaseCamera(cam, playerShip, { enemy: island, style: CFG.camStyle });
    freeCam = new FreeCam(cam);
    ballistics = new Ballistics(scene, swell);
    combatController = new CombatController(CFG, swell);
    combatController.setPlayerFirePolicy(LEVEL_1.salvo);
    combatController.setPlayerAimTarget(playerAimTarget);
    trajectoryRenderer = new TrajectoryRenderer(scene, ballistics, swell);
    registry = new TargetRegistry(scene);
    markers = new MarkerLayer();
    missionHud = new MissionHUD();
    mobileInput.attach();
    mobileInput.setEnabled(false);
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
      if (markers) markers.announce(`${emp.id} ${emp.label}`, effect, emp.type);
    };
    registry.onDestroyed = emp => {
      if (defenseNetwork) defenseNetwork.refreshStatus();
      pushLog('GAME', `${emp.id} ${emp.label} vernietigd`, false);
      if (fx) {
        hudPos.copyFrom(emp.root.position);
        hudPos.y += 2;
        fx.emplacementDestroyed(hudPos.clone());
      }
      if (missionDirector) missionDirector.onTargetDestroyed(emp);
      if (navigator.vibrate) navigator.vibrate([25, 40, 25]);
    };
    registry.onObjectiveComplete = null;

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

    matchDirector.bind({ cam, playerShip, enemyShip: island, chaseCam, ballistics, combatController, fx, registry, markers, missionHud, wakeManager, worldCollision, defenseNetwork });
    matchDirector.placeCinematicCam();

    scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
    scene.fogDensity = 1.6e-4;
    scene.fogColor = new BABYLON.Color3(0.62, 0.75, 0.90);

    function detonate(pos) {
      if (markers) markers.duckAt(pos);
      if (heatFx) heatFx.pulse(0.9);
      if (matchDirector.gameOver || matchDirector.mode === 'regie') return;
      if (missionDirector) missionDirector.reportImpact(pos);
      if (!matchDirector.enemyGodMode) registry.applyBlast(pos, CFG.shellDamage, CFG.blastRadius);
      else pushLog('BAL', 'Doel onkwetsbaar (Vijand Godmode actief)', false);
    }

    ballistics.onImpactWater = pos => fx.waterImpact(pos);
    ballistics.onImpactGround = pos => { fx.shipShatter(pos); detonate(pos); };
    ballistics.onImpactTarget = (emp, pos) => { fx.shipShatter(pos); detonate(pos); };
    ballistics.onImpactShip = (ship, pos) => {
      if (ship !== playerShip) { fx.shipShatter(pos); return; }
      if (matchDirector.mode === 'regie' || matchDirector.gameOver) return;
      if (matchDirector.playerGodMode) return;
      const sank = ship.damage(CFG.shipDamagePerHit);
      if (hud) hud.damageFlash();
      pushLog('BAL', `TREFFER op speler (hp ${ship.hp})`, false);
      if (sank) matchDirector.onShipSank(ship);
    };

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

    playerShip.loadGLB('./models/', 'Schip1.glb').then(result => {
      pushLog('GLB', `Schip1.glb geladen: ${result.sourceMeshCount ?? result.meshCount} -> ${result.meshCount} meshes, schaal ${result.modelScale.toFixed(5)}, lengte ${result.modelLength.toFixed(1)}m, ${result.turretsBound} echte turrets gekoppeld`, false);
      syncDepthRenderList();
      if (result.optimization) pushLog('PERF', `schip: ${result.optimization.sourceMeshes} -> ${result.optimization.resultMeshes} meshes`, result.optimization.failedGroups > 0);
      if (result.turretsBound === 0) pushLog('RIG', 'Geen benoemde koepelmeshes gevonden; logische turrets actief', false);
      try { turretRig = new TurretRig(scene, playerShip, pushLog, cam); }
      catch (error) { pushLog('RIG', 'turret-rig init faalde: ' + error, true); }
      shipModelReady = true;
      tryShowBriefing();
    }).catch(error => {
      pushLog('GLB', 'Schip1.glb laden mislukt: ' + (error.message || error), true);
      Debug.fatal(error, { title: 'Scheepsmodel kon niet laden', phase: 'level1-ready', tag: 'GLB' });
    });

    island.loadGLB('./models/land/', 'ocean_rocky_island.glb', {
      optimizeMeshes: PERF.mergeStaticMeshes,
      freezeStaticMaterials: PERF.freezeStaticMaterials,
      maxMergeVertices: PERF.maxMergeVertices,
    }).then(result => {
      pushLog('GLB', `eiland geladen: ${result.sourceMeshCount ?? result.meshCount} -> ${result.meshCount} meshes, voetafdruk r=${Math.round(result.hitRadius)}m`, false);
      syncDepthRenderList();
      missionDirector = new MissionDirector({
        level: LEVEL_1, registry, island, playerShip, matchDirector, chaseCam, markers,
        ballistics, combatController, aimTarget: playerAimTarget, hud: missionHud,
      });
      const missionTargets = missionDirector.initialize();
      if (defenseNetwork) defenseNetwork.refreshStatus();
      pushLog('MISSIE', `${missionTargets.length} vaste vuursteundoelen geplaatst voor Level 1.`, missionTargets.length !== LEVEL_1.objectives.length);
      matchDirector.bind({ missionDirector, missionHud });
      missionWorldReady = true;
      tryShowBriefing();

      battle = new BattleAmbience(scene, island, fx, { seed: CFG.targetSeed + 7, registry });
      const sites = battle.build();
      pushLog('GAME', `slagvelddecor: ${sites} stellingen`, sites < 8);
      Telemetry.bind({ battle });
      matchDirector.bind({ battle });
      const bounds = island.bounds ? island.bounds() : null;
      const center = bounds ? new BABYLON.Vector3(bounds.x0 + bounds.span * 0.5, 0, bounds.z0 + bounds.span * 0.5) : null;
      buildWreck({ scene, fx, pushLog, islandCenter: center });
      megaPlume = buildMegaPlume({ scene, islandCenter: center, pushLog });
      matchDirector.bind({ megaPlume });
      squadron = new Squadron(scene, { island });
      matchDirector.bind({ squadron });
      squadron.load().then(() => pushLog('LUCHT', `eskader geladen: ${squadron.planes.length} toestellen`, false))
        .catch(error => pushLog('LUCHT', 'eskader laden mislukt: ' + (error.message || error), true));
    }).catch(error => {
      pushLog('GLB', 'eiland laden mislukt: ' + (error.message || error), true);
      Debug.fatal(error, { title: 'Eiland of missie kon niet laden', phase: 'level1-ready', tag: 'GLB' });
    });
  }

  function buildMenu() {
    menu = new Menu({
      onPreset: id => applyState(id),
      onUndo: () => { if (historyIndex > 0) applyState(history[--historyIndex], false); },
      onRedo: () => { if (historyIndex < history.length - 1) applyState(history[++historyIndex], false); },
      onMode: mode => matchDirector.setMode(mode),
      onTime: scale => matchDirector.setTimeScale(scale),
      onGod: () => matchDirector.toggleGodMode(),
      onFilm: () => matchDirector.toggleFilmLook(),
      onReset: () => matchDirector.resetMatch(),
      onDebugLog: () => toggleHud(),
      onTurretRig: () => turretRig && turretRig.toggle(),
      onToggleTuner: () => island && island.toggleTuner(),
      onSpawnMove: () => {},
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
        const depthRenderer = scene.enableDepthRenderer(cam, false);
        depthMap = depthRenderer.getDepthMap();
        depthMap.renderList = depthRenderList;
        oceanRig.mat.setTexture('uDepthTex', depthMap);
        oceanRig.mat.setFloat('uCamFar', cam.maxZ);
        oceanRig.mat.setFloat('uContactFoam', CFG.contactFoam);
        oceanRig.mat.setFloat('uContactWidth', CFG.contactWidth);
      } catch (_) {}
      try { wakeManager = new WakeManager(scene, oceanRig, CFG); matchDirector.bind({ wakeManager }); } catch (_) {}
      Debug.setRenderViewHandler(mode => oceanRig && oceanRig.mat.setFloat('uDebugView', mode));
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
      window.zbSky = mode => skyRig.setSkyMode(mode);
      sunSweep = new SunSweepTool({ engine, scene, cam, skyRig, sun, amb, matchDirector, pushLog });
      window.zbSunSweep = opties => sunSweep.run(opties);
      rookSweep = new SmokeSweepTool({ engine, scene, cam, skyRig, sun, amb, matchDirector, pushLog, smokeCards: () => fx ? fx.smokeCardsRef : null });
      window.zbRookSweep = opties => rookSweep.run(opties);

      initGame();
      hud = new HUD();
      buildMenu();
      matchDirector.bind({ hud, menu });
      matchDirector.setMode('ship');
      overlay = new OverlayUI(matchDirector, { restricted: true });

      const devUiEnabled = matchDirector.devMode || new URLSearchParams(location.search).get('dev') === '1';
      if (devUiEnabled) {
        DevPanel.mount();
        DevPanel.toggle({ id: 'devmode', group: 'SANDBOX', label: 'Dev Modus Actief', get: () => matchDirector.devMode, set: () => matchDirector.toggleSandbox('devMode') });
        DevPanel.toggle({ id: 'godplayer', group: 'SANDBOX', label: 'Speler Godmode', get: () => matchDirector.playerGodMode, set: () => matchDirector.toggleSandbox('playerGodMode') });
        DevPanel.toggle({ id: 'godenemy', group: 'SANDBOX', label: 'Vijand Godmode', get: () => matchDirector.enemyGodMode, set: () => matchDirector.toggleSandbox('enemyGodMode') });
        DevPanel.toggle({ id: 'infammo', group: 'SANDBOX', label: 'Oneindig Munitie', get: () => matchDirector.infiniteAmmo, set: () => matchDirector.toggleSandbox('infiniteAmmo') });
        DevPanel.toggle({ id: 'film', group: 'WEERGAVE', label: 'WO2 filmlook', get: () => matchDirector.filmLook, set: () => matchDirector.toggleFilmLook() });
        DevPanel.toggle({ id: 'ribbon', group: 'DIAGNOSE', label: 'Perf-ribbon', get: () => hudEnabled(), set: () => toggleHud() });
        DevPanel.tool({ id: 'tuner', group: 'PANELEN', label: 'Eiland tuner', onTap: () => island && island.toggleTuner() });
        DevPanel.tool({ id: 'rig', group: 'PANELEN', label: 'Turret rig', onTap: () => turretRig && turretRig.toggle() });
      }
      Telemetry.bind({ wavesGen, hud, menu, sunSweep });
      Debug.loadingDone();
    } catch (error) {
      Debug.fatal(error, { title: 'Oceaan-init mislukt', phase: 'wavesGenerator', tag: 'FFT' });
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
  const curves = new BABYLON.ColorCurves();
  curves.globalSaturation = 90;
  curves.highlightsHue = 40; curves.highlightsSaturation = 16; curves.highlightsDensity = 55;
  curves.midtonesHue = 200; curves.midtonesSaturation = 6;
  curves.shadowsHue = 210; curves.shadowsSaturation = 22; curves.shadowsDensity = 50;
  ipc.colorCurves = curves;

  try {
    heatFx = new HeatFx(scene, cam, engine, {
      enabled: true, amount: 0.0016, bloomThreshold: 0.72, bloomIntensity: 0.55,
      grain: 0.045, bandLo: 0.18, bandHi: 0.92, ratio: PERF.postProcessRatio, bloomSamples: PERF.bloomSamples,
    });
    matchDirector.bind({ heatFx });
  } catch (error) { pushLog('PP', 'HeatFx kon niet worden aangemaakt: ' + error, true); }
  matchDirector.bind({ pipeline: { imageProcessing: scene.imageProcessingConfiguration } });
  matchDirector.applyFilmLook();

  function applyState(id, write = true) {
    const preset = PRESETS[id];
    if (!preset) return;
    if (wavesSettings && wavesGen) {
      wavesSettings.lambda = preset.lambda;
      wavesSettings.local.windSpeed = preset.windSpeed;
      wavesSettings.local.fetch = preset.fetch;
      wavesSettings.local.windDirection = preset.windDir;
      wavesSettings.swell.windSpeed = preset.windSpeed * 0.7;
      wavesSettings.swell.fetch = preset.fetch * 1.6;
      wavesSettings.swell.windDirection = preset.windDir + 15;
      wavesGen.rebake();
      swell.setFromPreset(preset.windSpeed, preset.fetch, preset.windDir);
      if (fx) {
        const angle = preset.windDir * Math.PI / 180;
        fx.setWind(new BABYLON.Vector3(Math.sin(angle) * preset.windSpeed * 0.06, 0, Math.cos(angle) * preset.windSpeed * 0.06));
      }
      if (oceanRig && oceanRig.mat && preset.foam !== undefined) oceanRig.mat.setFloat('uFoamScale', 2.4 * preset.foam);
    }
    if (write) saveState(id);
    if (menu) menu.refresh();
  }

  matchDirector.bind({
    onReset: () => {
      activeTarget = null;
      followSquad = false;
      if (turretRig && typeof turretRig.hide === 'function') turretRig.hide();
      if (trajectoryRenderer) trajectoryRenderer.hide();
      mobileInput.resetAim();
      mobileInput.setEnabled(true);
      if (missionDirector) missionDirector.reset(true);
      altState.up = false;
      altState.down = false;
      oceanTime = 0;
      simAccum = 0;
      uiAccum = 0;
      if (wavesGen && typeof wavesGen.reset === 'function') wavesGen.reset();
      if (aimCursor) {
        aimCursor.position.copyFrom(playerAimTarget);
        aimCursor.setEnabled(true);
      }
    },
  });

  function tryFireSalvo() {
    if (!combatController || !playerShip || !missionDirector) return;
    if (!matchDirector.canAcceptInput() || !missionDirector.canFire) return;
    const gameTime = matchDirector.gameTime;
    const status = combatController.playerAimStatus(playerShip, playerAimTarget);
    if (!status.anyReady) {
      missionHud && missionHud.announce('GESCHUT NOG NIET GEREED', 'Wacht tot minimaal één toren op doel ligt.', 'warning', 1.6);
      return;
    }
    const ok = combatController.fireSalvo(gameTime, playerShip);
    pushLog('VUUR', ok ? `salvo: ${combatController.lastSalvoTurretCount} gereedstaande toren(s)` : 'geweigerd: herladen', false);
    if (ok && navigator.vibrate) navigator.vibrate(35);
  }
  mobileInput.setFireHandler(tryFireSalvo);

  function updateAim(dt) {
    const jx = mobileInput.aim.x, jy = mobileInput.aim.y;
    const magnitude = Math.hypot(jx, jy);
    if (magnitude > 0.01) {
      camFwd.copyFrom(cam.getDirection(BABYLON.Axis.Z)); camFwd.y = 0;
      if (camFwd.lengthSquared() < 1e-6) camFwd.set(0, 0, 1);
      camFwd.normalize();
      camRight.copyFrom(cam.getDirection(BABYLON.Axis.X)); camRight.y = 0;
      if (camRight.lengthSquared() < 1e-6) camRight.set(1, 0, 0);
      camRight.normalize();
      const strength = Math.min(magnitude, 1);
      const speed = CFG.aimSpeedFine + (CFG.aimSpeedMax - CFG.aimSpeedFine) * Math.pow(strength, CFG.aimCurve);
      const gain = speed * dt / magnitude;
      const side = jx * gain, forward = -jy * gain;
      playerAimTarget.x += camRight.x * side + camFwd.x * forward;
      playerAimTarget.z += camRight.z * side + camFwd.z * forward;
    }
    const position = playerShip.root.position;
    let dx = playerAimTarget.x - position.x, dz = playerAimTarget.z - position.z;
    let distance = Math.hypot(dx, dz);
    if (distance < 1e-3) { dx = 1; dz = 0; distance = 1; }
    const clamped = Math.max(CFG.aimMinRange, Math.min(CFG.aimMaxRange, distance));
    if (clamped !== distance) {
      playerAimTarget.x = position.x + dx / distance * clamped;
      playerAimTarget.z = position.z + dz / distance * clamped;
    }
    const ground = island ? island.sample(playerAimTarget.x, playerAimTarget.z) : null;
    playerAimTarget.y = Number.isFinite(ground) ? ground : swell.getHeight(playerAimTarget.x, playerAimTarget.z);
  }

  let wakeLock = null;
  async function keepAwake() {
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
  keepAwake();

  let lastT = performance.now(), lastStats = 0, oceanTime = 0, simAccum = 0, uiAccum = 0;
  const SIM_STEP = 1 / SIM_HZ;
  const UI_STEP = 1 / PERF.uiUpdateHz;

  Debug.setStatusProvider(() => [
    `state: ${matchDirector.state} tijd: ${matchDirector.isGameplayActive ? matchDirector.timeScale + 'x' : 'STOP'}`,
    `backend: ${isWebGPU ? 'WebGPU' : 'WebGL2'} profiel: ${PERF.id}`,
    `sim: ${matchDirector.gameTime.toFixed(1)}s oceaan: ${oceanTime.toFixed(1)}s`,
    ...(playerShip ? [
      `mikpunt: ${playerAimTarget.x.toFixed(0)},${playerAimTarget.z.toFixed(0)}`,
      `actief doel: ${activeTarget ? activeTarget.id + ' ' + activeTarget.label : '-'}`,
      `vuurmissie: ${missionDirector ? missionDirector.objectiveIndex + 1 + '/' + missionDirector.targets.length + ' ' + missionDirector.state : '-'}`,
      `projectielen: ${ballistics ? ballistics.projectiles.length : 0}`,
      `hp speler: ${playerShip.hp}`,
    ] : []),
  ]);

  engine.runRenderLoop(() => {
    const now = performance.now();
    const frameMs = Math.min(now - lastT, 80);
    lastT = now;
    stats.frameCount++;
    const realDt = frameMs * 0.001;
    const frame = matchDirector.tick(realDt);
    const gameDt = frame.gameDt;
    const simTime = frame.gameTime;
    const gameplayActive = frame.running;
    oceanTime += gameDt;
    Telemetry.frame(frameMs);
    uiAccum += realDt;
    const updateUi = uiAccum >= UI_STEP;
    if (updateUi) uiAccum %= UI_STEP;

    stats.fpsHistory.push(frameMs);
    if (stats.fpsHistory.length > 60) stats.fpsHistory.shift();
    stats.currentFps = 1000 / (stats.fpsHistory.reduce((a, b) => a + b, 0) / stats.fpsHistory.length);

    if (wavesGen) {
      simAccum += gameDt;
      if (simAccum >= SIM_STEP) {
        try { wavesGen.update(simAccum); } catch (_) {}
        simAccum = 0;
      }
    }
    swell.update(oceanTime);

    let aimStatus = { statuses: [], readyCount: 0, total: 0, allReady: false, anyReady: false };
    if (playerShip) {
      if (gameplayActive) updateAim(gameDt);
      activeTarget = missionDirector ? missionDirector.activeTarget : null;
      if (aimCursor) { aimCursor.position.copyFrom(playerAimTarget); aimCursor.setEnabled(true); }
      if (playerAimTarget && !(turretRig && turretRig.enabled)) playerShip.aimTurretsAt(playerAimTarget, gameDt, CFG.muzzleVelocity);
      if (combatController) {
        combatController.setPlayerAimTarget(playerAimTarget);
        aimStatus = combatController.playerAimStatus(playerShip, playerAimTarget);
      }
      if (gameplayActive) {
        playerShip.speed = 0;
        playerShip.throttle = 0;
        playerShip.rudder = 0;
        playerShip.floatOnly(gameDt);
      }
    }

    if (gameplayActive && defenseNetwork && playerShip && playerShip.alive) defenseNetwork.update(simTime, playerShip);
    if (gameplayActive && registry && playerShip && playerShip.alive && combatController) {
      for (const emp of registry.list) {
        if (emp && emp.alive && emp.canFire && (!emp.missionControlled || emp.missionState === 'active')) {
          combatController.enemyFire(gameDt, simTime, emp, playerShip, ballistics, fx);
        }
      }
    }

    if (gameplayActive) {
      if (missionDirector) missionDirector.update(gameDt);
      if (island) island.update(gameDt);
      if (battle) battle.update(gameDt);
      if (squadron) squadron.update(gameDt);
      if (heatFx) heatFx.update(gameDt);
      if (combatController) combatController.update(gameDt, simTime, playerShip, null, ballistics, fx, false);
      if (wakeManager) wakeManager.update(gameDt, playerShip, null);
      if (ballistics) ballistics.update(gameDt);
    }

    if (trajectoryRenderer) {
      if (gameplayActive && missionDirector && missionDirector.canFire) trajectoryRenderer.update(playerShip, CFG.muzzleVelocity, aimStatus.allReady);
      else trajectoryRenderer.hide();
    }
    if (chaseCam && !(turretRig && turretRig.enabled)) chaseCam.update(realDt);
    if (oceanRig) {
      oceanRig.ocean.position.x = cam.position.x;
      oceanRig.ocean.position.z = cam.position.z;
      oceanRig.mat.setVector3('uCamPos', cam.position);
      oceanRig.mat.setFloat('uTime', oceanTime);
    }
    if (skyRig) skyRig.update(cam.position);
    if (gpuLost) return;
    try { scene.render(); }
    catch (error) { haltOnGpuLoss('render: ' + ((error && error.message) || error)); return; }

    const snapshot = missionDirector ? missionDirector.snapshot() : null;
    if (updateUi && markers && playerShip) markers.update(cam, registry, activeTarget, playerShip.root.position, gameDt, defenseNetwork, snapshot);
    if (updateUi && missionHud && snapshot) missionHud.update(snapshot);
    if (updateUi && hud && playerShip) {
      const target = activeTarget || noTarget;
      const pos = target.root.position;
      hudPos.set(pos.x, pos.y + 14, pos.z);
      const range = Math.hypot(pos.x - playerShip.root.position.x, pos.z - playerShip.root.position.z);
      hud.update({
        camera: cam,
        playerHp: playerShip.hp,
        playerMax: playerShip.maxHp,
        enemyHp: target.hp,
        enemyMax: target.maxHp,
        enemyPos: hudPos,
        enemyAlive: !!target.alive,
        enemyLabel: target.label || 'GEEN DOEL',
        range,
        aimReady: aimStatus.allReady,
        readyTurrets: aimStatus.readyCount,
        totalTurrets: aimStatus.total,
        fireAllowed: !!(missionDirector && missionDirector.canFire && aimStatus.anyReady),
        fireReady: combatController ? combatController.getFireReady(simTime) : 0,
        reloadSec: combatController ? Math.max(0, CFG.fireCooldown - (simTime - combatController.lastFireT)) : 0,
      });
    }

    const readyToFire = !!(gameplayActive && missionDirector && missionDirector.canFire && aimStatus.anyReady
      && combatController && combatController.getFireReady(simTime) >= 1);
    mobileInput.setFireEnabled(readyToFire);
    mobileInput.setFireReady(readyToFire);
    mobileInput.setAimEnabled(!!(gameplayActive && missionDirector && missionDirector.canFire));

    if (now - lastStats > 1000) {
      lastStats = now;
      updateDebugStats();
    }
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => engine.resize(), 150);
  });
  window.addEventListener('beforeunload', () => {
    try {
      if (wakeLock) wakeLock.release().catch(() => {});
      mobileInput.dispose();
      if (missionHud) missionHud.dispose();
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
      if (oceanRig) {
        if (oceanRig.envPlaceholder) oceanRig.envPlaceholder.dispose();
        oceanRig.mat.dispose();
        oceanRig.ocean.dispose();
      }
      scene.dispose();
      engine.dispose();
    } catch (_) {}
  });

  window.zbExportTargets = () => registry && registry.exportJSON();
  window.zbCam = name => chaseCam && chaseCam.setStyle(name, true);
}).catch(error => {
  Debug.fatal(error, { title: 'Opstartfout', phase: 'boot', tag: 'BOOT' });
});
