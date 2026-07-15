// src/core/debug.js
//
// M3.1 datalaag + in-game debug-GUI, herbouwd tegen exact wat main.js, devPanel.js en
// telemetry.js aanroepen.
//
// ── GUI, gereorganiseerd ─────────────────────────────────────────────────────
// Vroeger stonden er drie blokken tegelijk linksboven: cijfers, status en een roterende log.
// Dat was druk en overlapte. Nu twee heldere lagen, plus het tandwiel voor de diepte:
//
//   1. PERF-RIBBON (altijd zichtbaar, klein, niet-klikbaar, links boven).
//      Eén regel cijfers plus een frametijd-sparkline. Dit is de enige vaste overlay.
//      Kleur volgt de FPS: groen gezond, amber krap, rood slecht. Aan/uit via toggleHud().
//
//   2. WARNING-TOAST (verschijnt alleen bij een waarschuwing of fout).
//      Korte melding boven in beeld, tikbaar: tik opent de console op de LOG-tab.
//      Verdwijnt vanzelf. Zo mis je niets zonder dat er permanent iets in de weg staat.
//
//   3. Alle status, de volledige log, gereedschap en export zitten in het tandwiel
//      (src/ui/devPanel.js). debug.js LEVERT die data via Debug.getStatus/getPerf/onLog.
//
// Dit bestand bouwt bewust geen knoppen meer, op de ribbon en toast na. Modules registreren
// zich bij DevPanel; de facade hieronder is puur data en de twee overlays.

import {
  pushLog, addLogListener, getLogBuffer, getLogHistory, getWarnCount, clearBuffer,
} from './log.js';

export { pushLog, getLogBuffer };

// warnCount is nu een FUNCTIE (devPanel roept warnCount() aan). Levert aantal warn+error.
export function warnCount() { return getWarnCount(); }

// ── globale vangnetten ───────────────────────────────────────────────────────
// Wikkelen console.error/warn zodat ze in de in-game log verschijnen. pushLog print via de
// native console, dus deze wrappers voeden zichzelf niet terug (geen stack-overflow meer).
const fmt = (a) => a.map(x => typeof x === 'string' ? x : (x && x.message) || safeJson(x)).join(' ');
function safeJson(x) { try { return JSON.stringify(x); } catch (_) { return String(x); } }

console.error = (...a) => { pushLog('CONSOLE', fmt(a), true); };
console.warn  = (...a) => { pushLog('WARN', fmt(a), false, 'warn'); };

window.addEventListener('error', e => {
  if (e.target && e.target.tagName === 'SCRIPT') return;
  pushLog('RUNTIME', (e.message || 'onbekende runtime fout') +
    (e.filename ? ` @ ${String(e.filename).split('/').pop()}:${e.lineno}` : ''), true);
});
window.addEventListener('unhandledrejection', e => {
  const r = e.reason;
  pushLog('PROMISE', (r && (r.message || r)) || 'onafgehandelde promise-afwijzing', true);
});

// ── gedeelde perf-stats (main.js schrijft hierin elke frame) ─────────────────
export const stats = {
  frameCount: 0,
  fpsHistory: [],       // dt in ms, laatste ~60 frames. Voedt de sparkline.
  currentFps: 60,
  gpuWarnCount: 0,
  drawCalls: 0,
  activeMeshes: 0,
};

// ── interne verwijzingen ─────────────────────────────────────────────────────
let engineRef = null, sceneRef = null;
let buildString = 'UNKNOWN';
let statusProviderFn = null;
let diagTargetRef = null;
let panelToggle = null;
let renderViewIndex = 0;
let renderViewHandler = null;

export const renderViewNames = ['Standaard', 'Albedo', 'Normals', 'Wireframe'];

// ── ribbon-UI ────────────────────────────────────────────────────────────────
// M4.9: standaard UIT. De ribbon overlapte de hamburger (beide top-left) en alles wat hij
// toont staat in het DIAGNOSE-scherm en in de telemetrie-export (prestaties.ruweFrametijden
// is exact de sparkline-data). Wie hem live wil, zet hem aan via DIAGNOSE > Perf-ribbon;
// de keuze overleeft een reload. Nieuwe plek: linksonder, daar staat sinds M4.9 niets meer.
let hudVisible = false;
try { hudVisible = localStorage.getItem('zbRibbon') === '1'; } catch (_) {}
let ribbon, ribbonText, spark, sparkCtx, toastEl, toastTimer = null;
let lastTextPaint = 0;

const COL = { good: '#7ee8b0', warn: '#ffcf6a', bad: '#ff7a68', dim: '#8fb6cc' };

function fpsColor(fps) { return fps >= 55 ? COL.good : fps >= 45 ? COL.warn : COL.bad; }

function initUI() {
  if (ribbon) return;

  // PERF-RIBBON
  ribbon = document.createElement('div');
  ribbon.id = 'zb-perf';
  ribbon.setAttribute('data-ui', '');
  ribbon.style.cssText = `position:fixed;bottom:12px;left:10px;z-index:40;pointer-events:none;
    font-family:"Courier New",monospace;font-size:11px;line-height:1.3;color:#cfe1ee;
    background:rgba(6,12,22,0.6);border:1px solid rgba(126,184,212,0.22);border-radius:8px;
    padding:6px 8px;backdrop-filter:blur(6px);display:flex;flex-direction:column;gap:4px;
    text-shadow:0 1px 2px #000;`;

  ribbonText = document.createElement('div');
  ribbon.appendChild(ribbonText);

  spark = document.createElement('canvas');
  spark.width = 132; spark.height = 20;
  spark.style.cssText = 'width:132px;height:20px;display:block;opacity:0.9;';
  ribbon.appendChild(spark);
  sparkCtx = spark.getContext('2d');

  document.body.appendChild(ribbon);
  ribbon.style.display = hudVisible ? 'flex' : 'none';

  // WARNING-TOAST
  toastEl = document.createElement('div');
  toastEl.id = 'zb-toast';
  toastEl.setAttribute('data-ui', '');
  toastEl.style.cssText = `position:fixed;top:12px;left:50%;transform:translateX(-50%) translateY(-16px);
    z-index:99400;max-width:min(86vw,420px);pointer-events:auto;cursor:pointer;
    font-family:"Courier New",monospace;font-size:11px;line-height:1.35;color:#fff;
    background:rgba(20,10,10,0.92);border:1px solid rgba(255,122,104,0.5);border-radius:9px;
    padding:9px 12px;backdrop-filter:blur(8px);box-shadow:0 6px 20px rgba(0,0,0,0.45);
    opacity:0;transition:opacity 0.18s,transform 0.18s;word-break:break-word;`;
  toastEl.addEventListener('pointerup', () => { hideToast(); if (panelToggle) panelToggle('log'); });
  document.body.appendChild(toastEl);

  // De ribbon luistert mee voor de sparkline; de toast reageert op warn/error.
  addLogListener(onLogForOverlay);
}

function onLogForOverlay(entry) {
  if (!entry || entry.level === 'info') return;
  showToast(entry);
}

function showToast(entry) {
  if (!toastEl) return;
  const c = entry.level === 'error' ? COL.bad : COL.warn;
  toastEl.style.borderColor = entry.level === 'error' ? 'rgba(255,122,104,0.6)' : 'rgba(255,207,106,0.6)';
  toastEl.innerHTML =
    `<span style="color:${c};font-weight:bold;">${entry.level === 'error' ? 'FOUT' : 'LET OP'}</span>` +
    `<span style="color:${COL.dim};"> [${entry.tag}]</span> ${escapeHtml(entry.msg)}` +
    `<div style="color:${COL.dim};font-size:9px;margin-top:3px;">tik om de console te openen</div>`;
  toastEl.style.opacity = '1';
  toastEl.style.transform = 'translateX(-50%) translateY(0)';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, entry.level === 'error' ? 6000 : 4000);
}
function hideToast() {
  if (!toastEl) return;
  toastEl.style.opacity = '0';
  toastEl.style.transform = 'translateX(-50%) translateY(-16px)';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

export function toggleHud() {
  hudVisible = !hudVisible;
  try { localStorage.setItem('zbRibbon', hudVisible ? '1' : '0'); } catch (_) {}
  if (ribbon) ribbon.style.display = hudVisible ? 'flex' : 'none';
  pushLog('DEBUG', `perf-overlay ${hudVisible ? 'aan' : 'uit'}`, false);
}

export function hudEnabled() { return hudVisible; }

function drawSparkline() {
  if (!sparkCtx) return;
  const w = spark.width, h = spark.height;
  sparkCtx.clearRect(0, 0, w, h);
  const data = stats.fpsHistory;
  if (!data.length) return;
  const n = Math.min(data.length, w);
  const start = data.length - n;
  const bw = w / n;
  for (let i = 0; i < n; i++) {
    const dt = data[start + i];                 // ms
    const barH = Math.min(h, (dt / 50) * h);    // 50ms = volle hoogte
    const col = dt <= 20 ? COL.good : dt <= 33 ? COL.warn : COL.bad;
    sparkCtx.fillStyle = col;
    sparkCtx.fillRect(i * bw, h - barH, Math.max(1, bw - 0.5), barH);
  }
  // 60fps-lijn (16.7ms) als stille referentie
  const y = h - (16.7 / 50) * h;
  sparkCtx.strokeStyle = 'rgba(255,255,255,0.18)';
  sparkCtx.beginPath(); sparkCtx.moveTo(0, y); sparkCtx.lineTo(w, y); sparkCtx.stroke();
}

// Elke frame aangeroepen vanuit main. DOM-tekst is gethrottled, de sparkline volgt elk frame.
export function updateDebugStats() {
  if (!ribbon || !hudVisible) return;

  if (sceneRef) {
    try {
      if (!sceneRef.instrumentation) {
        sceneRef.instrumentation = new BABYLON.SceneInstrumentation(sceneRef);
        sceneRef.instrumentation.captureActiveMeshesEvaluationTime = true;
      }
      stats.activeMeshes = sceneRef.getActiveMeshes().length;
      stats.drawCalls = sceneRef.instrumentation.drawCallsCounter.current;
    } catch (_) {}
  }

  drawSparkline();

  const now = performance.now();
  if (now - lastTextPaint < 150) return;   // ~6-7 updates/sec is ruim genoeg om te lezen
  lastTextPaint = now;

  const fps = Math.round(stats.currentFps);
  const ms = stats.currentFps > 0 ? (1000 / stats.currentFps).toFixed(1) : '--';
  const warns = getWarnCount();
  ribbonText.innerHTML =
    `<span style="font-weight:bold;color:${fpsColor(fps)};">${fps} FPS</span>` +
    `<span style="color:${COL.dim};"> ${ms}ms · draws ${stats.drawCalls} · meshes ${stats.activeMeshes}</span>` +
    (warns ? `<span style="color:${COL.warn};"> · ⚠ ${warns}</span>` : '');
}

// ── fataal scherm ────────────────────────────────────────────────────────────
// index.html vangt bootfouten al af met #crash-screen. Deze overlay is voor fouten NA de boot
// (oceaan-init, GLB, enz.), die vroeger alleen in de console verdwenen en een zwart scherm
// achterlieten. Leesbaar, met directe export zodat je meteen een dump hebt.
function showFatal(err, info) {
  let el = document.getElementById('zb-fatal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'zb-fatal';
    el.setAttribute('data-ui', '');
    el.style.cssText = `position:fixed;inset:0;z-index:9999999;background:rgba(7,14,26,0.98);
      padding:18px;overflow-y:auto;color:#cfe1ee;font-family:"Courier New",monospace;
      user-select:text;-webkit-user-select:text;`;
    document.body.appendChild(el);
  }
  const stack = (err && err.stack) ? String(err.stack).slice(0, 1600) : '(geen stacktrace)';
  el.innerHTML =
    `<h2 style="color:${COL.bad};font-size:15px;letter-spacing:0.1em;margin-bottom:8px;">ZEEBESLAG FATALE FOUT</h2>` +
    `<div style="font-size:11px;color:${COL.dim};margin-bottom:10px;">${info.title || 'Fout'} · fase ${info.phase || '?'} · tag ${info.tag || '?'}</div>` +
    `<div style="font-size:12px;background:rgba(255,122,104,0.07);border:1px solid rgba(255,122,104,0.2);` +
    `border-radius:6px;padding:10px;margin-bottom:12px;word-break:break-word;color:${COL.bad};font-weight:bold;">` +
    `${escapeHtml((err && err.message) || String(err))}</div>` +
    `<div style="font-size:9px;background:#040810;border:1px solid rgba(126,184,212,0.2);border-radius:6px;` +
    `padding:10px;white-space:pre-wrap;color:#7eb8d4;overflow-x:auto;">${escapeHtml(stack)}</div>` +
    `<div id="zb-fatal-export" style="display:inline-block;margin-top:14px;padding:11px 14px;border-radius:8px;` +
    `background:rgba(126,184,212,0.15);border:1px solid rgba(126,184,212,0.45);color:#eaf4fb;` +
    `font:bold 11px 'Courier New',monospace;cursor:pointer;">DOWNLOAD TELEMETRIEDUMP</div>`;
  const btn = document.getElementById('zb-fatal-export');
  if (btn) btn.addEventListener('pointerup', () => {
    if (window.zbTel && window.zbTel.download) window.zbTel.download();
    else exportState();
  });
}

// ── wereldstaat-export (compacte snapshot, blijft op window en in Debug) ──────
function vecToObj(v) {
  if (!v) return null;
  return { x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3) };
}

function exportState() {
  if (!engineRef || !sceneRef) { pushLog('EXPORT', 'kan state niet exporteren, engine of scene mist', true); return; }
  pushLog('EXPORT', 'wereldstaat-snapshot genereren', false);

  const buf = getLogHistory();
  const errors = buf.filter(e => e.level === 'error').length;
  const warns  = buf.filter(e => e.level === 'warn').length;

  const state = {
    metadata: { timestamp: new Date().toISOString(), build: buildString, userAgent: navigator.userAgent },
    performance: {
      fps: Math.round(stats.currentFps), drawCalls: stats.drawCalls, activeMeshes: stats.activeMeshes,
      totalMeshes: sceneRef.meshes.length, totalMaterials: sceneRef.materials.length,
      warnings: warns, errors,
    },
    environment: {
      clearColor: sceneRef.clearColor ? sceneRef.clearColor.toHexString() : null,
      fogEnabled: sceneRef.fogMode !== 0, fogDensity: sceneRef.fogDensity,
      iblIntensity: sceneRef.environmentIntensity,
    },
    camera: {}, lights: [], shadows: [], entities: {},
    gameplayState: statusProviderFn ? statusProviderFn() : [],
    recentLogs: buf.slice(-30),
  };

  if (sceneRef.activeCamera) {
    const c = sceneRef.activeCamera;
    state.camera = { type: c.getClassName(), position: vecToObj(c.position), fov: c.fov ? +c.fov.toFixed(2) : null };
  }
  sceneRef.lights.forEach(l => {
    const d = { name: l.name, type: l.getClassName(), intensity: +l.intensity.toFixed(2), diffuse: l.diffuse.toHexString() };
    if (l.direction) d.direction = vecToObj(l.direction);
    state.lights.push(d);
    const sg = l.getShadowGenerator();
    if (sg) state.shadows.push({
      lightName: l.name, type: sg.getClassName(),
      mapSize: sg.getShadowMap() ? sg.getShadowMap().getSize() : null,
      pcssEnabled: sg.useContactHardeningShadow || false, bias: sg.bias,
    });
  });
  const ship = sceneRef.meshes.find(m => m.name && (m.name === 'Schip1_root' || m.name === 'playerShip' || m.name.includes('Schip1')));
  if (ship) state.entities.player = { name: ship.name, position: vecToObj(ship.position), rotation: vecToObj(ship.rotation) };

  const json = JSON.stringify(state, null, 2);
  console.log('========== ZEEBESLAG WORLD STATE ==========\n' + json + '\n===========================================');
  try { navigator.clipboard.writeText(json); pushLog('EXPORT', 'wereldstaat op het klembord', false); }
  catch (_) { pushLog('EXPORT', 'wereldstaat in de console (klembord geweigerd)', false); }
  return state;
}
window.zbExportWorldState = exportState;

// ── de facade ────────────────────────────────────────────────────────────────
export const Debug = {
  // opzet
  attachEngine: (e) => { engineRef = e; initUI(); },
  registerScene: (s) => { sceneRef = s; },
  setBuild: (b) => { buildString = b; },
  getBuild: () => buildString,

  // status en log (bron voor devPanel)
  setStatusProvider: (fn) => { statusProviderFn = fn; },
  getStatus: () => { try { return statusProviderFn ? (statusProviderFn() || []) : []; } catch (_) { return []; } },
  getPerf: () => ({
    fps: Math.round(stats.currentFps),
    ms: stats.currentFps > 0 ? +(1000 / stats.currentFps).toFixed(1) : null,
    draws: stats.drawCalls, meshes: stats.activeMeshes,
    warns: getWarnCount(), gpuWarns: stats.gpuWarnCount,
  }),
  onLog: (cb) => addLogListener(cb),
  clearLog: () => clearBuffer(),
  getLogBuffer: () => getLogBuffer(),
  pushLog,

  // console-koppeling (devPanel registreert de opener)
  setPanelToggler: (fn) => { panelToggle = fn; },
  togglePanel: (tab) => { if (panelToggle) panelToggle(tab); },

  // laden
  setLoading: (pct, msg) => { pushLog('LOAD', `[${pct}%] ${msg}`); },
  loadingDone: () => { pushLog('LOAD', 'sessie geinitialiseerd'); },

  // fataal
  fatal: (err, info = {}) => { pushLog('FATAL', `${info.title || 'fout'} (${info.tag || '?'}): ${err && err.message}`, true); showFatal(err, info); },

  // oceaan-renderweergave
  renderViewNames,
  getRenderView: () => renderViewIndex,
  setRenderView: (i) => { renderViewIndex = i; if (renderViewHandler) renderViewHandler(i); },
  setRenderViewHandler: (fn) => { renderViewHandler = fn; },

  // diagnose
  setDiagTarget: (t) => { diagTargetRef = t; },
  runDiag: (target) => {
    const tgt = target || diagTargetRef;
    pushLog('DIAG', tgt ? 'diagnose gedraaid' : 'geen diagnosedoel', !tgt);
  },

  exportWorldState: exportState,
};
