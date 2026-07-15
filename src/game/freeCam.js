// src/game/freeCam.js
//
// M3.2: vrije vliegcamera voor de 'free'-modus. Bestuurt de bestaande UniversalCamera direct,
// geen attachControl, in lijn met chaseCamera.js.
//
// Besturing (mobiel, twee joysticks):
//   rechter stick  -> kijken (yaw en pitch)
//   linker stick   -> vliegen: omhoog duwen vliegt in kijkrichting, opzij strafet horizontaal
// Omhoog en omlaag komen. dus vanzelf door omhoog te kijken en vooruit te vliegen. Geen aparte
// hoogteknoppen nodig, wat op een telefoon zonder toetsenbord het prettigst werkt.

const TURN = 1.7;    // rad/s bij volle stick
const SPEED = 420;   // m/s bij volle stick
const PITCH_LIMIT = 1.45;
const Y_MIN = 6;
const Y_MAX = 3800;

export class FreeCam {
  constructor(cam) {
    this.cam = cam;
    this.pos = cam.position.clone();
    this.yaw = 0;
    this.pitch = 0;
    this._look = new BABYLON.Vector3();
    this._fwd = new BABYLON.Vector3();
    this._right = new BABYLON.Vector3();
    this.seedFromCam(cam);
  }

  // Neem de huidige camerastand over, zodat instappen in free-modus geen sprong geeft.
  seedFromCam(cam) {
    this.pos.copyFrom(cam.position);
    const d = cam.getDirection(BABYLON.Axis.Z);
    const L = Math.hypot(d.x, d.y, d.z) || 1;
    this.yaw = Math.atan2(d.x / L, d.z / L);
    this.pitch = Math.asin(Math.max(-1, Math.min(1, d.y / L)));
  }

  update(dt, joyState, altState) {
    const jl = joyState.left, jr = joyState.right;

    // Kijken met de rechter stick.
    this.yaw += jr.x * TURN * dt;
    this.pitch += -jr.y * TURN * dt;
    if (this.pitch > PITCH_LIMIT) this.pitch = PITCH_LIMIT;
    if (this.pitch < -PITCH_LIMIT) this.pitch = -PITCH_LIMIT;

    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    this._fwd.set(sy * cp, sp, cy * cp);
    this._right.set(cy, 0, -sy);

    // Vliegen met de linker stick. Omhoog duwen (jl.y negatief) gaat vooruit langs de kijkas.
    const fwd = -jl.y * SPEED * dt;
    const str = jl.x * SPEED * dt;
    this.pos.x += this._fwd.x * fwd + this._right.x * str;
    this.pos.y += this._fwd.y * fwd;
    this.pos.z += this._fwd.z * fwd + this._right.z * str;

    // Optioneel hoogte via de alt-knoppen, als die zichtbaar zijn.
    if (altState) {
      if (altState.up) this.pos.y += SPEED * dt;
      if (altState.down) this.pos.y -= SPEED * dt;
    }

    if (this.pos.y < Y_MIN) this.pos.y = Y_MIN;
    if (this.pos.y > Y_MAX) this.pos.y = Y_MAX;

    this.cam.position.copyFrom(this.pos);
    this._look.set(this.pos.x + this._fwd.x, this.pos.y + this._fwd.y, this.pos.z + this._fwd.z);
    this.cam.setTarget(this._look);
  }
}
