// src/game/chaseCamera.js
//
// M3.0: camera-controller op de bestaande UniversalCamera. Geen nieuwe camera, geen attachControl.
//
// Waarom er stijlen zijn. De oude camera lijnde zich uit op de VAARKOERS: 85 meter bakboord,
// 20 meter naar achteren. Je schip ligt echter dwars op het eiland (koers +Z, eiland +X), dus
// "achter het schip" keek negentig graden van het doel weg. Dat is geen bug maar wel verwarrend.
//
// De stijl 'doel' lijnt zich uit op de SCHIP-NAAR-DOEL as. Dan staat de camera altijd achter je
// schip met het eiland erachter, ongeacht je koers. Dat is wat je bedoelt met "netjes achter het
// schip".
//
//   rel: 'doel'   -> as = schip naar vijand. side/back/height liggen in dat stelsel.
//   rel: 'koers'  -> as = vaarkoers. Klassieke breedzij, en de enige juiste als er geen doel is.

export const CAM_STYLES = {
  doel:  { rel: 'doel',  side:  14, back: 130, height:  36, lookAhead: 0.42 },
  kwart: { rel: 'koers', side:  85, back:  20, height:  32, lookAhead: 0.50 },
  hoog:  { rel: 'doel',  side:  40, back: 210, height: 120, lookAhead: 0.55 },
  brug:  { rel: 'koers', side:   0, back:  -6, height:  24, lookAhead: 0.60 },
};
export const CAM_ORDER = ['doel', 'kwart', 'hoog', 'brug'];

export class ChaseCamera {
  constructor(cam, ship, opts = {}) {
    this.cam = cam;
    this.ship = ship;
    this.enemy = opts.enemy ?? null;

    this._pos = cam.position.clone();
    this._look = new BABYLON.Vector3();
    this._scratch = new BABYLON.Vector3();
    this._axis = new BABYLON.Vector3(0, 0, 1);
    this._smLookY = ship.root.position.y + 6;
    this.enabled = false;

    this.setStyle(opts.style || 'doel');
    if (opts.side !== undefined)   this.SIDE = opts.side;
    if (opts.back !== undefined)   this.BACK = opts.back;
    if (opts.height !== undefined) this.HEIGHT = opts.height;
  }

  setEnemy(ship) { this.enemy = ship; }

  setStyle(name, snap = false) {
    const s = CAM_STYLES[name] || CAM_STYLES.doel;
    this.style = CAM_STYLES[name] ? name : 'doel';
    this.REL = s.rel;
    this.SIDE = s.side;
    this.BACK = s.back;
    this.HEIGHT = s.height;
    this.LOOK_BIAS = s.lookAhead;
    if (snap && this.enabled) this.activate();
    return this.style;
  }

  cycleStyle() {
    const i = CAM_ORDER.indexOf(this.style);
    return this.setStyle(CAM_ORDER[(i + 1) % CAM_ORDER.length], true);
  }

  // Voorwaartse as in het XZ-vlak: richting het doel, of anders de vaarkoers.
  _forward(out) {
    const s = this.ship.root.position;
    const e = this._enemyPos();
    if (this.REL === 'doel' && e) {
      const dx = e.x - s.x, dz = e.z - s.z;
      const L = Math.hypot(dx, dz);
      if (L > 1e-3) { out.set(dx / L, 0, dz / L); return out; }
    }
    const h = this.ship.heading;
    out.set(Math.sin(h), 0, Math.cos(h));
    return out;
  }

  _enemyPos() {
    return (this.enemy && this.enemy.alive && this.enemy.root) ? this.enemy.root.position : null;
  }

  _place(out) {
    const s = this.ship.root.position;
    const f = this._forward(this._axis);
    const portX = -f.z, portZ = f.x;      // bakboord staat loodrecht op de voorwaartse as
    out.x = s.x + portX * this.SIDE - f.x * this.BACK;
    out.y = s.y + this.HEIGHT;
    out.z = s.z + portZ * this.SIDE - f.z * this.BACK;
  }

  activate() {
    this.enabled = true;
    this._place(this._pos);
    this.cam.position.copyFrom(this._pos);
    this._smLookY = this.ship.root.position.y + 6;
  }

  deactivate() { this.enabled = false; }

  update(dt) {
    if (!this.enabled) return;
    const s = this.ship.root.position;
    const e = this._enemyPos();

    this._place(this._scratch);
    const kH = 1 - Math.exp(-dt * 2.2);
    const kV = 1 - Math.exp(-dt * 0.9);

    this._pos.x += (this._scratch.x - this._pos.x) * kH;
    this._pos.z += (this._scratch.z - this._pos.z) * kH;
    this._pos.y += (this._scratch.y - this._pos.y) * kV;
    this.cam.position.copyFrom(this._pos);

    let lx, lz;
    if (e) {
      lx = s.x + (e.x - s.x) * this.LOOK_BIAS;
      lz = s.z + (e.z - s.z) * this.LOOK_BIAS;
      this._smLookY += (((s.y + e.y) * 0.5) - this._smLookY) * kV;
    } else {
      // Geen doel: brandpunt ver op de horizon, zodat de camera parallel langs het schip kijkt.
      const f = this._forward(this._axis);
      lx = s.x + f.x * 2000;
      lz = s.z + f.z * 2000;
      this._smLookY += ((s.y + 6) - this._smLookY) * kV;
    }

    this._look.set(lx, this._smLookY, lz);
    this.cam.setTarget(this._look);
  }
}
