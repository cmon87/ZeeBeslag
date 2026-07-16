// M1.18: gevechts-HUD. Bouwt zijn eigen DOM (geen index.html-wijziging nodig) in het
// bestaande marinepalet (#7eb8d4 op donker glas, rood voor de vijand en voor schade).
// De hele overlay is pointer-events:none, dus tikken gaan door naar canvas en knoppen.
//
// Onderdelen:
//   - vijand-reticle in de wereld verankerd; buiten beeld wordt het een randpijl
//   - lock-status: groen = geschut ligt op de vijand, amber = torens draaien nog bij
//   - afstandsmeter in meters
//   - health bars voor speler en vijand
//   - herlaad-indicator op de vuurknop (conische veeg) + GEREED/HERLADEN
//   - rode randflits bij eigen schade

const CY = '#7eb8d4', GR = '#7ee8b0', AM = '#ffcf6a', RD = '#ff7a68';

export class HUD {
  constructor() {
    const root = document.createElement('div');
    root.setAttribute('data-ui', '');
    root.style.cssText = 'position:fixed;inset:0;z-index:40;pointer-events:none;font-family:"Courier New",monospace;';
    document.body.appendChild(root);
    this._root = root;

    this._eWrap = this._panel('position:fixed;top:58px;left:50%;transform:translateX(-50%);width:46%;max-width:360px;');
    this._eLabel = this._label('GEEN DOEL', RD);
    this._eWrap.appendChild(this._eLabel);
    this._eFill = this._bar(this._eWrap, RD);
    root.appendChild(this._eWrap);

    const pWrap = this._panel('position:fixed;bottom:20px;left:50%;transform:translateX(-50%);width:46%;max-width:360px;');
    this._pWrap = pWrap;
    pWrap.appendChild(this._label('EIGEN SCHIP', CY));
    this._pFill = this._bar(pWrap, CY);
    root.appendChild(pWrap);

    this._ret = document.createElement('div');
    this._ret.style.cssText = 'position:fixed;left:0;top:0;width:52px;height:52px;transform:translate(-50%,-50%);transition:opacity 0.15s;opacity:0;';
    this._lock = document.createElement('div');
    this._lock.style.cssText = 'position:absolute;inset:0;border:2px solid ' + CY + ';border-radius:50%;box-shadow:0 0 8px rgba(126,184,212,0.5);';
    this._lock.innerHTML = '<div style="position:absolute;left:50%;top:50%;width:5px;height:5px;background:currentColor;border-radius:50%;transform:translate(-50%,-50%);"></div>';
    this._arrow = document.createElement('div');
    this._arrow.style.cssText = 'position:absolute;left:50%;top:50%;width:0;height:0;border-left:11px solid transparent;border-right:11px solid transparent;border-bottom:20px solid ' + CY + ';transform:translate(-50%,-50%);display:none;filter:drop-shadow(0 0 5px rgba(126,184,212,0.6));';
    this._ret.appendChild(this._lock);
    this._ret.appendChild(this._arrow);
    root.appendChild(this._ret);

    this._range = document.createElement('div');
    this._range.style.cssText = 'position:fixed;left:0;top:0;transform:translate(-50%,34px);font-size:11px;letter-spacing:0.08em;white-space:nowrap;text-align:center;opacity:0;transition:opacity 0.15s;text-shadow:0 1px 3px #000;';
    root.appendChild(this._range);

    const fWrap = this._panel('position:fixed;right:24px;bottom:134px;width:42px;height:42px;display:flex;align-items:center;justify-content:center;');
    this._fWrap = fWrap;
    this._fireRing = document.createElement('div');
    this._fireRing.style.cssText = 'position:relative;width:42px;height:42px;border-radius:50%;'
      + 'background:conic-gradient(' + CY + ' 0deg, rgba(126,184,212,0.15) 0deg);'
      + 'box-shadow:0 0 8px rgba(126,184,212,0.35);';
    const hole = document.createElement('div');
    hole.style.cssText = 'position:absolute;inset:5px;border-radius:50%;background:rgba(8,16,30,0.92);'
      + 'border:1px solid rgba(126,184,212,0.25);';
    this._fireTxt = document.createElement('div');
    this._fireTxt.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;'
      + 'font-size:14px;font-weight:bold;letter-spacing:0.02em;color:' + GR + ';text-shadow:0 1px 3px #000;';
    this._fireTxt.textContent = '\u2713';
    this._fireRing.appendChild(hole);
    this._fireRing.appendChild(this._fireTxt);
    fWrap.appendChild(this._fireRing);
    root.appendChild(fWrap);

    this._flashTimer = null;
    this._flash = document.createElement('div');
    this._flash.style.cssText = 'position:fixed;inset:0;pointer-events:none;opacity:0;transition:opacity 0.4s;background:radial-gradient(ellipse at center, transparent 45%, rgba(200,30,20,0.55) 100%);';
    root.appendChild(this._flash);
  }

  _panel(extra) {
    const d = document.createElement('div');
    d.style.cssText = extra;
    return d;
  }
  _label(txt, col) {
    const l = document.createElement('div');
    l.textContent = txt;
    l.style.cssText = 'font-size:9px;letter-spacing:0.14em;color:' + col + ';margin-bottom:3px;text-shadow:0 1px 3px #000;';
    return l;
  }
  _bar(parent, col) {
    const track = document.createElement('div');
    track.style.cssText = 'width:100%;height:7px;background:rgba(10,20,40,0.7);border:1px solid rgba(126,184,212,0.3);border-radius:4px;overflow:hidden;';
    const fill = document.createElement('div');
    fill.style.cssText = 'height:100%;width:100%;background:' + col + ';border-radius:3px;transition:width 0.25s ease-out;box-shadow:0 0 6px ' + col + ';';
    track.appendChild(fill); parent.appendChild(track);
    return fill;
  }

  damageFlash() {
    if (this._flashTimer) clearTimeout(this._flashTimer);
    this._flash.style.opacity = '1';
    this._flashTimer = setTimeout(() => { this._flash.style.opacity = '0'; this._flashTimer = null; }, 90);
  }

  reset() {
    if (this._flashTimer) clearTimeout(this._flashTimer);
    this._flashTimer = null;
    this._flash.style.opacity = '0';
    this._ret.style.opacity = '0';
    this._range.style.opacity = '0';
    this._eFill.style.width = '100%';
    this._pFill.style.width = '100%';
    this._fireTxt.textContent = '\u2713';
    if (this._eLabel) this._eLabel.textContent = 'GEEN DOEL';
  }

  setMode(mode) {
    const combat = (mode === 'ship' || mode === 'regie');
    const disp = combat ? '' : 'none';
    if (this._eWrap) this._eWrap.style.display = disp;
    if (this._pWrap) this._pWrap.style.display = disp;
    if (this._ret) this._ret.style.display = combat ? '' : 'none';
    if (this._range) this._range.style.display = combat ? '' : 'none';
    if (this._fWrap) this._fWrap.style.display = combat ? '' : 'none';
  }

  update(st) {
    if (this._eLabel) this._eLabel.textContent = st.enemyAlive ? (st.enemyLabel || 'VIJAND') : 'GEEN DOEL';
    this._eFill.style.width = Math.max(0, Math.min(1, st.enemyHp / st.enemyMax)) * 100 + '%';
    this._pFill.style.width = Math.max(0, Math.min(1, st.playerHp / st.playerMax)) * 100 + '%';
    this._eWrap.style.opacity = st.enemyAlive ? '1' : '0.3';

    const readyTurrets = Math.max(0, Number(st.readyTurrets || 0));
    const totalTurrets = Math.max(0, Number(st.totalTurrets || 0));
    const fireAllowed = st.fireAllowed !== false && readyTurrets > 0;
    const rdy = st.fireReady >= 1 && fireAllowed;
    const deg = Math.round(Math.max(0, Math.min(1, st.fireReady)) * 360);
    const col = rdy ? GR : (fireAllowed ? CY : RD);
    this._fireRing.style.background = 'conic-gradient(' + col + ' ' + deg + 'deg, rgba(126,184,212,0.15) 0deg)';
    const sec = st.reloadSec !== undefined ? st.reloadSec : 0;
    this._fireTxt.textContent = !fireAllowed ? '\u00d7' : (rdy ? '\u2713' : String(Math.ceil(sec)));
    this._fireTxt.style.color = col;

    if (!st.enemyAlive) { this._ret.style.opacity = '0'; this._range.style.opacity = '0'; return; }
    const cam = st.camera, W = window.innerWidth, H = window.innerHeight;
    const dir = st.enemyPos.subtract(cam.position);
    const fwd = cam.getDirection(BABYLON.Axis.Z);
    const front = BABYLON.Vector3.Dot(fwd, dir) > 0;

    let sx = 0, sy = 0, onScreen = false;
    if (front) {
      const p = BABYLON.Vector3.Project(st.enemyPos, BABYLON.Matrix.Identity(),
        cam.getScene().getTransformMatrix(), cam.viewport.toGlobal(W, H));
      sx = p.x; sy = p.y;
      onScreen = sx > 26 && sx < W - 26 && sy > 60 && sy < H - 60;
    }

    const lockCol = st.aimReady ? GR : (readyTurrets > 0 ? CY : AM);
    const readyLabel = totalTurrets > 0 ? `${readyTurrets}/${totalTurrets}` : '-';
    if (front && onScreen) {
      this._lock.style.display = 'block'; this._arrow.style.display = 'none';
      this._lock.style.borderColor = lockCol; this._lock.style.color = lockCol;
      this._ret.style.left = sx + 'px'; this._ret.style.top = sy + 'px';
      this._ret.style.transform = 'translate(-50%,-50%)';
      this._ret.style.opacity = '1';
      this._range.style.left = sx + 'px'; this._range.style.top = sy + 'px';
      this._range.style.transform = 'translate(-50%,34px)';
      this._range.innerHTML = '<span style="color:' + lockCol + '">' + (st.aimReady ? 'GESCHUT GEREED' : 'RICHT') + ' ' + readyLabel + '</span>  ' + Math.round(st.range) + ' m';
      this._range.style.opacity = '1';
    } else {
      const right = cam.getDirection(BABYLON.Axis.X), up = cam.getDirection(BABYLON.Axis.Y);
      let dx = BABYLON.Vector3.Dot(right, dir), dy = -BABYLON.Vector3.Dot(up, dir);
      const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      const m = 54;
      const ex = W / 2 + dx * (W / 2 - m), ey = H / 2 + dy * (H / 2 - m);
      this._lock.style.display = 'none'; this._arrow.style.display = 'block';
      this._arrow.style.borderBottomColor = lockCol;
      this._arrow.style.transform = 'translate(-50%,-50%) rotate(' + (Math.atan2(dy, dx) + Math.PI / 2) + 'rad)';
      this._ret.style.left = ex + 'px'; this._ret.style.top = ey + 'px';
      this._ret.style.transform = 'translate(-50%,-50%)';
      this._ret.style.opacity = '1';
      this._range.style.opacity = '0';
    }
  }

  dispose() {
    if (this._flashTimer) clearTimeout(this._flashTimer);
    if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
  }
}
