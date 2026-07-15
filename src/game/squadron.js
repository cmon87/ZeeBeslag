// src/game/squadron.js
//
// M3.2: Squadron beheer.
// Fotorealistische V-formatie met organische vertraging (spring physics), 
// framerate-onafhankelijke Delta Time (dt) vluchtdynamiek en PBR-geoptimaliseerde rendering.

const PLANE_SPEED = 135;   
const BASE_ALTITUDE = 460; 
const CLEARANCE = 65;      
const MIN_ALT = 85;        
const MAX_ALT = 620;       
const CAPTURE = 280;       
const TURN_BASE = 0.72;    
const PASS_ALT = 420;      
const PLANE_SCALE = 3.5;   
const PROP_Z = 3.882;      
const PROP_RADIUS = 1.35;  
const PROP_SPIN = 46;      
const HIDE_GEAR = true;    
const GEAR_Y = -0.5;       
const VAPOR = true;        

class Plane {
  constructor(mesh, offset) {
    this.mesh = mesh;
    this.offset = offset; 
    
    this.position = mesh.position;
    this.velocity = new BABYLON.Vector3(0, 0, PLANE_SPEED);
    this.forwardDir = new BABYLON.Vector3(0, 0, 1);
    
    this.yaw = 0;
    this.pitch = 0;
    this.currentRoll = 0;
    this.lastYaw = 0;
    this.smoothTurn = 0;   
    this.smoothPitch = 0;  

    this.ps = null;        
    this.vaporL = null;    
    this.vaporR = null;    
  }
}

export class Squadron {
  constructor(scene, opts = {}) {
    this._scene = scene;
    this._island = opts.island || null;
    this.planes = [];
    this.enabled = false;
    this.patrolTime = 0;

    this.offsets = [
      new BABYLON.Vector3(0, 0, 0),              
      new BABYLON.Vector3(38, -2, -35),          
      new BABYLON.Vector3(-31, 1, -42),          
      new BABYLON.Vector3(72, -4, -68),          
      new BABYLON.Vector3(-62, -1, -80)          
    ];
    this.offsets.forEach(o => o.scaleInPlace(PLANE_SCALE));

    this._tmpMatrix = new BABYLON.Matrix();
    this._tmpTarget = new BABYLON.Vector3();
    this._tmpOffset = new BABYLON.Vector3();
    this.circuit = [];
    this.wp = 0;
    this._propDiscs = [];
    this._propMat = null;
    this._propTex = null;
    this._vaporTex = null;

    this._breakTimer = 22;      
    this._breakActive = false;
    this._breakT = 0;
    this._breakDur = 0;
    this._breakSet = new Set();

    this._cam = { type: 'chase', prev: '', t: 0, dur: 6, cut: true };
    this._camPos = new BABYLON.Vector3();
    this._camLook = new BABYLON.Vector3();
    this._camLookS = new BABYLON.Vector3();
    this._islandCam = new BABYLON.Vector3(2900, 200, 200);
  }

  _buildPropMat() {
    if (this._propMat) return;
    const S = 128, c = S / 2, R = c - 2;
    const tex = new BABYLON.DynamicTexture('propTex', S, this._scene, false);
    const ctx = tex.getContext();
    ctx.clearRect(0, 0, S, S);
    const g = ctx.createRadialGradient(c, c, R * 0.08, c, c, R);
    g.addColorStop(0.00, 'rgba(35,35,40,0.55)');    
    g.addColorStop(0.14, 'rgba(120,120,130,0.16)');
    g.addColorStop(0.60, 'rgba(175,180,190,0.09)'); 
    g.addColorStop(0.93, 'rgba(215,220,230,0.16)'); 
    g.addColorStop(1.00, 'rgba(215,220,230,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(230,235,245,0.10)';
    ctx.lineWidth = R * 0.5;
    for (let k = 0; k < 3; k++) {
      ctx.beginPath(); ctx.arc(c, c, R * 0.66, k * 2.094, k * 2.094 + 1.5); ctx.stroke();
    }
    tex.update(); tex.hasAlpha = true;

    const mat = new BABYLON.StandardMaterial('propMat', this._scene);
    mat.diffuseTexture = tex; mat.diffuseTexture.hasAlpha = true;
    mat.useAlphaFromDiffuseTexture = true;
    mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    this._propTex = tex; this._propMat = mat;
  }

  _hideRotor(inst) {
    const rotors = inst.getDescendants(false, n => (n.name || '').toLowerCase().indexOf('rotor') >= 0);
    for (const r of rotors) r.setEnabled(false);
  }

  _attachPropDisc(inst) {
    const disc = BABYLON.MeshBuilder.CreateDisc('propDisc', { radius: PROP_RADIUS, tessellation: 28 }, this._scene);
    disc.material = this._propMat;
    disc.parent = inst;                 
    disc.position.set(0, 0, PROP_Z);    
    disc.isPickable = false;
    disc.rotation.z = Math.random() * Math.PI * 2;
    this._propDiscs.push(disc);
  }

  _buildCircuit() {
    this.circuit = [
      { x: 5200, z: 2900,  y: 470 },       
      { x: 3900, z: 1900,  y: 445 },       
      { x: 3300, z: 800,   y: PASS_ALT },  
      { x: 2850, z: 150,   y: PASS_ALT },  
      { x: 2450, z: -550,  y: PASS_ALT },  
      { x: 2300, z: -1500, y: 420 },       
      { x: 2900, z: -2900, y: 460 },       
      { x: 5200, z: -2600, y: 480 },       
      { x: 6400, z: 200,   y: 470 },       
    ];
    this.wp = 0;
  }

  setIsland(island) { this._island = island; }

  _groundAlt(x, z) {
    if (this._island && this._island.sample) {
      const h = this._island.sample(x, z);
      if (h !== null && h !== undefined) return Math.max(MIN_ALT, h + CLEARANCE);
    }
    return this._island ? MIN_ALT : BASE_ALTITUDE;
  }

  _terrainFloor(x, z) {
    if (this._island && this._island.sample) {
      const h = this._island.sample(x, z);
      if (h !== null && h !== undefined) return Math.max(MIN_ALT, h + 25);
    }
    return MIN_ALT;
  }

  _clamp(plane) {
    const floor = this._terrainFloor(plane.position.x, plane.position.z);
    if (plane.position.y < floor) plane.position.y = floor;
    if (plane.position.y > MAX_ALT) plane.position.y = MAX_ALT;
  }

  _pickShot() {
    const shots = ['chase', 'side', 'front', 'high', 'wing', 'island'];
    let t;
    do { t = shots[(Math.random() * shots.length) | 0]; } while (t === this._cam.prev && shots.length > 1);
    this._cam.type = t;
    this._cam.prev = t;
    this._cam.t = 0;
    this._cam.dur = 5 + Math.random() * 3;
    this._cam.cut = true;
    if (t === 'island') this._computeIslandCam();
  }

  _computeIslandCam() {
    const gx = 2600 + Math.random() * 700;   
    const gz = -400 + Math.random() * 1000;  
    let gy = 180;
    if (this._island && this._island.sample) {
      const h = this._island.sample(gx, gz);
      if (h !== null && h !== undefined) gy = h + 4; 
    }
    this._islandCam.set(gx, gy, gz);
  }

  followCam(cam, dt) {
    if (!this.leader) return;
    const s = this._cam;
    s.t += dt;
    if (s.t >= s.dur) this._pickShot();

    const L = this.leader.position, F = this.leader.forwardDir;
    let sx = F.z, sz = -F.x;
    const sl = Math.hypot(sx, sz) || 1; sx /= sl; sz /= sl;

    const P = this._camPos, K = this._camLook;
    switch (s.type) {
      case 'side':
        P.set(L.x + sx * 95, L.y + 22, L.z + sz * 95);
        K.set(L.x + F.x * 12, L.y, L.z + F.z * 12);
        break;
      case 'front':
        P.set(L.x + F.x * 175, L.y + 18, L.z + F.z * 175);
        K.set(L.x, L.y, L.z);
        break;
      case 'high':
        P.set(L.x - F.x * 30, L.y + 235, L.z - F.z * 30);
        K.set(L.x, L.y, L.z);
        break;
      case 'wing': {
        const w = this.planes[3] ? this.planes[3].position : L;
        P.set(w.x + sx * 12, w.y + 8, w.z + sz * 12 - F.z * 18);
        K.set(L.x, L.y, L.z);
        break;
      }
      case 'island':
        P.copyFrom(this._islandCam);
        K.set(L.x, L.y, L.z);
        break;
      case 'chase':
      default:
        P.set(L.x - F.x * 112 + sx * 22, L.y + 34, L.z - F.z * 112 + sz * 22);
        K.set(L.x + F.x * 50, L.y, L.z + F.z * 50);
        break;
    }

    if (s.cut) {
      cam.position.copyFrom(P);
      this._camLookS.copyFrom(K);
      s.cut = false;
    } else {
      const kp = 1 - Math.exp(-5 * dt);   
      cam.position.x += (P.x - cam.position.x) * kp;
      cam.position.y += (P.y - cam.position.y) * kp;
      cam.position.z += (P.z - cam.position.z) * kp;
      const kl = 1 - Math.exp(-7 * dt);
      this._camLookS.x += (K.x - this._camLookS.x) * kl;
      this._camLookS.y += (K.y - this._camLookS.y) * kl;
      this._camLookS.z += (K.z - this._camLookS.z) * kl;
    }
    cam.setTarget(this._camLookS);
  }

  async load(rootUrl = null, file = 'plane_zero.glb') {
    const base = ['./models/planes/', './planes/', './models/', './models/land/', './assets/planes/'];
    const candidates = rootUrl ? [rootUrl, ...base.filter(x => x !== rootUrl)] : base;

    let res = null, used = null, lastErr = null;
    for (const root of candidates) {
      try {
        const r = await BABYLON.SceneLoader.ImportMeshAsync('', root, file, this._scene);
        if (r && r.meshes && r.meshes.length) { res = r; used = root; break; }
      } catch (e) { lastErr = e; }
    }
    if (!res) {
      throw new Error('plane_zero.glb niet te laden. Geprobeerd: ' + candidates.join(', ')
        + (lastErr ? ' (laatste fout: ' + (lastErr.message || lastErr) + ')' : ''));
    }
    this._rootUrl = used;

    const masterRoot = res.meshes[0];

    res.meshes.forEach(m => {
      m.isPickable = false;
      if (m.getTotalVertices() > 0) {
        m.receiveShadows = true;

        // M4.7: PBR herstel met een vaste albedo in plaats van black crush.
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
          pbr.metallic = 0.05;
          pbr.roughness = 0.85;
          pbr.environmentIntensity = 0.0;
          pbr.albedoColor = new BABYLON.Color3(0.60, 0.65, 0.62); // Lichtgrijsgroen
        }
      }
    });

    this._buildPropMat();
    if (VAPOR) this._buildVaporTex();

    if (HIDE_GEAR) {
      res.meshes.forEach(m => {
        if (m.getTotalVertices() <= 0) return;
        const pos = m.getVerticesData(BABYLON.VertexBuffer.PositionKind);
        if (!pos) return;
        let changed = false;
        for (let k = 1; k < pos.length; k += 3) {
          if (pos[k] < GEAR_Y) { pos[k] = GEAR_Y; changed = true; }
        }
        if (changed) {
          m.setVerticesData(BABYLON.VertexBuffer.PositionKind, pos, false);
          const idx = m.getIndices();
          const nrm = m.getVerticesData(BABYLON.VertexBuffer.NormalKind) || [];
          if (idx) { BABYLON.VertexData.ComputeNormals(pos, idx, nrm); m.setVerticesData(BABYLON.VertexBuffer.NormalKind, nrm, false); }
        }
      });
    }

    this._buildCircuit();
    const w0 = this.circuit[0], w1 = this.circuit[1];
    const fwd = new BABYLON.Vector3(w1.x - w0.x, 0, w1.z - w0.z).normalize();
    this.wp = 1;

    for (let i = 0; i < 5; i++) {
      const inst = masterRoot.instantiateHierarchy(null, { doNotInstantiate: false });
      inst.name = `squadron_zero_${i}`;
      inst.setEnabled(true);
      inst.scaling.setAll(PLANE_SCALE); 
      this._hideRotor(inst);            
      this._attachPropDisc(inst);       

      const plane = new Plane(inst, this.offsets[i]);
      plane.position.set(w0.x + this.offsets[i].x, w0.y + this.offsets[i].y, w0.z + this.offsets[i].z);
      plane.velocity.copyFrom(fwd).scaleInPlace(PLANE_SPEED);
      plane.forwardDir.copyFrom(fwd);
      plane.lastYaw = Math.atan2(fwd.x, fwd.z);
      plane.ps = this._buildContrail(this._scene, inst);
      if (VAPOR) {
        plane.vaporL = this._buildVapor(inst, -1);
        plane.vaporR = this._buildVapor(inst, +1);
      }

      this.planes.push(plane);
    }

    masterRoot.setEnabled(false);

    this.leader = this.planes[0];
    this.enabled = true;
  }

  _buildContrail(scene, mesh) {
    const size = 64;
    const dtex = new BABYLON.DynamicTexture('trailTex', size, scene, false);
    const ctx = dtex.getContext();
    const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
    g.addColorStop(0.0, 'rgba(255, 255, 255, 0.45)');
    g.addColorStop(0.3, 'rgba(210, 215, 220, 0.15)');
    g.addColorStop(1.0, 'rgba(210, 215, 220, 0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
    dtex.update();
    dtex.hasAlpha = true;

    const ps = new BABYLON.ParticleSystem('contrailPS', 250, scene);
    ps.particleTexture = dtex;
    ps.emitter = mesh;
    
    ps.minEmitBox = new BABYLON.Vector3(-0.3, 0.2, -4); 
    ps.maxEmitBox = new BABYLON.Vector3(0.3, 0.2, -4);
    
    ps.color1 = new BABYLON.Color4(1, 1, 1, 0.12);
    ps.color2 = new BABYLON.Color4(0.9, 0.9, 0.95, 0.05);
    ps.colorDead = new BABYLON.Color4(0.85, 0.85, 0.9, 0.0);
    
    ps.minSize = 1.2; ps.maxSize = 4.0;
    ps.minLifeTime = 1.0; ps.maxLifeTime = 2.4;
    
    ps.emitRate = 45; 
    ps.gravity = new BABYLON.Vector3(0, -0.6, 0); 
    ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ALPHA;
    ps.isLocal = false; 
    
    ps.start();
    return ps;
  }

  _buildVaporTex() {
    if (this._vaporTex) return;
    const size = 64;
    const tex = new BABYLON.DynamicTexture('vaporTex', size, this._scene, false);
    const ctx = tex.getContext();
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0.0, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.4, 'rgba(240,245,250,0.22)');
    g.addColorStop(1.0, 'rgba(240,245,250,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
    tex.update(); tex.hasAlpha = true;
    this._vaporTex = tex;
  }

  _buildVapor(mesh, sideSign) {
    const ps = new BABYLON.ParticleSystem('vaporPS', 90, this._scene);
    ps.particleTexture = this._vaporTex;
    ps.emitter = mesh;
    const x = sideSign * 5.7; 
    ps.minEmitBox = new BABYLON.Vector3(x - 0.2, 0.15, -0.6);
    ps.maxEmitBox = new BABYLON.Vector3(x + 0.2, 0.35, -0.6);
    ps.color1 = new BABYLON.Color4(1, 1, 1, 0.11);
    ps.color2 = new BABYLON.Color4(0.95, 0.97, 1.0, 0.06);
    ps.colorDead = new BABYLON.Color4(1, 1, 1, 0.0);
    ps.minSize = 0.8; ps.maxSize = 2.6;
    ps.minLifeTime = 0.35; ps.maxLifeTime = 0.95;
    ps.emitRate = 0;
    ps.gravity = new BABYLON.Vector3(0, -0.2, 0);
    ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ALPHA;
    ps.isLocal = false;
    ps.start();
    return ps;
  }

  _updateVapor(plane) {
    if (!plane.vaporL) return;
    const turnMag = Math.min(1, Math.abs(plane.smoothTurn) / 0.5);
    const rate = 4 + turnMag * turnMag * 140; 
    plane.vaporL.emitRate = rate;
    plane.vaporR.emitRate = rate;
  }

  update(dt) {
    if (!this.enabled || dt <= 0 || !this.leader) return;

    this.patrolTime += dt;

    if (this._breakActive) {
      this._breakT += dt;
      if (this._breakT >= this._breakDur) { this._breakActive = false; this._breakSet.clear(); }
    } else {
      this._breakTimer -= dt;
      if (this._breakTimer <= 0 && this.planes.length >= 5) {
        this._breakActive = true;
        this._breakT = 0;
        this._breakDur = 12 + Math.random() * 6;   
        const a = 1 + ((Math.random() * 4) | 0);
        let b = 1 + ((Math.random() * 4) | 0);
        if (b === a) b = (a % 4) + 1;
        this._breakSet = new Set([a, b]);
        this._breakTimer = 28 + Math.random() * 22; 
      }
    }

    const wp = this.circuit[this.wp];
    const dx = wp.x - this.leader.position.x;
    const dz = wp.z - this.leader.position.z;
    if (dx * dx + dz * dz < CAPTURE * CAPTURE) {
      this.wp = (this.wp + 1) % this.circuit.length;
    }
    this._tmpTarget.set(wp.x, wp.y, wp.z);
    const dirToTarget = this._tmpTarget.subtract(this.leader.position).normalize();
    this.leader.forwardDir = BABYLON.Vector3.Lerp(
      this.leader.forwardDir, dirToTarget, 1.0 - Math.pow(TURN_BASE, dt)
    ).normalize();
    this.leader.position.addInPlace(this.leader.forwardDir.scale(PLANE_SPEED * dt));
    this._clamp(this.leader);
    this._applyFlightDynamics(this.leader, dt);
    this._updateVapor(this.leader);

    BABYLON.Matrix.RotationYawPitchRollToRef(this.leader.yaw, this.leader.pitch, 0, this._tmpMatrix);
    this._tmpMatrix.setTranslation(this.leader.position);

    const k = 1 - Math.exp(-9 * dt);

    for (let i = 1; i < this.planes.length; i++) {
      const plane = this.planes[i];

      let ox = plane.offset.x, oy = plane.offset.y, oz = plane.offset.z;
      if (this._breakActive && this._breakSet.has(i)) {
        const p = this._breakT / this._breakDur;      
        const env = Math.sin(p * Math.PI);            
        const side = plane.offset.x >= 0 ? 1 : -1;
        ox += side * (520 + 120 * Math.sin(p * Math.PI * 3)) * env; 
        oy += 150 * env;                                            
        oz += (-140 + 80 * Math.sin(p * Math.PI * 2)) * env;        
      }
      this._tmpOffset.set(ox, oy, oz);
      const anchorPos = BABYLON.Vector3.TransformCoordinates(this._tmpOffset, this._tmpMatrix);

      const px = plane.position.x, py = plane.position.y, pz = plane.position.z;
      plane.position.x += (anchorPos.x - px) * k;
      plane.position.y += (anchorPos.y - py) * k;
      plane.position.z += (anchorPos.z - pz) * k;
      this._clamp(plane);

      const mvx = plane.position.x - px, mvy = plane.position.y - py, mvz = plane.position.z - pz;
      if (mvx * mvx + mvz * mvz > 1e-4) {
        plane.forwardDir.set(mvx, mvy, mvz).normalize();
      } else {
        plane.forwardDir.copyFrom(this.leader.forwardDir);
      }

      this._applyFlightDynamics(plane, dt);
      this._updateVapor(plane);
    }

    for (let i = 0; i < this._propDiscs.length; i++) this._propDiscs[i].rotation.z += PROP_SPIN * dt;
  }

  _applyFlightDynamics(plane, dt) {
    const currentYaw = Math.atan2(plane.forwardDir.x, plane.forwardDir.z);

    let yawDelta = currentYaw - plane.lastYaw;
    if (yawDelta > Math.PI) yawDelta -= 2 * Math.PI;
    if (yawDelta < -Math.PI) yawDelta += 2 * Math.PI;
    plane.lastYaw = currentYaw;

    const raw = yawDelta / dt;
    plane.smoothTurn += (raw - plane.smoothTurn) * (1 - Math.pow(0.06, dt));

    const targetRoll = BABYLON.Scalar.Clamp(-plane.smoothTurn * 1.5, -0.9, 0.9);
    plane.currentRoll = BABYLON.Scalar.Lerp(plane.currentRoll, targetRoll, 1.0 - Math.pow(0.28, dt));

    const rawPitch = Math.asin(Math.max(-1, Math.min(1, -plane.forwardDir.y)));
    plane.smoothPitch += (rawPitch - plane.smoothPitch) * (1 - Math.pow(0.05, dt));

    plane.yaw = currentYaw;
    plane.pitch = plane.smoothPitch;

    if (!plane.mesh.rotationQuaternion) {
      plane.mesh.rotationQuaternion = new BABYLON.Quaternion();
    }
    BABYLON.Quaternion.RotationYawPitchRollToRef(
      plane.yaw, plane.pitch, plane.currentRoll, plane.mesh.rotationQuaternion
    );
  }

  reset() {
    if (!this.planes.length) return;
    if (!this.circuit.length) this._buildCircuit();
    const w0 = this.circuit[0], w1 = this.circuit[1];
    const fwd = new BABYLON.Vector3(w1.x - w0.x, 0, w1.z - w0.z).normalize();

    this.patrolTime = 0;
    this.wp = 1;
    this._breakTimer = 22;
    this._breakActive = false;
    this._breakT = 0;
    this._breakDur = 0;
    this._breakSet.clear();
    this._cam.type = 'chase';
    this._cam.prev = '';
    this._cam.t = 0;
    this._cam.cut = true;

    for (let i = 0; i < this.planes.length; i++) {
      const plane = this.planes[i];
      const off = this.offsets[i] || BABYLON.Vector3.Zero();
      plane.position.set(w0.x + off.x, w0.y + off.y, w0.z + off.z);
      plane.velocity.copyFrom(fwd).scaleInPlace(PLANE_SPEED);
      plane.forwardDir.copyFrom(fwd);
      plane.yaw = Math.atan2(fwd.x, fwd.z);
      plane.pitch = 0;
      plane.currentRoll = 0;
      plane.lastYaw = plane.yaw;
      plane.smoothTurn = 0;
      plane.smoothPitch = 0;
      if (BABYLON.Quaternion && BABYLON.Quaternion.RotationYawPitchRoll) {
        plane.mesh.rotationQuaternion = BABYLON.Quaternion.RotationYawPitchRoll(plane.yaw, 0, 0);
      }
      for (const ps of [plane.ps, plane.vaporL, plane.vaporR]) {
        try { if (ps && typeof ps.reset === 'function') ps.reset(); } catch (_) {}
      }
    }
  }

  dispose() {
    this.enabled = false;
    for (const d of this._propDiscs) d.dispose();
    this._propDiscs = [];
    if (this._propMat) { this._propMat.dispose(); this._propMat = null; }
    if (this._propTex) { this._propTex.dispose(); this._propTex = null; }
    for (const plane of this.planes) {
      if (plane.ps) plane.ps.dispose();
      if (plane.vaporL) plane.vaporL.dispose();
      if (plane.vaporR) plane.vaporR.dispose();
      plane.mesh.dispose(false, true);
    }
    if (this._vaporTex) { this._vaporTex.dispose(); this._vaporTex = null; }
    this.planes = [];
  }
}
