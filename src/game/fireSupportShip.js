import { Ship } from './ship.js';

function normalizeAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// Level-1-specialisatie van het bestaande schip. De basisnavigatie blijft intact voor latere
// levels, terwijl deze klasse betrouwbare logische turrets en per-turret gereedstatus levert.
export class FireSupportShip extends Ship {
  _bindTurrets() {
    this._clearTurretBindings();
    let turretsBound = 0;

    for (let i = 0; i < this.turrets.length; i++) {
      const t = this.turrets[i];
      const aliases = [
        ...(Array.isArray(t.meshNames) ? t.meshNames : []),
        `Koepel0${i + 1}`,
        `Koepel${i + 1}`,
        `Turret0${i + 1}`,
        `Turret${i + 1}`,
      ];

      let node = null;
      for (const name of aliases) {
        node = (this._scene.getTransformNodeByName && this._scene.getTransformNodeByName(name))
          || this._scene.getMeshByName(name);
        if (node) break;
      }

      if (node) {
        t.node = node;
        t.mesh = node.getClassName && node.getClassName().includes('Mesh')
          ? node
          : ((node.getChildMeshes && node.getChildMeshes(false)[0]) || null);
        t.bound = true;

        t.elevNode = new BABYLON.TransformNode(`${node.name}_elev`, this._scene);
        t.elevNode.parent = node;
        const children = node.getChildMeshes ? node.getChildMeshes(true) : [];
        for (const child of children) {
          if (child !== t.mesh) child.parent = t.elevNode;
        }

        const euler = node.rotationQuaternion
          ? node.rotationQuaternion.toEulerAngles()
          : node.rotation;
        t.restYaw = euler ? euler.y : 0;
        turretsBound++;
      } else {
        t.node = new BABYLON.TransformNode(`fake_turret_${i}`, this._scene);
        t.node.parent = this.root;
        t.node.position.copyFrom(t.localPos);
        t.elevNode = new BABYLON.TransformNode(`fake_elev_${i}`, this._scene);
        t.elevNode.parent = t.node;
        t.mesh = null;
        t.bound = false;
        t.restYaw = 0;
      }
    }

    return turretsBound;
  }

  _clearTurretBindings() {
    for (const t of this.turrets) {
      if (t.node && t.node.name && t.node.name.startsWith('fake_turret_')) {
        try { t.node.dispose(false, true); } catch (_) {}
      } else if (t.elevNode && t.elevNode.name && t.elevNode.name.endsWith('_elev')) {
        try {
          const children = t.elevNode.getChildren ? t.elevNode.getChildren() : [];
          for (const child of children) child.parent = t.node || null;
          t.elevNode.dispose(true, false);
        } catch (_) {}
      }
      t.node = null;
      t.elevNode = null;
      t.mesh = null;
      t.bound = false;
    }
  }

  _turretBaseToRef(t, out) {
    if (t.node && typeof t.node.getAbsolutePosition === 'function') {
      out.copyFrom(t.node.getAbsolutePosition());
    } else {
      BABYLON.Vector3.TransformCoordinatesToRef(t.localPos, this.root.getWorldMatrix(), out);
    }
    return out;
  }

  _turretSolution(t, targetPos, muzzleVelocity) {
    const base = this._turretBaseToRef(t, this._v1);
    const dx = targetPos.x - base.x;
    const dz = targetPos.z - base.z;
    const dy = targetPos.y - (base.y + t.muzzleY);
    const dist2D = Math.hypot(dx, dz);
    if (!Number.isFinite(dist2D) || dist2D < 1e-5) return null;

    const desiredAbsoluteYaw = Math.atan2(dx, dz);
    let desiredYaw = normalizeAngle(desiredAbsoluteYaw - this.heading - t.restYaw);
    let withinArc = true;
    if (t.minYaw !== null && t.maxYaw !== null) {
      if (desiredYaw < t.minYaw) { desiredYaw = t.minYaw; withinArc = false; }
      if (desiredYaw > t.maxYaw) { desiredYaw = t.maxYaw; withinArc = false; }
    }

    const v2 = muzzleVelocity * muzzleVelocity;
    const root = v2 * v2 - 9.81 * (9.81 * dist2D * dist2D + 2 * dy * v2);
    let desiredElev = 0;
    const ballisticSolution = root >= 0;
    if (ballisticSolution) {
      desiredElev = Math.atan((v2 - Math.sqrt(root)) / (9.81 * dist2D));
      desiredElev = Math.max(-0.05, Math.min(0.80, desiredElev));
    }
    return { desiredYaw, desiredElev, withinArc, ballisticSolution };
  }

  getTurretReadiness(targetPos, muzzleVelocity, opts = {}) {
    const yawTolerance = Number.isFinite(opts.yawTolerance) ? opts.yawTolerance : 0.010;
    const elevationTolerance = Number.isFinite(opts.elevationTolerance) ? opts.elevationTolerance : 0.012;
    const statuses = [];
    for (let i = 0; i < this.turrets.length; i++) {
      const t = this.turrets[i];
      const solution = this._turretSolution(t, targetPos, muzzleVelocity);
      if (!solution) {
        statuses.push({ index: i, ready: false, yawReady: false, elevationReady: false, ballisticSolution: false, withinArc: false, yawError: Infinity, elevationError: Infinity });
        continue;
      }
      const yawError = Math.abs(normalizeAngle(solution.desiredYaw - t.yaw));
      const elevationError = Math.abs(solution.desiredElev - t.elev);
      const yawReady = yawError <= yawTolerance;
      const elevationReady = elevationError <= elevationTolerance;
      statuses.push({
        index: i,
        ready: solution.withinArc && solution.ballisticSolution && yawReady && elevationReady,
        yawReady,
        elevationReady,
        ballisticSolution: solution.ballisticSolution,
        withinArc: solution.withinArc,
        yawError,
        elevationError,
      });
    }
    return statuses;
  }

  aimError(targetPos, muzzleVelocity) {
    const first = this.getTurretReadiness(targetPos, muzzleVelocity)[0];
    return first ? first.yawError : Infinity;
  }

  aimTurretsAt(targetPos, dt, muzzleVelocity) {
    if (this.sinking || !this.alive || !targetPos || !Number.isFinite(dt) || dt <= 0) return;
    const yawStep = 0.4 * dt;
    const elevStep = 0.25 * dt;

    for (const t of this.turrets) {
      const solution = this._turretSolution(t, targetPos, muzzleVelocity);
      if (!solution) continue;
      const hitLimit = !solution.withinArc;

      if (hitLimit && !t._wasAtLimit) {
        try { if (navigator.vibrate) navigator.vibrate([15, 30, 15]); } catch (_) {}
        t._wasAtLimit = true;
      } else if (!hitLimit) {
        t._wasAtLimit = false;
      }

      const yawDelta = normalizeAngle(solution.desiredYaw - t.yaw);
      t.yaw = normalizeAngle(t.yaw + Math.sign(yawDelta) * Math.min(Math.abs(yawDelta), yawStep));
      if (t.node) t.node.rotation.y = t.yaw;

      if (t.elev < solution.desiredElev) t.elev = Math.min(t.elev + elevStep, solution.desiredElev);
      if (t.elev > solution.desiredElev) t.elev = Math.max(t.elev - elevStep, solution.desiredElev);
      if (t.elevNode) t.elevNode.rotation.x = -t.elev;
    }
  }

  getMuzzle(outPos, outDir, turretIndex) {
    const t = (turretIndex !== undefined && turretIndex >= 0) ? this.turrets[turretIndex] : null;
    if (!t) return super.getMuzzle(outPos, outDir, turretIndex);

    const a = t.restYaw + t.yaw;
    const ce = Math.cos(t.elev), se = Math.sin(t.elev);
    this._v1.set(Math.sin(a) * ce, se, Math.cos(a) * ce);
    BABYLON.Vector3.TransformNormalToRef(this._v1, this.root.getWorldMatrix(), this._v2);
    this._v2.normalize();

    const base = this._turretBaseToRef(t, this._v1);
    const reach = t.barrel + t.pivotBack;
    outPos.set(
      base.x + this._v2.x * reach,
      base.y + t.muzzleY + this._v2.y * reach,
      base.z + this._v2.z * reach,
    );
    if (outDir) outDir.copyFrom(this._v2);
  }
}
