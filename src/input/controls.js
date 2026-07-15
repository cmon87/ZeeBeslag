// controls.js
// M1.1: Volledige migratie naar Pointer Events API, inclusief defensieve CSS en nodeType checks.
// M1.12: Robuuste PointerCapture try-catch patches ter voorkoming van DOMExceptions op mobiel (multitouch).

export function setupBtn(el, cb) {
  if (!el) return;
  let a = false;
  
  el.style.userSelect = 'none';
  el.style.webkitUserSelect = 'none';
  el.style.touchAction = 'none';
  el.style.webkitTouchCallout = 'none';

  const s = e => {
    e.preventDefault();
    if (a) return;
    a = true;
    el.classList.add('active');
    try {
      if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
    } catch (_) {}
  };
  
  const en = e => {
    e.preventDefault();
    if (!a) return;
    a = false;
    el.classList.remove('active');
    try {
      if (el.releasePointerCapture && el.hasPointerCapture && el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
    } catch (_) {}
    cb();
  };
  
  el.addEventListener('pointerdown', s);
  el.addEventListener('pointerup', en);
  el.addEventListener('pointercancel', en);
}

export const joyState = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
export const altState = { up: false, down: false };

(function() {
  // Blokkade voor native mobile gedrag (context menu's op long press)
  window.oncontextmenu = () => false;

  const bL = document.getElementById('joyBaseL'), kL = document.getElementById('joyKnobL');
  const bR = document.getElementById('joyBaseR'), kR = document.getElementById('joyKnobR');
  const DEAD = 8, MAX_R = 48, DRAG_THRESHOLD = 5;
  const pointers = {};
  
  const side = x => x < window.innerWidth / 2 ? 'left' : 'right';
  const knob = (b, k, dx, dy) => {
    const r = Math.min(Math.sqrt(dx * dx + dy * dy), MAX_R);
    const a = Math.atan2(dy, dx);
    k.style.transform = `translate(calc(-50% + ${Math.cos(a) * r}px),calc(-50% + ${Math.sin(a) * r}px))`;
  };
  
  // Node type check toegevoegd om crashes op textnodes te voorkomen
  const onUI = t => t.target && t.target.nodeType === 1 && typeof t.target.closest === 'function' && t.target.closest('[data-ui]');

  document.addEventListener('pointerdown', e => {
    if (onUI(e)) return;
    e.preventDefault();
    const sd = side(e.clientX);
    const b = sd === 'left' ? bL : bR;
    if (b) {
        b.style.left = e.clientX + 'px';
        b.style.top = e.clientY + 'px';
        b.style.opacity = '1';
    }
    pointers[e.pointerId] = { sd, ox: e.clientX, oy: e.clientY, active: false };
  }, { passive: false });

  document.addEventListener('pointermove', e => {
    const p = pointers[e.pointerId];
    if (!p) return;
    e.preventDefault();
    const dx = e.clientX - p.ox, dy = e.clientY - p.oy;
    const d = Math.sqrt(dx * dx + dy * dy);
    
    // Positive Friction: pas reageren na de drag threshold
    if (!p.active && d > DRAG_THRESHOLD) p.active = true;
    
    if (p.active) {
      joyState[p.sd].x = d > DEAD ? (dx / Math.max(d, 1)) * Math.min(d / MAX_R, 1) : 0;
      joyState[p.sd].y = d > DEAD ? (dy / Math.max(d, 1)) * Math.min(d / MAX_R, 1) : 0;
      knob(p.sd === 'left' ? bL : bR, p.sd === 'left' ? kL : kR, dx, dy);
    }
  }, { passive: false });

  const endPointer = e => {
    const p = pointers[e.pointerId];
    if (!p) return;
    e.preventDefault();
    joyState[p.sd].x = 0;
    joyState[p.sd].y = 0;
    const b = p.sd === 'left' ? bL : bR;
    const k = p.sd === 'left' ? kL : kR;
    if (b) b.style.opacity = '0';
    if (k) k.style.transform = 'translate(-50%,-50%)';
    delete pointers[e.pointerId];
  };

  document.addEventListener('pointerup', endPointer, { passive: false });
  document.addEventListener('pointercancel', endPointer, { passive: false });

  ['Up', 'Down'].forEach(d => {
    const b = document.getElementById('btn' + d);
    if (!b) return;
    const k = d.toLowerCase();
    
    b.style.userSelect = 'none';
    b.style.webkitUserSelect = 'none';
    b.style.touchAction = 'none';
    b.style.webkitTouchCallout = 'none';
    
    const s = e => {
      e.preventDefault();
      altState[k] = true;
      b.classList.add('holding');
      try {
        if (b.setPointerCapture) b.setPointerCapture(e.pointerId);
      } catch (_) {}
    };
    
    const en = e => {
      e.preventDefault();
      altState[k] = false;
      b.classList.remove('holding');
      try {
        if (b.releasePointerCapture && b.hasPointerCapture && b.hasPointerCapture(e.pointerId)) {
          b.releasePointerCapture(e.pointerId);
        }
      } catch (_) {}
    };
    
    b.addEventListener('pointerdown', s);
    b.addEventListener('pointerup', en);
    b.addEventListener('pointercancel', en);
  });

  document.addEventListener('keydown', e => { if (e.key === 'ArrowUp' || e.key === 'w') altState.up = true; if (e.key === 'ArrowDown' || e.key === 's') altState.down = true; });
  document.addEventListener('keyup', e => { if (e.key === 'ArrowUp' || e.key === 'w') altState.up = false; if (e.key === 'ArrowDown' || e.key === 's') altState.down = false; });
})();
