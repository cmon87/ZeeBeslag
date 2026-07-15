// src/game/worldCollision.js
//
// M6.4: lichte fysieke wereld voor het spelersschip.
// De visuele eilandmesh blijft buiten de collisionloop. In plaats daarvan wordt de reeds
// gebakken heightmap bemonsterd op een klein aantal punten onder de romp. Beweging wordt
// gesweept, zodat het schip ook bij versneld spel niet door een smalle kaap kan springen.

const DEFAULT_BOUNDS = Object.freeze({ minX: -2500, maxX: 7000, minZ: -4500, maxZ: 4500 });

function finitePosition(p) {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.z);
}

export class WorldCollision {
  constructor(terrain = null, opts = {}) {
    this.terrain = terrain;
    this.waterLevel = Number.isFinite(opts.waterLevel) ? opts.waterLevel : 0;
    this.underKeelClearance = Number.isFinite(opts.underKeelClearance) ? Math.max(0, opts.underKeelClearance) : 1.5;
    this.sweepStep = Number.isFinite(opts.sweepStep) ? Math.max(1, opts.sweepStep) : 6;
    this.bounds = { ...DEFAULT_BOUNDS, ...(opts.bounds || {}) };
    this.lastContact = null;
    this._pendingContact = null;
    this._wasBlocked = false;
  }

  setTerrain(terrain) { this.terrain = terrain; }

  setBounds(bounds = {}) {
    this.bounds = { ...this.bounds, ...bounds };
  }

  reset() {
    this.lastContact = null;
    this._pendingContact = null;
    this._wasBlocked = false;
  }

  consumeContact() {
    const event = this._pendingContact;
    this._pendingContact = null;
    return event;
  }

  resolveShipMove(ship, from, desired) {
    if (!ship || !finitePosition(from) || !finitePosition(desired)) {
      return { x: from && Number.isFinite(from.x) ? from.x : 0, z: from && Number.isFinite(from.z) ? from.z : 0, blocked: true, reason: 'invalid', moved: 0 };
    }

    const bounded = this._clampToBounds(desired);
    const boundary = bounded.x !== desired.x || bounded.z !== desired.z;
    const direct = this._sweep(ship, from, bounded);

    let result = direct;
    let slid = false;
    if (direct.blocked) {
      const xOnly = this._sweep(ship, from, { x: bounded.x, z: from.z });
      const zOnly = this._sweep(ship, from, { x: from.x, z: bounded.z });
      const xMove = Math.hypot(xOnly.x - from.x, xOnly.z - from.z);
      const zMove = Math.hypot(zOnly.x - from.x, zOnly.z - from.z);
      const candidate = xMove >= zMove ? xOnly : zOnly;
      if (Math.max(xMove, zMove) > direct.moved + 0.05) {
        result = candidate;
        slid = true;
      }
    }

    const blocked = boundary || result.blocked;
    const reason = result.blocked ? 'terrain' : (boundary ? 'boundary' : null);
    const moved = Math.hypot(result.x - from.x, result.z - from.z);
    if (boundary && moved > 0.05) slid = true;
    const contact = blocked ? {
      reason,
      x: result.x,
      z: result.z,
      slid,
      moved,
      clearance: result.clearance,
    } : null;

    this.lastContact = contact;
    if (blocked && !this._wasBlocked) this._pendingContact = { ...contact };
    this._wasBlocked = blocked;

    return {
      x: result.x,
      z: result.z,
      blocked,
      boundary,
      terrain: !!result.blocked,
      slid,
      reason,
      moved,
      clearance: result.clearance,
      speedScale: blocked ? (slid && moved > 0.05 ? 0.55 : 0) : 1,
    };
  }

  _clampToBounds(pos) {
    const b = this.bounds;
    return {
      x: Math.max(b.minX, Math.min(b.maxX, pos.x)),
      z: Math.max(b.minZ, Math.min(b.maxZ, pos.z)),
    };
  }

  _sweep(ship, from, to) {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const distance = Math.hypot(dx, dz);
    const fromClearance = this._hullClearance(ship, from.x, from.z);
    const toClearance = this._hullClearance(ship, to.x, to.z);
    const escapeMove = fromClearance < 0 && toClearance > fromClearance + 0.02;
    if (distance <= 1e-6) {
      return { x: from.x, z: from.z, blocked: fromClearance < 0, moved: 0, clearance: fromClearance };
    }

    const steps = Math.max(1, Math.min(256, Math.ceil(distance / this.sweepStep)));
    let lastT = 0;
    let lastClearance = fromClearance;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = from.x + dx * t;
      const z = from.z + dz * t;
      const clearance = this._hullClearance(ship, x, z);

      if (clearance < 0) {
        // Staat het schip door een handmatige spawn al in ondiep water, dan mag een beweging
        // die de situatie aantoonbaar verbetert doorgaan. Zo kan de speler altijd achteruit.
        if (escapeMove && clearance >= fromClearance - 0.02) {
          lastT = t;
          lastClearance = clearance;
          continue;
        }

        let lo = lastT;
        let hi = t;
        for (let n = 0; n < 8; n++) {
          const mid = (lo + hi) * 0.5;
          const mx = from.x + dx * mid;
          const mz = from.z + dz * mid;
          if (this._hullClearance(ship, mx, mz) >= 0) lo = mid;
          else hi = mid;
        }
        const xSafe = from.x + dx * lo;
        const zSafe = from.z + dz * lo;
        return {
          x: xSafe,
          z: zSafe,
          blocked: true,
          moved: Math.hypot(xSafe - from.x, zSafe - from.z),
          clearance: this._hullClearance(ship, xSafe, zSafe),
        };
      }

      lastT = t;
      lastClearance = clearance;
    }

    return { x: to.x, z: to.z, blocked: false, moved: distance, clearance: lastClearance };
  }

  _hullClearance(ship, x, z) {
    const terrain = this.terrain;
    if (!terrain || typeof terrain.sample !== 'function') return Number.POSITIVE_INFINITY;

    const heading = Number.isFinite(ship.heading) ? ship.heading : 0;
    const fx = Math.sin(heading), fz = Math.cos(heading);
    const rx = Math.cos(heading), rz = -Math.sin(heading);
    const halfL = Math.max(1, (ship.length || 1) * 0.43);
    const halfB = Math.max(0.5, (ship.beam || 1) * 0.48);
    const minDepth = Math.max(0.1, (ship.draft || 0) + this.underKeelClearance);
    const threshold = this.waterLevel - minDepth;

    // Midden, boeg, hek, beide zijden en vier kwartpunten. Negen heightmap-lookups per
    // sweepstap zijn veel goedkoper dan triangle collision tegen het volledige eiland.
    const samples = [
      [0, 0], [halfL, 0], [-halfL, 0], [0, halfB], [0, -halfB],
      [halfL * 0.72, halfB * 0.78], [halfL * 0.72, -halfB * 0.78],
      [-halfL * 0.72, halfB * 0.78], [-halfL * 0.72, -halfB * 0.78],
    ];

    let clearance = Number.POSITIVE_INFINITY;
    let sampled = 0;
    for (const [forward, right] of samples) {
      const sx = x + fx * forward + rx * right;
      const sz = z + fz * forward + rz * right;
      const ground = terrain.sample(sx, sz);
      if (ground === null || ground === undefined || !Number.isFinite(ground)) continue;
      sampled++;
      clearance = Math.min(clearance, threshold - ground);
    }
    return sampled ? clearance : Number.POSITIVE_INFINITY;
  }
}
