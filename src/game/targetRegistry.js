// src/game/targetRegistry.js
//
// M6.5: centraal doelregister met expliciete missieobjectieven, spottingevents en type-status.
// Fysieke treffers blijven onafhankelijk van de zichtstatus: blind vuur kan een onbekend doel
// raken. De registry is tevens de enige plek die bepaalt wanneer het objectief voltooid is.

import { Emplacement } from './emplacement.js';
import { segmentSphereHitT } from './collisionMath.js';

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class TargetRegistry {
  constructor(scene) {
    this._scene = scene;
    this.list = [];
    this.onDestroyed = null;          // (emplacement) => void
    this.onSpotted = null;            // (emplacement, source) => void
    this.onObjectiveComplete = null;  // () => void
    this.onAllDestroyed = null;       // compatibiliteitsalias
    this._objectiveCompletedNotified = false;
    this._tmp = new BABYLON.Vector3();
  }

  add(emp) {
    if (!emp || !emp.root) throw new TypeError('TargetRegistry.add vereist een geldig emplacement');
    this.list.push(emp);
    this._objectiveCompletedNotified = false;
    return emp;
  }

  clear() {
    for (const e of this.list) {
      try { if (e && typeof e.dispose === 'function') e.dispose(); } catch (_) {}
    }
    this.list.length = 0;
    this._objectiveCompletedNotified = false;
  }

  reset() {
    for (const e of this.list) e.reset();
    this._objectiveCompletedNotified = false;
  }

  get aliveCount() { let n = 0; for (const e of this.list) if (e.alive) n++; return n; }
  get total() { return this.list.length; }
  get objectiveCount() { let n = 0; for (const e of this.list) if (e.objective !== false) n++; return n; }
  get objectiveRemaining() { let n = 0; for (const e of this.list) if (e.objective !== false && e.alive) n++; return n; }
  get objectiveComplete() { return this.objectiveCount > 0 && this.objectiveRemaining === 0; }

  typeCounts(aliveOnly = false) {
    const out = Object.create(null);
    for (const e of this.list) {
      if (!e || (aliveOnly && !e.alive)) continue;
      out[e.type] = (out[e.type] || 0) + 1;
    }
    return out;
  }

  spot(emp, source = 'zichtlijn') {
    if (!emp || !emp.alive || typeof emp.spot !== 'function') return false;
    const changed = emp.spot();
    if (changed && this.onSpotted) this.onSpotted(emp, source);
    return changed;
  }

  // Directe treffer op een werk: de granaat detoneert op de bunker zelf.
  hitTest(pos, owner) {
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i];
      if (e === owner || !e.alive) continue;
      const dx = pos.x - e.root.position.x;
      const dy = pos.y - (e.root.position.y + (e.visibilityHeight ?? 12));
      const dz = pos.z - e.root.position.z;
      if (dx * dx + dy * dy + dz * dz < e.radius * e.radius) return e;
    }
    return null;
  }

  // Exacte segment-boltest voor snelle granaten.
  hitTestSegment(from, to, owner, tMin = 0) {
    let best = null;
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i];
      if (!e || e === owner || !e.alive || !e.root) continue;
      this._tmp.set(
        e.root.position.x,
        e.root.position.y + (e.visibilityHeight ?? 12),
        e.root.position.z,
      );
      const t = segmentSphereHitT(from, to, this._tmp, e.radius, tMin, 1);
      if (t !== null && (!best || t < best.t)) best = { target: e, t };
    }
    return best;
  }

  // Springlading. Kwadratische afval tot nul op de rand.
  applyBlast(pos, damage, radius) {
    const r2 = radius * radius;
    let killed = 0;
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i];
      if (!e.alive) continue;
      const dx = pos.x - e.root.position.x;
      const dy = pos.y - (e.root.position.y + (e.visibilityHeight ?? 10));
      const dz = pos.z - e.root.position.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      const f = 1 - (d2 / r2);
      if (e.damage(damage * f)) {
        killed++;
        if (this.onDestroyed) this.onDestroyed(e);
      }
    }
    if (killed) this._checkObjectiveComplete();
    return killed;
  }

  _checkObjectiveComplete() {
    if (!this.objectiveComplete || this._objectiveCompletedNotified) return false;
    this._objectiveCompletedNotified = true;
    if (this.onObjectiveComplete) this.onObjectiveComplete();
    if (this.onAllDestroyed && this.onAllDestroyed !== this.onObjectiveComplete) this.onAllDestroyed();
    return true;
  }

  nearestAlive(pos, maxDist = Infinity) {
    let best = null, bestD = maxDist * maxDist;
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i];
      if (!e.alive || e.state === 'unknown') continue;
      const dx = pos.x - e.root.position.x, dz = pos.z - e.root.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) { bestD = d2; best = e; }
    }
    return best;
  }

  spotAll(source = 'sandbox') { for (const e of this.list) this.spot(e, source); }

  toJSON() { return { emplacements: this.list.map(e => e.toJSON()) }; }

  exportJSON() {
    const blob = new Blob([JSON.stringify(this.toJSON(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'emplacements.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  loadJSON(data) {
    const rows = Array.isArray(data && data.emplacements) ? data.emplacements : [];
    const next = [];
    try {
      for (const d of rows) {
        if (!d || !d.pos || !Number.isFinite(d.pos.x) || !Number.isFinite(d.pos.y) || !Number.isFinite(d.pos.z)) {
          throw new TypeError('Ongeldige emplacementpositie in JSON');
        }
        next.push(new Emplacement(this._scene, d.type, {
          id: d.id,
          yaw: d.yaw,
          hp: d.hp,
          label: d.label,
          radius: d.radius,
          objective: d.objective,
          damageTakenMultiplier: d.damageTakenMultiplier,
          engageRange: d.engageRange,
          visualRange: d.visualRange,
          fireInterval: d.fireInterval,
          reactionTime: d.reactionTime,
          turnRate: d.turnRate,
          aimTolerance: d.aimTolerance,
          spreadMrad: d.spreadMrad,
          pos: new BABYLON.Vector3(d.pos.x, d.pos.y, d.pos.z),
        }));
      }
    } catch (err) {
      for (const e of next) { try { e.dispose(); } catch (_) {} }
      throw err;
    }

    this.clear();
    for (const e of next) this.add(e);
    return this.list.length;
  }

  // Procedureel plaatsen op de gebakken eiland-heightmap. De profielen bepalen HP en gedrag;
  // scatter overschrijft die waarden niet meer met één generieke hp=100.
  scatter(island, opts = {}) {
    const count   = opts.count ?? 14;
    const seed    = opts.seed ?? 1337;
    const minDist = opts.minDist ?? 260;
    const minH    = opts.minH ?? 8;
    const mix     = opts.mix ?? ['battery', 'bunker', 'bunker', 'radar', 'bunker', 'depot',
                                 'battery', 'bunker', 'radar', 'depot', 'bunker', 'battery',
                                 'depot', 'radar'];

    const rnd = mulberry32(seed);
    const cx = island.root.position.x, cz = island.root.position.z;
    const b = island.bounds ? island.bounds() : null;
    const x0 = b ? b.x0 : cx - island.hitRadius;
    const z0 = b ? b.z0 : cz - island.hitRadius;
    const span = b ? b.span : island.hitRadius * 2;
    const inset = span * 0.06;

    const placed = [];
    let tries = 0;
    while (placed.length < count && tries < 20000) {
      tries++;
      const x = x0 + inset + rnd() * (span - 2 * inset);
      const z = z0 + inset + rnd() * (span - 2 * inset);
      const h = island.sample(x, z);
      if (h === null || h === undefined || h < minH) continue;

      let ok = true;
      for (const p of placed) {
        const dx = x - p.x, dz = z - p.z;
        if (dx * dx + dz * dz < minDist * minDist) { ok = false; break; }
      }
      if (!ok) continue;
      placed.push({ x, y: h, z });
    }

    placed.sort((p, q) => p.x - q.x);
    this.clear();
    placed.forEach((p, i) => {
      const type = mix[i % mix.length];
      this.add(new Emplacement(this._scene, type, {
        id: 'T' + String(i + 1).padStart(2, '0'),
        pos: new BABYLON.Vector3(p.x, p.y, p.z),
        yaw: rnd() * Math.PI * 2,
      }));
    });
    return this.list.length;
  }

  dispose() { this.clear(); }
}
