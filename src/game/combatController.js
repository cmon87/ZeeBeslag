// src/game/combatController.js
//
// M6.5: vuurleiding voor speler en vijandelijke kustbatterijen.
// Vijandelijk vuur gebruikt DefenseNetwork voor detectie, reactietijd, bevoorrading,
// nauwkeurigheid en bereik. De oude enemyFire(simTime, ...) signatuur blijft ondersteund
// voor regressietests en losse integraties.

import { solveElevation } from './ballistics.js';

const MRAD = 0.001;

export class CombatController {
  constructor(cfg, swell) {
    this.cfg = cfg;
    this.swell = swell;
    this.defenseNetwork = null;

    this.lastFireT = -10;
    this.pendingShots = [];
    this.playerFirePolicy = { readyOnly: false, roundsPerTurret: cfg.roundsPerTurret };
    this.lastSalvoTurretCount = 0;
    this._enemyCh = cfg.enemyMuzzleChannel ?? 0;

    this._muzzle = new BABYLON.Vector3();
    this._dir    = new BABYLON.Vector3();
    this._launch = new BABYLON.Vector3();
    this._flat   = new BABYLON.Vector3();
    this._target = new BABYLON.Vector3();
  }

  setDefenseNetwork(network) {
    this.defenseNetwork = network || null;
  }

  setPlayerFirePolicy(policy = {}) {
    this.playerFirePolicy = {
      readyOnly: policy.readyOnly === true,
      roundsPerTurret: Math.max(1, Math.floor(policy.roundsPerTurret ?? this.cfg.roundsPerTurret ?? 1)),
    };
  }

  cancelPending() { this.pendingShots.length = 0; }

  reset() {
    this.cancelPending();
    this.lastFireT = -10;
    this.lastSalvoTurretCount = 0;
  }

  getFireReady(simTime) {
    return Math.min(1.0, Math.max(0, (simTime - this.lastFireT) / this.cfg.fireCooldown));
  }

  fireSalvo(simTime, playerShip) {
    if (!playerShip || simTime - this.lastFireT < this.cfg.fireCooldown) return false;
    const aim = this.playerAimStatus(playerShip, this._targetForPlayer || null);
    const turretIndices = this.playerFirePolicy.readyOnly
      ? aim.statuses.filter(s => s.ready).map(s => s.index)
      : playerShip.turrets.map((_, index) => index);
    if (turretIndices.length === 0) return false;

    this.lastFireT = simTime;
    this.lastSalvoTurretCount = turretIndices.length;
    let delay = 0;
    for (const ti of turretIndices) {
      for (let i = 0; i < this.playerFirePolicy.roundsPerTurret; i++) {
        this.pendingShots.push({ turret: ti, at: simTime + delay });
        delay += this.cfg.burstGap;
      }
      delay += this.cfg.turretGap;
    }
    return true;
  }

  processSalvo(simTime, playerShip, ballistics, fx) {
    for (let i = this.pendingShots.length - 1; i >= 0; i--) {
      if (this.pendingShots[i].at <= simTime) {
        this._shoot(playerShip, this.pendingShots[i].turret, ballistics, fx, this.cfg.playerSpreadMrad);
        this.pendingShots.splice(i, 1);
      }
    }
  }

  enemyFire(...args) {
    let cdt, simTime, emplacement, playerShip, ballistics, fx;
    if (typeof args[1] === 'number') {
      [cdt, simTime, emplacement, playerShip, ballistics, fx] = args;
    } else {
      [simTime, emplacement, playerShip, ballistics, fx] = args;
      cdt = 1 / 30;
    }

    if (!Number.isFinite(simTime) || !Number.isFinite(cdt) || cdt <= 0 || !ballistics ||
        !emplacement || !emplacement.alive || emplacement.canFire !== true ||
        !playerShip || !playerShip.alive) return false;
    if (!emplacement.root || !playerShip.root) return false;
    if ((typeof emplacement.root.isDisposed === 'function' && emplacement.root.isDisposed()) ||
        (typeof playerShip.root.isDisposed === 'function' && playerShip.root.isDisposed())) return false;

    const control = this.defenseNetwork
      ? this.defenseNetwork.getFireControl(emplacement, simTime)
      : {
          canEngage: true,
          contactSource: 'legacy',
          engageRange: emplacement.engageRange ?? this.cfg.engageRange,
          fireInterval: emplacement.fireInterval ?? this.cfg.enemyFireInterval,
          spreadMrad: emplacement.spreadMrad ?? this.cfg.enemySpreadMrad,
          turnRate: emplacement.turnRate ?? Infinity,
          aimTolerance: emplacement.aimTolerance ?? Math.PI,
          targetPosition: playerShip.root.position,
        };

    if (!control || control.contactSource === 'none') return false;

    const pPos = playerShip.root.position;
    const ePos = emplacement.root.position;
    const dist = Math.hypot(pPos.x - ePos.x, pPos.z - ePos.z);
    if (!Number.isFinite(dist) || dist > control.engageRange) return false;

    const known = control.targetPosition || pPos;
    this._target.set(known.x, known.y, known.z);
    if (typeof emplacement.aimAt === 'function') {
      const aimed = emplacement.aimAt(this._target, cdt, control.turnRate, control.aimTolerance);
      if (!aimed) return false;
    }
    if (!control.canEngage) return false;

    if (simTime - emplacement.lastFireT < control.fireInterval) return false;

    const tof = dist / this.cfg.muzzleVelocity;
    const freshContact = control.contactSource === 'radar' || control.contactSource === 'visual' || control.contactSource === 'legacy';
    const pVelX = freshContact ? Math.sin(playerShip.heading) * playerShip.speed : 0;
    const pVelZ = freshContact ? Math.cos(playerShip.heading) * playerShip.speed : 0;

    const interceptTarget = this._target;
    interceptTarget.x += pVelX * tof;
    interceptTarget.z += pVelZ * tof;

    if (typeof emplacement.getMuzzle !== 'function') return false;
    emplacement.getMuzzle(this._muzzle);
    if (!Number.isFinite(this._muzzle.x) || !Number.isFinite(this._muzzle.y) || !Number.isFinite(this._muzzle.z)) return false;

    const dx = interceptTarget.x - this._muzzle.x;
    const dy = interceptTarget.y - this._muzzle.y;
    const dz = interceptTarget.z - this._muzzle.z;
    const dPlane = Math.hypot(dx, dz);

    const spreadRad = Math.max(0, control.spreadMrad) * MRAD;
    const angleDev = (Math.random() - 0.5) * spreadRad;
    const baseAngle = Math.atan2(dx, dz) + angleDev;

    const elev = solveElevation(dPlane, dy, this.cfg.muzzleVelocity, 9.81);
    if (elev === null) return false;

    const ce = Math.cos(elev), se = Math.sin(elev);
    this._dir.set(Math.sin(baseAngle) * ce, se, Math.cos(baseAngle) * ce).normalize();

    if (fx && typeof fx.muzzleBlast === 'function') fx.muzzleBlast(this._muzzle, this._dir, this._enemyCh);
    this._dir.scaleInPlace(this.cfg.muzzleVelocity);
    ballistics.fire(this._muzzle, this._dir, { owner: emplacement, tracer: false });

    emplacement.lastFireT = simTime;
    return true;
  }

  enemyShipFire(enemyShip, playerShip, ballistics, fx) {
    if (!ballistics || !enemyShip || !enemyShip.alive || !playerShip || !playerShip.alive) return;
    if (!enemyShip.turrets || !enemyShip.turrets.length || typeof enemyShip.nextTurret !== 'function') return;
    const ti = enemyShip.nextTurret();
    if (ti < 0) return;
    this._shoot(enemyShip, ti, ballistics, fx, this.cfg.enemySpreadMrad);
  }

  setPlayerAimTarget(target) {
    this._targetForPlayer = target || null;
  }

  playerAimStatus(playerShip, target = this._targetForPlayer) {
    if (!playerShip || !target || typeof playerShip.getTurretReadiness !== 'function') {
      return { statuses: [], readyCount: 0, total: playerShip?.turrets?.length || 0, allReady: false, anyReady: false };
    }
    const statuses = playerShip.getTurretReadiness(target, this.cfg.muzzleVelocity, {
      yawTolerance: this.cfg.aimReadyRad,
      elevationTolerance: this.cfg.aimReadyElevRad ?? this.cfg.aimReadyRad * 1.5,
    });
    const readyCount = statuses.reduce((n, status) => n + (status.ready ? 1 : 0), 0);
    return {
      statuses,
      readyCount,
      total: statuses.length,
      allReady: statuses.length > 0 && readyCount === statuses.length,
      anyReady: readyCount > 0,
    };
  }

  playerAimReady(playerShip, target) {
    return this.playerAimStatus(playerShip, target).allReady;
  }

  update(cdt, simTime, playerShip, enemyShip, ballistics, fx, gameOver) {
    if (gameOver || !Number.isFinite(cdt) || cdt <= 0) return;
    if (this.pendingShots.length > 0) this.processSalvo(simTime, playerShip, ballistics, fx);
  }

  _shoot(ship, turretIndex, ballistics, fx, spreadMrad) {
    if (!ship || !ballistics) return;
    ship.getMuzzle(this._muzzle, this._dir, turretIndex);

    const ax = Math.asin(Math.max(-1, Math.min(1, this._dir.y)));
    const ay = Math.atan2(this._dir.x, this._dir.z);
    const devRadius = spreadMrad * MRAD;
    const r = Math.sqrt(Math.random()) * devRadius;
    const th = Math.random() * Math.PI * 2;
    const nx = ax + Math.sin(th) * r;
    const ny = ay + Math.cos(th) * r;
    const cx = Math.cos(nx), sx = Math.sin(nx);
    const cy = Math.cos(ny), sy = Math.sin(ny);

    this._launch.set(sy * cx, sx, cy * cx);
    if (fx && typeof fx.muzzleBlast === 'function') fx.muzzleBlast(this._muzzle, this._launch, turretIndex);
    this._launch.scaleInPlace(this.cfg.muzzleVelocity);
    ballistics.fire(this._muzzle, this._launch, { owner: ship, tracer: true });
  }
}
