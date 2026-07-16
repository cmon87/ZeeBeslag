// Mobile-only inputlaag voor Level 1.
// Alleen touch/pen wordt als gameplayinput geaccepteerd. Pointer-cancel voert nooit een actie uit.

export const joyState = {
  left: { x: 0, y: 0 },
  right: { x: 0, y: 0 }, // compatibiliteit voor devmodules; level 1 gebruikt hem niet.
};
export const altState = { up: false, down: false };

function isTouchPointer(e) {
  return !e.pointerType || e.pointerType === 'touch' || e.pointerType === 'pen';
}

export function setupBtn(el, cb) {
  if (!el) return () => {};
  let activePointer = null;
  let cancelled = false;

  const reset = (e) => {
    if (activePointer !== null && e && e.pointerId !== activePointer) return;
    try {
      if (e && el.releasePointerCapture && el.hasPointerCapture && el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
    } catch (_) {}
    activePointer = null;
    el.classList.remove('active');
    el.style.transform = '';
  };

  const down = (e) => {
    if (!isTouchPointer(e) || el.disabled || activePointer !== null) return;
    e.preventDefault();
    e.stopPropagation();
    activePointer = e.pointerId;
    cancelled = false;
    el.classList.add('active');
    el.style.transform = 'scale(0.92)';
    try { el.setPointerCapture && el.setPointerCapture(e.pointerId); } catch (_) {}
  };

  const up = (e) => {
    if (e.pointerId !== activePointer) return;
    e.preventDefault();
    e.stopPropagation();
    const shouldRun = !cancelled && !el.disabled;
    reset(e);
    if (shouldRun && typeof cb === 'function') cb();
  };

  const cancel = (e) => {
    if (e.pointerId !== activePointer) return;
    e.preventDefault();
    e.stopPropagation();
    cancelled = true;
    reset(e);
  };

  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('lostpointercapture', cancel);

  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', cancel);
    el.removeEventListener('lostpointercapture', cancel);
  };
}

export class MobileInputController {
  constructor() {
    this.enabled = false;
    this.aimEnabled = false;
    this.fireEnabled = false;
    this.isAiming = false;
    this._pointerId = null;
    this._originX = 0;
    this._originY = 0;
    this._maxRadius = 58;
    this._fireHandler = null;
    this._detachFire = null;
    this._attached = false;
    this._handlers = null;
  }

  attach() {
    if (this._attached || typeof document === 'undefined') return this;
    this.base = document.getElementById('joyBaseL');
    this.knob = document.getElementById('joyKnobL');
    this.fireButton = document.getElementById('btnFire');
    if (!this.base || !this.knob || !this.fireButton) {
      throw new Error('Mobiele bediening mist joyBaseL, joyKnobL of btnFire');
    }

    const onDown = (e) => {
      if (!this.enabled || !this.aimEnabled || !isTouchPointer(e) || this._pointerId !== null) return;
      if (e.target && e.target.closest && e.target.closest('[data-ui]')) return;
      if (e.clientX > window.innerWidth * 0.72) return;
      e.preventDefault();
      this._pointerId = e.pointerId;
      this._originX = e.clientX;
      this._originY = e.clientY;
      this.isAiming = true;
      this.base.style.left = `${e.clientX}px`;
      this.base.style.top = `${e.clientY}px`;
      this.base.style.opacity = '1';
      try { document.documentElement.setPointerCapture && document.documentElement.setPointerCapture(e.pointerId); } catch (_) {}
    };

    const onMove = (e) => {
      if (e.pointerId !== this._pointerId) return;
      e.preventDefault();
      const dx = e.clientX - this._originX;
      const dy = e.clientY - this._originY;
      const length = Math.hypot(dx, dy);
      const radius = Math.min(length, this._maxRadius);
      const nx = length > 0 ? dx / length : 0;
      const ny = length > 0 ? dy / length : 0;
      const strength = Math.min(1, length / this._maxRadius);
      const deadzoned = strength < 0.10 ? 0 : (strength - 0.10) / 0.90;
      joyState.left.x = nx * deadzoned;
      joyState.left.y = ny * deadzoned;
      this.knob.style.transform = `translate(calc(-50% + ${nx * radius}px),calc(-50% + ${ny * radius}px))`;
    };

    const finish = (e) => {
      if (e.pointerId !== this._pointerId) return;
      e.preventDefault();
      this._pointerId = null;
      this.isAiming = false;
      joyState.left.x = 0;
      joyState.left.y = 0;
      this.base.style.opacity = '0';
      this.knob.style.transform = 'translate(-50%,-50%)';
    };

    document.addEventListener('pointerdown', onDown, { passive: false });
    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', finish, { passive: false });
    document.addEventListener('pointercancel', finish, { passive: false });
    this._handlers = { onDown, onMove, finish };
    this._detachFire = setupBtn(this.fireButton, () => {
      if (this.enabled && this.fireEnabled && this._fireHandler) this._fireHandler();
    });
    this._attached = true;
    this._syncFireButton();
    return this;
  }

  setFireHandler(fn) { this._fireHandler = typeof fn === 'function' ? fn : null; }
  setEnabled(value) {
    this.enabled = !!value;
    this.aimEnabled = this.enabled;
    if (!this.enabled) this.resetAim();
    this._syncFireButton();
  }
  setAimEnabled(value) {
    this.aimEnabled = this.enabled && !!value;
    if (!this.aimEnabled) this.resetAim();
  }
  setFireEnabled(value) {
    this.fireEnabled = this.enabled && !!value;
    this._syncFireButton();
  }
  setFireReady(value) {
    if (!this.fireButton) return;
    this.fireButton.dataset.ready = value ? '1' : '0';
  }
  resetAim() {
    this._pointerId = null;
    this.isAiming = false;
    joyState.left.x = 0;
    joyState.left.y = 0;
    joyState.right.x = 0;
    joyState.right.y = 0;
    if (this.base) this.base.style.opacity = '0';
    if (this.knob) this.knob.style.transform = 'translate(-50%,-50%)';
  }
  _syncFireButton() {
    if (!this.fireButton) return;
    const active = this.enabled && this.fireEnabled;
    this.fireButton.disabled = !active;
    this.fireButton.style.opacity = active ? '1' : '0.42';
  }
  get aim() { return joyState.left; }

  dispose() {
    if (this._handlers) {
      document.removeEventListener('pointerdown', this._handlers.onDown);
      document.removeEventListener('pointermove', this._handlers.onMove);
      document.removeEventListener('pointerup', this._handlers.finish);
      document.removeEventListener('pointercancel', this._handlers.finish);
    }
    if (this._detachFire) this._detachFire();
    this._handlers = null;
    this._detachFire = null;
    this._attached = false;
  }
}

export const mobileInput = new MobileInputController();
