// src/game/gameClock.js
//
// Eén monotone gameplayklok voor alle simulatiesystemen. Realtime wordt alleen gebruikt om
// frames te meten; gameTime loopt uitsluitend wanneer de state PLAYING is. Hierdoor kunnen
// pauze, game-over en reset geen verborgen timers of cooldowns laten doorlopen.

export const GAME_STATES = Object.freeze({
  LOADING: 'loading',
  PLAYING: 'playing',
  PAUSED: 'paused',
  GAME_OVER: 'gameOver',
  RESETTING: 'resetting',
});

const VALID_STATES = new Set(Object.values(GAME_STATES));

export class GameClock {
  constructor(opts = {}) {
    this._state = VALID_STATES.has(opts.state) ? opts.state : GAME_STATES.LOADING;
    this._timeScale = this._sanitizeScale(opts.timeScale ?? 1);
    this._gameTime = Number.isFinite(opts.gameTime) && opts.gameTime >= 0 ? opts.gameTime : 0;
    this._realTime = 0;
  }

  get state() { return this._state; }
  get timeScale() { return this._timeScale; }
  get gameTime() { return this._gameTime; }
  get realTime() { return this._realTime; }
  get running() { return this._state === GAME_STATES.PLAYING && this._timeScale > 0; }

  _sanitizeScale(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new RangeError(`Ongeldige tijdschaal: ${String(value)}`);
    return n;
  }

  setState(next) {
    if (!VALID_STATES.has(next)) throw new RangeError(`Ongeldige game state: ${String(next)}`);
    this._state = next;
    return this._state;
  }

  setTimeScale(value) {
    this._timeScale = this._sanitizeScale(value);
    return this._timeScale;
  }

  tick(realDt) {
    const safeRealDt = Number.isFinite(realDt) && realDt > 0 ? Math.min(realDt, 0.1) : 0;
    this._realTime += safeRealDt;
    const gameDt = this.running ? safeRealDt * this._timeScale : 0;
    this._gameTime += gameDt;
    return {
      state: this._state,
      running: this.running,
      realDt: safeRealDt,
      gameDt,
      gameTime: this._gameTime,
      timeScale: this._timeScale,
    };
  }

  reset(gameTime = 0) {
    if (!Number.isFinite(gameTime) || gameTime < 0) throw new RangeError('gameTime moet een niet-negatief getal zijn');
    this._gameTime = gameTime;
    return this._gameTime;
  }

  snapshot() {
    return {
      state: this._state,
      timeScale: this._timeScale,
      gameTime: this._gameTime,
      realTime: this._realTime,
      running: this.running,
    };
  }
}
