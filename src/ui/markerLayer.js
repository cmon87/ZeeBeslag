// src/ui/markerLayer.js
//
// M6.5: doelmarkers met tactische rollen en korte identificatiemeldingen.
// Onbekende doelen blijven onzichtbaar. Radar, depot, bunker en batterij zijn na spotting
// visueel en tekstueel van elkaar te onderscheiden zonder extra knoppen.

const CY = '#7eb8d4', AM = '#ffcf6a', RD = '#ff7a68', GY = '#5a6570', GR = '#7ee8b0';
const TYPE_COLORS = Object.freeze({ battery: RD, arty: RD, radar: CY, depot: AM, bunker: GR, aa: AM, def: CY });
const MARKER_LIFT = 140;
const DUCK_RADIUS = 200;
const DUCK_TIME = 3.4;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

export class MarkerLayer {
  constructor() {
    const root = document.createElement('div');
    root.setAttribute('data-ui', '');
    root.style.cssText = 'position:fixed;inset:0;z-index:38;pointer-events:none;font-family:"Courier New",monospace;';
    document.body.appendChild(root);
    this._root = root;
    this._entries = new Map();

    this._counter = document.createElement('div');
    this._counter.style.cssText = 'position:fixed;top:14px;left:14px;font-size:11px;line-height:1.45;letter-spacing:0.10em;color:' + CY + ';text-shadow:0 1px 3px #000;';
    root.appendChild(this._counter);

    this._announce = document.createElement('div');
    this._announce.style.cssText = 'position:fixed;top:102px;left:50%;transform:translateX(-50%);max-width:min(82vw,420px);padding:9px 13px;border:1px solid rgba(126,184,212,0.45);border-radius:7px;background:rgba(5,12,22,0.82);text-align:center;opacity:0;transition:opacity .18s;font-size:11px;line-height:1.45;text-shadow:0 1px 3px #000;';
    root.appendChild(this._announce);
    this._announceUntil = 0;

    this._proj = new BABYLON.Vector3();
    this._dir = new BABYLON.Vector3();
    this._lift = new BABYLON.Vector3();
    this._id = BABYLON.Matrix.Identity();
    this._visible = true;
    this._ducks = [];
    this._now = 0;
  }

  setVisible(v) { this._visible = v; this._root.style.display = v ? '' : 'none'; }

  announce(title, detail = '', type = 'def', duration = 3.2) {
    const col = TYPE_COLORS[type] || CY;
    const safeTitle = escapeHtml(title);
    const safeDetail = escapeHtml(detail);
    this._announce.innerHTML = `<div style="color:${col};font-weight:bold;letter-spacing:.10em">${safeTitle}</div>${safeDetail ? `<div style="color:#d9e5ec;margin-top:3px">${safeDetail}</div>` : ''}`;
    this._announce.style.borderColor = col;
    this._announce.style.opacity = '1';
    this._announceUntil = this._now + Math.max(0.5, duration);
  }

  duckAt(pos) { this._ducks.push({ x: pos.x, z: pos.z, until: this._now + DUCK_TIME }); }

  _duckFactor(p) {
    let f = 1;
    for (const d of this._ducks) {
      const dx = p.x - d.x, dz = p.z - d.z;
      if (dx * dx + dz * dz > DUCK_RADIUS * DUCK_RADIUS) continue;
      const left = (d.until - this._now) / DUCK_TIME;
      if (left > 0) f = Math.min(f, 1 - left);
    }
    return Math.max(f, 0.12);
  }

  _make(emp) {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:0;top:0;transform:translate(-50%,-50%);opacity:0;transition:opacity 0.12s;will-change:transform;';

    const ring = document.createElement('div');
    ring.style.cssText = 'width:12px;height:12px;border:1px solid ' + CY + ';transform:rotate(45deg);margin:0 auto;';
    el.appendChild(ring);

    const stem = document.createElement('div');
    stem.style.cssText = 'width:1px;height:0px;margin:1px auto 0;background:linear-gradient(' + CY + ',transparent);opacity:0.5;';
    el.appendChild(stem);

    const txt = document.createElement('div');
    txt.style.cssText = 'margin-top:6px;font-size:9px;letter-spacing:0.08em;white-space:nowrap;text-align:center;color:' + CY + ';text-shadow:0 1px 3px #000;';
    el.appendChild(txt);

    const track = document.createElement('div');
    track.style.cssText = 'width:42px;height:3px;margin:3px auto 0;background:rgba(10,20,40,0.75);border-radius:2px;overflow:hidden;';
    const bar = document.createElement('div');
    bar.style.cssText = 'height:100%;width:100%;background:' + RD + ';transition:width 0.2s;';
    track.appendChild(bar);
    el.appendChild(track);

    this._root.appendChild(el);
    const e = { el, ring, stem, txt, bar, track };
    this._entries.set(emp, e);
    return e;
  }

  update(cam, registry, active, shipPos, dt = 0.016, defenseNetwork = null, mission = null) {
    if (!this._visible || !cam || !registry) return;

    this._now += Math.max(0, dt);
    if (this._ducks.length) this._ducks = this._ducks.filter(d => d.until > this._now);
    if (this._announceUntil > 0 && this._now >= this._announceUntil) {
      this._announce.style.opacity = '0';
      this._announceUntil = 0;
    }

    const W = window.innerWidth, H = window.innerHeight;
    const vp = cam.viewport.toGlobal(W, H);
    const tm = cam.getScene().getTransformMatrix();
    const fwd = cam.getDirection(BABYLON.Axis.Z);
    const ns = defenseNetwork ? defenseNetwork.status : null;
    this._counter.style.display = mission ? 'none' : '';
    this._counter.innerHTML = mission
      ? `VUURMISSIE&nbsp; ${Math.min(mission.objectiveIndex + 1, mission.objectiveTotal)} / ${mission.objectiveTotal}`
        + `<br><span style="color:${AM}">${mission.phaseLabel || ''}</span>`
      : `OBJECTIEVEN&nbsp; ${registry.objectiveRemaining} / ${registry.objectiveCount}`
        + (ns ? `<br><span style="color:${ns.radarOperational ? CY : GY}">RADAR ${ns.radarOperational ? 'ACTIEF' : 'UIT'}</span>`
        + ` &nbsp; <span style="color:${ns.supplyOperational ? AM : GY}">DEPOT ${ns.supplyOperational ? 'ACTIEF' : 'UIT'}</span>` : '');

    for (const emp of registry.list) {
      let e = this._entries.get(emp);
      if (!e) e = this._make(emp);
      if (emp.state === 'unknown') { e.el.style.opacity = '0'; continue; }

      const p = emp.root.position;
      this._lift.set(p.x, p.y + MARKER_LIFT, p.z);
      this._dir.set(p.x - cam.position.x, p.y - cam.position.y, p.z - cam.position.z);
      if (BABYLON.Vector3.Dot(fwd, this._dir) <= 0) { e.el.style.opacity = '0'; continue; }

      BABYLON.Vector3.ProjectToRef(this._lift, this._id, tm, vp, this._proj);
      const sx = this._proj.x, sy = this._proj.y;
      BABYLON.Vector3.ProjectToRef(p, this._id, tm, vp, this._proj);
      const footY = this._proj.y;
      if (sx < -40 || sx > W + 40 || sy < -40 || sy > H + 40) { e.el.style.opacity = '0'; continue; }

      const isActive = emp === active;
      const dead = !emp.alive;
      const baseCol = TYPE_COLORS[emp.type] || CY;
      const col = dead ? GY : (isActive ? AM : baseCol);
      const duck = this._duckFactor(p);

      e.el.style.transform = `translate(${Math.round(sx)}px,${Math.round(sy)}px) translate(-50%,-50%)`;
      e.el.style.opacity = String((dead ? 0.28 : (isActive ? 0.95 : 0.52)) * duck);

      const size = isActive ? 20 : 10;
      e.ring.style.width = size + 'px';
      e.ring.style.height = size + 'px';
      e.ring.style.borderColor = col;
      e.ring.style.borderWidth = isActive ? '1.5px' : '1px';
      e.stem.style.height = Math.max(0, Math.min(Math.round(footY - sy) - size, 120)) + 'px';
      e.stem.style.background = `linear-gradient(${col},transparent)`;
      e.stem.style.opacity = isActive ? '0.5' : '0.22';
      e.txt.style.color = col;

      if (dead) {
        e.txt.textContent = emp.id + '  UIT';
        e.track.style.display = 'none';
      } else {
        e.track.style.display = isActive ? '' : 'none';
        const d = shipPos ? Math.round(Math.hypot(p.x - shipPos.x, p.z - shipPos.z)) : 0;
        e.txt.textContent = isActive
          ? `${emp.id}  ${emp.label}  ${d} m${emp.tacticalHint ? '  •  ' + emp.tacticalHint : ''}`
          : emp.id;
        e.bar.style.width = Math.max(0, Math.min(1, emp.hp / emp.maxHp)) * 100 + '%';
        e.bar.style.background = emp.hp / emp.maxHp > 0.35 ? RD : AM;
      }
    }
  }

  reset() {
    this._ducks.length = 0;
    this._now = 0;
    this._announceUntil = 0;
    this._announce.style.opacity = '0';
    for (const e of this._entries.values()) e.el.style.opacity = '0';
  }

  dispose() {
    if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
    this._entries.clear();
  }
}
