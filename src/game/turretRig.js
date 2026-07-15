// M1.48: turret-rig, opnieuw opgezet bovenop het gekoppelde turret-systeem in ship.js.
// De rig werkt nu op ship.turrets (de drie echte, gekoppelde koepels), niet meer op losse
// scene-nodes, dus er zijn precies drie turrets in plaats van meshes plus lege parent-nodes.
// Twee dingen zijn af te stellen, allebei rond de verticale draai-as:
//   1. het draaipunt langs de loop-as (z-as pivot), live via ship.setTurretPivotBack;
//   2. de vuurboog: draai de turret naar een uiterste en leg die vast als min- of max-hoek.
// De rig focust de camera op de gekozen turret, nummert de turrets 1..3 boven het schip en
// markeert de selectie met alleen de randen van de koepel (bounding box), niet de hele mesh.
// De gewone aim wordt in main.js gepauzeerd zolang de rig open staat.

const DEG = 180 / Math.PI;

export class TurretRig {
  constructor(scene, ship, log, cam) {
    this.scene = scene;
    this.ship = ship;
    this.log = log || (() => {});
    this.cam = cam;
    this.enabled = false;
    this.active = 0;
    this.orbit = 0.5;          // azimut-offset van de camera rond de turret
    this.preview = 0;          // huidige test-yaw in radialen (t.o.v. rust)
    this._panel = null;
    this._labels = [];
    this._arc = [];
    this._camSaved = null;

    this._buildLabels();
    this._buildPanel();
    this._obs = scene.onBeforeRenderObservable.add(() => { if (this.enabled) this._frame(); });
  }

  _turrets() { return (this.ship && this.ship.turrets ? this.ship.turrets : []).filter(t => t.bound); }
  _cur() { return this._turrets()[this.active]; }

  // ── per-frame: camera, nummers, randen, vuurboog ──
  _frame() {
    const ts = this._turrets();
    const t = ts[this.active];
    if (t && this.cam) this._followCam(t);
    this._updateLabels(ts);
    if (t) this._drawArc(t);
  }

  _turretSize(t) {
    try { return t.mesh.getBoundingInfo().boundingBox.extendSizeWorld.length(); }
    catch (_) { return 6; }
  }

  _followCam(t) {
    const c = t.node.getAbsolutePosition();
    const dist = Math.max(this._turretSize(t) * 3.0, 22);
    // Kijkrichting schuin van achter de loop, plus een instelbare azimut zodat je rondom kunt kijken.
    const ang = this.ship.heading + t.restYaw + Math.PI + this.orbit;
    this.cam.position.set(c.x + Math.sin(ang) * dist, c.y + dist * 0.6, c.z + Math.cos(ang) * dist);
    // Rotatie in dezelfde euler-conventie als de vrije camera (rotation.y = yaw om +Z).
    const dir = c.subtract(this.cam.position);
    const horiz = Math.sqrt(dir.x * dir.x + dir.z * dir.z) || 1e-3;
    this.cam.rotation.y = Math.atan2(dir.x, dir.z);
    this.cam.rotation.x = -Math.atan2(dir.y, horiz);
    this.cam.rotation.z = 0;
  }

  // ── nummers 1..3 boven de turrets (DOM-overlay die de 3D-positie volgt) ──
  _buildLabels() {
    for (let i = 0; i < 3; i++) {
      const d = document.createElement('div');
      d.setAttribute('data-ui', '');
      d.textContent = String(i + 1);
      d.style.cssText = 'position:fixed;z-index:99000;display:none;pointer-events:none;font-family:"Courier New",monospace;' +
        'font-weight:bold;font-size:15px;color:#fff;background:rgba(10,20,40,0.7);border:1px solid rgba(126,184,212,0.5);' +
        'border-radius:50%;width:26px;height:26px;line-height:24px;text-align:center;transform:translate(-50%,-50%);';
      document.body.appendChild(d);
      this._labels.push(d);
    }
  }

  _updateLabels(ts) {
    const eng = this.scene.getEngine();
    const cv = eng.getRenderingCanvas();
    const rect = cv.getBoundingClientRect();
    const w = eng.getRenderWidth(), h = eng.getRenderHeight();
    for (let i = 0; i < this._labels.length; i++) {
      const lab = this._labels[i], t = ts[i];
      if (!t) { lab.style.display = 'none'; continue; }
      let topY = 6;
      try { topY = (t.mesh.getBoundingInfo().boundingBox.maximumWorld.y - t.node.getAbsolutePosition().y) + 3; } catch (_) {}
      const top = t.node.getAbsolutePosition().add(new BABYLON.Vector3(0, topY, 0));
      const p = BABYLON.Vector3.Project(top, BABYLON.Matrix.Identity(), this.scene.getTransformMatrix(),
        { x: 0, y: 0, width: w, height: h });
      if (p.z < 0 || p.z > 1) { lab.style.display = 'none'; continue; }
      lab.style.display = 'block';
      lab.style.left = (rect.left + (p.x / w) * rect.width) + 'px';
      lab.style.top = (rect.top + (p.y / h) * rect.height) + 'px';
      const on = i === this.active;
      lab.style.background = on ? 'rgba(255,140,0,0.95)' : 'rgba(10,20,40,0.7)';
      lab.style.borderColor = on ? '#ffb060' : 'rgba(126,184,212,0.5)';
      lab.style.width = lab.style.height = on ? '30px' : '24px';
      lab.style.lineHeight = on ? '28px' : '22px';
    }
  }

  // ── selectie-randen: alleen de bounding box van de koepel ──
  _paintSelection(ts) {
    ts.forEach((t, i) => { try { if (t.mesh) t.mesh.showBoundingBox = (i === this.active); } catch (_) {} });
  }
  _clearSelection() {
    this._turrets().forEach(t => { try { if (t.mesh) t.mesh.showBoundingBox = false; } catch (_) {} });
  }

  // ── vuurboog: lijnen vanaf het draaipunt naar min, max en de huidige richting ──
  _line(name, from, ang, len, col) {
    const to = new BABYLON.Vector3(from.x + Math.sin(ang) * len, from.y, from.z + Math.cos(ang) * len);
    const l = BABYLON.MeshBuilder.CreateLines(name, { points: [from, to], updatable: false }, this.scene);
    l.color = col; l.isPickable = false; l.renderingGroupId = 3;
    return l;
  }
  _drawArc(t) {
    this._arc.forEach(l => l.dispose()); this._arc = [];
    const c = t.node.getAbsolutePosition();
    const base = this.ship.heading + t.restYaw;
    const len = Math.max(this._turretSize(t) * 3.5, 20);
    // huidige loop-richting (groen)
    this._arc.push(this._line('rigCur', c, base + t.yaw, len * 1.05, new BABYLON.Color3(0.3, 1, 0.4)));
    // grenzen (oranje) als ze gezet zijn
    if (t.minYaw != null && t.maxYaw != null) {
      this._arc.push(this._line('rigMin', c, base + t.minYaw, len, new BABYLON.Color3(1, 0.5, 0.1)));
      this._arc.push(this._line('rigMax', c, base + t.maxYaw, len, new BABYLON.Color3(1, 0.5, 0.1)));
    }
  }

  // ── UI ──
  _buildPanel() {
    const p = document.createElement('div');
    p.setAttribute('data-ui', '');
    p.style.cssText = 'position:fixed;right:8px;bottom:70px;z-index:99001;width:min(78%,300px);max-height:62vh;overflow-y:auto;' +
      'background:rgba(7,14,26,0.82);border:1px solid rgba(126,184,212,0.3);border-radius:10px;backdrop-filter:blur(10px);' +
      'padding:10px 12px;font-family:"Courier New",monospace;color:#cfe1ee;font-size:12px;display:none;pointer-events:auto;';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:6px;cursor:move;touch-action:none;';
    const title = document.createElement('span');
    title.style.cssText = 'letter-spacing:0.16em;color:#7eb8d4;flex:1;';
    title.textContent = 'TURRET-RIG';
    const x = document.createElement('button'); x.textContent = '\u00d7'; x.setAttribute('data-ui', '');
    x.style.cssText = 'background:none;border:none;color:#7eb8d4;font:20px inherit;';
    x.addEventListener('click', () => this.hide());
    head.appendChild(title); head.appendChild(x);
    p.appendChild(head);
    this._dragBind(head, p);

    const body = document.createElement('div');
    p.appendChild(body);

    if (!this._turrets().length) {
      const w = document.createElement('div'); w.style.cssText = 'color:#ff9080;line-height:1.5;';
      w.textContent = 'Geen gekoppelde turrets. Laad eerst het schip-GLB.';
      body.appendChild(w); document.body.appendChild(p); this._panel = p; return;
    }

    // selectie
    const sel = document.createElement('div');
    sel.style.cssText = 'display:flex;align-items:center;gap:8px;margin:2px 0 8px;';
    const prev = this._btn('\u25c4'), next = this._btn('\u25ba');
    this._nameEl = document.createElement('div');
    this._nameEl.style.cssText = 'flex:1;text-align:center;font-size:13px;color:#eaf4fb;';
    prev.addEventListener('click', () => this._setActive(this.active - 1));
    next.addEventListener('click', () => this._setActive(this.active + 1));
    sel.appendChild(prev); sel.appendChild(this._nameEl); sel.appendChild(next);
    body.appendChild(sel);

    // camera rondom
    const camRow = document.createElement('div');
    camRow.style.cssText = 'display:flex;gap:8px;margin-bottom:10px;';
    const cl = this._btn('\u21bb camera'); cl.style.flex = '1';
    const cr = this._btn('camera \u21ba'); cr.style.flex = '1';
    cl.addEventListener('click', () => { this.orbit -= 0.4; });
    cr.addEventListener('click', () => { this.orbit += 0.4; });
    camRow.appendChild(cl); camRow.appendChild(cr);
    body.appendChild(camRow);

    // draaipunt (z-as pivot)
    body.appendChild(this._sectionLabel('DRAAIPUNT (z-as)'));
    this._pivot = this._slider('Naar achteren', -6, 6, 0.1, 'm', v => {
      const i = this.active; this.ship.setTurretPivotBack(i, v); this._readout();
    });
    body.appendChild(this._pivot.row);

    // vuurboog
    body.appendChild(this._sectionLabel('VUURBOOG'));
    this._yaw = this._slider('Test-draai', -180, 180, 1, '\u00b0', v => {
      this.preview = v / DEG; this.ship.previewTurretYaw(this.active, this.preview); this._readout();
    });
    body.appendChild(this._yaw.row);

    const lim = document.createElement('div');
    lim.style.cssText = 'display:flex;gap:8px;margin:6px 0;';
    const setMin = this._btn('\u25c4 grens min'); setMin.style.flex = '1';
    const setMax = this._btn('grens max \u25ba'); setMax.style.flex = '1';
    setMin.addEventListener('click', () => this._setLimit('min'));
    setMax.addEventListener('click', () => this._setLimit('max'));
    lim.appendChild(setMin); lim.appendChild(setMax);
    body.appendChild(lim);

    const lim2 = document.createElement('div');
    lim2.style.cssText = 'display:flex;gap:8px;margin-bottom:4px;';
    const mid = this._btn('naar midden'); mid.style.flex = '1';
    const clr = this._btn('wis boog'); clr.style.flex = '1';
    mid.addEventListener('click', () => { this._yaw.set(0); this.preview = 0; this.ship.previewTurretYaw(this.active, 0); this._readout(); });
    clr.addEventListener('click', () => { this.ship.setTurretLimits(this.active, null, null); this._readout(); });
    lim2.appendChild(mid); lim2.appendChild(clr);
    body.appendChild(lim2);

    const exp = this._btn('JSON export (klembord + log)');
    exp.style.cssText += 'width:100%;margin-top:10px;background:rgba(126,184,212,0.18);';
    exp.addEventListener('click', () => this._export());
    body.appendChild(exp);

    this._read = document.createElement('div');
    this._read.style.cssText = 'margin-top:10px;font-size:11px;color:#7ee8b0;line-height:1.5;' +
      'border-top:1px solid rgba(126,184,212,0.18);padding-top:8px;white-space:pre-wrap;';
    body.appendChild(this._read);

    document.body.appendChild(p);
    this._panel = p;
    this._setActive(0);
  }

  _setLimit(which) {
    const t = this._cur(); if (!t) return;
    let mn = t.minYaw, mx = t.maxYaw;
    if (which === 'min') mn = this.preview; else mx = this.preview;
    // Zorg dat min <= max; anders wisselen zodat de boog geldig blijft.
    if (mn != null && mx != null && mn > mx) { const s = mn; mn = mx; mx = s; }
    this.ship.setTurretLimits(this.active, mn, mx);
    this._readout();
  }

  _sectionLabel(txt) {
    const d = document.createElement('div');
    d.textContent = txt;
    d.style.cssText = 'letter-spacing:0.12em;color:#7eb8d4;font-size:10px;margin:10px 0 4px;opacity:0.85;';
    return d;
  }

  _dragBind(handle, panel) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    const down = e => {
      if (e.target && e.target.tagName === 'BUTTON') return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      panel.style.top = oy + 'px'; panel.style.left = ox + 'px';
      panel.style.bottom = 'auto'; panel.style.right = 'auto';
      if (handle.setPointerCapture && e.pointerId != null) handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const move = e => {
      if (!dragging) return;
      let nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
      nx = Math.max(0, Math.min(nx, window.innerWidth - 44));
      ny = Math.max(0, Math.min(ny, window.innerHeight - 44));
      panel.style.left = nx + 'px'; panel.style.top = ny + 'px'; e.preventDefault();
    };
    const up = () => { dragging = false; };
    handle.addEventListener('pointerdown', down);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  _btn(txt) {
    const b = document.createElement('button');
    b.setAttribute('data-ui', ''); b.textContent = txt;
    b.style.cssText = 'padding:9px 11px;border-radius:7px;border:1px solid rgba(126,184,212,0.3);' +
      'background:rgba(10,20,40,0.6);color:#cfe1ee;font:12px inherit;';
    return b;
  }

  _slider(label, min, max, step, unit, onInput) {
    const row = document.createElement('div'); row.style.cssText = 'margin:6px 0;';
    const top = document.createElement('div'); top.style.cssText = 'display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;';
    const l = document.createElement('span'); l.textContent = label;
    const v = document.createElement('span'); v.style.color = '#7eb8d4';
    top.appendChild(l); top.appendChild(v);
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = 0; inp.setAttribute('data-ui', '');
    inp.style.cssText = 'width:100%;accent-color:#7eb8d4;';
    const fmt = n => (step < 1 ? (+n).toFixed(1) : n) + unit;
    inp.addEventListener('input', () => { v.textContent = fmt(inp.value); onInput(parseFloat(inp.value)); });
    row.appendChild(top); row.appendChild(inp);
    return { row, el: inp, set: n => { inp.value = n; v.textContent = fmt(n); }, range: (mn, mx, st) => { inp.min = mn; inp.max = mx; if (st) inp.step = st; } };
  }

  _setActive(i) {
    const ts = this._turrets(); const n = ts.length; if (!n) return;
    this.active = ((i % n) + n) % n;
    const t = this._cur();
    this._nameEl.textContent = `Turret ${this.active + 1} / ${n}`;
    // pivot-slider schalen op de koepelgrootte
    const s = this._turretSize(t);
    if (this._pivot) { this._pivot.range(-s * 1.5, s * 1.5, Math.max(s / 40, 0.05)); this._pivot.set(t.pivotBack || 0); }
    // test-draai op de huidige stand
    this.preview = t.yaw || 0;
    if (this._yaw) this._yaw.set(Math.round(this.preview * DEG));
    this._paintSelection(ts);
    this._readout();
  }

  _readout() {
    const t = this._cur(); if (!t || !this._read) return;
    const lim = (t.minYaw != null && t.maxYaw != null)
      ? `${Math.round(t.minYaw * DEG)}\u00b0 .. ${Math.round(t.maxYaw * DEG)}\u00b0`
      : 'onbeperkt';
    this._read.textContent =
      `draaipunt: ${(t.pivotBack || 0).toFixed(1)} m naar achteren\n` +
      `test-draai: ${Math.round(this.preview * DEG)}\u00b0\n` +
      `vuurboog: ${lim}`;
  }

  _export() {
    const rig = {};
    this._turrets().forEach(t => {
      rig[t.mesh.name] = {
        pivotBack: +(t.pivotBack || 0).toFixed(2),
        minYaw: t.minYaw != null ? +t.minYaw.toFixed(3) : null,
        maxYaw: t.maxYaw != null ? +t.maxYaw.toFixed(3) : null,
      };
    });
    const txt = JSON.stringify({ build: 'turret-rig', rig }, null, 2);
    this.log('RIG', 'JSON export:\n' + txt, false);
    try { if (navigator.clipboard) navigator.clipboard.writeText(txt); } catch (_) {}
  }

  toggle() { this.enabled ? this.hide() : this.show(); }
  show() {
    if (!this._turrets().length) { this.log('RIG', 'geen gekoppelde turrets', true); }
    this.enabled = true;
    if (this._panel) this._panel.style.display = 'block';
    this._paintSelection(this._turrets());
    this._setActive(this.active);
    this.log('RIG', 'turret-rig AAN (aim gepauzeerd)', false);
  }
  hide() {
    this.enabled = false;
    if (this._panel) this._panel.style.display = 'none';
    this._labels.forEach(l => l.style.display = 'none');
    this._arc.forEach(l => l.dispose()); this._arc = [];
    this._clearSelection();
    this.log('RIG', 'turret-rig UIT', false);
  }
  dispose() {
    this.hide();
    this._labels.forEach(l => { if (l.parentNode) l.parentNode.removeChild(l); });
    this._labels = [];
    if (this._obs) this.scene.onBeforeRenderObservable.remove(this._obs);
    if (this._panel && this._panel.parentNode) this._panel.parentNode.removeChild(this._panel);
  }
}
