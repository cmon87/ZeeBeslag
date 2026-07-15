// M6.6: WakeManager met mobiel budget.
// - resolutie en updatefrequentie komen uit het performanceprofiel;
// - CPU-decay en GPU-upload lopen op vaste lage frequentie, niet iedere renderframe;
// - interpolatie en boeggolfrecords zijn begrensd;
// - een stilstaand schip blijft de wake-map niet verzadigen.

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

export class WakeManager {
  constructor(scene, oceanRig, cfg) {
    this.scene = scene;
    this.oceanRig = oceanRig;
    this.cfg = cfg;

    this.res = clampInt(cfg.wakeResolution ?? 256, 128, 512);
    this.updateHz = Math.max(8, Math.min(60, Number(cfg.wakeUpdateHz ?? 20)));
    this.updateInterval = 1 / this.updateHz;
    this.maxParts = clampInt(cfg.wakeMaxParts ?? 48, 8, 128);
    this.maxInterpolationStamps = clampInt(cfg.wakeMaxInterpolationStamps ?? 24, 4, 64);
    this.size = 2000;
    this.deposit = 15;
    this.shelterR = 4;
    this.shelterAmp = 130;
    this.cx = 0;
    this.cz = 0;
    this._accum = 0;
    this._uploads = 0;
    this._skipped = 0;

    this.data = new Uint8Array(this.res * this.res * 2);
    this.scratch = new Uint8Array(this.res * this.res * 2);
    this.tex = new BABYLON.RawTexture(
      this.data,
      this.res,
      this.res,
      BABYLON.Constants.TEXTUREFORMAT_RG,
      scene,
      false,
      false,
      BABYLON.Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
      BABYLON.Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );

    this._wakeCenterVec = new BABYLON.Vector2(0, 0);

    if (this.oceanRig && this.oceanRig.mat) {
      this.oceanRig.mat.setTexture('uWakeMap', this.tex);
      this.oceanRig.mat.setVector2('uWakeCenter', this._wakeCenterVec);
      this.oceanRig.mat.setFloat('uWakeSize', this.size);
      this.oceanRig.mat.setFloat('uWakeStrength', this.cfg.wakeStrength);
      this.oceanRig.mat.setFloat('uWakeFlatten', this.cfg.wakeFlatten);
    }
  }

  get performanceStats() {
    return {
      resolution: this.res,
      updateHz: this.updateHz,
      bytesPerUpload: this.data ? this.data.byteLength : 0,
      uploads: this._uploads,
      skippedFrames: this._skipped,
      maxParts: this.maxParts,
    };
  }

  wakeStamp(wx, wz, rTex, amp, ch) {
    const u = (wx - this.cx) / this.size + 0.5;
    const v = (wz - this.cz) / this.size + 0.5;
    if (u < 0 || u > 1 || v < 0 || v > 1) return;

    const cx = u * this.res;
    const cy = v * this.res;
    const d = this.data;
    const R = this.res;

    const x0 = Math.max(0, (cx - rTex) | 0);
    const x1 = Math.min(R - 1, (cx + rTex) | 0);
    const y0 = Math.max(0, (cy - rTex) | 0);
    const y1 = Math.min(R - 1, (cy + rTex) | 0);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dist = Math.hypot(x - cx, y - cy);
        if (dist > rTex) continue;
        const idx = (y * R + x) * 2 + ch;
        const nv = d[idx] + amp * (1 - dist / rTex);
        d[idx] = nv > 255 ? 255 : nv;
      }
    }
  }

  wakeStampShip(ship, dt) {
    if (!ship || !ship.alive) return;
    const p = ship.root.position;
    const h = ship.heading;
    const fx0 = Math.sin(h);
    const fz0 = Math.cos(h);
    const moving = Math.abs(ship.speed) > 0.08;

    const halfLen = ship.length * 0.45;
    const bowX = p.x + fx0 * halfLen;
    const bowZ = p.z + fz0 * halfLen;
    const sternX = p.x - fx0 * halfLen;
    const sternZ = p.z - fz0 * halfLen;

    // Alleen een bewegend schip maakt een luwtepad. Dit voorkomt dat kanaal G tijdens
    // stilstand iedere update naar 255 wordt opgeteld.
    if (moving) {
      this.wakeStamp(sternX, sternZ, ship.beam * 0.8, this.shelterAmp, 1);
      this.wakeStamp(p.x, p.z, ship.beam * 0.5, this.shelterAmp, 1);
    }

    if (ship.speed > this.cfg.wakeMinSpeed) {
      if (!ship._foamLast) ship._foamLast = { x: sternX, z: sternZ };
      const dx = sternX - ship._foamLast.x;
      const dz = sternZ - ship._foamLast.z;
      const len = Math.hypot(dx, dz);

      if (len > 0.5) {
        const w = ship.beam * 0.4 + Math.min(ship.speed / 10, 1) * 2.0;
        const step = this.size / this.res;
        const n = Math.min(Math.ceil(len / step), this.maxInterpolationStamps);
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          this.wakeStamp(ship._foamLast.x + dx * t, ship._foamLast.z + dz * t, w, this.deposit * 0.4, 0);
        }
        ship._foamLast.x = sternX;
        ship._foamLast.z = sternZ;
      }

      if (!ship._wakeParts) ship._wakeParts = [];
      if (!ship._lastBow) ship._lastBow = { x: bowX, z: bowZ };

      const bowMove = Math.hypot(bowX - ship._lastBow.x, bowZ - ship._lastBow.z);
      if (bowMove > 3.0) {
        const nx = -fz0;
        const nz = fx0;
        ship._wakeParts.push({
          x: bowX, z: bowZ,
          nx, nz,
          age: 0,
          speed: ship.speed * 0.35,
          maxAge: 12.0,
        });
        if (ship._wakeParts.length > this.maxParts) {
          ship._wakeParts.splice(0, ship._wakeParts.length - this.maxParts);
        }
        ship._lastBow.x = bowX;
        ship._lastBow.z = bowZ;
      }

      for (let i = ship._wakeParts.length - 1; i >= 0; i--) {
        const wp = ship._wakeParts[i];
        wp.age += dt;
        if (wp.age > wp.maxAge) {
          ship._wakeParts.splice(i, 1);
          continue;
        }

        const dist = wp.age * wp.speed;
        const pxL = wp.x - wp.nx * dist;
        const pzL = wp.z - wp.nz * dist;
        const pxR = wp.x + wp.nx * dist;
        const pzR = wp.z + wp.nz * dist;
        const life = wp.age / wp.maxAge;
        const radius = 1.0 + life * 15.0;
        const amp = this.deposit * 0.5 * (1.0 - life);

        this.wakeStamp(pxL, pzL, radius, amp, 0);
        this.wakeStamp(pxR, pzR, radius, amp, 0);
      }
      this.wakeStamp(bowX, bowZ, ship.beam * 0.4, this.deposit * 0.6, 0);
    } else {
      ship._foamLast = { x: sternX, z: sternZ };
      ship._lastBow = { x: bowX, z: bowZ };
      if (ship._wakeParts) ship._wakeParts = [];
    }
  }

  update(cdt, playerShip, enemyShip) {
    if (!this.data || !this.tex || this.cfg.wakeStrength <= 0 || !Number.isFinite(cdt) || cdt <= 0) return;
    this._accum += cdt;
    if (this._accum + 1e-9 < this.updateInterval) {
      this._skipped++;
      return;
    }

    // Een achtergrondwissel mag niet in één update alle wake wegvagen of honderden stamps maken.
    const stepDt = Math.min(this._accum, 0.25);
    this._accum = 0;
    const decay = Math.exp(-stepDt / this.cfg.wakeTau);
    const pxm = this.size / this.res;

    let ax = 0, az = 0, n = 0;
    if (playerShip && playerShip.alive) { ax += playerShip.root.position.x; az += playerShip.root.position.z; n++; }
    if (enemyShip && enemyShip.alive) { ax += enemyShip.root.position.x; az += enemyShip.root.position.z; n++; }

    let shiftX = 0, shiftZ = 0;
    if (n > 0) {
      ax /= n; az /= n;
      const tCx = Math.round(ax / pxm) * pxm;
      const tCz = Math.round(az / pxm) * pxm;
      shiftX = Math.round((tCx - this.cx) / pxm);
      shiftZ = Math.round((tCz - this.cz) / pxm);
    }

    if (shiftX !== 0 || shiftZ !== 0) {
      const R = this.res;
      const src = this.data;
      const dst = this.scratch;
      for (let y = 0; y < R; y++) {
        const yy = y + shiftZ;
        const rowOk = yy >= 0 && yy < R;
        for (let x = 0; x < R; x++) {
          const di = (y * R + x) * 2;
          const xx = x + shiftX;
          if (rowOk && xx >= 0 && xx < R) {
            const si = (yy * R + xx) * 2;
            dst[di] = src[si] * decay;
            dst[di + 1] = src[si + 1] * decay;
          } else {
            dst[di] = 0;
            dst[di + 1] = 0;
          }
        }
      }
      this.data = dst;
      this.scratch = src;
      this.cx += shiftX * pxm;
      this.cz += shiftZ * pxm;
      if (this.oceanRig && this.oceanRig.mat) {
        this.oceanRig.mat.setVector2('uWakeCenter', this._wakeCenterVec.set(this.cx, this.cz));
      }
    } else {
      const d = this.data;
      for (let i = 0; i < d.length; i++) d[i] *= decay;
    }

    this.wakeStampShip(playerShip, stepDt);
    this.wakeStampShip(enemyShip, stepDt);
    this.tex.update(this.data);
    this._uploads++;
  }

  reset(playerShip = null, enemyShip = null) {
    if (!this.data || !this.tex) return;
    this.data.fill(0);
    this.scratch.fill(0);
    this._accum = 0;

    const ships = [playerShip, enemyShip].filter(Boolean);
    let ax = 0, az = 0;
    for (const ship of ships) {
      if (ship.root && ship.root.position) {
        ax += ship.root.position.x;
        az += ship.root.position.z;
      }
      ship._foamLast = null;
      ship._lastBow = null;
      ship._wakeParts = [];
    }
    if (ships.length) {
      this.cx = ax / ships.length;
      this.cz = az / ships.length;
    } else {
      this.cx = 0;
      this.cz = 0;
    }
    if (this.oceanRig && this.oceanRig.mat) {
      this.oceanRig.mat.setVector2('uWakeCenter', this._wakeCenterVec.set(this.cx, this.cz));
    }
    this.tex.update(this.data);
    this._uploads++;
  }

  dispose() {
    if (this.tex) {
      this.tex.dispose();
      this.tex = null;
    }
    this.data = null;
    this.scratch = null;
  }
}
