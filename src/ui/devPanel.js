// src/ui/devPanel.js
//
// M6.3: UI/UX architectuur.
// - Accordeon-structuur (klapmenu's) met sessie-persistensie.
// - Dynamische fouten-badge (Red Dot) gekoppeld aan de centrale Debug module.
// - Telemetrie/fouten export verplaatst naar het LOGBOEK-tabblad.

import { Debug } from '../core/debug.js';

class _DevPanel {
  constructor() {
    this._root = null;
    this._menu = null;
    this._isOpen = false;
    this._tools = [];
    this._cfg = null;

    this._pin = null;
    this._activeTab = 'BEDIENING'; 
    this._logFilter = 'ALL';
    
    this._openGroups = {};
    
    this._hasUnreadErrors = false;
    this._redDot = null;
    
    this._bg = 'rgba(15,20,28,0.92)';
    this._fg = '#a0b8c8';
    this._hl = '#7eb8d4';
    this._hi = '#ffffff';

    Debug.setPanelToggler((tab) => { this.open(tab); });
    Debug.onLog((entry) => { 
      if (this._isOpen && this._activeTab === 'LOGBOEK') {
        this._paintLog();
      } else if (entry.level === 'warn' || entry.level === 'error') {
        this._hasUnreadErrors = true;
        this._updateRedDot();
      }
    });
  }

  gameConfig(cfg) { this._cfg = cfg; }

  toggle(opts) { this._add({ kind: 'toggle', ...opts }); }
  slider(opts) {
    this._add({ kind: 'slider', ...opts, _def: opts.get() });
    this._persistLoad(this._tools[this._tools.length - 1]);
  }
  cycle(opts)  { this._add({ kind: 'cycle', ...opts }); }
  sweep(opts)  { this._add({ kind: 'sweep', ...opts }); }
  tool(opts)   { this._add({ kind: 'tool', ...opts }); }
  exportItem(opts) { this._add({ kind: 'export', ...opts }); }

  _add(t) {
    const ex = this._tools.find(x => x.id === t.id && x.group === t.group);
    if (ex) Object.assign(ex, t); else this._tools.push(t);
  }

  _persistLoad(t) {
    if (!t.persist) return;
    try {
      const s = localStorage.getItem('zbTweak:' + t.id);
      if (s !== null && !isNaN(parseFloat(s))) t.set(parseFloat(s));
    } catch (_) {}
  }

  _persistSave(t, v) {
    if (!t.persist) return;
    try { localStorage.setItem('zbTweak:' + t.id, String(v)); } catch (_) {}
  }

  _persistClear(t) {
    if (!t.persist) return;
    try { localStorage.removeItem('zbTweak:' + t.id); } catch (_) {}
  }

  mount() {
    if (this._root) return;
    this._root = document.createElement('div');
    this._root.setAttribute('data-ui', '');
    this._root.style.cssText = `position:fixed; z-index:9000; inset:0; pointer-events:none; font-family:"Courier New",monospace; touch-action:none;`;

    const btn = document.createElement('div');
    btn.innerHTML = '&#9881;'; 
    btn.style.cssText = `
      position:absolute; bottom:12px; left:10px; width:40px; height:40px;
      background:rgba(10,15,25,0.8); border:1px solid rgba(126,184,212,0.3);
      border-radius:8px; color:#7eb8d4; font-size:22px; text-align:center;
      line-height:38px; cursor:pointer; pointer-events:auto;
      box-shadow:0 4px 12px rgba(0,0,0,0.5); user-select:none;
    `;
    
    this._redDot = document.createElement('div');
    this._redDot.style.cssText = `
      position:absolute; top:-4px; right:-4px; width:12px; height:12px;
      background:#ff7a68; border-radius:50%; box-shadow:0 0 6px #ff7a68;
      display:none; transition:opacity 0.2s;
    `;
    btn.appendChild(this._redDot);
    
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { if (btn.setPointerCapture) btn.setPointerCapture(e.pointerId); } catch (_) {}
    });
    btn.addEventListener('pointerup', e => {
      e.preventDefault();
      try { if (btn.releasePointerCapture && btn.hasPointerCapture && btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId); } catch (_) {}
      this.toggleOpen();
      if (navigator.vibrate) navigator.vibrate(10);
    });
    btn.addEventListener('pointercancel', e => {
      try { if (btn.releasePointerCapture && btn.hasPointerCapture && btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId); } catch (_) {}
    });
    
    this._root.appendChild(btn);
    document.body.appendChild(this._root);
  }

  _updateRedDot() {
    if (this._redDot) {
      this._redDot.style.display = this._hasUnreadErrors ? 'block' : 'none';
    }
  }

  toggleOpen() { this._isOpen ? this.close() : this.open(); }

  open(tab = null) {
    if (tab) this._activeTab = tab;
    this._isOpen = true;
    
    if (this._activeTab === 'LOGBOEK') {
      this._hasUnreadErrors = false;
      this._updateRedDot();
    }
    
    if (!this._menu) this._buildMenu();
    this._menu.style.display = 'flex';
    this._paint();
  }

  close() {
    this._isOpen = false;
    if (this._menu) this._menu.style.display = 'none';
  }

  refresh() {
    if (this._isOpen) this._paint();
    if (this._pin) this._paintPin();
  }

  _buildMenu() {
    this._menu = document.createElement('div');
    this._menu.style.cssText = `position:absolute; inset:0; background:rgba(0,0,0,0.6); pointer-events:auto; display:none; flex-direction:column; align-items:center; justify-content:center;`;

    const box = document.createElement('div');
    box.style.cssText = `width:95%; max-width:440px; height:85vh; background:${this._bg}; border:1px solid #334; border-radius:12px; display:flex; flex-direction:column; box-shadow:0 10px 40px rgba(0,0,0,0.8); overflow:hidden;`;

    const head = document.createElement('div');
    head.style.cssText = `padding:10px 14px; border-bottom:1px solid #334; display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.3);`;
    
    const title = document.createElement('div');
    title.innerText = 'SYSTEEM PANEEL';
    title.style.cssText = `color:${this._hi}; font-weight:bold; font-size:15px; letter-spacing:1px;`;
    
    const closeBtn = document.createElement('div');
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cssText = `color:${this._fg}; font-size:26px; line-height:20px; cursor:pointer; padding:0 8px; touch-action:none;`;
    
    closeBtn.addEventListener('pointerdown', e => { try { if (closeBtn.setPointerCapture) closeBtn.setPointerCapture(e.pointerId); } catch (_) {} });
    closeBtn.addEventListener('pointerup', e => { 
      try { if (closeBtn.releasePointerCapture && closeBtn.hasPointerCapture && closeBtn.hasPointerCapture(e.pointerId)) closeBtn.releasePointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault(); 
      if (navigator.vibrate) navigator.vibrate(10); 
      this.close(); 
    });
    
    head.appendChild(title); head.appendChild(closeBtn);
    box.appendChild(head);

    this._tabBar = document.createElement('div');
    this._tabBar.style.cssText = `display:flex; border-bottom:1px solid #334; background:rgba(255,255,255,0.02);`;
    box.appendChild(this._tabBar);

    this._content = document.createElement('div');
    this._content.style.cssText = 'flex:1; overflow-y:auto; padding:10px; display:flex; flex-direction:column;';
    box.appendChild(this._content);

    this._menu.appendChild(box);
    this._root.appendChild(this._menu);
  }

  _paintTabs() {
    this._tabBar.innerHTML = '';
    ['BEDIENING', 'STATUS', 'LOGBOEK'].forEach(name => {
      const btn = document.createElement('div');
      const active = this._activeTab === name;
      btn.innerText = name;
      btn.style.cssText = `flex:1; text-align:center; padding:10px 0; font-size:12px; font-weight:bold; cursor:pointer; color:${active ? this._hi : this._fg}; border-bottom:2px solid ${active ? this._hl : 'transparent'}; background:${active ? 'rgba(126,184,212,0.1)' : 'transparent'}; transition:background 0.2s; touch-action:none;`;
      
      btn.addEventListener('pointerdown', e => { try { if (btn.setPointerCapture) btn.setPointerCapture(e.pointerId); } catch (_) {} });
      btn.addEventListener('pointerup', e => {
        e.preventDefault();
        try { if (btn.releasePointerCapture && btn.hasPointerCapture && btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId); } catch (_) {}
        if (this._activeTab !== name) { 
          this._activeTab = name; 
          if (navigator.vibrate) navigator.vibrate(10); 
          if (name === 'LOGBOEK') { this._hasUnreadErrors = false; this._updateRedDot(); }
          this._paint(); 
        }
      });
      btn.addEventListener('pointercancel', e => {
        try { if (btn.releasePointerCapture && btn.hasPointerCapture && btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId); } catch (_) {}
      });
      this._tabBar.appendChild(btn);
    });
  }

  _paint() {
    if (!this._content) return;
    this._paintTabs();
    this._content.innerHTML = '';
    
    if (this._activeTab === 'BEDIENING') this._paintTweaks();
    else if (this._activeTab === 'STATUS') this._paintStatus();
    else if (this._activeTab === 'LOGBOEK') this._paintLog();
  }

  _paintTweaks() {
    const isDev = this._tools.some(t => t.id === 'devmode' && t.get());
    const groups = {};
    for (const t of this._tools) {
      if (t.id === 'telemetry') continue; // Verplaatst naar het logboek
      
      const g = t.group || 'OVERIG';
      if (g === 'SANDBOX' && t.id !== 'devmode' && !isDev) continue;
      if (!groups[g]) groups[g] = [];
      groups[g].push(t);
    }
    const repaint = () => { this._paint(); if (this._pin) this._paintPin(); };
    
    for (const [gname, list] of Object.entries(groups)) {
      if (list.length === 0) continue;

      const isOpen = !!this._openGroups[gname];
      
      const gh = document.createElement('div');
      gh.style.cssText = `
        color:${this._hl}; font-size:12px; font-weight:bold; padding:10px 8px; margin:6px 0 0 0;
        background:rgba(255,255,255,0.03); border-radius:${isOpen ? '6px 6px 0 0' : '6px'};
        border-bottom:${isOpen ? '1px solid #334' : 'none'};
        display:flex; justify-content:space-between; align-items:center;
        cursor:pointer; touch-action:none;
      `;
      gh.innerHTML = `<span>${gname}</span><span style="transition:transform 0.25s cubic-bezier(0.4, 0, 0.2, 1); transform:${isOpen ? 'rotate(90deg)' : 'rotate(0deg)'}">&#9654;</span>`;
      
      gh.addEventListener('pointerdown', e => { try { if (gh.setPointerCapture) gh.setPointerCapture(e.pointerId); } catch (_) {} });
      gh.addEventListener('pointerup', e => {
        try { if (gh.releasePointerCapture && gh.hasPointerCapture && gh.hasPointerCapture(e.pointerId)) gh.releasePointerCapture(e.pointerId); } catch (_) {}
        this._openGroups[gname] = !this._openGroups[gname];
        if (navigator.vibrate) navigator.vibrate(10);
        this._paintTweaksRepaintOnly();
      });
      gh.addEventListener('pointercancel', e => {
        try { if (gh.releasePointerCapture && gh.hasPointerCapture && gh.hasPointerCapture(e.pointerId)) gh.releasePointerCapture(e.pointerId); } catch (_) {}
      });

      this._content.appendChild(gh);

      const contentWrap = document.createElement('div');
      contentWrap.id = `group-${gname}`;
      contentWrap.style.cssText = `
        overflow:hidden; transition:max-height 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease-out;
        max-height:${isOpen ? '1500px' : '0px'}; opacity:${isOpen ? '1' : '0'};
        padding:${isOpen ? '6px 0' : '0'}; background:rgba(0,0,0,0.2); border-radius:0 0 6px 6px;
      `;
      
      for (const t of list) this._widget(t, contentWrap, repaint);
      this._content.appendChild(contentWrap);
    }
  }

  _paintTweaksRepaintOnly() {
    this._paint();
  }

  _paintStatus() {
    const lines = Debug.getStatus();
    const box = document.createElement('div');
    box.style.cssText = `background:rgba(0,0,0,0.3); padding:10px; border-radius:6px; font-size:11px; color:#fff; line-height:1.5; white-space:pre-wrap;`;
    box.innerHTML = lines.length ? lines.join('\\n') : 'Geen live-data beschikbaar.';
    this._content.appendChild(box);
  }

  _paintLog() {
    const header = document.createElement('div');
    header.style.cssText = `display:flex; flex-wrap:wrap; gap:4px; margin-bottom:10px; align-items:center;`;
    
    ['ALL', 'GAME', 'WEBGPU', 'BAL', 'ERROR'].forEach(f => {
      const btn = document.createElement('div');
      const act = this._logFilter === f;
      btn.innerText = f;
      btn.style.cssText = `padding:4px 8px; font-size:10px; border-radius:8px; cursor:pointer; background:${act ? this._hl : '#334'}; color:${act ? '#000' : '#fff'}; font-weight:bold; touch-action:none;`;
      
      btn.addEventListener('pointerdown', e => { try { if (btn.setPointerCapture) btn.setPointerCapture(e.pointerId); } catch (_) {} });
      btn.addEventListener('pointerup', e => { 
        try { if (btn.releasePointerCapture && btn.hasPointerCapture && btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId); } catch (_) {}
        this._logFilter = f; 
        if (navigator.vibrate) navigator.vibrate(10); 
        this._paintLog(); 
      });
      btn.addEventListener('pointercancel', e => {
        try { if (btn.releasePointerCapture && btn.hasPointerCapture && btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId); } catch (_) {}
      });

      header.appendChild(btn);
    });

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex; gap:6px; margin-left:auto;';

    const exportBtn = document.createElement('div');
    exportBtn.innerText = 'JSON EXPORT';
    exportBtn.style.cssText = `padding:4px 10px; font-size:10px; border-radius:8px; cursor:pointer; background:#34C759; color:#fff; font-weight:bold; touch-action:none;`;
    
    exportBtn.addEventListener('pointerdown', e => { try { if (exportBtn.setPointerCapture) exportBtn.setPointerCapture(e.pointerId); } catch (_) {} });
    exportBtn.addEventListener('pointerup', e => { 
       try { if (exportBtn.releasePointerCapture && exportBtn.hasPointerCapture && exportBtn.hasPointerCapture(e.pointerId)) exportBtn.releasePointerCapture(e.pointerId); } catch (_) {}
       if (navigator.vibrate) navigator.vibrate(10); 
       const t = this._tools.find(x => x.id === 'telemetry');
       if (t) t.run();
    });
    exportBtn.addEventListener('pointercancel', e => {
      try { if (exportBtn.releasePointerCapture && exportBtn.hasPointerCapture && exportBtn.hasPointerCapture(e.pointerId)) exportBtn.releasePointerCapture(e.pointerId); } catch (_) {}
    });

    const clearBtn = document.createElement('div');
    clearBtn.innerText = 'WISSEN';
    clearBtn.style.cssText = `padding:4px 10px; font-size:10px; border-radius:8px; cursor:pointer; background:#ff7a68; color:#fff; font-weight:bold; touch-action:none;`;
    
    clearBtn.addEventListener('pointerdown', e => { try { if (clearBtn.setPointerCapture) clearBtn.setPointerCapture(e.pointerId); } catch (_) {} });
    clearBtn.addEventListener('pointerup', e => { 
       try { if (clearBtn.releasePointerCapture && clearBtn.hasPointerCapture && clearBtn.hasPointerCapture(e.pointerId)) clearBtn.releasePointerCapture(e.pointerId); } catch (_) {}
       if (navigator.vibrate) navigator.vibrate([20, 30, 20]); 
       Debug.clearLog(); 
       this._paintLog(); 
    });
    clearBtn.addEventListener('pointercancel', e => {
      try { if (clearBtn.releasePointerCapture && clearBtn.hasPointerCapture && clearBtn.hasPointerCapture(e.pointerId)) clearBtn.releasePointerCapture(e.pointerId); } catch (_) {}
    });

    actions.appendChild(exportBtn);
    actions.appendChild(clearBtn);
    header.appendChild(actions);

    this._content.innerHTML = '';
    this._content.appendChild(header);

    const logBox = document.createElement('div');
    logBox.style.cssText = `flex:1; background:rgba(0,0,0,0.4); border-radius:6px; padding:8px; overflow-y:auto; font-size:10px; line-height:1.4;`;
    
    const logs = Debug.getLogBuffer();
    logs.forEach(l => {
      if (this._logFilter === 'ERROR' && l.level !== 'error') return;
      if (this._logFilter !== 'ALL' && this._logFilter !== 'ERROR' && l.tag !== this._logFilter) return;
      
      const el = document.createElement('div');
      let col = '#bbb';
      if (l.level === 'warn') col = '#ffcf6a';
      if (l.level === 'error') col = '#ff7a68';
      el.style.color = col;
      el.style.marginBottom = '4px';
      el.innerText = `[${l.time}] [${l.tag}] ${l.msg}`;
      logBox.appendChild(el);
    });

    this._content.appendChild(logBox);
    setTimeout(() => { logBox.scrollTop = logBox.scrollHeight; }, 10);
  }

  _widget(t, parent, repaint) {
    const row = document.createElement('div');
    row.style.cssText = `display:flex; justify-content:space-between; align-items:center; padding:8px; margin-bottom:2px;`;
    const left = document.createElement('div');
    left.innerHTML = `<div style="color:${this._hi};font-size:12px;">${t.label}</div>`;
    if (t.hint) left.innerHTML += `<div style="color:#667;font-size:10px;margin-top:2px;">${t.hint}</div>`;

    const right = document.createElement('div');

    if (t.kind === 'toggle') {
      const v = t.get();
      right.style.cssText = `width:36px; height:20px; border-radius:10px; background:${v ? '#34C759' : '#445'}; position:relative; cursor:pointer; transition:background 0.2s; touch-action:none;`;
      const knob = document.createElement('div');
      knob.style.cssText = `width:16px; height:16px; background:#fff; border-radius:8px; position:absolute; top:2px; left:${v ? '18px' : '2px'}; transition:left 0.2s; box-shadow:0 2px 4px rgba(0,0,0,0.3);`;
      right.appendChild(knob);
      
      right.addEventListener('pointerdown', e => { try { if (right.setPointerCapture) right.setPointerCapture(e.pointerId); } catch (_) {} });
      right.addEventListener('pointerup', e => { 
        try { if (right.releasePointerCapture && right.hasPointerCapture && right.hasPointerCapture(e.pointerId)) right.releasePointerCapture(e.pointerId); } catch (_) {}
        t.set(!v); 
        if (navigator.vibrate) navigator.vibrate(10); 
        repaint(); 
      });
      right.addEventListener('pointercancel', e => {
        try { if (right.releasePointerCapture && right.hasPointerCapture && right.hasPointerCapture(e.pointerId)) right.releasePointerCapture(e.pointerId); } catch (_) {}
      });

    } else if (t.kind === 'slider') {
      const v = t.get();
      row.style.flexDirection = 'column'; row.style.alignItems = 'stretch';
      const top = document.createElement('div'); top.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:6px;';
      const valDisp = document.createElement('div');
      valDisp.style.cssText = `color:${this._hl};font-size:12px;`;
      valDisp.innerText = t.fmt ? t.fmt(v) : v.toFixed(2);
      top.appendChild(left); top.appendChild(valDisp);
      row.appendChild(top);

      const track = document.createElement('div');
      track.style.cssText = 'height:24px; position:relative; cursor:pointer; touch-action:none;';
      const line = document.createElement('div');
      line.style.cssText = 'position:absolute;top:10px;left:0;right:0;height:4px;background:#445;border-radius:2px;';
      const fill = document.createElement('div');
      const pct = Math.max(0, Math.min(1, (v - t.min) / (t.max - t.min)));
      fill.style.cssText = `position:absolute;top:10px;left:0;width:${pct*100}%;height:4px;background:${this._hl};border-radius:2px;`;
      const knob = document.createElement('div');
      knob.style.cssText = `position:absolute;top:3px;left:calc(${pct*100}% - 9px);width:18px;height:18px; background:#fff;border-radius:9px;box-shadow:0 2px 6px rgba(0,0,0,0.5);`;
      track.appendChild(line); track.appendChild(fill); track.appendChild(knob);

      let dragging = false;
      const updateV = (e) => {
        const r = track.getBoundingClientRect();
        const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        let nv = t.min + p * (t.max - t.min);
        if (t.step) nv = Math.round(nv / t.step) * t.step;
        nv = Math.max(t.min, Math.min(t.max, nv));
        t.set(nv); this._persistSave(t, nv);
        const np = (nv - t.min) / (t.max - t.min);
        fill.style.width = (np * 100) + '%';
        knob.style.left = `calc(${np * 100}% - 9px)`;
        valDisp.innerText = t.fmt ? t.fmt(nv) : nv.toFixed(2);
      };
      
      track.addEventListener('pointerdown', e => { dragging = true; try { if (track.setPointerCapture) track.setPointerCapture(e.pointerId); } catch (_) {} updateV(e); });
      track.addEventListener('pointermove', e => { if (dragging) updateV(e); });
      const stopDrag = (e) => { dragging = false; try { if (track.releasePointerCapture && track.hasPointerCapture && track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId); } catch (_) {} repaint(); };
      track.addEventListener('pointerup', stopDrag);
      track.addEventListener('pointercancel', stopDrag);

      row.appendChild(track); parent.appendChild(row); return;
      
    } else if (t.kind === 'cycle') {
      const v = t.get();
      right.style.cssText = `padding:4px 10px; background:#445; border-radius:4px; color:${this._hi}; font-size:10px; cursor:pointer; touch-action:none;`;
      right.innerText = t.names ? t.names[v] : v;
      
      right.addEventListener('pointerdown', e => { try { if (right.setPointerCapture) right.setPointerCapture(e.pointerId); } catch (_) {} });
      right.addEventListener('pointerup', e => { 
        try { if (right.releasePointerCapture && right.hasPointerCapture && right.hasPointerCapture(e.pointerId)) right.releasePointerCapture(e.pointerId); } catch (_) {}
        t.set((v + 1) % (t.names ? t.names.length : 2)); 
        if (navigator.vibrate) navigator.vibrate(10); 
        repaint(); 
      });
      right.addEventListener('pointercancel', e => {
        try { if (right.releasePointerCapture && right.hasPointerCapture && right.hasPointerCapture(e.pointerId)) right.releasePointerCapture(e.pointerId); } catch (_) {}
      });
      
    } else if (t.kind === 'tool' || t.kind === 'sweep') {
      right.style.cssText = `padding:4px 10px; background:rgba(126,184,212,0.15); border:1px solid ${this._hl}; border-radius:4px; color:${this._hl}; font-size:10px; cursor:pointer; touch-action:none;`;
      right.innerText = t.kind === 'sweep' ? 'Start' : 'Open';
      
      right.addEventListener('pointerdown', e => { try { if (right.setPointerCapture) right.setPointerCapture(e.pointerId); } catch (_) {} });
      right.addEventListener('pointerup', e => { 
        try { if (right.releasePointerCapture && right.hasPointerCapture && right.hasPointerCapture(e.pointerId)) right.releasePointerCapture(e.pointerId); } catch (_) {}
        if (navigator.vibrate) navigator.vibrate(10); 
        t.onTap(); 
        this.close(); 
      });
      right.addEventListener('pointercancel', e => {
        try { if (right.releasePointerCapture && right.hasPointerCapture && right.hasPointerCapture(e.pointerId)) right.releasePointerCapture(e.pointerId); } catch (_) {}
      });
      
    } else if (t.kind === 'export') {
      right.style.cssText = `padding:4px 10px; background:#34C759; border-radius:4px; color:#fff; font-size:10px; font-weight:bold; cursor:pointer; touch-action:none;`;
      right.innerText = 'EXPORTEER';
      
      right.addEventListener('pointerdown', e => { try { if (right.setPointerCapture) right.setPointerCapture(e.pointerId); } catch (_) {} });
      right.addEventListener('pointerup', e => { 
        try { if (right.releasePointerCapture && right.hasPointerCapture && right.hasPointerCapture(e.pointerId)) right.releasePointerCapture(e.pointerId); } catch (_) {}
        if (navigator.vibrate) navigator.vibrate(10); 
        t.run(); 
      });
      right.addEventListener('pointercancel', e => {
        try { if (right.releasePointerCapture && right.hasPointerCapture && right.hasPointerCapture(e.pointerId)) right.releasePointerCapture(e.pointerId); } catch (_) {}
      });
    }
    
    row.appendChild(left); row.appendChild(right); parent.appendChild(row);
  }

  _openPin(name) {
    this.close();
    if (this._pin && this._pin.name === name) return;
    this._closePin();

    const root = document.createElement('div');
    root.setAttribute('data-ui', '');
    root.style.cssText = `position:fixed; top:20px; right:20px; width:280px; background:${this._bg}; border:1px solid #334; border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,0.6); pointer-events:auto; z-index:8000; touch-action:none;`;
    
    const head = document.createElement('div');
    head.style.cssText = `padding:8px 10px; border-bottom:1px solid #334; display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.4); border-radius:8px 8px 0 0; cursor:move;`;
    head.innerHTML = `<div style="color:${this._hi};font-size:12px;font-weight:bold;">${name}</div>`;
    
    const closeBtn = document.createElement('div');
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cssText = `color:${this._fg}; font-size:20px; cursor:pointer; padding:0 4px; touch-action:none;`;
    
    closeBtn.addEventListener('pointerdown', e => { try { if (closeBtn.setPointerCapture) closeBtn.setPointerCapture(e.pointerId); } catch (_) {} });
    closeBtn.addEventListener('pointerup', (e) => { 
      try { if (closeBtn.releasePointerCapture && closeBtn.hasPointerCapture && closeBtn.hasPointerCapture(e.pointerId)) closeBtn.releasePointerCapture(e.pointerId); } catch (_) {}
      e.stopPropagation(); 
      if (navigator.vibrate) navigator.vibrate(10); 
      this._closePin(true); 
    });
    closeBtn.addEventListener('pointercancel', e => {
      try { if (closeBtn.releasePointerCapture && closeBtn.hasPointerCapture && closeBtn.hasPointerCapture(e.pointerId)) closeBtn.releasePointerCapture(e.pointerId); } catch (_) {}
    });
    
    head.appendChild(closeBtn);

    let dragging = false, ox = 0, oy = 0;
    head.addEventListener('pointerdown', e => { dragging = true; ox = e.clientX - root.offsetLeft; oy = e.clientY - root.offsetTop; try { if (head.setPointerCapture) head.setPointerCapture(e.pointerId); } catch (_) {} });
    head.addEventListener('pointermove', e => { if (!dragging) return; root.style.left = (e.clientX - ox) + 'px'; root.style.top = (e.clientY - oy) + 'px'; root.style.right = 'auto'; });
    const stopDrag = (e) => { dragging = false; try { if (head.releasePointerCapture && head.hasPointerCapture && head.hasPointerCapture(e.pointerId)) head.releasePointerCapture(e.pointerId); } catch (_) {} };
    head.addEventListener('pointerup', stopDrag);
    head.addEventListener('pointercancel', stopDrag);

    root.appendChild(head);

    const body = document.createElement('div');
    body.style.cssText = 'padding:6px; max-height:70vh; overflow-y:auto;';
    root.appendChild(body);

    document.body.appendChild(root);
    this._pin = { name, root, body };
    this._paintPin();
    
    try { localStorage.setItem('zbPin', name); } catch (_) {}
  }

  _paintPin() {
    if (!this._pin) return;
    const { name, body } = this._pin;
    body.innerHTML = '';
    const repaint = () => this._paintPin();
    for (const t of this._tools) { if ((t.group || 'OVERIG') === name) this._widget(t, body, repaint); }
  }

  _closePin(forget = false) {
    if (!this._pin) return;
    if (this._pin.root.parentNode) this._pin.root.parentNode.removeChild(this._pin.root);
    this._pin = null;
    if (forget) { try { localStorage.removeItem('zbPin'); } catch (_) {} }
  }

  resetTweaks() {
    let n = 0;
    for (const t of this._tools) {
      if (t.kind !== 'slider' || !t.persist) continue;
      let had = false;
      try { had = localStorage.getItem('zbTweak:' + t.id) !== null; } catch (_) {}
      if (t._def != null) { try { t.set(t._def); } catch (_) {} }
      this._persistClear(t);
      if (had) n++;
    }
    Debug.pushLog('TWEAK', `codedefaults hersteld, ${n} onthouden waarde(n) gewist`, false);
    this._paint();
    if (this._pin) this._paintPin();
  }
}

export const DevPanel = new _DevPanel();
