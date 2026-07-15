// src/game/matchDirector.js
//
// M6.3: centrale lifecycle en gameplayklok.
// M6.4: reset wist ook de fysieke navigatiecontacten.
// M6.5: reset en sandbox synchroniseren ook het vijandelijke detectienetwerk.
// Alle gameplay gebruikt dezelfde state: loading, playing, paused, gameOver of resetting.
// De compatibele getters timeScale en gameOver blijven bestaan voor oudere modules.

import { pushLog } from '../core/log.js';
import { GameClock, GAME_STATES } from './gameClock.js';

export { GAME_STATES };

export class MatchDirector {
  constructor(cfg) {
    this.cfg = cfg;
    this.clock = new GameClock({ state: GAME_STATES.LOADING, timeScale: 1 });

    this.mode = 'ship';
    this.filmLook = true;

    this.devMode = false;
    this.playerGodMode = false;
    this.enemyGodMode = false;
    this.infiniteAmmo = false;
    this.autoSpot = false;

    this.resultEl = null;
    this.playBtnEl = null;
    this._resetTimer = null;
    this._transitionListeners = new Set();
    this.refs = {};

    try { const s = localStorage.getItem('zbFilm'); if (s !== null) this.filmLook = s === '1'; } catch(_) {}
    try { const m = localStorage.getItem('zbMode'); if (m === 'ship' || m === 'regie') this.mode = m; } catch(_) {}
    try {
      const devStr = localStorage.getItem('zbDev');
      if (devStr) {
        const d = JSON.parse(devStr);
        this.devMode = !!d.devMode;
        this.playerGodMode = !!d.playerGodMode;
        this.enemyGodMode = !!d.enemyGodMode;
        this.infiniteAmmo = !!d.infiniteAmmo;
        this.autoSpot = !!d.autoSpot;
      }
    } catch(_) {}
  }

  get state() { return this.clock.state; }
  get timeScale() { return this.clock.timeScale; }
  get gameTime() { return this.clock.gameTime; }
  get gameOver() { return this.state === GAME_STATES.GAME_OVER; }
  get isPaused() { return this.state === GAME_STATES.PAUSED; }
  get isGameplayActive() { return this.clock.running; }

  bind(refs) {
    this.refs = { ...this.refs, ...refs };
    this._syncRuntimeScale();
  }

  onTransition(fn) {
    if (typeof fn !== 'function') return () => {};
    this._transitionListeners.add(fn);
    return () => this._transitionListeners.delete(fn);
  }

  tick(realDt) { return this.clock.tick(realDt); }

  canAcceptInput() {
    return this.state === GAME_STATES.PLAYING && this.mode !== 'free';
  }

  completeLoading() {
    if (this.state !== GAME_STATES.LOADING) return false;
    this._transition(GAME_STATES.PLAYING, 'wereld gereed');
    return true;
  }

  setPlayBtn(btn) { this.playBtnEl = btn; this.syncPlayBtn(); }

  syncPlayBtn() {
    if (!this.playBtnEl) return;
    const btn = this.playBtnEl;
    btn.disabled = false;
    btn.style.opacity = '1';

    if (this.state === GAME_STATES.LOADING || this.state === GAME_STATES.RESETTING) {
      btn.innerHTML = 'LADEN';
      btn.disabled = true;
      btn.style.opacity = '0.55';
      btn.style.background = 'rgba(90,100,110,0.75)';
    } else if (this.state === GAME_STATES.GAME_OVER) {
      btn.innerHTML = 'EINDE';
      btn.disabled = true;
      btn.style.opacity = '0.65';
      btn.style.background = 'rgba(120,55,55,0.75)';
    } else if (this.state === GAME_STATES.PAUSED) {
      btn.innerHTML = '&#9654; PLAY';
      btn.style.background = 'rgba(52,199,89,0.85)';
    } else {
      btn.innerHTML = '&#10074;&#10074; PAUZE';
      btn.style.background = 'rgba(255,149,0,0.85)';
    }
  }

  setMode(m) {
    if (m !== 'ship' && m !== 'regie' && m !== 'free') {
      pushLog('MODE', `ongeldige modus geweigerd: ${String(m)}`, true);
      return false;
    }
    if (this.state === GAME_STATES.RESETTING) return false;
    this.mode = m;
    try { localStorage.setItem('zbMode', m); } catch(_) {}
    pushLog('MODE', `camera/besturing naar: ${m}`, false);
    if (this.refs.menu) this.refs.menu.refresh();

    if (m === 'free' && this.refs.chaseCam) this.refs.chaseCam.deactivate();
    else if (this.refs.chaseCam) this.refs.chaseCam.activate();
    if (this.refs.hud && typeof this.refs.hud.setMode === 'function') this.refs.hud.setMode(m);
    return true;
  }

  setTimeScale(value) {
    const scale = Number(value);
    if (!Number.isFinite(scale) || scale < 0) {
      pushLog('GAME', `ongeldige tijdschaal geweigerd: ${String(value)}`, true);
      return false;
    }
    if (scale === 0) return this.pause();
    if (this.state === GAME_STATES.GAME_OVER || this.state === GAME_STATES.RESETTING) {
      pushLog('GAME', `tijdschaal geweigerd in state ${this.state}`, false);
      return false;
    }

    this.clock.setTimeScale(scale);
    if (this.state === GAME_STATES.PAUSED) this._transition(GAME_STATES.PLAYING, 'hervat');
    else this._syncRuntimeScale();
    this.syncPlayBtn();
    if (this.refs.menu) this.refs.menu.refresh();
    pushLog('GAME', `simulatietijd: ${scale}x`, false);
    return true;
  }

  pause() {
    if (this.state !== GAME_STATES.PLAYING) return false;
    this._transition(GAME_STATES.PAUSED, 'pauze');
    pushLog('GAME', 'simulatie gepauzeerd', false);
    return true;
  }

  resume() {
    if (this.state !== GAME_STATES.PAUSED) return false;
    if (this.timeScale <= 0) this.clock.setTimeScale(1);
    this._transition(GAME_STATES.PLAYING, 'hervat');
    pushLog('GAME', `simulatie hervat op ${this.timeScale}x`, false);
    return true;
  }

  _transition(next, reason = '') {
    const prev = this.state;
    if (prev === next) { this._syncRuntimeScale(); return false; }
    this.clock.setState(next);
    this._syncRuntimeScale();
    this.syncPlayBtn();
    if (this.refs.menu) this.refs.menu.refresh();
    for (const fn of this._transitionListeners) {
      try { fn({ from: prev, to: next, reason, gameTime: this.gameTime }); } catch (_) {}
    }
    return true;
  }

  _syncRuntimeScale() {
    const scale = this.isGameplayActive ? this.timeScale : 0;
    const scalable = [this.refs.fx, this.refs.megaPlume];
    for (const system of scalable) {
      try { if (system && typeof system.setTimeScale === 'function') system.setTimeScale(scale); } catch (_) {}
    }
    if (scale === 0 && this.refs.sfx && typeof this.refs.sfx.stopAll === 'function') {
      try { this.refs.sfx.stopAll(); } catch (_) {}
    }
  }

  toggleSandbox(setting) {
    if (this[setting] !== undefined) {
      this[setting] = !this[setting];
      this._saveSandbox();
      pushLog('DEV', `Sandbox [${setting}] is nu ${this[setting] ? 'AAN' : 'UIT'}`, false);
      if (setting === 'autoSpot' && this[setting] && this.refs.registry) {
        if (typeof this.refs.registry.spotAll === 'function') this.refs.registry.spotAll('sandbox');
      }
    }
  }

  _saveSandbox() {
    const d = {
      devMode: this.devMode,
      playerGodMode: this.playerGodMode,
      enemyGodMode: this.enemyGodMode,
      infiniteAmmo: this.infiniteAmmo,
      autoSpot: this.autoSpot,
    };
    try { localStorage.setItem('zbDev', JSON.stringify(d)); } catch(_) {}
  }

  onShipSank() {
    if (this.gameOver || this.state === GAME_STATES.RESETTING) return;
    pushLog('GAME', 'SCHIP GEZONKEN. Einde oefening.', true);
    this._transition(GAME_STATES.GAME_OVER, 'schip gezonken');
    this._freezeCombatNow();
    if (this.refs.chaseCam) this.refs.chaseCam.deactivate();
    this.mode = 'free';
    if (this.refs.hud) this.refs.hud.setMode('free');
    if (this.refs.menu) this.refs.menu.refresh();
    this.showResult('MISSIE GEFAALD', '#ff7a68', 'Het schip is gezonken.');
  }

  onObjectiveComplete() {
    if (this.gameOver || this.state === GAME_STATES.RESETTING) return;
    pushLog('GAME', 'ALLE MISSIEOBJECTIEVEN VERNIETIGD. Succes.', false);
    this._transition(GAME_STATES.GAME_OVER, 'objectief voltooid');
    this._freezeCombatNow();
    if (this.refs.chaseCam) this.refs.chaseCam.deactivate();
    this.mode = 'free';
    if (this.refs.hud) this.refs.hud.setMode('free');
    if (this.refs.menu) this.refs.menu.refresh();
    this.showResult('MISSIE GESLAAGD', '#7ee8b0', 'Alle aangewezen vijandelijke objectieven zijn uitgeschakeld.');
  }


  _freezeCombatNow() {
    try { if (this.refs.combatController && typeof this.refs.combatController.cancelPending === 'function') this.refs.combatController.cancelPending(); } catch (_) {}
    try { if (this.refs.sfx && typeof this.refs.sfx.stopAll === 'function') this.refs.sfx.stopAll(); } catch (_) {}
  }

  showResult(title, color, sub) {
    if (!this.resultEl) {
      this.resultEl = document.createElement('div');
      this.resultEl.setAttribute('data-ui', '');
      this.resultEl.style.cssText = 'position:fixed;top:40%;left:50%;transform:translate(-50%,-50%);text-align:center;font-family:"Courier New",monospace;z-index:100;pointer-events:auto;text-shadow:0 2px 8px rgba(0,0,0,0.8);background:rgba(5,10,18,0.72);border:1px solid rgba(126,184,212,0.35);border-radius:12px;padding:22px 26px;backdrop-filter:blur(8px);';
      document.body.appendChild(this.resultEl);
    }
    this.resultEl.innerHTML = `<div style="font-size:32px;font-weight:bold;color:${color}">${title}</div><div style="font-size:16px;color:#fff;margin-top:8px">${sub}</div><button data-restart style="margin-top:20px;padding:10px 16px;border-radius:8px;border:1px solid rgba(126,184,212,0.55);background:rgba(25,55,80,0.9);color:#fff;font-family:inherit;font-weight:bold">HERSTART MISSIE</button>`;
    this.resultEl.style.display = 'block';
    const btn = this.resultEl.querySelector('[data-restart]');
    if (btn) btn.onclick = () => this.resetMatch();
    if (this._resetTimer) clearTimeout(this._resetTimer);
  }

  _safeReset(errors, label, fn) {
    try { fn(); } catch (err) { errors.push(`${label}: ${err && err.message ? err.message : String(err)}`); }
  }

  resetMatch() {
    if (this.state === GAME_STATES.RESETTING) return false;
    const errors = [];
    this._transition(GAME_STATES.RESETTING, 'missie reset');
    if (this._resetTimer) clearTimeout(this._resetTimer);
    if (this.resultEl) this.resultEl.style.display = 'none';

    this._safeReset(errors, 'audio', () => this.refs.sfx && this.refs.sfx.stopAll());
    this._safeReset(errors, 'combat', () => this.refs.combatController && this.refs.combatController.reset());
    this._safeReset(errors, 'projectielen', () => this.refs.ballistics && this.refs.ballistics.clear());
    this._safeReset(errors, 'effecten', () => this.refs.fx && this.refs.fx.resetTransient && this.refs.fx.resetTransient());
    this._safeReset(errors, 'achtergrondpluim', () => this.refs.megaPlume && this.refs.megaPlume.reset && this.refs.megaPlume.reset());
    this._safeReset(errors, 'slagveld', () => this.refs.battle && this.refs.battle.reset && this.refs.battle.reset());
    this._safeReset(errors, 'doelen', () => this.refs.registry && this.refs.registry.reset());
    this._safeReset(errors, 'verdedigingsnetwerk', () => this.refs.defenseNetwork && this.refs.defenseNetwork.reset && this.refs.defenseNetwork.reset());
    this._safeReset(errors, 'schip', () => {
      if (this.refs.playerShip) this.refs.playerShip.respawn(new BABYLON.Vector3(0, 0, 0), 0);
    });
    this._safeReset(errors, 'wereldcollision', () => this.refs.worldCollision && this.refs.worldCollision.reset && this.refs.worldCollision.reset());
    this._safeReset(errors, 'kielzog', () => this.refs.wakeManager && this.refs.wakeManager.reset && this.refs.wakeManager.reset(this.refs.playerShip, this.refs.enemyShip));
    this._safeReset(errors, 'markers', () => this.refs.markers && this.refs.markers.reset && this.refs.markers.reset());
    this._safeReset(errors, 'hud', () => this.refs.hud && this.refs.hud.reset && this.refs.hud.reset());
    this._safeReset(errors, 'hitte', () => this.refs.heatFx && this.refs.heatFx.reset && this.refs.heatFx.reset());
    this._safeReset(errors, 'eskader', () => this.refs.squadron && this.refs.squadron.reset && this.refs.squadron.reset());
    this._safeReset(errors, 'spelcontext', () => this.refs.onReset && this.refs.onReset());

    this.clock.reset(0);
    this.clock.setTimeScale(1);
    this.mode = 'ship';
    this._safeReset(errors, 'camera', () => {
      if (this.refs.chaseCam) this.refs.chaseCam.activate();
      if (this.refs.hud) this.refs.hud.setMode('ship');
      this.placeCinematicCam();
    });
    this._transition(GAME_STATES.PLAYING, 'reset voltooid');

    if (errors.length) {
      pushLog('GAME', `Missie gereset met ${errors.length} waarschuwing(en): ${errors.join(' | ')}`, true);
    } else {
      pushLog('GAME', 'Missie volledig gereset.', false);
    }
    return errors.length === 0;
  }

  aiDrive(ship, dt) {
    if (!this.isGameplayActive || !ship) return;
    ship.throttle = this.cfg.aiThrottle;
    ship.rudder += (this.cfg.aiRudderAmp - ship.rudder) * (1 - Math.exp(-dt * this.cfg.aiRudderRate));
  }

  placeCinematicCam() {
    if (!this.refs.cam || !this.refs.playerShip || !this.refs.enemyShip) return;
    const p = this.refs.playerShip.root.position;
    const ePos = this.refs.enemyShip.root ? this.refs.enemyShip.root.position : this.refs.enemyShip.position;
    if (!ePos) return;

    const forward = ePos.subtract(p).normalize();
    const up = BABYLON.Vector3.Up();
    const left = BABYLON.Vector3.Cross(up, forward).normalize();
    const camPos = p.subtract(forward.scale(120)).add(left.scale(60));
    camPos.y = p.y + 40;
    this.refs.cam.position.copyFrom(camPos);
    this.refs.cam.setTarget(ePos);
  }

  toggleFilmLook() {
    this.filmLook = !this.filmLook;
    try { localStorage.setItem('zbFilm', this.filmLook ? '1' : '0'); } catch(_) {}
    this.applyFilmLook();
  }

  applyFilmLook() {
    if (!this.refs.pipeline || !this.refs.pipeline.imageProcessing) return;
    const ip = this.refs.pipeline.imageProcessing;
    if (this.filmLook) {
      const c = new BABYLON.ColorCurves();
      c.globalSaturation = -60;
      c.shadowsHue = 215; c.shadowsDensity = 22; c.shadowsSaturation = -15;
      c.midtonesHue = 95; c.midtonesDensity = 6;
      c.highlightsHue = 48; c.highlightsDensity = 10; c.highlightsSaturation = -35;
      ip.colorCurves = c;
      ip.colorCurvesEnabled = true;
      ip.contrast = 1.30;
      ip.exposure = 1.0;
    } else {
      ip.colorCurvesEnabled = false;
      ip.contrast = 1.05;
      ip.exposure = 1.05;
    }
  }
}
