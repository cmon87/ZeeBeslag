// ZeeBeslag Telemetrie - alles wat te meten valt, in een JSON.
//
// Zelfstandig. Raakt debug.js niet aan. Leest de bestaande logbuffer als die te bereiken is,
// anders valt hij terug op localStorage en zegt hij dat erbij.
//
// Wat het toevoegt bovenop de bestaande export:
//   - frametijd-ring van 600 frames met p1/p50/p99, stalls, en de verhouding wandklok vs
//     gerenderde tijd (verraadt achtergrond-throttling en hangende frames)
//   - WebGPU adapter-info, limieten, features, en een teller op device.createBuffer met de
//     grootste allocatie (hier ging het op jouw toestel mis)
//   - volledige turret-staat per koepel: yaw, elevatie, rustrichting, vuurbogen, monding en
//     looprichting, plus de actuele richtfout
//   - gevechtstellers: salvo's aangevraagd, geaccepteerd, geweigerd op cooldown, granaten
//     afgevuurd, inslagen per soort, blast-toepassingen, werken vernietigd
//   - live projectielen met positie, snelheid en leeftijd
//   - alle emplacements met hp en staat
//   - invoerstaat en een ring van joystick-samples
//   - gebeurtenisring van 500 met tijdstempel
//   - fout- en promise-ring, plus console.error
//   - localStorage-inhoud voor de zb-sleutels
//   - een scenegraph-inventaris per mesh
//
// Gebruik:
//   Telemetry.init({ build, cfg });
//   Telemetry.bind({ engine, scene, cam, ... });
//   Telemetry.instrument();          // na het toewijzen van de ballistics-callbacks
//   Telemetry.frame(dtMs);           // elke frame
//   Telemetry.mountButton();         // zwevende knop TEL
//   window.zbDump()                  // object in de console
//   window.zbTel.download()          // json-bestand

const MAX_EVENTS = 500;
const MAX_ERRORS = 120;
const MAX_FRAMES = 600;
const MAX_INPUT = 240;
const MAX_MESHES = 250;
const MAX_PROJECTILES = 60;

const R2D = 180 / Math.PI;

function safe(fn, fallback) {
  try { const v = fn(); return v === undefined ? (fallback ?? null) : v; }
  catch (e) { return { _fout: String((e && e.message) || e) }; }
}
function num(v, d = 2) { return (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : null; }
function vec(v, d = 2) { return v ? { x: num(v.x, d), y: num(v.y, d), z: num(v.z, d) } : null; }

class Ring {
  constructor(n) { this.n = n; this.a = []; }
  push(x) { this.a.push(x); if (this.a.length > this.n) this.a.shift(); }
  get length() { return this.a.length; }
  all() { return this.a; }
  clear() { this.a.length = 0; }
}

class TelemetryClass {
  constructor() {
    this.build = '?';
    this.cfg = null;
    this.refs = {};
    this.providers = new Map();

    this.t0 = performance.now();
    this.events = new Ring(MAX_EVENTS);
    this.errors = new Ring(MAX_ERRORS);
    this.frames = new Ring(MAX_FRAMES);
    this.input = new Ring(MAX_INPUT);

    this.counters = {
      salvoRequested: 0,
      salvoAccepted: 0,
      salvoRejectedCooldown: 0,
      salvoRejectedOther: 0,
      shellsFired: 0,
      impactWater: 0,
      impactGround: 0,
      impactTarget: 0,
      impactShip: 0,
      blastApplied: 0,
      emplacementsDestroyed: 0,
      fireButtonPresses: 0,
      gpuBuffersCreated: 0,
      gpuBufferBytesTotal: 0,
      gpuBufferMaxSize: 0,
      gpuMappedBufferMaxSize: 0,
      visibilityHidden: 0,
      resizes: 0,
    };

    this._accumMs = 0;        // opgetelde gerenderde tijd
    this._lastInputT = 0;
    this._instrumented = false;
    this._async = { battery: null, storage: null, adapter: null };
    this.assets = {};        // per bestand: bytes, laadMs, status. Gevuld via asset().

    this._hookGlobals();
    this._hookVisibility();
  }

  // ── opzet ────────────────────────────────────────────────────────────────
  init({ build, cfg } = {}) {
    if (build) this.build = build;
    if (cfg) this.cfg = cfg;
    this.event('init', { build: this.build });
    this._collectAsync();
    window.zbTel = this;
    window.zbDump = () => this.snapshot();
    return this;
  }

  bind(refs) { this.refs = { ...this.refs, ...refs }; return this; }

  // Registreert een geladen asset met grootte en duur. Roep aan na een GLB-load.
  // status: 'ok' | 'fout' | 'laadt'. bytes mag null zijn als de grootte onbekend is.
  asset(naam, info = {}) {
    const prev = this.assets[naam] || {};
    this.assets[naam] = {
      bytes: info.bytes != null ? info.bytes : (prev.bytes != null ? prev.bytes : null),
      mb: info.bytes != null ? +(info.bytes / 1048576).toFixed(2) : (prev.mb != null ? prev.mb : null),
      laadMs: info.laadMs != null ? Math.round(info.laadMs) : (prev.laadMs != null ? prev.laadMs : null),
      meshes: info.meshes != null ? info.meshes : (prev.meshes != null ? prev.meshes : null),
      status: info.status || prev.status || 'onbekend',
      fout: info.fout || prev.fout || null,
      t: num((performance.now() - this.t0) / 1000, 3),
    };
    this.event('asset', { naam, ...this.assets[naam] });
    return this;
  }

  // Meet de bestandsgrootte via een HEAD-request. Werkt lokaal via de NMM-server, die
  // content-length meestuurt. Faalt stil (retourneert null) als de header ontbreekt.
  async _assetBytes(url) {
    try {
      const r = await fetch(url, { method: 'HEAD' });
      const len = r.headers.get('content-length');
      return len ? parseInt(len, 10) : null;
    } catch (_) { return null; }
  }

  // Extra secties van buitenaf: Telemetry.provider('mijnDing', () => ({...}))
  provider(name, fn) { this.providers.set(name, fn); return this; }

  // ── gebeurtenissen ───────────────────────────────────────────────────────
  event(type, data) {
    this.events.push({ t: num((performance.now() - this.t0) / 1000, 3), type, ...(data || {}) });
  }

  frame(dtMs) {
    this.frames.push(Math.round(dtMs * 100) / 100);
    this._accumMs += dtMs;

    const now = performance.now();
    if (now - this._lastInputT > 100) {
      this._lastInputT = now;
      const j = this.refs.joyState;
      if (j) this.input.push({
        t: num((now - this.t0) / 1000, 2),
        lx: num(j.left.x, 3), ly: num(j.left.y, 3),
        rx: num(j.right.x, 3), ry: num(j.right.y, 3),
      });
    }
  }

  // ── instrumentatie: wikkel bestaande functies zonder ze te herschrijven ──
  instrument() {
    if (this._instrumented) return this;
    this._instrumented = true;

    const T = this;
    const { ballistics, combatController, registry, matchDirector, engine } = this.refs;

    if (combatController && combatController.fireSalvo) {
      const orig = combatController.fireSalvo.bind(combatController);
      combatController.fireSalvo = (simTime, ship) => {
        T.counters.salvoRequested++;
        const before = combatController.lastFireT;
        const ok = orig(simTime, ship);
        if (ok) {
          T.counters.salvoAccepted++;
          T.event('salvo', {
            simTime: num(simTime), turrets: ship ? ship.turrets.length : 0,
            queued: combatController.pendingShots.length,
          });
        } else if (ship && ship.alive) {
          T.counters.salvoRejectedCooldown++;
          T.event('salvoGeweigerd', { reden: 'cooldown', simTime: num(simTime), sinds: num(simTime - before) });
        } else {
          T.counters.salvoRejectedOther++;
          T.event('salvoGeweigerd', { reden: ship ? 'schip dood' : 'geen schip' });
        }
        return ok;
      };
    }

    if (ballistics && ballistics.fire) {
      const orig = ballistics.fire.bind(ballistics);
      ballistics.fire = (pos, vel, opts) => {
        T.counters.shellsFired++;
        T.event('granaat', {
          van: vec(pos, 1),
          v: num(Math.hypot(vel.x, vel.y, vel.z), 1),
          elevGraden: num(Math.asin(Math.max(-1, Math.min(1, vel.y / Math.max(1e-6, Math.hypot(vel.x, vel.y, vel.z))))) * R2D, 2),
        });
        return orig(pos, vel, opts);
      };
    }

    if (ballistics) {
      const wrap = (key, counter, extra) => {
        const prev = ballistics[key];
        ballistics[key] = (...args) => {
          T.counters[counter]++;
          T.event(key, extra ? extra(...args) : {});
          if (prev) return prev(...args);
        };
      };
      wrap('onImpactWater',  'impactWater',  (pos) => ({ pos: vec(pos, 1) }));
      wrap('onImpactGround', 'impactGround', (pos) => ({ pos: vec(pos, 1) }));
      wrap('onImpactTarget', 'impactTarget', (emp, pos) => ({ id: emp && emp.id, pos: vec(pos, 1) }));
      wrap('onImpactShip',   'impactShip',   (ship, pos) => ({ pos: vec(pos, 1) }));
    }

    if (registry && registry.applyBlast) {
      const orig = registry.applyBlast.bind(registry);
      registry.applyBlast = (pos, dmg, rad) => {
        T.counters.blastApplied++;
        return orig(pos, dmg, rad);
      };
      const od = registry.onDestroyed;
      registry.onDestroyed = (emp) => {
        T.counters.emplacementsDestroyed++;
        T.event('doelVernietigd', {
          id: emp.id, type: emp.type, over: registry.aliveCount,
          objectievenOver: registry.objectiveRemaining,
        });
        if (od) od(emp);
      };
      const os = registry.onSpotted;
      registry.onSpotted = (emp, source) => {
        T.event('doelGeidentificeerd', { id: emp.id, type: emp.type, bron: source });
        if (os) os(emp, source);
      };
    }

    if (matchDirector) {
      const om = matchDirector.setMode.bind(matchDirector);
      matchDirector.setMode = (m) => { T.event('modus', { modus: m }); return om(m); };
      const ot = matchDirector.setTimeScale.bind(matchDirector);
      matchDirector.setTimeScale = (s) => { T.event('tijdschaal', { schaal: s }); return ot(s); };
    }

    // WebGPU bufferallocaties tellen en hardware-limieten omzeilen (Polyfill).
    try {
      const dev = engine && engine._device;
      if (dev && dev.createBuffer && !dev.__zbWrapped) {
        const orig = dev.createBuffer.bind(dev);
        dev.createBuffer = (desc) => {
          const size = (desc && desc.size) || 0;
          T.counters.gpuBuffersCreated++;
          T.counters.gpuBufferBytesTotal += size;
          if (size > T.counters.gpuBufferMaxSize) T.counters.gpuBufferMaxSize = size;
          if (desc && desc.mappedAtCreation && size > T.counters.gpuMappedBufferMaxSize) {
            T.counters.gpuMappedBufferMaxSize = size;
          }
          
          try {
            return orig(desc);
          } catch (e) {
            // --- ZEEBESLAG POLYFILL VOOR HARDE WEBGPU LIMIETEN ---
            // Als de GPU weigert de buffer direct te mappen (zoals de 512KB RangeError), 
            // simuleren we een gemapte buffer en handelen we de upload asynchroon af.
            if (desc && desc.mappedAtCreation && e.name === 'RangeError') {
              T.event('gpuPolyfill', { size, msg: 'mappedAtCreation limiet omzeild' });
              
              const altDesc = { ...desc, mappedAtCreation: false };
              altDesc.usage |= 8; // GPUBufferUsage.COPY_DST, nodig om asynchroon te schrijven
              
              const buf = orig(altDesc);
              let localMem = new ArrayBuffer(size);
              
              buf.getMappedRange = () => localMem;
              
              buf.unmap = () => {
                if (localMem) {
                  dev.queue.writeBuffer(buf, 0, localMem);
                  localMem = null;
                }
              };
              return buf;
            }

            // Reguliere foutafhandeling
            T.errors.push({
              t: num((performance.now() - T.t0) / 1000, 3), soort: 'gpu-createBuffer',
              size, mappedAtCreation: !!(desc && desc.mappedAtCreation),
              usage: desc && desc.usage, msg: String(e && e.message || e),
            });
            throw e;
          }
        };
        dev.__zbWrapped = true;
      }
    } catch (_) {}

    // Device loss hook...
    try {
      const dev = engine && engine._device;
      if (dev && dev.lost && !dev.__zbLostHooked) {
        dev.__zbLostHooked = true;
        dev.lost.then((info) => {
          const rec = { t: num((performance.now() - T.t0) / 1000, 3), soort: 'gpu-device-lost',
                        reden: info && info.reason, msg: (info && info.message) || 'geen bericht' };
          T.errors.push(rec);
          T.event('gpuDeviceLost', rec);
          if (window.__zbPushError) window.__zbPushError('gpu-device-lost', `WebGPU device verloren: ${rec.reden} - ${rec.msg}`);
        });
      }
    } catch (_) {}

    // Vuurknop tellen zonder controls.js aan te raken.
    const fb = document.getElementById('btnFire');
    if (fb) {
      const bump = () => { T.counters.fireButtonPresses++; T.event('vuurknop', {}); };
      fb.addEventListener('touchend', bump, { passive: true });
      fb.addEventListener('mouseup', bump);
    }

    this.event('instrumented', {});
    return this;
  }

  // ── globale foutafvang ───────────────────────────────────────────────────
  _hookGlobals() {
    const T = this;

    // Fouten die index.html al ving voordat deze module bestond.
    try {
      for (const e of (window.__zbEarlyErrors || [])) {
        T.errors.push({ t: num(e.t, 3), soort: 'vroeg:' + e.soort, msg: e.msg, bron: e.bron, regel: e.regel, stack: e.stack });
      }
    } catch (_) {}
    window.addEventListener('error', (e) => {
      T.errors.push({
        t: num((performance.now() - T.t0) / 1000, 3), soort: 'error',
        msg: (e && e.message) || 'onbekend',
        bron: e && e.filename, regel: e && e.lineno, kolom: e && e.colno,
        stack: (e && e.error && e.error.stack ? String(e.error.stack).slice(0, 1200) : null),
      });
    }, true);

    window.addEventListener('unhandledrejection', (e) => {
      const r = e && e.reason;
      T.errors.push({
        t: num((performance.now() - T.t0) / 1000, 3), soort: 'promise',
        msg: String((r && r.message) || r),
        stack: (r && r.stack ? String(r.stack).slice(0, 1200) : null),
      });
    });

    const ce = console.error.bind(console);
    console.error = (...args) => {
      T.errors.push({
        t: num((performance.now() - T.t0) / 1000, 3), soort: 'console',
        msg: args.map(a => (typeof a === 'string' ? a : safe(() => JSON.stringify(a), String(a)))).join(' ').slice(0, 800),
      });
      ce(...args);
    };
  }

  _hookVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.counters.visibilityHidden++;
      this.event('zichtbaarheid', { verborgen: document.hidden });
    });
    window.addEventListener('resize', () => { this.counters.resizes++; });
  }

  async _collectAsync() {
    try { if (navigator.getBattery) { const b = await navigator.getBattery(); this._async.battery = { level: b.level, charging: b.charging }; } } catch (_) {}
    try { if (navigator.storage && navigator.storage.estimate) this._async.storage = await navigator.storage.estimate(); } catch (_) {}
    try {
      if (navigator.gpu && navigator.gpu.requestAdapter) {
        const a = await navigator.gpu.requestAdapter();
        if (a) {
          const info = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : null);
          this._async.adapter = {
            info: info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : null,
            features: [...(a.features || [])],
            limits: this._limits(a.limits),
          };
        }
      }
    } catch (_) {}
  }

  _limits(l) {
    if (!l) return null;
    const out = {};
    const keys = ['maxTextureDimension2D','maxBufferSize','maxStorageBufferBindingSize','maxUniformBufferBindingSize',
      'maxComputeWorkgroupStorageSize','maxComputeInvocationsPerWorkgroup','maxComputeWorkgroupSizeX',
      'maxComputeWorkgroupsPerDimension','maxBindGroups','maxVertexBuffers','maxVertexAttributes',
      'maxColorAttachments','maxSamplersPerShaderStage','maxStorageTexturesPerShaderStage'];
    for (const k of keys) if (l[k] !== undefined) out[k] = l[k];
    return out;
  }

  // ── afgeleide statistiek ─────────────────────────────────────────────────
  _frameStats() {
    const a = this.frames.all();
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const q = p => s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))];
    const mean = a.reduce((x, y) => x + y, 0) / a.length;
    const wall = performance.now() - this.t0;
    return {
      steekproef: a.length,
      msGemiddeld: num(mean),
      fpsGemiddeld: num(1000 / mean, 1),
      msP50: num(q(0.5)), msP90: num(q(0.9)), msP99: num(q(0.99)),
      fpsP1Laag: num(1000 / q(0.99), 1),
      msMax: num(s[s.length - 1]),
      frames40ms: a.filter(x => x > 40).length,
      frames80ms: a.filter(x => x >= 79.9).length,   // geklemd door Math.min(dt, 80) in main
      wandklokS: num(wall / 1000),
      gerenderdS: num(this._accumMs / 1000),
      // <1 betekent dat de renderloop niet liep: achtergrond, throttling of een stall.
      loopdekking: num(this._accumMs / Math.max(wall, 1), 3),
      ruweFrametijden: a,
    };
  }

  _logHistory() {
    const D = this.refs.Debug;
    if (D && typeof D.getLogBuffer === 'function') return { bron: 'debug.getLogBuffer', regels: D.getLogBuffer() };
    try {
      const raw = localStorage.getItem('zeebeslag_debug_log');
      if (raw) return { bron: 'localStorage (alleen laatste 150, mogelijk verouderd)', regels: JSON.parse(raw) };
    } catch (_) {}
    return { bron: 'niet beschikbaar', regels: [] };
  }

  // ── de dump ──────────────────────────────────────────────────────────────
  snapshot() {
    const r = this.refs;
    const engine = r.engine, scene = r.scene, cam = r.cam;
    const ship = r.playerShip, ball = r.ballistics, cc = r.combatController;
    const reg = r.registry, isl = r.island, md = r.matchDirector, wg = r.wavesGen;
    const dn = r.defenseNetwork;

    const simTime = safe(() => (r.getSimTime ? r.getSimTime() : null));
    const aimTarget = safe(() => (r.getAimTarget ? r.getAimTarget() : null));

    const snap = {
      _schema: 'zeebeslag-telemetrie/2',

      meta: safe(() => ({
        build: this.build,
        tijdstempel: new Date().toISOString(),
        paginaLeeftijdS: num((performance.now() - this.t0) / 1000),
        url: location.href,
        hash: location.hash,
        userAgent: navigator.userAgent,
        uaData: navigator.userAgentData ? {
          merken: navigator.userAgentData.brands, mobiel: navigator.userAgentData.mobile,
          platform: navigator.userAgentData.platform,
        } : null,
        taal: navigator.language,
        zichtbaar: !document.hidden,
        fullscreen: !!document.fullscreenElement,
        orientatie: safe(() => screen.orientation && screen.orientation.type),
      })),

      hardware: safe(() => ({
        devicePixelRatio: window.devicePixelRatio,
        venster: `${window.innerWidth}x${window.innerHeight}`,
        scherm: `${screen.width}x${screen.height}`,
        kernen: navigator.hardwareConcurrency || null,
        geheugenGB: navigator.deviceMemory || null,
        maxTouchPoints: navigator.maxTouchPoints,
        verbinding: navigator.connection ? {
          type: navigator.connection.effectiveType, downlink: navigator.connection.downlink,
          rtt: navigator.connection.rtt, dataBesparing: navigator.connection.saveData,
        } : null,
        accu: this._async.battery,
        opslag: this._async.storage,
        jsHeap: performance.memory ? {
          gebruiktMB: num(performance.memory.usedJSHeapSize / 1048576, 1),
          totaalMB: num(performance.memory.totalJSHeapSize / 1048576, 1),
          limietMB: num(performance.memory.jsHeapSizeLimit / 1048576, 1),
        } : null,
      })),

      webgpu: safe(() => ({
        ondersteund: !!navigator.gpu,
        adapter: this._async.adapter,
        deviceLimieten: engine && engine._device ? this._limits(engine._device.limits) : null,
        deviceFeatures: engine && engine._device ? [...(engine._device.features || [])] : null,
        bufferTellers: {
          aangemaakt: this.counters.gpuBuffersCreated,
          totaalMB: num(this.counters.gpuBufferBytesTotal / 1048576, 2),
          grootste: this.counters.gpuBufferMaxSize,
          grootsteMappedAtCreation: this.counters.gpuMappedBufferMaxSize,
        },
      })),

      engine: safe(() => ({
        babylon: BABYLON.Engine.Version,
        klasse: engine && engine.getClassName ? engine.getClassName() : null,
        isWebGPU: !!(engine && engine.isWebGPU),
        hardwareScaling: engine ? engine.getHardwareScalingLevel() : null,
        renderBuffer: engine ? `${engine.getRenderWidth()}x${engine.getRenderHeight()}` : null,
        gpuFrameTijdMs: safe(() => engine && engine.gpuFrameTimeCounter ? num(engine.gpuFrameTimeCounter.current / 1e6, 3) : null),
        drawCalls: safe(() => engine && engine._drawCalls ? engine._drawCalls.current : null),
        actieveIndices: safe(() => scene && scene._activeIndices ? scene._activeIndices.current : null),
      })),

      performanceProfiel: safe(() => ({
        profiel: r.performanceProfile || null,
        renderResolutie: r.getRenderResolution ? r.getRenderResolution() : null,
        depthRenderMeshes: r.getDepthRenderCount ? r.getDepthRenderCount() : null,
        wake: r.wakeManager && r.wakeManager.performanceStats ? r.wakeManager.performanceStats : null,
      })),

      prestaties: this._frameStats(),

      // M4.9: laatste Sun Sweep metingen (per tegel: zonstand, gpuMs, cpuMs, capture-route).
      zonSweep: safe(() => (r.sunSweep && r.sunSweep.laatsteResultaten) ? r.sunSweep.laatsteResultaten : null),

      tellers: { ...this.counters },

      scene: safe(() => ({
        meshes: scene.meshes.length,
        actieveMeshes: scene.getActiveMeshes().length,
        materialen: scene.materials.length,
        texturen: scene.textures.length,
        lichten: scene.lights.length,
        transformNodes: scene.transformNodes.length,
        mist: { modus: scene.fogMode, dichtheid: scene.fogDensity },
        camera: cam ? {
          naam: cam.name, positie: vec(cam.position), rotatie: vec(cam.rotation, 3),
          fov: num(cam.fov, 3), minZ: cam.minZ, maxZ: cam.maxZ,
        } : null,
        inventaris: scene.meshes.slice(0, MAX_MESHES).map(m => ({
          naam: m.name,
          klasse: m.getClassName ? m.getClassName() : '?',
          verts: m.getTotalVertices ? m.getTotalVertices() : 0,
          aan: m.isEnabled(false),
          zichtbaar: m.isVisible,
          pickbaar: m.isPickable,
          materiaal: m.material ? m.material.name : null,
        })),
        meshesAfgekapt: Math.max(0, scene.meshes.length - MAX_MESHES),
      })),

      oceaan: safe(() => ({
        gebakken: wg ? !!wg.baked : null,
        geometrie: safe(() => r.oceanRig && r.oceanRig.quality ? r.oceanRig.quality : null),
        lengteSchalen: wg && wg.lengthScale ? [...wg.lengthScale] : [],
        oceaanTijdS: r.getOceanTime ? num(r.getOceanTime()) : null,
      })),

      cfg: this.cfg ? { ...this.cfg } : null,

      director: safe(() => md ? {
        state: md.state, modus: md.mode, tijdschaal: md.timeScale,
        gameTijdS: num(md.gameTime), actief: md.isGameplayActive, gepauzeerd: md.isPaused,
        gameOver: md.gameOver, godMode: md.godMode, filmLook: md.filmLook,
      } : null),

      schip: safe(() => {
        if (!ship) return null;
        const mp = new BABYLON.Vector3(), md2 = new BABYLON.Vector3();
        return {
          positie: vec(ship.root.position), koersRad: num(ship.heading, 4),
          snelheid: num(ship.speed), gas: num(ship.throttle), roer: num(ship.rudder),
          hp: ship.hp, maxHp: ship.maxHp, alive: ship.alive, zinkend: ship.sinking,
          glbGeladen: ship.isModelLoaded
            ? ship.isModelLoaded()
            : !!(ship.glbHolder && ship.meshes && ship.meshes.length),
          glbBestand: ship.modelSourceFile || null,
          glbMeshes: Array.isArray(ship.meshes) ? ship.meshes.length : 0,
          modelOptimalisatie: ship.modelOptimization || null,
          modelSchaal: num(ship.modelScale, 6),
          modelAfmetingenM: ship.modelBounds && ship.modelBounds.scaled ? {
            breedte: num(ship.modelBounds.scaled.width, 2),
            hoogte: num(ship.modelBounds.scaled.height, 2),
            lengteZ: num(ship.modelBounds.scaled.length, 2),
            langsteHorizontaleAs: num(ship.modelBounds.scaled.horizontalLength, 2),
          } : null,
          aantalTurrets: ship.turrets.length,
          navigatieContact: ship.navigationContact ? {
            reden: ship.navigationContact.reason,
            grens: !!ship.navigationContact.boundary,
            terrein: !!ship.navigationContact.terrain,
            glijdt: !!ship.navigationContact.slid,
            vrijeRuimteM: num(ship.navigationContact.clearance, 2),
          } : null,
          richtfoutGraden: aimTarget && ship.aimError
            ? num(ship.aimError(aimTarget, this.cfg ? this.cfg.muzzleVelocity : 300) * R2D, 3) : null,
          turrets: ship.turrets.map((t, i) => {
            ship.getMuzzle(mp, md2, i);
            return {
              i, gekoppeld: !!t.bound, mesh: t.mesh ? t.mesh.name : null,
              yawGraden: num(t.yaw * R2D, 2),
              elevGraden: num(t.elev * R2D, 2),
              rustYawGraden: num((t.restYaw || 0) * R2D, 2),
              slewRate: t.slewRate, elevRate: t.elevRate,
              yawGrens: [t.minYaw, t.maxYaw],
              elevGrens: [num(t.minElev, 4), num(t.maxElev, 4)],
              loopLengte: t.barrel, draaipuntAchter: num(t.pivotBack),
              monding: vec(mp, 1), looprichting: vec(md2, 4),
            };
          }),
        };
      }),

      gevecht: safe(() => cc ? {
        simTijdS: num(simTime),
        laatsteVuurT: num(cc.lastFireT),
        cooldownS: this.cfg ? this.cfg.fireCooldown : null,
        gereed: num(cc.getFireReady(simTime || 0), 3),
        wachtrij: cc.pendingShots.length,
        wachtrijInhoud: cc.pendingShots.slice(0, 20).map(s => ({ turret: s.turret, om: num(s.at) })),
        vijandVuurT: num(cc.enemyFireT),
      } : null),

      ballistiek: safe(() => ball ? {
        zwaartekracht: ball.g,
        terreinGekoppeld: !!ball.terrain,
        registerGekoppeld: !!ball.registry,
        scheepsdoelen: ball.targets.map(t => ({ naam: t.ship && t.ship.root ? t.ship.root.name : '?', straal: t.radius })),
        aantalProjectielen: ball.projectiles.length,
        projectielen: ball.projectiles.slice(0, MAX_PROJECTILES).map(p => ({
          pos: vec(p.pos, 1), snelheid: vec(p.vel, 1),
          v: num(Math.hypot(p.vel.x, p.vel.y, p.vel.z), 1),
          leeftijdS: num(p.age),
        })),
      } : null),

      mikpunt: safe(() => aimTarget ? {
        positie: vec(aimTarget, 1),
        afstandTotSchip: ship ? num(Math.hypot(aimTarget.x - ship.root.position.x, aimTarget.z - ship.root.position.z), 1) : null,
      } : null),

      doelen: safe(() => reg ? {
        totaal: reg.total, levend: reg.aliveCount,
        objectieven: reg.objectiveCount, objectievenOver: reg.objectiveRemaining,
        typesLevend: reg.typeCounts ? reg.typeCounts(true) : null,
        lijst: reg.list.map(e => ({
          id: e.id, type: e.type, label: e.label, staat: e.state, alive: e.alive,
          objectief: e.objective !== false, hp: num(e.hp, 1), maxHp: e.maxHp,
          schadeFactor: num(e.damageTakenMultiplier, 3), straal: e.radius,
          contact: e.contactSource || 'none', alertSinds: num(e.alertSince),
          laatsteVuurT: num(e.lastFireT), positie: vec(e.root.position, 1),
        })),
      } : null),

      verdedigingsnetwerk: safe(() => dn ? {
        ...dn.status,
        configuratie: { ...dn.cfg },
      } : null),

      eiland: safe(() => isl ? {
        positie: vec(isl.root.position, 1),
        voetafdrukStraal: num(isl.hitRadius, 1),
        topY: num(isl._topY, 1), botY: num(isl._botY, 1),
        pickbareMeshes: isl._pickables ? isl._pickables.length : 0,
        tuning: isl.tuneConfig,
        glbGeladen: !!isl.glbHolder,
      } : null),

      invoer: safe(() => ({
        joyLinks: r.joyState ? { x: num(r.joyState.left.x, 3), y: num(r.joyState.left.y, 3) } : null,
        joyRechts: r.joyState ? { x: num(r.joyState.right.x, 3), y: num(r.joyState.right.y, 3) } : null,
        altKnoppen: r.altState ? { ...r.altState } : null,
        vuurknopZichtbaar: safe(() => {
          const b = document.getElementById('btnFire');
          if (!b) return 'ontbreekt in de DOM';
          const cs = getComputedStyle(b), rc = b.getBoundingClientRect();
          return { display: cs.display, pointerEvents: cs.pointerEvents, opacity: cs.opacity,
                   rect: { x: Math.round(rc.x), y: Math.round(rc.y), w: Math.round(rc.width), h: Math.round(rc.height) } };
        }),
        // Wat ligt er onder het midden van de vuurknop? Een onzichtbare overlay hier is de
        // klassieke reden dat een knop niet reageert.
        elementOpVuurknop: safe(() => {
          const b = document.getElementById('btnFire');
          if (!b) return null;
          const rc = b.getBoundingClientRect();
          const el = document.elementFromPoint(rc.x + rc.width / 2, rc.y + rc.height / 2);
          return el ? (el.id || el.className || el.tagName) : null;
        }),
        samples: this.input.all(),
      })),

      opslag: safe(() => {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!/^(zb|ocean|zeebeslag)/i.test(k)) continue;
          const v = localStorage.getItem(k);
          out[k] = v.length > 200 ? `[${v.length} tekens]` : v;
        }
        return out;
      }),

      assets: safe(() => {
        const list = this.assets;
        let totaal = 0;
        for (const k in list) if (list[k].bytes) totaal += list[k].bytes;
        return {
          totaalMB: +(totaal / 1048576).toFixed(2),
          bestanden: list,
        };
      }),

      gebeurtenissen: this.events.all(),
      fouten: this.errors.all(),
      logHistorie: this._logHistory(),
    };

    for (const [name, fn] of this.providers) snap[name] = safe(fn);
    return snap;
  }

  // ── uitvoer ──────────────────────────────────────────────────────────────
  json(pretty = true) { return JSON.stringify(this.snapshot(), null, pretty ? 2 : 0); }

  download() {
    try {
      const blob = new Blob([this.json()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `zeebeslag_telemetrie_${Date.now()}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      if (navigator.vibrate) navigator.vibrate(50);
      return true;
    } catch (e) { console.error('telemetrie-download mislukt', e); return false; }
  }

  async copy() {
    try { await navigator.clipboard.writeText(this.json()); if (navigator.vibrate) navigator.vibrate([20, 40, 20]); return true; }
    catch (e) { console.error('klembord mislukt', e); return false; }
  }

  // De zwevende TEL-knop is verdwenen. Er is nog precies één technische knop in het hele spel,
  // en die zit in src/ui/devPanel.js, tabblad EXPORT. Deze methode blijft bestaan zodat oude
  // aanroepen niet crashen, maar hij bouwt niets meer.
  mountButton() {
    return this;
  }
}

export const Telemetry = new TelemetryClass();
