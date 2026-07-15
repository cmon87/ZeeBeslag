// src/game/islandTarget.js
//
// M3.1: statisch doelwit-eiland met cinematografische upgrades.
// Inclusief PBR-overrides, schaduwontvangst, vlak PBR-materiaal (natte-kustlijn-plugin verwijderd: crashte op Adreno/WebGPU)
// met volledige WGSL/WebGPU ondersteuning voor moderne GPU's, en geoptimaliseerde 
// 24x24px native mobiele UI hitboxes.
// M6.6: statische eilanddelen worden per materiaal samengevoegd voor minder draw calls.

import { mergeStaticMeshesByMaterial } from '../core/meshOptimizer.js';

const DEFAULT_TUNE = { scaleX: 2.4, scaleY: 1.3, scaleZ: 3.6, submerge: 0.1 };
const HEIGHTMAP_TARGET_M = 8;
const HEIGHTMAP_MAX = 512;
const HEIGHTMAP_MIN = 256;
const LOS_MIN_STEP_M = 4;
const LOS_MAX_SAMPLES = 512;

// Native Shader Plugin voor natte rotsen rondom de waterlijn (Y=0)
// M3.1 FIX: Volledige WGSL (WebGPU) en GLSL (WebGL2) ondersteuning voor Adreno GPU's
export class IslandTarget {
  constructor(scene, opts = {}) {
    this._scene = scene;
    this.root = new BABYLON.TransformNode('islandRoot', scene);
    this.root.rotationQuaternion = BABYLON.Quaternion.Identity();

    if (opts.position) this.root.position.copyFrom(opts.position);

    this.static = true;
    this.heading = 0;
    this.speed = 0;
    this.throttle = 0;
    this.rudder = 0;

    this.maxHp = opts.maxHp ?? 400;
    this.hp = this.maxHp;
    this.alive = true;
    this.sinking = false;
    this.gone = false;

    this.turrets = [];
    this.hitRadius = opts.hitRadius ?? 90;

    this._size = opts.size ?? 1200;
    this.tuneConfig = { ...DEFAULT_TUNE, ...(opts.tune || {}) };
    this._submerge = this.tuneConfig.submerge;

    this._pickables = [];
    this._hm = null;          
    this._hmRes = 0;
    this._hmX0 = 0; this._hmZ0 = 0; this._hmSpan = 1;
    this._topY = 500;
    this._botY = -200;
    this._footR2 = 0;
    this._bakeTimer = null;
    this._disposed = false;
    this.optimizeMeshes = opts.optimizeMeshes !== false;
    this.freezeStaticMaterials = opts.freezeStaticMaterials !== false;
    this.maxMergeVertices = Number(opts.maxMergeVertices || 250000);
    this.modelOptimization = null;
  }

  addTurret() { return null; }
  aimTurretsAt() { }
  nextTurret() { return -1; }
  getMuzzle(outPos, outDir) {
    if (outPos) outPos.copyFrom(this.root.position);
    if (outDir) outDir.set(0, 0, 1);
  }

  damage(amount) {
    if (!this.alive) return false;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp === 0) { this.alive = false; return true; }
    return false;
  }

  respawn(position, _heading) {
    this.hp = this.maxHp;
    this.alive = true;
    this.sinking = false;
    this.gone = false;
    this.root.setEnabled(true);
    if (position) this.root.position.copyFrom(position);
  }

  update(_dt) { }
  floatOnly(_dt) { }

  sample(x, z) {
    const hm = this._hm;
    if (!hm) return null;
    const res = this._hmRes;
    const fx = (x - this._hmX0) / this._hmSpan * (res - 1);
    const fz = (z - this._hmZ0) / this._hmSpan * (res - 1);
    if (fx < 0 || fz < 0 || fx > res - 1 || fz > res - 1) return null;

    const x0 = fx | 0, z0 = fz | 0;
    const x1 = Math.min(x0 + 1, res - 1), z1 = Math.min(z0 + 1, res - 1);
    const tx = fx - x0, tz = fz - z0;

    let a = hm[z0 * res + x0], b = hm[z0 * res + x1];
    let c = hm[z1 * res + x0], d = hm[z1 * res + x1];

    const na = a === a, nb = b === b, nc = c === c, nd = d === d;
    
    if (!na && !nb && !nc && !nd) return null;
    
    if (!na) a = 0;
    if (!nb) b = 0;
    if (!nc) c = 0;
    if (!nd) d = 0;

    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  bounds() {
    if (!this._hm) return null;
    return { x0: this._hmX0, z0: this._hmZ0, span: this._hmSpan };
  }

  // Heightmap-gebaseerde line-of-sight. De visuele eilandmeshes blijven bewust niet-pickable:
  // raycasts tegen 1,25 miljoen driehoeken zijn te duur en werkten bovendien niet doordat de
  // GLB-hiërarchie dieper ligt dan island.root. Zichtbaarheid en rendering zijn zo ontkoppeld.
  hasLineOfSight(from, to, opts = {}) {
    if (this._disposed || !from || !to) return false;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const distance = Math.hypot(dx, dy, dz);
    if (!Number.isFinite(distance)) return false;
    if (distance <= 1e-3 || !this._hm) return true;

    const startMargin = Math.max(0, opts.startMargin ?? 8);
    const endMargin = Math.max(0, opts.endMargin ?? opts.endpointMargin ?? 24);
    const usable = distance - startMargin - endMargin;
    if (usable <= 0) return true;

    const texel = this._hmSpan / Math.max(1, this._hmRes - 1);
    const requestedStep = opts.step ?? texel * 0.75;
    const step = Math.max(LOS_MIN_STEP_M, Number.isFinite(requestedStep) ? requestedStep : LOS_MIN_STEP_M);
    const sampleCount = Math.min(LOS_MAX_SAMPLES, Math.max(1, Math.ceil(usable / step)));
    const clearance = Math.max(0, opts.clearance ?? 1.5);

    for (let i = 1; i <= sampleCount; i++) {
      const along = startMargin + usable * (i / (sampleCount + 1));
      const t = along / distance;
      const x = from.x + dx * t;
      const y = from.y + dy * t;
      const z = from.z + dz * t;
      const ground = this.sample(x, z);
      if (ground !== null && ground + clearance >= y) return false;
    }
    return true;
  }

  bakeHeightmap(res = 0) {
    if (!this._pickables.length) return 0;
    const t0 = performance.now();

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    const wms = [];
    for (const m of this._pickables) {
      m.unfreezeWorldMatrix();
      m.computeWorldMatrix(true);
      wms.push(m.getWorldMatrix());
      const bb = m.getBoundingInfo().boundingBox;
      const lo = bb.minimumWorld, hi = bb.maximumWorld;
      if (lo.x < minX) minX = lo.x; if (hi.x > maxX) maxX = hi.x;
      if (lo.z < minZ) minZ = lo.z; if (hi.z > maxZ) maxZ = hi.z;
      if (lo.y < minY) minY = lo.y; if (hi.y > maxY) maxY = hi.y;
    }
    const span = Math.max(maxX - minX, maxZ - minZ) * 1.02;
    const cx = (minX + maxX) * 0.5, cz = (minZ + maxZ) * 0.5;

    if (!res) {
      const want = Math.pow(2, Math.ceil(Math.log2(span / HEIGHTMAP_TARGET_M)));
      res = Math.max(HEIGHTMAP_MIN, Math.min(HEIGHTMAP_MAX, want));
    }
    this._hmX0 = cx - span * 0.5;
    this._hmZ0 = cz - span * 0.5;
    this._hmSpan = span;
    this._hmRes = res;

    const hm = new Float32Array(res * res).fill(NaN);
    const v = new BABYLON.Vector3();
    let count = 0;

    for (let mi = 0; mi < this._pickables.length; mi++) {
      const pos = this._pickables[mi].getVerticesData(BABYLON.VertexBuffer.PositionKind);
      if (!pos) continue;
      const wm = wms[mi];
      for (let i = 0; i < pos.length; i += 3) {
        v.set(pos[i], pos[i + 1], pos[i + 2]);
        BABYLON.Vector3.TransformCoordinatesToRef(v, wm, v);
        const gx = (((v.x - this._hmX0) / span) * (res - 1)) | 0;
        const gz = (((v.z - this._hmZ0) / span) * (res - 1)) | 0;
        if (gx < 0 || gz < 0 || gx >= res || gz >= res) continue;
        const k = gz * res + gx;
        if (!(hm[k] >= v.y)) hm[k] = v.y;   
        count++;
      }
    }

    const src = hm.slice();
    for (let z = 1; z < res - 1; z++) {
      for (let x = 1; x < res - 1; x++) {
        const k = z * res + x;
        if (src[k] === src[k]) continue;
        let n = 0, mx = -Infinity;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const s = src[(z + dz) * res + (x + dx)];
          if (s === s) { n++; if (s > mx) mx = s; }
        }
        if (n >= 3) hm[k] = mx;
      }
    }

    this._hm = hm;
    this._topY = maxY + 20;
    this._botY = minY - 20;
    const r = span * 0.5;
    this._footR2 = r * r;
    this.hitRadius = r;

    for (const m of this._pickables) { m.isPickable = false; m.freezeWorldMatrix(); }

    const ms = performance.now() - t0;
    this.bakeStats = {
      res, vertices: count, ms: Math.round(ms), span: Math.round(span),
      meterPerTexel: +(span / res).toFixed(1),
      hoogte: Math.round(maxY - minY),
      centrum: [Math.round(cx), Math.round(cz)],
      root: [Math.round(this.root.position.x), Math.round(this.root.position.z)],
      dekt: Math.abs(cx - this.root.position.x) < span * 0.5 && Math.abs(cz - this.root.position.z) < span * 0.5,
    };
    return ms;
  }

  _scheduleRebake() {
    if (this._disposed) return;
    if (this._bakeTimer) clearTimeout(this._bakeTimer);
    this._bakeTimer = setTimeout(() => {
      this._bakeTimer = null;
      if (!this._disposed) this.bakeHeightmap(this._hmRes || 256);
    }, 220);
  }

  async loadGLB(rootUrl, file, opts = {}) {
    const _zbT0 = performance.now();
    let _zbBytes = null;
    try {
      const _hr = await fetch(rootUrl + file, { method: 'HEAD' });
      const _cl = _hr.headers.get('content-length');
      _zbBytes = _cl ? parseInt(_cl, 10) : null;
    } catch (_) {}
    let res;
    try {
      res = await BABYLON.SceneLoader.ImportMeshAsync('', rootUrl, file, this._scene);
    } catch (e) {
      try { if (window.zbTel) window.zbTel.asset(file, { bytes: _zbBytes, laadMs: performance.now() - _zbT0, status: 'fout', fout: String(e && e.message || e) }); } catch (_) {}
      throw e;
    }
    if (!res || !Array.isArray(res.meshes) || res.meshes.length === 0) {
      throw new Error(`Eilandmodel ${file} bevat geen meshes`);
    }
    try {
      if (window.zbTel) window.zbTel.asset(file, { bytes: _zbBytes, laadMs: performance.now() - _zbT0, meshes: res.meshes.length, status: 'ok' });
    } catch (_) {}
    if (this._disposed) {
      for (const m of res.meshes) { try { m.dispose(false, true); } catch (_) {} }
      throw new Error(`IslandTarget is disposed tijdens laden van ${file}`);
    }

    const holder = new BABYLON.TransformNode(file + '_holder', this._scene);
    const glbRoot = res.meshes[0];
    if (!glbRoot) {
      holder.dispose();
      throw new Error(`Eilandmodel ${file} heeft geen geldige rootmesh`);
    }

    this._pickables = [];
    res.meshes.forEach((m) => {
      if (m.getTotalVertices && m.getTotalVertices() > 0) {
        m.isPickable = false;        
        m.__zbIsland = true;
        m.receiveShadows = true; 
        
        // PBR Upgrade & Shader Injectie
        if (m.material) {
          let pbr;
          if (m.material.getClassName() === "PBRMaterial") {
            pbr = m.material;
          } else {
            pbr = new BABYLON.PBRMaterial(m.material.name + "_pbr", this._scene);
            if (m.material.diffuseTexture) pbr.albedoTexture = m.material.diffuseTexture;
            if (m.material.bumpTexture) pbr.bumpTexture = m.material.bumpTexture;
            m.material = pbr;
          }
          
          pbr.metallic = 0.02;
          pbr.roughness = 0.85; 
          pbr.environmentIntensity = 1.0; 
          
        }

        this._pickables.push(m);
      } else {
        m.isPickable = false;
      }
    });

    glbRoot.parent = holder;
    glbRoot.computeWorldMatrix(true);
    const sourceBounds = glbRoot.getHierarchyBoundingVectors(true);

    const optimized = mergeStaticMeshesByMaterial(this._pickables, {
      enabled: opts.optimizeMeshes ?? this.optimizeMeshes,
      holder,
      nodes: [...res.meshes, ...((res.transformNodes || []).filter(Boolean))],
      namePrefix: 'islandMerged',
      freezeMaterials: opts.freezeStaticMaterials ?? this.freezeStaticMaterials,
      maxVerticesPerMerge: opts.maxMergeVertices ?? this.maxMergeVertices,
    });
    this._pickables = optimized.meshes;
    this.modelOptimization = optimized.stats;

    holder.rotation.x = (opts.tiltX !== undefined) ? opts.tiltX : 0;
    holder.rotation.y = (opts.tiltY !== undefined) ? opts.tiltY : -Math.PI / 2;
    holder.rotation.z = (opts.tiltZ !== undefined) ? opts.tiltZ : 0;
    holder.computeWorldMatrix(true);

    const bb = sourceBounds;
    this._baseSx = bb.max.x - bb.min.x;
    this._baseSy = bb.max.y - bb.min.y;
    this._baseSz = bb.max.z - bb.min.z;
    this._baseMinY = bb.min.y;

    const widest = Math.max(this._baseSx, this._baseSz, 1e-3);
    this._baseScale = (opts.size ?? this._size) / widest;

    holder.scaling.setAll(this._baseScale);
    holder.computeWorldMatrix(true);

    const height = this._baseSy;
    holder.position.y = -this._baseMinY - height * this._submerge;
    holder.parent = this.root;

    this.glbHolder = holder;
    this.applyTuning(false);          
    this.bakeHeightmap();             
    this.createTunerUI();

    return {
      meshCount: this._pickables.length,
      sourceMeshCount: optimized.stats.sourceMeshes,
      optimization: this.modelOptimization,
      scale: this._baseScale,
      hitRadius: this.hitRadius,
      modelSize: { x: this._baseSx, y: this._baseSy, z: this._baseSz },
      bake: this.bakeStats,
    };
  }

  applyTuning(rebake = true) {
    if (!this.glbHolder) return;
    const sx = this._baseScale * this.tuneConfig.scaleX;
    const sy = this._baseScale * this.tuneConfig.scaleY;
    const sz = this._baseScale * this.tuneConfig.scaleZ;

    this.glbHolder.scaling.set(sx, sy, sz);
    this.glbHolder.computeWorldMatrix(true);

    const height = this._baseSy * sy;
    this.glbHolder.position.y = (-this._baseMinY * sy) - (height * this.tuneConfig.submerge);
    if (rebake) this._scheduleRebake();   
  }

  exportConfigJSON() {
    const data = {
      file: "ocean_rocky_island.glb",
      baseSize: this._size,
      tuneConfig: this.tuneConfig,
      finalScale: {
        x: this._baseScale * this.tuneConfig.scaleX,
        y: this._baseScale * this.tuneConfig.scaleY,
        z: this._baseScale * this.tuneConfig.scaleZ
      },
      finalPositionY: this.glbHolder.position.y,
      hitRadius: this.hitRadius
    };

    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "island_config.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  toggleTuner(force) {
    if (!this.tunerUI) return;
    const isHidden = this.tunerUI.style.display === 'none';
    const show = force !== undefined ? force : isHidden;
    this.tunerUI.style.display = show ? 'block' : 'none';
  }

  createTunerUI() {
    if (document.getElementById('islandTunerUI')) return;

    const container = document.createElement('div');
    container.id = 'islandTunerUI';
    container.setAttribute('data-ui', '');

    container.style.cssText = `
      display: none; position: fixed; top: 60px; left: 12px;
      width: 260px; background: rgba(15, 15, 20, 0.90);
      border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 12px;
      padding: 12px; color: #fff; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: 12px; z-index: 99000; user-select: none;
      -webkit-user-select: none; -webkit-touch-callout: none;
      touch-action: none; box-shadow: 0 5px 25px rgba(0,0,0,0.8);
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    `;

    const stopEvents = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel', 'touchstart', 'touchmove', 'touchend', 'touchcancel'];
    stopEvents.forEach((evt) => {
      container.addEventListener(evt, (e) => {
        e.stopPropagation(); e.stopImmediatePropagation();
      }, { passive: false });
    });

    const btnClose = document.createElement('button');
    btnClose.innerText = 'X';
    btnClose.style.cssText = `
      position: absolute; top: 8px; right: 8px;
      background: none; border: none; color: #ff7a68;
      font-size: 18px; font-weight: bold; padding: 4px 8px;
      cursor: pointer; touch-action: none; min-width: 24px; min-height: 24px;
    `;
    btnClose.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); e.stopImmediatePropagation();
      this.toggleTuner(false);
    });
    container.appendChild(btnClose);

    const title = document.createElement('div');
    title.innerText = 'Eiland Tuner (Sleepbaar)';
    title.style.cssText = `
      font-weight: 800; margin-bottom: 12px; margin-right: 20px;
      text-align: center; text-transform: uppercase; letter-spacing: 1px;
      font-size: 11px; color: #E0E0E0; padding: 6px; min-height: 24px;
      background: rgba(255,255,255,0.1); border-radius: 6px;
      cursor: grab; touch-action: none;
    `;
    container.appendChild(title);

    let isDraggingMenu = false;
    let dragStartX = 0, dragStartY = 0;
    let menuStartLeft = 0, menuStartTop = 0;

    title.addEventListener('pointerdown', (e) => {
      isDraggingMenu = true; title.setPointerCapture(e.pointerId);
      title.style.cursor = 'grabbing'; title.style.background = 'rgba(255,255,255,0.2)';
      dragStartX = e.clientX; dragStartY = e.clientY;
      const rect = container.getBoundingClientRect();
      menuStartLeft = rect.left; menuStartTop = rect.top;
      e.stopPropagation(); e.stopImmediatePropagation();
    });

    title.addEventListener('pointermove', (e) => {
      if (!isDraggingMenu || !title.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - dragStartX; const dy = e.clientY - dragStartY;
      container.style.left = `${menuStartLeft + dx}px`;
      container.style.top = `${menuStartTop + dy}px`;
      container.style.right = 'auto'; container.style.bottom = 'auto';
      e.stopPropagation(); e.stopImmediatePropagation();
    });

    const stopMenuDrag = (e) => {
      if (!isDraggingMenu) return;
      isDraggingMenu = false; title.releasePointerCapture(e.pointerId);
      title.style.cursor = 'grab'; title.style.background = 'rgba(255,255,255,0.1)';
      e.stopPropagation(); e.stopImmediatePropagation();
    };

    title.addEventListener('pointerup', stopMenuDrag);
    title.addEventListener('pointercancel', stopMenuDrag);

    const createSlider = (labelTxt, key, min, max, step) => {
      const wrapper = document.createElement('div');
      wrapper.style.marginBottom = '12px';

      const label = document.createElement('div');
      label.style.display = 'flex'; label.style.justifyContent = 'space-between';
      label.style.marginBottom = '6px';

      const nameSpan = document.createElement('span');
      nameSpan.innerText = labelTxt;
      nameSpan.style.color = '#B0B0B0'; nameSpan.style.fontWeight = '600';

      const valSpan = document.createElement('span');
      valSpan.innerText = this.tuneConfig[key].toFixed(2);
      valSpan.style.fontFamily = 'monospace'; valSpan.style.color = '#4EA8DE';

      label.appendChild(nameSpan); label.appendChild(valSpan);

      const track = document.createElement('div');
      track.style.width = '100%'; track.style.height = '24px';
      track.style.minHeight = '24px';
      track.style.background = 'rgba(255,255,255,0.08)'; track.style.borderRadius = '12px';
      track.style.position = 'relative'; track.style.overflow = 'hidden'; track.style.touchAction = 'none';

      const fill = document.createElement('div');
      fill.style.height = '100%'; fill.style.background = 'linear-gradient(90deg, #007AFF, #00C6FF)';
      fill.style.width = '0%'; fill.style.pointerEvents = 'none'; fill.style.borderRadius = '12px';

      track.appendChild(fill); wrapper.appendChild(label); wrapper.appendChild(track);

      const updateVisuals = (val) => {
        valSpan.innerText = val.toFixed(2);
        const pct = ((val - min) / (max - min)) * 100;
        fill.style.width = pct + '%';
      };

      updateVisuals(this.tuneConfig[key]);

      let isDragging = false;

      const onPointerMove = (e) => {
        const rect = track.getBoundingClientRect();
        let pct = (e.clientX - rect.left) / rect.width;
        pct = Math.max(0, Math.min(1, pct));
        let val = min + pct * (max - min);
        val = Math.round(val / step) * step;

        if (this.tuneConfig[key] !== val) {
          this.tuneConfig[key] = val;
          updateVisuals(val);
          this.applyTuning();
        }
      };

      track.addEventListener('pointerdown', (e) => {
        isDragging = true; track.setPointerCapture(e.pointerId);
        onPointerMove(e);
        if (navigator.vibrate) navigator.vibrate(10);
        track.style.transform = 'scale(0.98)';
        e.stopPropagation(); e.stopImmediatePropagation();
      });

      track.addEventListener('pointermove', (e) => {
        if (isDragging && track.hasPointerCapture(e.pointerId)) onPointerMove(e);
        e.stopPropagation(); e.stopImmediatePropagation();
      });

      const onPointerUp = (e) => {
        if (!isDragging) return;
        isDragging = false; track.releasePointerCapture(e.pointerId);
        if (navigator.vibrate) navigator.vibrate(10);
        track.style.transform = 'scale(1)';
        e.stopPropagation(); e.stopImmediatePropagation();
      };

      track.addEventListener('pointerup', onPointerUp);
      track.addEventListener('pointercancel', onPointerUp);

      return wrapper;
    };

    container.appendChild(createSlider('Schaal X (Breedte)', 'scaleX', 0.1, 10.0, 0.05));
    container.appendChild(createSlider('Schaal Y (Hoogte)', 'scaleY', 0.1, 10.0, 0.05));
    container.appendChild(createSlider('Schaal Z (Diepte)', 'scaleZ', 0.1, 10.0, 0.05));
    container.appendChild(createSlider('Waterlijn (Submerge)', 'submerge', -2.0, 2.0, 0.05));

    const btnExport = document.createElement('button');
    btnExport.innerText = 'Export JSON (Hold)';
    btnExport.style.cssText = `
      width: 100%; padding: 10px; margin-top: 10px; min-height: 24px;
      background: #34C759; color: white; border: none; border-radius: 8px;
      font-weight: 800; font-size: 12px; text-transform: uppercase;
      letter-spacing: 1px; touch-action: none;
      transition: background 0.2s, transform 0.2s;
    `;

    let holdTimeout;
    let isHolding = false;

    btnExport.addEventListener('pointerdown', (e) => {
      isHolding = true; btnExport.setPointerCapture(e.pointerId);
      btnExport.style.transform = 'scale(0.95)'; btnExport.style.background = '#2EAA4E';
      if (navigator.vibrate) navigator.vibrate(15);

      holdTimeout = setTimeout(() => {
        if (!isHolding) return;
        if (navigator.vibrate) navigator.vibrate([20, 50, 20]);
        this.exportConfigJSON();
        btnExport.innerText = 'Opgeslagen!'; btnExport.style.background = '#007AFF';
        setTimeout(() => {
          btnExport.innerText = 'Export JSON (Hold)';
          btnExport.style.background = '#34C759';
        }, 2000);
      }, 400);
      e.stopPropagation(); e.stopImmediatePropagation();
    });

    const cancelHold = (e) => {
      if (!isHolding) return;
      isHolding = false; clearTimeout(holdTimeout);
      btnExport.style.transform = 'scale(1)';
      if (btnExport.innerText !== 'Opgeslagen!') btnExport.style.background = '#34C759';
      btnExport.releasePointerCapture(e.pointerId);
      e.stopPropagation(); e.stopImmediatePropagation();
    };

    btnExport.addEventListener('pointerup', cancelHold);
    btnExport.addEventListener('pointercancel', cancelHold);
    btnExport.addEventListener('pointerleave', cancelHold);

    container.appendChild(btnExport);

    container.addEventListener('contextmenu', (e) => { e.preventDefault(); return false; });

    document.body.appendChild(container);
    this.tunerUI = container;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._bakeTimer) clearTimeout(this._bakeTimer);
    this._bakeTimer = null;
    this._hm = null;
    if (this.tunerUI) { this.tunerUI.remove(); this.tunerUI = null; }
    if (this.glbHolder) {
      this.glbHolder.getChildMeshes(false).forEach((m) => {
        try { if (m.material) m.material.dispose(false, true); } catch (_) {}
        try { m.dispose(false, true); } catch (_) {}
      });
      try { this.glbHolder.dispose(false, true); } catch (_) {}
      this.glbHolder = null;
    }
    this._pickables = [];
    try { this.root.dispose(); } catch (_) {}
  }
}
