// src/game/defenseNetwork.js
//
// M6.5: data-gedreven vijandelijk detectie- en bevoorradingsnetwerk.
// Speler-spotting en vijandelijke detectie zijn bewust gescheiden. Een onbekend doel kan dus
// op de speler vuren wanneer radar of eigen waarneming contact heeft, zonder dat de HUD het al
// toont. Vernietigde radars en depots hebben direct een tactisch, meetbaar effect.

export const DIFFICULTY_PROFILES = Object.freeze({
  easy: Object.freeze({
    label: 'MAKKELIJK', rangeMultiplier: 0.90, spreadMultiplier: 1.28,
    reloadMultiplier: 1.20, reactionMultiplier: 1.25,
  }),
  normal: Object.freeze({
    label: 'NORMAAL', rangeMultiplier: 1.00, spreadMultiplier: 1.00,
    reloadMultiplier: 1.00, reactionMultiplier: 1.00,
  }),
  hard: Object.freeze({
    label: 'MOEILIJK', rangeMultiplier: 1.08, spreadMultiplier: 0.82,
    reloadMultiplier: 0.84, reactionMultiplier: 0.78,
  }),
});

const DEFAULTS = Object.freeze({
  difficulty: 'normal',
  sensorInterval: 0.30,
  radarRange: 3800,
  contactMemory: 8,
  noDepotReloadMultiplier: 1.55,
});

function distanceXZ(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function aliveTypeCount(list, type) {
  let count = 0;
  for (const e of list) if (e && e.alive && e.type === type) count++;
  return count;
}

export class DefenseNetwork {
  constructor(registry, island, opts = {}) {
    if (!registry) throw new TypeError('DefenseNetwork vereist een TargetRegistry');
    this.registry = registry;
    this.island = island || null;
    this.cfg = { ...DEFAULTS, ...opts };
    this.difficultyId = DIFFICULTY_PROFILES[this.cfg.difficulty] ? this.cfg.difficulty : 'normal';
    this.difficulty = DIFFICULTY_PROFILES[this.difficultyId];

    this._nextSensorT = -Infinity;
    this._radarContact = false;
    this._radarSourceId = null;
    this._lastPlayerPos = null;
    this._status = null;
    this.refreshStatus();
  }

  setDifficulty(id) {
    if (!DIFFICULTY_PROFILES[id]) return false;
    this.difficultyId = id;
    this.difficulty = DIFFICULTY_PROFILES[id];
    return true;
  }

  refreshStatus() {
    const list = this.registry.list || [];
    const next = {
      difficulty: this.difficultyId,
      difficultyLabel: this.difficulty.label,
      batteriesAlive: aliveTypeCount(list, 'battery') + aliveTypeCount(list, 'arty'),
      radarsAlive: aliveTypeCount(list, 'radar'),
      depotsAlive: aliveTypeCount(list, 'depot'),
      bunkersAlive: aliveTypeCount(list, 'bunker'),
      radarContact: this._radarContact,
      radarSourceId: this._radarSourceId,
    };
    next.radarOperational = next.radarsAlive > 0;
    next.supplyOperational = next.depotsAlive > 0;
    this._status = next;
    return next;
  }

  get status() { return { ...this.refreshStatus() }; }

  reset() {
    this._nextSensorT = -Infinity;
    this._radarContact = false;
    this._radarSourceId = null;
    this._lastPlayerPos = null;
    for (const e of this.registry.list) {
      if (e && typeof e.clearContact === 'function') e.clearContact();
    }
    this.refreshStatus();
  }

  update(simTime, playerShip) {
    if (!Number.isFinite(simTime) || !playerShip || !playerShip.alive || !playerShip.root) return;
    if (simTime < this._nextSensorT) return;
    this._nextSensorT = simTime + Math.max(0.05, this.cfg.sensorInterval);

    const playerPos = playerShip.root.position;
    this._lastPlayerPos = { x: playerPos.x, y: playerPos.y, z: playerPos.z };
    this._scanRadar(playerPos);

    for (const emp of this.registry.list) {
      if (!emp || !emp.alive || emp.canFire !== true || !emp.root) continue;
      const dist = distanceXZ(emp.root.position, playerPos);
      const maxRange = (emp.engageRange ?? 3200) * this.difficulty.rangeMultiplier;
      let source = null;

      const visualRange = (emp.visualRange ?? 1750) * this.difficulty.rangeMultiplier;
      // Een levende radar levert de beste vuurleidingskwaliteit. Zonder radar valt de batterij
      // terug op eigen zicht; achter terrein blijft alleen kort contactgeheugen over.
      if (this._radarContact && dist <= maxRange) source = 'radar';
      else if (dist <= visualRange && this._hasLos(emp, playerPos)) source = 'visual';

      if (source && typeof emp.setContact === 'function') {
        emp.setContact(simTime, source, this.cfg.contactMemory, playerPos);
      } else if (typeof emp.expireContact === 'function') {
        emp.expireContact(simTime);
      }
    }

    this.refreshStatus();
  }

  _scanRadar(playerPos) {
    this._radarContact = false;
    this._radarSourceId = null;
    const range = this.cfg.radarRange * this.difficulty.rangeMultiplier;
    for (const radar of this.registry.list) {
      if (!radar || !radar.alive || radar.type !== 'radar' || !radar.root) continue;
      if (distanceXZ(radar.root.position, playerPos) > range) continue;
      if (!this._hasLos(radar, playerPos)) continue;
      this._radarContact = true;
      this._radarSourceId = radar.id;
      break;
    }
  }

  _hasLos(emp, playerPos) {
    if (!this.island || typeof this.island.hasLineOfSight !== 'function') return true;
    const from = {
      x: emp.root.position.x,
      y: emp.root.position.y + (emp.visibilityHeight ?? 12),
      z: emp.root.position.z,
    };
    const to = { x: playerPos.x, y: playerPos.y + 14, z: playerPos.z };
    return this.island.hasLineOfSight(from, to, {
      startMargin: Math.max(12, emp.radius || 24),
      endMargin: 22,
      clearance: 1.5,
    });
  }

  getFireControl(emp, simTime) {
    const status = this.refreshStatus();
    if (!emp || !emp.alive || emp.canFire !== true ||
        typeof emp.hasContact !== 'function' || !emp.hasContact(simTime)) {
      return { canEngage: false, contactSource: 'none' };
    }

    const source = emp.contactSource || 'memory';
    const sourceSpread = source === 'radar' ? 0.78 : source === 'visual' ? 1.08 : 1.75;
    const sourceReaction = source === 'radar' ? 0.72 : source === 'visual' ? 1.0 : 1.25;
    const depotReload = status.supplyOperational ? 1.0 : this.cfg.noDepotReloadMultiplier;

    const reactionTime = (emp.reactionTime ?? 2.2) * this.difficulty.reactionMultiplier * sourceReaction;
    const reacted = Number.isFinite(emp.alertSince) && simTime >= emp.alertSince + reactionTime;

    return {
      canEngage: reacted,
      contactSource: source,
      reactionRemaining: Math.max(0, emp.alertSince + reactionTime - simTime),
      engageRange: (emp.engageRange ?? 3200) * this.difficulty.rangeMultiplier,
      fireInterval: (emp.fireInterval ?? 4.8) * this.difficulty.reloadMultiplier * depotReload,
      spreadMrad: (emp.spreadMrad ?? 11) * this.difficulty.spreadMultiplier * sourceSpread,
      turnRate: emp.turnRate ?? (12 * Math.PI / 180),
      aimTolerance: emp.aimTolerance ?? (2.0 * Math.PI / 180),
      radarOperational: status.radarOperational,
      supplyOperational: status.supplyOperational,
      targetPosition: emp.lastKnownTarget ? { ...emp.lastKnownTarget } : null,
    };
  }

  tacticalEffectFor(emp) {
    if (!emp) return '';
    if (emp.type === 'radar') return 'Vernietiging verkort vijandelijke detectie en verslechtert vuurleiding.';
    if (emp.type === 'depot') return 'Vernietiging vertraagt het herladen van alle kustbatterijen.';
    if (emp.type === 'bunker') return 'Versterkt werk: explosies richten minder schade aan.';
    if (emp.canFire) return 'Kustgeschut: draait, richt en vuurt alleen met geldig contact.';
    return emp.tacticalHint || '';
  }
}
