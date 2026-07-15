// src/game/ship.js
//
// M6.2.2: robuuste GLB-import voor het spelersschip.
// - model wordt automatisch naar de ingestelde scheepslengte geschaald;
// - de kiel wordt op lokaal y=0 gezet en het model horizontaal gecentreerd;
// - glbHolder/modelBounds/modelScale geven een betrouwbare laadstatus;
// - ontbrekende koepelmeshes vallen terug op correct gepositioneerde logische turrets.
// M6.4: optionele heightmap-navigatie voorkomt varen door land en buiten missiegrenzen.
// M6.6: statische scheepsmeshes worden per materiaal samengevoegd en materialen bevroren.

import { mergeStaticMeshesByMaterial } from '../core/meshOptimizer.js';

export class Ship {
  constructor(scene, swellField, opts = {}) {
    this._scene = scene;
    this._swell = swellField;
    this.root = new BABYLON.TransformNode('shipRoot', scene);
    if (opts.position) this.root.position.copyFrom(opts.position);

    this.alive = true;
    this.sinking = false;
    this._sinkTimer = 0;

    this.maxHp = opts.maxHp || 100;
    this.hp = this.maxHp;

    this.speed = 0;
    this.throttle = 0;
    this.rudder = 0;
    this.heading = opts.heading || 0;

    this.maxSpeed = 12.5;
    this.accel = 0.6;
    this.turnRate = 0.22;

    this.length = opts.length || 150;
    this.beam = opts.beam || 18;
    this.draft = opts.draft || 4;
    this.modelYOffset = Number.isFinite(opts.modelYOffset) ? opts.modelYOffset : 0;

    this.pitch = 0;
    this.roll = 0;

    this._v1 = new BABYLON.Vector3();
    this._v2 = new BABYLON.Vector3();

    this.meshes = [];
    this.glbHolder = null;
    this.modelScale = 1;
    this.modelBounds = null;
    this.modelSourceFile = null;
    this.optimizeVisualModel = opts.optimizeVisualModel !== false;
    this.freezeStaticMaterials = opts.freezeStaticMaterials !== false;
    this.maxMergeVertices = Number(opts.maxMergeVertices || 250000);
    this.modelOptimization = null;

    this.turrets = [];
    this._lastFiredTurret = -1;

    this.navigationCollision = null;
    this.navigationContact = null;
  }

  async loadGLB(path, file) {
    this._disposeImportedModel();

    const res = await BABYLON.SceneLoader.ImportMeshAsync('', path, file, this._scene);
    const importedMeshes = (res.meshes || []).filter(Boolean);
    const importedNodes = [
      ...importedMeshes,
      ...((res.transformNodes || []).filter(Boolean)),
    ];
    const importedSet = new Set(importedNodes);

    this.glbHolder = new BABYLON.TransformNode('shipModelHolder', this._scene);
    this.glbHolder.parent = this.root;

    // Alleen de wortels van de geïmporteerde hiërarchie worden verplaatst. Zo blijven
    // interne parent-childrelaties, skins en animatiepivots intact.
    for (const node of importedNodes) {
      if (!node.parent || !importedSet.has(node.parent)) node.parent = this.glbHolder;
    }

    const keptMeshes = [];
    for (const mesh of importedMeshes) {
      const materialName = mesh.material && mesh.material.name;
      if (materialName === 'Water') {
        try { mesh.dispose(false, true); } catch (_) {}
        continue;
      }
      mesh.isPickable = false;
      keptMeshes.push(mesh);
    }
    const sourceMeshCount = keptMeshes.filter(m => m.getTotalVertices && m.getTotalVertices() > 0).length;
    const protectedName = /(?:koepel|turret|gun[_ -]?(?:mount|yaw|elev)|barbette)/i;
    const optimized = mergeStaticMeshesByMaterial(keptMeshes, {
      enabled: this.optimizeVisualModel,
      holder: this.glbHolder,
      nodes: importedNodes,
      namePrefix: 'shipMerged',
      freezeMaterials: this.freezeStaticMaterials,
      maxVerticesPerMerge: this.maxMergeVertices,
      protect: (mesh) => {
        let node = mesh;
        while (node && node !== this.glbHolder) {
          if (protectedName.test(node.name || '')) return true;
          node = node.parent;
        }
        return false;
      },
    });
    this.meshes = optimized.meshes;
    this.modelOptimization = optimized.stats;

    const bounds = this._measureModelBounds(this.meshes, this.glbHolder);
    if (!bounds) {
      this._disposeImportedModel();
      throw new Error(`Schipmodel '${file}' bevat geen meetbare rendergeometrie`);
    }

    const sourceHorizontalLength = Math.max(bounds.extents.x, bounds.extents.z);
    if (!Number.isFinite(sourceHorizontalLength) || sourceHorizontalLength <= 1e-6) {
      this._disposeImportedModel();
      throw new Error(`Schipmodel '${file}' heeft ongeldige afmetingen`);
    }

    const scale = this.length / sourceHorizontalLength;
    if (!Number.isFinite(scale) || scale <= 0) {
      this._disposeImportedModel();
      throw new Error(`Schipmodel '${file}' leverde een ongeldige schaal op`);
    }

    this.modelScale = scale;
    this.glbHolder.scaling.setAll(scale);

    // De gameplay-root representeert de kiel: lokaal y=0. Horizontaal wordt het model
    // rond de root gecentreerd. De positie wordt in meters gezet, dus ná toepassing
    // van de uniforme modelschaal.
    this.glbHolder.position.set(
      -bounds.center.x * scale,
      -bounds.min.y * scale + this.modelYOffset,
      -bounds.center.z * scale,
    );
    this.glbHolder.computeWorldMatrix(true);

    this.modelBounds = {
      source: {
        min: bounds.min.clone(),
        max: bounds.max.clone(),
        center: bounds.center.clone(),
        extents: bounds.extents.clone(),
      },
      scaled: {
        width: bounds.extents.x * scale,
        height: bounds.extents.y * scale,
        length: bounds.extents.z * scale,
        horizontalLength: sourceHorizontalLength * scale,
      },
    };
    this.modelSourceFile = `${path || ''}${file || ''}`;

    const turretsBound = this._bindTurrets();
    return {
      meshCount: this.meshes.length,
      sourceMeshCount,
      optimization: this.modelOptimization,
      turretsBound,
      modelScale: this.modelScale,
      modelLength: this.modelBounds.scaled.horizontalLength,
      modelHeight: this.modelBounds.scaled.height,
    };
  }

  _measureModelBounds(meshes, holder) {
    if (!holder || !meshes || meshes.length === 0) return null;

    holder.computeWorldMatrix(true);
    const inverseHolder = holder.getWorldMatrix().clone();
    inverseHolder.invert();

    const min = new BABYLON.Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    const max = new BABYLON.Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
    const localCorner = new BABYLON.Vector3();
    let measured = 0;

    for (const mesh of meshes) {
      try {
        if (!mesh || (mesh.isDisposed && mesh.isDisposed())) continue;
        if (!mesh.getTotalVertices || mesh.getTotalVertices() <= 0) continue;

        mesh.computeWorldMatrix(true);
        const info = mesh.getBoundingInfo && mesh.getBoundingInfo();
        const corners = info && info.boundingBox && info.boundingBox.vectorsWorld;
        if (!corners || corners.length === 0) continue;

        for (const corner of corners) {
          BABYLON.Vector3.TransformCoordinatesToRef(corner, inverseHolder, localCorner);
          min.x = Math.min(min.x, localCorner.x);
          min.y = Math.min(min.y, localCorner.y);
          min.z = Math.min(min.z, localCorner.z);
          max.x = Math.max(max.x, localCorner.x);
          max.y = Math.max(max.y, localCorner.y);
          max.z = Math.max(max.z, localCorner.z);
        }
        measured++;
      } catch (_) {
        // Eén corrupte submesh mag de overige 474 meshes niet blokkeren.
      }
    }

    if (measured === 0 || !Number.isFinite(min.x) || !Number.isFinite(max.x)) return null;
    const center = min.add(max).scale(0.5);
    const extents = max.subtract(min);
    return { min, max, center, extents, measured };
  }

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
        // Het huidige GLB bevat geen stabiele Koepel01..03-namen. De logische
        // turrets blijven daarom bruikbaar en staan op hun ingestelde lokale positie.
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

  _disposeImportedModel() {
    this._clearTurretBindings();
    if (this.glbHolder) {
      try { this.glbHolder.dispose(false, true); } catch (_) {}
    } else {
      for (const mesh of this.meshes) {
        try { if (mesh && !(mesh.isDisposed && mesh.isDisposed())) mesh.dispose(false, true); } catch (_) {}
      }
    }
    this.meshes = [];
    this.glbHolder = null;
    this.modelScale = 1;
    this.modelBounds = null;
    this.modelSourceFile = null;
    this.modelOptimization = null;
  }

  isModelLoaded() {
    if (!this.glbHolder || (this.glbHolder.isDisposed && this.glbHolder.isDisposed())) return false;
    return this.meshes.some(mesh => mesh && !(mesh.isDisposed && mesh.isDisposed()));
  }

  setNavigationCollision(collision) {
    this.navigationCollision = collision || null;
    this.navigationContact = null;
    return this;
  }

  addTurret(localPos, opts = {}) {
    this.turrets.push({
      localPos: localPos.clone(),
      barrel: opts.barrel || 6,
      muzzleY: opts.muzzleY || 1.2,
      meshNames: Array.isArray(opts.meshNames) ? [...opts.meshNames] : [],
      yaw: 0,
      elev: 0,
      restYaw: 0,
      node: null,
      elevNode: null,
      mesh: null,
      bound: false,
      pivotBack: 0,
      minYaw: null,
      maxYaw: null,
      _wasAtLimit: false,
    });
  }

  aimError(targetPos, muzzleVelocity) {
    if (this.turrets.length === 0) return 0;
    const t = this.turrets[0];
    if (!t.node) return 0;
    const base = t.node.getAbsolutePosition();
    const dx = targetPos.x - base.x, dz = targetPos.z - base.z;
    const currentAbsoluteYaw = this.heading + t.restYaw + t.yaw;
    const currentDir = new BABYLON.Vector2(Math.sin(currentAbsoluteYaw), Math.cos(currentAbsoluteYaw));
    const targetDir = new BABYLON.Vector2(dx, dz).normalize();
    return Math.acos(BABYLON.Scalar.Clamp(BABYLON.Vector2.Dot(currentDir, targetDir), -1, 1));
  }

  aimTurretsAt(targetPos, dt, muzzleVelocity) {
    if (this.sinking || !this.alive) return;
    const SLEW_RATE_YAW = 0.4 * dt;
    const SLEW_RATE_ELEV = 0.25 * dt;

    for (const t of this.turrets) {
      if (!t.node || !t.elevNode) continue;
      const base = t.node.getAbsolutePosition();
      const dx = targetPos.x - base.x, dz = targetPos.z - base.z;
      const targetAbsoluteYaw = Math.atan2(dx, dz);

      let targetYaw = targetAbsoluteYaw - this.heading - t.restYaw;
      while (targetYaw > Math.PI) targetYaw -= 2 * Math.PI;
      while (targetYaw < -Math.PI) targetYaw += 2 * Math.PI;

      let hitLimit = false;
      if (t.minYaw !== null && t.maxYaw !== null) {
        if (targetYaw < t.minYaw) { targetYaw = t.minYaw; hitLimit = true; }
        if (targetYaw > t.maxYaw) { targetYaw = t.maxYaw; hitLimit = true; }
      }

      if (hitLimit && !t._wasAtLimit) {
        try { if (navigator.vibrate) navigator.vibrate([15, 30, 15]); } catch(_) {}
        t._wasAtLimit = true;
      } else if (!hitLimit) {
        t._wasAtLimit = false;
      }

      if (t.yaw < targetYaw) t.yaw = Math.min(t.yaw + SLEW_RATE_YAW, targetYaw);
      if (t.yaw > targetYaw) t.yaw = Math.max(t.yaw - SLEW_RATE_YAW, targetYaw);
      t.node.rotation.y = t.yaw;

      const dist2D = Math.hypot(dx, dz);
      const dy = targetPos.y - (base.y + t.muzzleY);
      const v2 = muzzleVelocity * muzzleVelocity;
      const g = 9.81;
      const root = v2 * v2 - g * (g * dist2D * dist2D + 2 * dy * v2);
      
      let targetElev = 0;
      if (root >= 0) {
        targetElev = Math.atan((v2 - Math.sqrt(root)) / (g * dist2D));
        if (targetElev < -0.05) targetElev = -0.05;
        if (targetElev > 0.80) targetElev = 0.80; 
      }

      if (t.elev < targetElev) t.elev = Math.min(t.elev + SLEW_RATE_ELEV, targetElev);
      if (t.elev > targetElev) t.elev = Math.max(t.elev - SLEW_RATE_ELEV, targetElev);
      t.elevNode.rotation.x = -t.elev;
    }
  }

  damage(amount) {
    if (!this.alive) return false;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.sinking = true;
      this._sinkTimer = 0;
      return true;
    }
    return false;
  }

  respawn(pos, heading) {
    this.alive = true;
    this.sinking = false;
    this._sinkTimer = 0;
    this.hp = this.maxHp;
    this.speed = 0;
    this.throttle = 0;
    this.rudder = 0;
    this.heading = Number.isFinite(heading) ? heading : 0;
    this.pitch = 0;
    this.roll = 0;
    this._lastFiredTurret = -1;
    this.navigationContact = null;
    this.root.position.copyFrom(pos);
    this.root.rotationQuaternion = BABYLON.Quaternion.Identity();

    // Alle dynamische koepelstanden en WakeManager-cachevelden terug naar een verse start.
    for (const t of this.turrets) {
      t.yaw = 0;
      t.elev = 0;
      t._wasAtLimit = false;
      if (t.node) t.node.rotation.y = 0;
      if (t.elevNode) t.elevNode.rotation.x = 0;
    }
    this._foamLast = null;
    this._lastBow = null;
    this._wakeParts = [];
  }

  update(dt) {
    if (this.sinking) {
      this._sinkTimer += dt;
      this.root.position.y -= 0.8 * dt;
      this.roll += 0.05 * dt;
      this.pitch -= 0.08 * dt;
      const qH = BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Y, this.heading);
      const qP = BABYLON.Quaternion.RotationAxis(BABYLON.Axis.X, this.pitch);
      const qR = BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Z, this.roll);
      this.root.rotationQuaternion = qH.multiply(qP).multiply(qR);
      return;
    }

    if (this.alive) {
      const targetSpeed = this.throttle * this.maxSpeed;
      this.speed += (targetSpeed - this.speed) * (1 - Math.exp(-dt * this.accel));
      const speedFactor = Math.abs(this.speed) / this.maxSpeed;
      this.heading += this.rudder * this.turnRate * speedFactor * dt;

      const fromX = this.root.position.x;
      const fromZ = this.root.position.z;
      const desiredX = fromX + Math.sin(this.heading) * this.speed * dt;
      const desiredZ = fromZ + Math.cos(this.heading) * this.speed * dt;

      if (this.navigationCollision && typeof this.navigationCollision.resolveShipMove === 'function') {
        const move = this.navigationCollision.resolveShipMove(
          this,
          { x: fromX, z: fromZ },
          { x: desiredX, z: desiredZ },
        );
        this.root.position.x = move.x;
        this.root.position.z = move.z;
        this.navigationContact = move.blocked ? move : null;
        if (move.blocked) {
          const scale = Number.isFinite(move.speedScale) ? move.speedScale : 0;
          this.speed *= Math.max(0, Math.min(1, scale));
          if (Math.abs(this.speed) < 0.05) this.speed = 0;
        }
      } else {
        this.root.position.x = desiredX;
        this.root.position.z = desiredZ;
        this.navigationContact = null;
      }
    }

    this._applyBuoyancy(dt);
  }

  floatOnly(dt) {
    if (this.sinking || !this.alive) return;
    this._applyBuoyancy(dt);
  }

  _applyBuoyancy(dt) {
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const rx = Math.cos(this.heading), rz = -Math.sin(this.heading);

    const L2 = this.length * 0.4, B2 = this.beam * 0.4;
    const px = this.root.position.x, pz = this.root.position.z;

    const hBow  = this._swell.getHeight(px + fx * L2, pz + fz * L2);
    const hStbd = this._swell.getHeight(px + rx * B2, pz + rz * B2);
    const hPort = this._swell.getHeight(px - rx * B2, pz - rz * B2);
    const hStern= this._swell.getHeight(px - fx * L2, pz - fz * L2);

    const midY = (hBow + hStern) * 0.5 - this.draft;
    const rawPitch = Math.atan2(hBow - hStern, this.length * 0.8);
    const rawRoll  = Math.atan2(hPort - hStbd, this.beam * 0.8);

    const kY = 1 - Math.exp(-dt * 2.0);
    const kA = 1 - Math.exp(-dt * 1.2);

    this.root.position.y += (midY - this.root.position.y) * kY;
    this.pitch += (rawPitch - this.pitch) * kA;
    this.roll += (rawRoll - this.roll) * kA;

    const qH = BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Y, this.heading);
    const qP = BABYLON.Quaternion.RotationAxis(BABYLON.Axis.X, this.pitch);
    const qR = BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Z, this.roll);
    this.root.rotationQuaternion = qH.multiply(qP).multiply(qR);
  }

  nextTurret() {
    if (!this.turrets || this.turrets.length === 0) return -1;
    this._lastFiredTurret = ((this._lastFiredTurret || 0) + 1) % this.turrets.length;
    return this._lastFiredTurret;
  }

  getMuzzle(outPos, outDir, turretIndex) {
    const t = (turretIndex !== undefined && turretIndex >= 0) ? this.turrets[turretIndex] : null;

    if (t && t.node) {
      const a = t.restYaw + t.yaw;
      const ce = Math.cos(t.elev), se = Math.sin(t.elev);
      this._v1.set(Math.sin(a) * ce, se, Math.cos(a) * ce);
      BABYLON.Vector3.TransformNormalToRef(this._v1, this.root.getWorldMatrix(), this._v2);
      this._v2.normalize();

      const base = t.node.getAbsolutePosition();
      const reach = t.barrel + t.pivotBack;
      outPos.set(base.x + this._v2.x * reach, base.y + t.muzzleY + this._v2.y * reach, base.z + this._v2.z * reach);
      if (outDir) outDir.copyFrom(this._v2);
      return;
    }

    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    outPos.set(this.root.position.x + fx * this.length * 0.35, this.root.position.y + 7, this.root.position.z + fz * this.length * 0.35);
    if (outDir) outDir.set(fx, 0, fz);
  }
}
