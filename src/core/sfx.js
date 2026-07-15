// src/core/sfx.js
//
// M3.3: minimale SFX-speler voor korte geluidseffecten. Gebruikt HTMLAudioElement, dus geen
// afhankelijkheid van het Babylon-audio-engine (dat op WebGPU-builds soms lastig doet).
//
// Mobiel: browsers laten audio pas toe na een gebruikersinteractie. Het eerste geluid speelt
// daarom vanuit een echte tik (de vuurknop is zo'n tik), en unlock() ontgrendelt de rest zodra
// er ooit ergens getikt wordt.
//
// M3.4: Expliciete Garbage Collection toegevoegd voor gekloonde nodes om decoder exhaustion
// en memory leaks te voorkomen op mobiele systemen (iOS/Android).

export class Sfx {
  constructor() {
    this.map = {};
    this.enabled = true;
    this._unlocked = false;
    this._active = new Set();

    // Eén keer ontgrendelen bij de eerste tik, zodat later afspelen zonder directe tik ook mag.
    const unlock = () => {
      this._unlocked = true;
      for (const k in this.map) {
        const a = this.map[k];
        try { a.muted = true; a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; }); } catch (_) {}
      }
      window.removeEventListener('pointerdown', unlock);
    };
    window.addEventListener('pointerdown', unlock, { once: true });
  }

  load(name, url, { volume = 1 } = {}) {
    const a = new Audio(url);
    a.preload = 'auto';
    a.volume = volume;
    this.map[name] = a;
    return a;
  }

  play(name, volume) {
    if (!this.enabled) return;
    const base = this.map[name];
    if (!base) return;
    try {
      // Kloon zodat snel achter elkaar afspelen elkaar niet afkapt.
      const a = base.cloneNode();
      a.volume = volume !== undefined ? volume : base.volume;
      
      // Garbage Collection: ruim gekloonde node op na afspelen om memory leaks te voorkomen
      const cleanup = () => {
        a.removeEventListener('ended', cleanup);
        a.removeEventListener('error', cleanup);
        this._active.delete(a);
        try {
          a.pause();
          a.src = '';
          a.load(); // Forceert de browser om decoder-buffers per direct te dealloceren
        } catch (_) {}
      };
      
      a.addEventListener('ended', cleanup);
      a.addEventListener('error', cleanup);
      this._active.add(a);
      a.play().catch(() => { cleanup(); });
    } catch (_) {
      try { base.currentTime = 0; base.play().catch(() => {}); } catch (__) {}
    }
  }

  stopAll() {
    for (const a of [...this._active]) {
      try {
        a.pause();
        a.currentTime = 0;
        a.src = '';
        a.load();
      } catch (_) {}
      this._active.delete(a);
    }
    for (const a of Object.values(this.map)) {
      try { a.pause(); a.currentTime = 0; } catch (_) {}
    }
  }

  setEnabled(v) {
    this.enabled = !!v;
    if (!this.enabled) this.stopAll();
  }
}
