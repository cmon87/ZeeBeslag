// src/game/ballistics.js
//
// M3.1: ballistiek.
// Inclusief collision fix voor 'opwaartse terrein-fantomisering' in update().
// M6.4: swept collision voor schepen, doelen, terrein en water.

import { pointOnSegment, segmentSphereHitT } from './collisionMath.js';

export const G = 9.81;

export function solveElevation(d, dy, v, g = G) {
  if (d < 1e-3) return null;
  const v2 = v * v;
  const disc = v2 * v2 - g * (g * d * d + 2 * dy * v2);
  if (disc < 0) return null;
  return Math.atan((v2 - Math.sqrt(disc)) / (g * d));
}

export function maxRange(v, g = G) { return (v * v) / g; }

// ── TRACERPOOL (gradient billboard-beam) ────────────────────────────────────
// Een additieve quad met een lengtegradient: hete witte kop, oranje body, dovende staart.
// De quad wordt langs de snelheidsvector georiënteerd via een expliciete rotatiematrix (NIET
// lookAt, want lookAt-naar-een-punt plus niet-uniforme scaling gaf de schuine strepen) en rolt
// om die as naar de camera. Volledig gepoold: 48 instanties, alleen positie/rotatie/schaal.
const TRACER_POOL = 48;
const TRACER_LEN = 45;      // korter: kort hete streep achter de granaat, geen lange verticale balk
const TRACER_WIDTH = 3.0;   // meter breed op het felste punt

export class Ballistics {
  constructor(scene, swellField, opts = {}) {
    this._scene = scene;
    this._swell = swellField;
    this.g = G;
    this.projectiles = [];
    this.targets = [];           
    this.terrain = null;         
    this.registry = null;        

    // M6.5: ontstekingsafstand (fuze arming). Een granaat detoneert niet binnen deze straal
    // van zijn eigen monding. Nodig omdat de loop van een stelling binnen de eigen trefferbol
    // van 24 m ligt en het terrein onder de monding vaak hoger is dan de monding zelf: zonder
    // arming blies elke stelling zichzelf op, direct of via de springlading van 45 m op de
    // helling naast zich. Scheepsdoelen gebruiken hiervoor al de owner-uitsluiting.
    this.armDist = opts.armDist ?? 45;
    this._armDist2 = this.armDist * this.armDist;

    this.onImpactWater = null;   
    this.onImpactShip = null;    
    this.onImpactGround = null;  
    this.onImpactTarget = null;  

    this._pool = null;
    this._tmp = new BABYLON.Vector3();
    this._tail = new BABYLON.Vector3();
    this._mid = new BABYLON.Vector3();
    this._toCam = new BABYLON.Vector3();
    this._R = new BABYLON.Vector3();
    this._N = new BABYLON.Vector3();
    this._F = new BABYLON.Vector3();
    this._m = new BABYLON.Matrix();
    this._prev = new BABYLON.Vector3();
    this._next = new BABYLON.Vector3();
    this._impactPoint = new BABYLON.Vector3();
    this._targetCenter = new BABYLON.Vector3();
    this._initTracerPool(scene);
  }

  // Gradient langs de lengte-as (V) en zachte rand langs de breedte (U). Head aan de v=1 kant.
  _buildTracerTexture(scene) {
    const W = 64, H = 256;
    const dtex = new BABYLON.DynamicTexture('tracerGrad', { width: W, height: H }, scene, false);
    const ctx = dtex.getContext();
    const img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      const v = 1 - y / (H - 1);                    // v=1 is de kop (bovenaan)
      const head = Math.pow(v, 0.35);               // fel, korte kop
      const tail = Math.exp(-(1 - v) * 3.2);        // dovende sliert naar achter
      const lume = Math.max(head, tail * 0.55);
      const r = 255;
      const g = Math.round(120 + 130 * lume);
      const b = Math.round(40 + 110 * Math.pow(lume, 2.2));
      for (let x = 0; x < W; x++) {
        const u = x / (W - 1);
        const edge = Math.sin(u * Math.PI);         // zacht naar de randen: ronde streep
        const a = Math.round(255 * lume * Math.pow(edge, 1.6));
        const i = (y * W + x) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = a;
      }
    }
    ctx.putImageData(img, 0, 0);
    dtex.update();
    dtex.hasAlpha = true;
    return dtex;
  }

  _initTracerPool(scene) {
    const tex = this._buildTracerTexture(scene);

    const mat = new BABYLON.StandardMaterial('tracerBeamM', scene);
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    mat.diffuseColor = BABYLON.Color3.Black();
    mat.specularColor = BABYLON.Color3.Black();
    mat.emissiveColor = BABYLON.Color3.White();
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.alphaMode = BABYLON.Constants.ALPHA_ADD;
    mat.disableDepthWrite = true;
    mat.freeze();

    // Grondvlak (X-Z), normaal +Y. X = breedte, Z = lengte, +Z = kop.
    const master = BABYLON.MeshBuilder.CreateGround('tracerBeam', { width: 1, height: 1, subdivisions: 1 }, scene);
    master.material = mat;
    master.isPickable = false;
    master.renderingGroupId = 1;
    master.position.set(0, -8000, 0);
    master.scaling.setAll(0.001);
    master.rotationQuaternion = BABYLON.Quaternion.Identity();

    const list = [];
    for (let i = 0; i < TRACER_POOL; i++) {
      const inst = master.createInstance('tracerBeam' + i);
      inst.isPickable = false;
      inst.rotationQuaternion = BABYLON.Quaternion.Identity();
      inst.setEnabled(false);
      list.push(inst);
    }
    this._pool = { master, mat, tex, list };
  }

  _takeTracer() {
    for (const m of this._pool.list) if (!m.isEnabled(false)) { m.setEnabled(true); return m; }
    return null;
  }

  _releaseTracer(t) { if (t) t.setEnabled(false); }

  // Oriënteer de quad LANGS de snelheidsvector met een expliciete rotatiematrix en rol hem naar
  // de camera. Geen lookAt: lookAt-naar-een-punt plus niet-uniforme scaling gaf de schuine strepen.
  _placeTracer(p) {
    const beam = p.tracer;
    if (!beam) return;
    const len = Math.min(BABYLON.Vector3.Distance(p.pos, p.origin), TRACER_LEN);
    if (len < 0.5) { beam.setEnabled(false); return; }

    const v = p.vel;
    const inv = 1 / Math.max(Math.hypot(v.x, v.y, v.z), 1e-6);
    this._F.set(v.x * inv, v.y * inv, v.z * inv);                 // lengte-as = kop-richting (+Z)
    this._tail.set(p.pos.x - this._F.x * len, p.pos.y - this._F.y * len, p.pos.z - this._F.z * len);
    this._mid.set((p.pos.x + this._tail.x) * 0.5, (p.pos.y + this._tail.y) * 0.5, (p.pos.z + this._tail.z) * 0.5);

    const cam = this._scene.activeCamera;
    if (cam) this._toCam.copyFrom(cam.globalPosition).subtractInPlace(this._mid);
    else this._toCam.set(0, 1, 0);

    BABYLON.Vector3.CrossToRef(this._F, this._toCam, this._R);    // breedte-as (X)
    if (this._R.lengthSquared() < 1e-8) {
      this._R.set(-this._F.y, this._F.x, 0);
      if (this._R.lengthSquared() < 1e-8) this._R.set(1, 0, 0);
    }
    this._R.normalize();
    BABYLON.Vector3.CrossToRef(this._F, this._R, this._N);        // normaal naar camera (Y)
    this._N.normalize();

    // Rotatiematrix uit de basis (R=X, N=Y, F=Z). Head aan +Z.
    // Als kop/staart omgedraaid: zet this._F.scaleInPlace(-1) net na de set hierboven.
    BABYLON.Matrix.FromValuesToRef(
      this._R.x, this._R.y, this._R.z, 0,
      this._N.x, this._N.y, this._N.z, 0,
      this._F.x, this._F.y, this._F.z, 0,
      0, 0, 0, 1, this._m);
    BABYLON.Quaternion.FromRotationMatrixToRef(this._m, beam.rotationQuaternion);

    beam.position.copyFrom(this._mid);
    beam.scaling.set(TRACER_WIDTH, 1, len);
  }

  addTarget(ship, radius) { this.targets.push({ ship, radius }); }
  setTerrain(t) { this.terrain = t; }
  setRegistry(r) { this.registry = r; }

  fire(pos, vel, opts = {}) {
    const p = {
      pos: pos.clone(), vel: vel.clone(), origin: pos.clone(),
      alive: true, age: 0, mesh: null, tracer: null, owner: opts.owner || null,
    };
    if (opts.tracer !== false) p.tracer = this._takeTracer();
    this.projectiles.push(p);
    return p;
  }

  clear() { for (const p of this.projectiles) this._kill(p); this.projectiles.length = 0; }

  computeLaunchVelocity(from, to, muzzleSpeed, out) {
    const dx = to.x - from.x, dz = to.z - from.z;
    const d = Math.hypot(dx, dz);
    const theta = solveElevation(d, to.y - from.y, muzzleSpeed, this.g);
    if (theta === null) return null;
    const vh = Math.cos(theta) * muzzleSpeed, vy = Math.sin(theta) * muzzleSpeed;
    out.set(dx / d * vh, vy, dz / d * vh);
    return out;
  }

  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    let anyDead = false;

    for (let i = 0; i < this.projectiles.length; i++) {
      const p = this.projectiles[i];
      if (!p.alive) { anyDead = true; continue; }

      p.age += dt;
      this._prev.copyFrom(p.pos);
      p.vel.y -= this.g * dt;
      this._next.set(
        this._prev.x + p.vel.x * dt,
        this._prev.y + p.vel.y * dt,
        this._prev.z + p.vel.z * dt,
      );

      let impact = this._findShipImpact(p, this._prev, this._next);
      const armedT = this._armedStartT(p, this._prev, this._next);

      if (armedT !== null) {
        if (this.registry && typeof this.registry.hitTestSegment === 'function') {
          const direct = this.registry.hitTestSegment(this._prev, this._next, p.owner, armedT);
          if (direct) impact = this._earlierImpact(impact, { type: 'target', t: direct.t, target: direct.target });
        } else if (this.registry) {
          // Compatibiliteitsfallback voor een ouder register. Alleen het eindpunt wordt dan getest.
          const emp = this.registry.hitTest(this._next, p.owner);
          if (emp) impact = this._earlierImpact(impact, { type: 'target', t: 1, target: emp });
        }

        const terrainHit = this._findTerrainImpact(this._prev, this._next, armedT);
        if (terrainHit !== null) impact = this._earlierImpact(impact, { type: 'ground', t: terrainHit });

        if (p.vel.y < 0) {
          const waterHit = this._findWaterImpact(this._prev, this._next, armedT);
          if (waterHit !== null) impact = this._earlierImpact(impact, { type: 'water', t: waterHit });
        }
      }

      if (impact) {
        pointOnSegment(this._prev, this._next, impact.t, this._impactPoint);
        if (impact.type === 'ground' && this.terrain) {
          const ground = this.terrain.sample(this._impactPoint.x, this._impactPoint.z);
          if (ground !== null && ground !== undefined && Number.isFinite(ground)) this._impactPoint.y = ground;
        } else if (impact.type === 'water') {
          this._impactPoint.y = this._swell.getHeight(this._impactPoint.x, this._impactPoint.z);
        }

        p.pos.copyFrom(this._impactPoint);
        p.alive = false;
        anyDead = true;

        if (impact.type === 'ship' && this.onImpactShip) {
          this.onImpactShip(impact.ship, p.pos.clone(), p.owner);
        } else if (impact.type === 'target' && this.onImpactTarget) {
          this.onImpactTarget(impact.target, p.pos.clone());
        } else if (impact.type === 'ground' && this.onImpactGround) {
          this.onImpactGround(p.pos.clone());
        } else if (impact.type === 'water' && this.onImpactWater) {
          this.onImpactWater(p.pos.clone());
        }

        this._kill(p);
        continue;
      }

      p.pos.copyFrom(this._next);
      this._placeTracer(p);

      if (p.age > 60) {
        p.alive = false;
        anyDead = true;
        this._kill(p);
      }
    }

    if (anyDead) this.projectiles = this.projectiles.filter(p => p.alive);
  }

  _earlierImpact(current, candidate) {
    if (!candidate || !Number.isFinite(candidate.t) || candidate.t < 0 || candidate.t > 1) return current;
    if (!current || candidate.t < current.t - 1e-7) return candidate;
    return current;
  }

  _findShipImpact(p, from, to) {
    let best = null;
    for (let i = 0; i < this.targets.length; i++) {
      const tg = this.targets[i];
      if (!tg || tg.ship === p.owner || !tg.ship || !tg.ship.alive || !tg.ship.root) continue;
      const radius = Number.isFinite(tg.radius) ? Math.max(0, tg.radius) : 0;
      const t = segmentSphereHitT(from, to, tg.ship.root.position, radius, 0, 1);
      if (t !== null && (!best || t < best.t)) best = { type: 'ship', t, ship: tg.ship };
    }
    return best;
  }

  _armedStartT(p, from, to) {
    if (this.armDist <= 0) return 0;
    const ox = p.origin.x, oy = p.origin.y, oz = p.origin.z;
    const d0x = from.x - ox, d0y = from.y - oy, d0z = from.z - oz;
    if (d0x * d0x + d0y * d0y + d0z * d0z >= this._armDist2) return 0;
    const d1x = to.x - ox, d1y = to.y - oy, d1z = to.z - oz;
    if (d1x * d1x + d1y * d1y + d1z * d1z < this._armDist2) return null;

    let lo = 0, hi = 1;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) * 0.5;
      const x = from.x + (to.x - from.x) * mid - ox;
      const y = from.y + (to.y - from.y) * mid - oy;
      const z = from.z + (to.z - from.z) * mid - oz;
      if (x * x + y * y + z * z >= this._armDist2) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  _findTerrainImpact(from, to, tMin) {
    if (!this.terrain || typeof this.terrain.sample !== 'function') return null;
    const texel = this.terrain.bakeStats && Number.isFinite(this.terrain.bakeStats.meterPerTexel)
      ? this.terrain.bakeStats.meterPerTexel
      : 8;
    const step = Math.max(2, Math.min(10, texel * 0.7));
    return this._findSurfaceImpact(from, to, tMin, step, (x, z) => this.terrain.sample(x, z));
  }

  _findWaterImpact(from, to, tMin) {
    if (!this._swell || typeof this._swell.getHeight !== 'function') return null;
    return this._findSurfaceImpact(from, to, tMin, 8, (x, z) => this._swell.getHeight(x, z));
  }

  _findSurfaceImpact(from, to, tMin, maxStep, sampler) {
    const start = Math.max(0, Math.min(1, tMin));
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const distance = Math.hypot(dx, dy, dz) * (1 - start);
    const steps = Math.max(1, Math.min(256, Math.ceil(distance / Math.max(1, maxStep))));

    let prevT = start;
    let prevSurface = sampler(from.x + dx * prevT, from.z + dz * prevT);
    let prevGap = (prevSurface === null || prevSurface === undefined || !Number.isFinite(prevSurface))
      ? Number.POSITIVE_INFINITY
      : (from.y + dy * prevT) - prevSurface;
    if (prevGap <= 0) return prevT;

    for (let i = 1; i <= steps; i++) {
      const t = start + (1 - start) * (i / steps);
      const x = from.x + dx * t;
      const y = from.y + dy * t;
      const z = from.z + dz * t;
      const surface = sampler(x, z);
      const gap = (surface === null || surface === undefined || !Number.isFinite(surface))
        ? Number.POSITIVE_INFINITY
        : y - surface;

      if (gap <= 0) {
        let lo = prevT, hi = t;
        for (let n = 0; n < 8; n++) {
          const mid = (lo + hi) * 0.5;
          const mx = from.x + dx * mid;
          const my = from.y + dy * mid;
          const mz = from.z + dz * mid;
          const ms = sampler(mx, mz);
          const mg = (ms === null || ms === undefined || !Number.isFinite(ms))
            ? Number.POSITIVE_INFINITY
            : my - ms;
          if (mg > 0) lo = mid;
          else hi = mid;
        }
        return hi;
      }

      prevT = t;
      prevGap = gap;
    }
    return null;
  }

  _secant(y0, s0, y1, s1) {
    const denom = (y0 - s0) - (y1 - s1);
    if (denom <= 1e-6) return 1;
    return Math.min(Math.max((y0 - s0) / denom, 0), 1);
  }

  // Terug in de pool. Geen dispose, dus geen bufferverkeer.
  _kill(p) {
    this._releaseTracer(p.tracer);
    p.tracer = null;
  }

  dispose() {
    this.clear();
    this._pool.list.forEach(m => m.dispose());
    this._pool.master.dispose();
    this._pool.mat.dispose();
    this._pool.tex.dispose();
    this._pool = null;
  }
}
