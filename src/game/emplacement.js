// src/game/emplacement.js
//
// M6.5: data-gedreven verdedigingswerken met verschillende tactische rollen.
// Zichtstatus ('unknown'/'spotted') is uitsluitend voor de speler. Vijandelijk contact,
// richtgedrag en bevoorrading worden apart beheerd door DefenseNetwork.

const EMP_SCALE = 16;
const DEG = Math.PI / 180;

export const EMPLACEMENT_PROFILES = Object.freeze({
  battery: Object.freeze({
    label: 'KUSTBATTERIJ', tacticalHint: 'KUSTGESCHUT', objective: true,
    canFire: true, hp: 110, radius: 24, visibilityHeight: 16, damageTakenMultiplier: 1,
    engageRange: 3200, visualRange: 1800, fireInterval: 4.8,
    reactionTime: 2.2, turnRate: 12 * DEG, aimTolerance: 2.0 * DEG, spreadMrad: 11,
  }),
  bunker: Object.freeze({
    label: 'BUNKER', tacticalHint: 'VERSTERKT', objective: true,
    canFire: false, hp: 150, radius: 26, visibilityHeight: 12, damageTakenMultiplier: 0.65,
  }),
  radar: Object.freeze({
    label: 'RADAR', tacticalHint: 'VIJANDELIJKE DETECTIE', objective: true,
    canFire: false, hp: 70, radius: 20, visibilityHeight: 20, damageTakenMultiplier: 1,
  }),
  depot: Object.freeze({
    label: 'MUNITIEDEPOT', tacticalHint: 'VIJANDELIJKE BEVOORRADING', objective: true,
    canFire: false, hp: 90, radius: 28, visibilityHeight: 10, damageTakenMultiplier: 1.08,
  }),
  arty: Object.freeze({
    label: 'KUSTBATTERIJ', tacticalHint: 'KUSTGESCHUT', objective: true,
    canFire: true, hp: 110, radius: 24, visibilityHeight: 16, damageTakenMultiplier: 1,
    engageRange: 3200, visualRange: 1800, fireInterval: 4.8,
    reactionTime: 2.2, turnRate: 12 * DEG, aimTolerance: 2.0 * DEG, spreadMrad: 11,
  }),
  aa: Object.freeze({
    label: 'LUCHTAFWEER', tacticalHint: 'LUCHTVERDEDIGING', objective: true,
    canFire: false, hp: 85, radius: 22, visibilityHeight: 14, damageTakenMultiplier: 0.9,
  }),
  def: Object.freeze({
    label: 'VERDEDIGINGSWERK', tacticalHint: 'DOEL', objective: true,
    canFire: false, hp: 100, radius: 24, visibilityHeight: 12, damageTakenMultiplier: 1,
  }),
});

function profileFor(type) {
  return EMPLACEMENT_PROFILES[type] || EMPLACEMENT_PROFILES.def;
}

function normalizeAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

const _matsByScene = new WeakMap();

function makeMat(scene, name, diffuse) {
  const m = new BABYLON.StandardMaterial(name, scene);
  m.diffuseColor = new BABYLON.Color3(diffuse[0], diffuse[1], diffuse[2]);
  m.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
  return m;
}

function materials(scene) {
  let mats = _matsByScene.get(scene);
  if (mats) return mats;
  mats = {
    types: {
      def: makeMat(scene, 'empDef', [0.35, 0.38, 0.32]),
      battery: makeMat(scene, 'empBattery', [0.32, 0.34, 0.28]),
      arty: makeMat(scene, 'empArty', [0.32, 0.34, 0.28]),
      bunker: makeMat(scene, 'empBunker', [0.28, 0.30, 0.27]),
      radar: makeMat(scene, 'empRadar', [0.25, 0.38, 0.40]),
      depot: makeMat(scene, 'empDepot', [0.43, 0.34, 0.22]),
      aa: makeMat(scene, 'empAA', [0.30, 0.35, 0.31]),
    },
    dead: makeMat(scene, 'empDead', [0.10, 0.08, 0.08]),
  };
  _matsByScene.set(scene, mats);
  return mats;
}

function matForType(scene, type) {
  const t = materials(scene).types;
  return t[type] || t.def;
}

export class Emplacement {
  constructor(scene, type, config = {}) {
    if (!scene) throw new TypeError('Emplacement vereist een scene');
    if (!config.pos) throw new TypeError('Emplacement vereist config.pos');

    this._scene = scene;
    this.type = type || 'def';
    this.profile = profileFor(this.type);
    this.id = config.id || 'TGT';
    this.label = config.label || this.profile.label;
    this.tacticalHint = config.tacticalHint || this.profile.tacticalHint;
    this.objective = config.objective ?? this.profile.objective;
    this.canFire = config.canFire ?? this.profile.canFire;
    this.visibilityHeight = config.visibilityHeight ?? this.profile.visibilityHeight;
    this.damageTakenMultiplier = config.damageTakenMultiplier ?? this.profile.damageTakenMultiplier ?? 1;
    this.missionControlled = config.missionControlled === true;
    this.missionState = this.missionControlled ? (config.missionState || 'inactive') : 'active';
    this._initialMissionState = this.missionState;
    this._disposed = false;

    this.root = new BABYLON.TransformNode('emp_' + this.id, scene);
    this.root.position.copyFrom(config.pos);
    this.root.rotation.y = config.yaw || 0;
    this.root.scaling.setAll(EMP_SCALE);

    this.maxHp = config.hp ?? this.profile.hp;
    this.hp = this.maxHp;
    this.alive = true;
    this.radius = config.radius ?? this.profile.radius;

    this.engageRange = config.engageRange ?? this.profile.engageRange ?? 0;
    this.visualRange = config.visualRange ?? this.profile.visualRange ?? 0;
    this.fireInterval = config.fireInterval ?? this.profile.fireInterval ?? Infinity;
    this.reactionTime = config.reactionTime ?? this.profile.reactionTime ?? 0;
    this.turnRate = config.turnRate ?? this.profile.turnRate ?? 0;
    this.aimTolerance = config.aimTolerance ?? this.profile.aimTolerance ?? Math.PI;
    this.spreadMrad = config.spreadMrad ?? this.profile.spreadMrad ?? 0;

    this.missionState = this.missionControlled ? this._initialMissionState : 'active';
    this.state = 'unknown';
    this.lastFireT = -Infinity;
    this.alertSince = -Infinity;
    this.contactSource = 'none';
    this.contactFreshUntil = -Infinity;
    this.contactUntil = -Infinity;
    this.lastKnownTarget = null;

    this._meshes = [];
    this._gunMesh = null;
    this._gunYaw = null;
    this._gunHalfLen = 0;

    this._build(this.type);
    this.root.setEnabled(true);
    this._setVisualVisible(false);
  }

  _build(type) {
    let body;
    if (type === 'radar') {
      body = BABYLON.MeshBuilder.CreateBox('rdr', { width: 0.6, height: 1.2, depth: 0.6 }, this._scene);
      body.position.y = 0.6;
    } else if (type === 'depot') {
      body = BABYLON.MeshBuilder.CreateBox('dpt', { width: 1.5, height: 0.65, depth: 1.1 }, this._scene);
      body.position.y = 0.325;
    } else {
      body = BABYLON.MeshBuilder.CreateCylinder('bkr', { diameter: 1.4, height: 0.8, tessellation: 12 }, this._scene);
      body.position.y = 0.4;
    }

    if (this.canFire) {
      this._gunYaw = new BABYLON.TransformNode('gunYaw_' + this.id, this._scene);
      this._gunYaw.parent = this.root;
      const gun = BABYLON.MeshBuilder.CreateCylinder('gun', { diameter: 0.15, height: 1.2, tessellation: 6 }, this._scene);
      gun.rotation.x = Math.PI / 2;
      gun.position.set(0, 0.4, 0.6);
      gun.parent = this._gunYaw;
      this._meshes.push(gun);
      this._gunMesh = gun;
      this._gunHalfLen = 0.6;
    }

    body.parent = this.root;
    this._meshes.push(body);
    const mat = matForType(this._scene, this.type);
    for (const mesh of this._meshes) {
      mesh.material = mat;
      mesh.isPickable = false;
    }
  }

  _setVisualVisible(visible) {
    for (const mesh of this._meshes) mesh.isVisible = !!visible;
  }

  getMuzzle(target) {
    if (this._gunMesh) {
      if (typeof this._gunMesh.computeWorldMatrix === 'function') this._gunMesh.computeWorldMatrix(true);
      BABYLON.Vector3.TransformCoordinatesFromFloatsToRef(
        0, this._gunHalfLen, 0, this._gunMesh.getWorldMatrix(), target);
    } else {
      target.copyFrom(this.root.position);
    }
    return target;
  }

  aimAt(worldPos, dt, turnRate = this.turnRate, tolerance = this.aimTolerance) {
    if (!this._gunYaw || !worldPos || !Number.isFinite(dt) || dt <= 0) return !this.canFire;
    const dx = worldPos.x - this.root.position.x;
    const dz = worldPos.z - this.root.position.z;
    if (!Number.isFinite(dx) || !Number.isFinite(dz) || (dx * dx + dz * dz) < 1e-6) return true;

    const desiredLocal = normalizeAngle(Math.atan2(dx, dz) - this.root.rotation.y);
    const current = this._gunYaw.rotation.y || 0;
    const delta = normalizeAngle(desiredLocal - current);
    const maxStep = Math.max(0, turnRate) * dt;
    const step = Math.sign(delta) * Math.min(Math.abs(delta), maxStep);
    this._gunYaw.rotation.y = normalizeAngle(current + step);
    return Math.abs(normalizeAngle(desiredLocal - this._gunYaw.rotation.y)) <= tolerance;
  }

  setContact(simTime, source, memorySec = 8, targetPos = null) {
    if (!Number.isFinite(simTime) || !this.alive || !this.isMissionInteractive()) return false;
    const hadContact = this.hasContact(simTime);
    if (!hadContact) this.alertSince = simTime;
    this.contactSource = source === 'radar' ? 'radar' : 'visual';
    this.contactFreshUntil = simTime + 0.65;
    this.contactUntil = simTime + Math.max(0, memorySec);
    if (targetPos && Number.isFinite(targetPos.x) && Number.isFinite(targetPos.y) && Number.isFinite(targetPos.z)) {
      this.lastKnownTarget = { x: targetPos.x, y: targetPos.y, z: targetPos.z };
    }
    return !hadContact;
  }

  expireContact(simTime) {
    if (!Number.isFinite(simTime)) return;
    if (simTime <= this.contactFreshUntil) return;
    if (simTime <= this.contactUntil) this.contactSource = 'memory';
    else this.clearContact();
  }

  hasContact(simTime) {
    return this.alive && this.isMissionInteractive() && Number.isFinite(simTime) && simTime <= this.contactUntil && this.contactSource !== 'none';
  }

  clearContact() {
    this.alertSince = -Infinity;
    this.contactSource = 'none';
    this.contactFreshUntil = -Infinity;
    this.contactUntil = -Infinity;
    this.lastKnownTarget = null;
  }

  isMissionInteractive() {
    return !this.missionControlled || this.missionState === 'active';
  }

  setMissionState(next) {
    if (!this.missionControlled) return false;
    if (next !== 'inactive' && next !== 'active' && next !== 'completed') return false;
    this.missionState = next;
    this.clearContact();
    if (next === 'active' && this.alive) {
      this.state = 'spotted';
      this._setVisualVisible(true);
    } else if (next === 'inactive' && this.alive) {
      this.state = 'unknown';
      this._setVisualVisible(false);
    } else if (next === 'completed') {
      this._setVisualVisible(true);
    }
    return true;
  }

  spot() {
    if (!this.isMissionInteractive()) return false;
    if (this.state === 'unknown') {
      this.state = 'spotted';
      this._setVisualVisible(true);
      return true;
    }
    return false;
  }

  damage(amount) {
    if (!this.alive || !this.isMissionInteractive() || !Number.isFinite(amount) || amount <= 0) return false;
    const applied = Math.max(0, amount * this.damageTakenMultiplier);
    this.hp = Math.max(0, this.hp - applied);
    if (this.hp === 0) { this._destroy(); return true; }
    return false;
  }

  _destroy() {
    this.alive = false;
    this.state = 'destroyed';
    this._setVisualVisible(true);
    this.clearContact();
    const dead = materials(this._scene).dead;
    for (const m of this._meshes) m.material = dead;
    this.root.scaling.y = EMP_SCALE * 0.45;
  }

  reset() {
    if (this._disposed) return;
    this.hp = this.maxHp;
    this.alive = true;
    this.missionState = this.missionControlled ? this._initialMissionState : 'active';
    this.state = 'unknown';
    this.lastFireT = -Infinity;
    this.clearContact();
    if (this._gunYaw) this._gunYaw.rotation.y = 0;
    const mat = matForType(this._scene, this.type);
    for (const m of this._meshes) m.material = mat;
    this.root.scaling.setAll(EMP_SCALE);
    this.root.setEnabled(true);
    this._setVisualVisible(false);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const m of this._meshes) {
      try { m.dispose(); } catch (_) {}
    }
    this._meshes.length = 0;
    this._gunMesh = null;
    try { if (this._gunYaw) this._gunYaw.dispose(); } catch (_) {}
    this._gunYaw = null;
    try { this.root.dispose(); } catch (_) {}
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      pos: {
        x: +(this.root.position.x).toFixed(2),
        y: +(this.root.position.y).toFixed(2),
        z: +(this.root.position.z).toFixed(2),
      },
      yaw: +(this.root.rotation.y).toFixed(3),
      hp: this.maxHp,
      label: this.label,
      radius: this.radius,
      objective: this.objective,
      damageTakenMultiplier: this.damageTakenMultiplier,
      engageRange: this.engageRange || undefined,
      visualRange: this.visualRange || undefined,
      fireInterval: Number.isFinite(this.fireInterval) ? this.fireInterval : undefined,
      reactionTime: this.reactionTime || undefined,
      turnRate: this.turnRate || undefined,
      aimTolerance: this.aimTolerance || undefined,
      spreadMrad: this.spreadMrad || undefined,
      missionControlled: this.missionControlled || undefined,
      missionState: this.missionControlled ? this.missionState : undefined,
    };
  }
}
