// src/ui/overlayUI.js
//
// M3.0: OverlayUI.
// De CAM-knop wisselt nu tussen gevechtsmodus en de vrije cinematische camera. In M1.52 riep
// hij setMode('free') aan, maar setMode kende 'free' niet en zette je terug in 'ship'. De knop
// deed dus zichtbaar niets.

export class OverlayUI {
  constructor(matchDirector, opts = {}) {
    this.md = matchDirector;
    this.restricted = opts.restricted === true;
    this.container = null;
    this.playBtn = null;
    this.camBtn = null;
    this.followBtn = null;
    this._followHandler = null;
    this._prevMode = 'ship';
    this.build();
  }

  build() {
    this.container = document.createElement('div');
    this.container.setAttribute('data-ui', '');
    this.container.style.cssText = 'position:fixed;top:12px;right:10px;display:flex;gap:6px;z-index:70;touch-action:none;user-select:none;-webkit-user-select:none;';

    this.buildPlayBtn();
    this.buildCamBtn();
    if (!this.restricted) this.buildFollowBtn();

    document.body.appendChild(this.container);
  }

  buildFollowBtn() {
    this.followBtn = document.createElement('button');
    this._style(this.followBtn);
    this.followBtn.innerHTML = '\u2708 VOLG';
    this.followBtn.style.display = 'none';
    this._bindPointer(this.followBtn, () => { if (this._followHandler) this._followHandler(); });
    this.container.appendChild(this.followBtn);
  }

  setFollowHandler(fn) { this._followHandler = fn; }

  showFollow(v) { if (!this.restricted && this.followBtn) this.followBtn.style.display = v ? '' : 'none'; }

  setFollowActive(v) {
    if (!this.followBtn) return;
    if (v) {
      this.followBtn.style.background = 'rgba(52,199,89,0.8)';
      this.followBtn.style.color = '#fff';
      this.followBtn.style.borderColor = 'rgba(52,199,89,0.9)';
    } else {
      this.followBtn.style.background = 'rgba(10,20,40,0.72)';
      this.followBtn.style.color = '#7eb8d4';
      this.followBtn.style.borderColor = 'rgba(126,184,212,0.4)';
    }
  }

  _bindPointer(el, onClick) {
    let isDown = false;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      el.style.transform = 'scale(0.92)';
      if (navigator.vibrate) navigator.vibrate(10);
      isDown = true;
    });
    el.addEventListener('pointermove', (e) => { e.stopPropagation(); });
    el.addEventListener('pointerup', (e) => {
      e.stopPropagation();
      el.releasePointerCapture(e.pointerId);
      el.style.transform = 'scale(1)';
      if (isDown) { isDown = false; onClick(); }
    });
    el.addEventListener('pointercancel', (e) => {
      e.stopPropagation();
      el.style.transform = 'scale(1)';
      isDown = false;
    });
  }

  _style(btn) {
    btn.setAttribute('data-ui', '');
    btn.style.cssText = 'background:rgba(10,20,40,0.72);color:#7eb8d4;border:1px solid rgba(126,184,212,0.4);border-radius:8px;padding:7px 8px;font-family:"Courier New",monospace;font-size:10px;font-weight:bold;letter-spacing:0.02em;white-space:nowrap;backdrop-filter:blur(8px);transition:transform 0.1s, background 0.2s, border-color 0.2s, color 0.2s;outline:none;';
  }

  buildPlayBtn() {
    this.playBtn = document.createElement('button');
    this._style(this.playBtn);
    this._bindPointer(this.playBtn, () => {
      if (this.md.isPaused) this.md.resume();
      else this.md.pause();
    });
    this.container.appendChild(this.playBtn);
    this.md.setPlayBtn(this.playBtn);
  }

  buildCamBtn() {
    this.camBtn = document.createElement('button');
    this._style(this.camBtn);
    this._camLabel('doel');

    if (this.restricted) {
      let downPointer = null;
      this.camBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation(); downPointer = e.pointerId;
        try { this.camBtn.setPointerCapture(e.pointerId); } catch (_) {}
        this.camBtn.style.transform = 'scale(0.92)';
      });
      this.camBtn.addEventListener('pointerup', (e) => {
        if (e.pointerId !== downPointer) return;
        e.preventDefault(); e.stopPropagation(); downPointer = null;
        this.camBtn.style.transform = 'scale(1)';
        const cc = this.md.refs.chaseCam;
        if (!cc) return;
        const next = cc.style === 'hoog' ? 'doel' : 'hoog';
        cc.setStyle(next, true);
        this._camLabel(next);
      });
      this.camBtn.addEventListener('pointercancel', (e) => {
        if (e.pointerId !== downPointer) return;
        downPointer = null; this.camBtn.style.transform = 'scale(1)';
      });
      this.container.appendChild(this.camBtn);
      return;
    }

    let hold = null, held = false;
    const down = (e) => {
      e.stopPropagation();
      held = false;
      this.camBtn.style.transform = 'scale(0.92)';
      if (navigator.vibrate) navigator.vibrate(8);
      hold = setTimeout(() => {
        held = true;
        if (navigator.vibrate) navigator.vibrate([12, 30, 12]);
        this._toggleFree();
      }, 500);
    };
    const up = (e) => {
      e.stopPropagation();
      clearTimeout(hold);
      this.camBtn.style.transform = 'scale(1)';
      if (held) return;
      if (this.md.mode === 'free') { this._toggleFree(); return; }
      const cc = this.md.refs.chaseCam;
      if (cc) this._camLabel(cc.cycleStyle());
    };
    this.camBtn.addEventListener('pointerdown', down);
    this.camBtn.addEventListener('pointerup', up);
    this.camBtn.addEventListener('pointercancel', (e) => {
      e.stopPropagation(); clearTimeout(hold); this.camBtn.style.transform = 'scale(1)';
    });

    this.container.appendChild(this.camBtn);
  }

  _camLabel(name) {
    this.camBtn.innerHTML = '&#128249; ' + String(name).toUpperCase();
    this.camBtn.style.color = '#7eb8d4';
    this.camBtn.style.borderColor = 'rgba(126,184,212,0.4)';
  }

  _toggleFree() {
    if (this.md.mode === 'free') {
      this.md.setMode(this._prevMode || 'ship');
      const cc = this.md.refs.chaseCam;
      this._camLabel(cc ? cc.style : 'doel');
    } else {
      this._prevMode = this.md.mode;
      this.md.setMode('free');
      this.md.placeCinematicCam();
      this.camBtn.innerHTML = '&#128249; VRIJ';
      this.camBtn.style.color = '#ffcf6a';
      this.camBtn.style.borderColor = 'rgba(255,207,106,0.6)';
    }
  }

  dispose() {
    if (this.container && this.container.parentNode) this.container.parentNode.removeChild(this.container);
  }
}
