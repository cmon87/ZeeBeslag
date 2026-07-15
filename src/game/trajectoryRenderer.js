// M2.0: TrajectoryRenderer.
//
// Twee wijzigingen.
//
// 1. Hij tekent nu de baan die de granaat DAADWERKELIJK volgt, dus vanaf de monding langs de
//    echte looprichting. Voorheen tekende hij de ideale oplossing naar het mikpunt, ongeacht
//    waar de loop stond. Daardoor liet de lijn altijd zien dat je zou raken, ook als de toren
//    nog dertig graden verkeerd stond. De lijn is nu echte feedback: ligt hij op het kruis,
//    dan lig je op doel.
//
// 2. Geen allocaties per frame meer. De vorige versie bouwde per toren 31 nieuwe Vector3 plus
//    een array, elke frame, terwijl het commentaar beweerde dat te vermijden.

const STEPS = 48;

export class TrajectoryRenderer {
  constructor(scene, ballistics, swell) {
    this.scene = scene;
    this.ballistics = ballistics;
    this.swell = swell;
    this.gravity = ballistics ? ballistics.g : 9.81;

    this.lines = [];
    this._pts = [];               // hergebruikte puntenbuffer per lijn
    this._muzzle = new BABYLON.Vector3();
    this._dir = new BABYLON.Vector3();

    this._green = new BABYLON.Color3(0.49, 0.91, 0.69);
    this._red   = new BABYLON.Color3(1.00, 0.35, 0.28);
  }

  _ensure(n) {
    while (this.lines.length < n) {
      const buf = [];
      for (let j = 0; j <= STEPS; j++) buf.push(BABYLON.Vector3.Zero());
      const line = BABYLON.MeshBuilder.CreateLines('traj_' + this.lines.length, { points: buf, updatable: true }, this.scene);
      line.alpha = 0.75;
      line.isPickable = false;
      line.doNotSyncBoundingInfo = true;
      line.alwaysSelectAsActiveMesh = true;
      this.lines.push(line);
      this._pts.push(buf);
    }
  }

  update(playerShip, muzzleVelocity, isReady) {
    if (!playerShip || !playerShip.alive || !playerShip.turrets.length) { this.hide(); return; }

    this._ensure(playerShip.turrets.length);
    const col = isReady ? this._green : this._red;

    for (let i = 0; i < playerShip.turrets.length; i++) {
      playerShip.getMuzzle(this._muzzle, this._dir, i);

      const vx = this._dir.x * muzzleVelocity;
      const vy = this._dir.y * muzzleVelocity;
      const vz = this._dir.z * muzzleVelocity;

      // Analytische vluchttijd tot terugkeer op mondingshoogte, plus marge voor de daling.
      const tUp = Math.max(vy, 0) / this.gravity;
      const tof = Math.max(2 * tUp + 1.5, 1.0);
      const dt = tof / STEPS;

      const buf = this._pts[i];
      let ended = false;
      for (let j = 0; j <= STEPS; j++) {
        const t = j * dt;
        const px = this._muzzle.x + vx * t;
        const pz = this._muzzle.z + vz * t;
        let py = this._muzzle.y + vy * t - 0.5 * this.gravity * t * t;

        if (!ended) {
          const wy = this.swell ? this.swell.getHeight(px, pz) : 0;
          if (t > 0 && py < wy) { py = wy; ended = true; }
        } else {
          // Alle resterende punten op het laatste punt: de lijn stopt visueel bij de inslag.
          buf[j].copyFrom(buf[j - 1]);
          continue;
        }
        buf[j].set(px, py, pz);
      }

      const line = this.lines[i];
      line.isVisible = true;
      line.color = col;
      BABYLON.MeshBuilder.CreateLines('traj_' + i, { points: buf, instance: line });
    }

    for (let i = playerShip.turrets.length; i < this.lines.length; i++) this.lines[i].isVisible = false;
  }

  hide() {
    for (const line of this.lines) line.isVisible = false;
  }

  dispose() {
    for (const line of this.lines) line.dispose();
    this.lines = [];
    this._pts = [];
  }
}
