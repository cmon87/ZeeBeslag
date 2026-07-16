import { Emplacement } from './emplacement.js';

const VALID_STATES = new Set(['briefing', 'active', 'transition', 'complete', 'failed']);

function findMissionPosition(island, placement, occupied) {
  const b = island && typeof island.bounds === 'function' ? island.bounds() : null;
  if (!b) throw new Error('Level 1 vereist geldige eilandbounds');
  const targetX = b.x0 + b.span * placement.x;
  const targetZ = b.z0 + b.span * placement.z;
  const step = Math.max(18, b.span / 70);
  const maxRing = 14;
  let best = null;

  for (let ring = 0; ring <= maxRing; ring++) {
    for (let ix = -ring; ix <= ring; ix++) {
      for (let iz = -ring; iz <= ring; iz++) {
        if (ring > 0 && Math.abs(ix) !== ring && Math.abs(iz) !== ring) continue;
        const x = targetX + ix * step;
        const z = targetZ + iz * step;
        const y = island.sample(x, z);
        if (!Number.isFinite(y) || y < (placement.minHeight || 0)) continue;
        if (occupied.some(p => Math.hypot(p.x - x, p.z - z) < 220)) continue;
        const score = Math.hypot(x - targetX, z - targetZ) - y * 0.15;
        if (!best || score < best.score) best = { x, y, z, score };
      }
    }
    if (best) break;
  }
  if (!best) throw new Error('Geen bruikbare positie gevonden voor een level-1-doel');
  return new BABYLON.Vector3(best.x, best.y, best.z);
}

export class MissionDirector {
  constructor(opts) {
    this.level = opts.level;
    this.registry = opts.registry;
    this.island = opts.island;
    this.playerShip = opts.playerShip;
    this.matchDirector = opts.matchDirector;
    this.chaseCam = opts.chaseCam;
    this.markers = opts.markers;
    this.ballistics = opts.ballistics;
    this.combatController = opts.combatController;
    this.aimTarget = opts.aimTarget;
    this.hud = opts.hud;
    this.targets = [];
    this.state = 'briefing';
    this.objectiveIndex = 0;
    this.timeRemaining = 0;
    this.transitionRemaining = 0;
    this.completedCount = 0;
    this.ready = false;
  }

  initialize() {
    const occupied = [];
    this.registry.clear();
    this.targets = this.level.objectives.map((def, index) => {
      const pos = findMissionPosition(this.island, def.placement, occupied);
      occupied.push(pos);
      const emp = new Emplacement(this.registry._scene, def.type, {
        ...def,
        pos,
        yaw: Math.atan2(this.playerShip.root.position.x - pos.x, this.playerShip.root.position.z - pos.z),
        objective: true,
        missionControlled: true,
        missionState: 'inactive',
        engageRange: def.engageRange ?? 3600,
        visualRange: def.visualRange ?? 3600,
      });
      emp.missionOrder = index;
      emp.missionDefinition = def;
      this.registry.add(emp);
      return emp;
    });
    this.ready = this.targets.length === this.level.objectives.length;
    this.reset(false);
    return this.targets;
  }

  showBriefing(onStart) {
    if (!this.ready) throw new Error('Missie kan niet starten voordat de doelen gereed zijn');
    this.state = 'briefing';
    this.hud.showBriefing(this.level, () => {
      this.start();
      if (typeof onStart === 'function') onStart();
    });
  }

  start() {
    if (!this.ready) return false;
    this.state = 'active';
    this.objectiveIndex = Math.max(0, Math.min(this.objectiveIndex, this.targets.length - 1));
    this._activateCurrent();
    return true;
  }

  reset(autoStart = true) {
    for (const target of this.targets) {
      target.reset();
      target.setMissionState('inactive');
    }
    this.state = autoStart ? 'active' : 'briefing';
    this.objectiveIndex = 0;
    this.completedCount = 0;
    this.transitionRemaining = 0;
    this.timeRemaining = this.level.objectives[0]?.timeLimit || 0;
    if (autoStart && this.targets.length) this._activateCurrent();
    this.hud && this.hud.reset();
  }

  get activeTarget() {
    if (this.state !== 'active' && this.state !== 'transition') return null;
    return this.targets[this.objectiveIndex] || null;
  }

  get activeDefinition() { return this.level.objectives[this.objectiveIndex] || null; }
  get canFire() { return this.state === 'active' && !!this.activeTarget && this.activeTarget.alive; }

  _activateCurrent() {
    const target = this.targets[this.objectiveIndex];
    const def = this.activeDefinition;
    if (!target || !def) return;
    for (const other of this.targets) {
      if (other !== target && other.alive) other.setMissionState('inactive');
    }
    target.setMissionState('active');
    this.timeRemaining = def.timeLimit;
    this.state = 'active';
    if (this.chaseCam) this.chaseCam.setEnemy(target);
    if (this.aimTarget) {
      this.aimTarget.set(
        target.root.position.x + this.level.aim.initialOffsetX,
        target.root.position.y,
        target.root.position.z + this.level.aim.initialOffsetZ,
      );
      const ground = this.island.sample(this.aimTarget.x, this.aimTarget.z);
      if (Number.isFinite(ground)) this.aimTarget.y = ground;
    }
    if (this.markers) this.markers.announce(`VUURMISSIE ${this.objectiveIndex + 1}`, def.orderText, target.type, 4.2);
    if (this.hud) this.hud.announce(`DOEL AANGEWEZEN: ${def.label}`, def.orderText, 'info', 4.2);
  }

  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (this.state === 'active') {
      this.timeRemaining = Math.max(0, this.timeRemaining - dt);
      if (this.timeRemaining <= 0) this.fail('De geallieerde aanval liep vast voordat het doel was uitgeschakeld.');
    } else if (this.state === 'transition') {
      this.transitionRemaining = Math.max(0, this.transitionRemaining - dt);
      const shellsResolved = (!this.combatController || this.combatController.pendingShots.length === 0)
        && (!this.ballistics || this.ballistics.projectiles.length === 0);
      if (this.transitionRemaining <= 0 && shellsResolved) this._advance();
    }
  }

  onTargetDestroyed(target) {
    if (target !== this.activeTarget || this.state !== 'active') return false;
    target.setMissionState('completed');
    this.completedCount++;
    this.state = 'transition';
    this.transitionRemaining = 1.35;
    if (this.hud) this.hud.announce('DOEL UITGESCHAKELD', 'Geallieerde troepen hervatten de opmars.', 'success', 3.2);
    return true;
  }

  _advance() {
    if (this.objectiveIndex >= this.targets.length - 1) {
      this.complete();
      return;
    }
    this.objectiveIndex++;
    this._activateCurrent();
  }

  reportImpact(pos) {
    const target = this.activeTarget;
    if (!target || !pos || this.state !== 'active') return;
    const dx = pos.x - target.root.position.x;
    const dz = pos.z - target.root.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance <= 38) {
      this.hud && this.hud.announce('DOELGEBIED', 'Treffers op of direct naast de stelling.', 'success', 1.8);
      return;
    }
    const ship = this.playerShip.root.position;
    const fx = target.root.position.x - ship.x;
    const fz = target.root.position.z - ship.z;
    const len = Math.hypot(fx, fz) || 1;
    const nx = fx / len, nz = fz / len;
    const along = dx * nx + dz * nz;
    const side = dx * (-nz) + dz * nx;
    let correction;
    if (Math.abs(along) >= Math.abs(side)) correction = along > 0 ? 'LANG' : 'KORT';
    else correction = side > 0 ? 'RECHTS' : 'LINKS';
    this.hud && this.hud.announce(`${correction} ${Math.round(distance)} M`, 'Corrigeer het inslagpunt en vuur opnieuw.', 'warning', 2.2);
  }

  complete() {
    if (this.state === 'complete') return;
    this.state = 'complete';
    this.matchDirector.finishMission(true, 'MISSIE GESLAAGD', 'Het bruggenhoofd is veilig. De geallieerde troepen rukken op.');
  }

  fail(reason) {
    if (this.state === 'failed' || this.state === 'complete') return;
    this.state = 'failed';
    this.matchDirector.finishMission(false, 'MISSIE GEFAALD', reason);
  }

  snapshot() {
    const def = this.activeDefinition || {};
    return {
      state: this.state,
      objectiveIndex: this.objectiveIndex,
      objectiveTotal: this.targets.length,
      completedCount: this.completedCount,
      timeRemaining: this.timeRemaining,
      targetLabel: def.label || '',
      phaseLabel: def.phaseLabel || '',
      orderText: def.orderText || '',
    };
  }
}
