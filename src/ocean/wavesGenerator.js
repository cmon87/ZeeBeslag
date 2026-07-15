// M0: mechanisch uit index.html v7 geextraheerd, gedrag ongewijzigd.
// M1.9: (1) deferInitialBake-optie. (2) Per-cascade simulatiefrequentie.
// M1.11: Ondersteuning voor pre-loaded fotorealistische EXR noise-textuur
//        als superieure basis voor de golftop-generatie. Val-terug naar CPU-ruis.
// M1.12: Starttijd offset (pre-warm): door virtueel 10.000 seconden in het
//        verleden te starten, elimineren we de opstart-kolk (constructieve
//        interferentie) volledig en tonen we direct realistische chaos.

import { FFT } from './fft.js';
import { WavesCascade } from './wavesCascade.js';

export class WavesGenerator {
  constructor(size, wavesSettings, engine, opts) {
    this._engine = engine;
    
    // M6.3: gesimuleerde oceaantijd. De eerdere performance.now()-bron liet de zee
    // tijdens pauze ongemerkt doorlopen en veroorzaakte een zichtbare sprong bij hervatten.
    // We behouden de 10.000 seconden pre-warm, maar tellen uitsluitend gameplay-delta op.
    this._prewarmTime = 10000.0;
    this._simTime = this._prewarmTime;
    
    this._wavesSettings = wavesSettings;
    this._fft = new FFT(engine, size);
    
    // M1.11: Gebruik EXR noise textuur indien meegegeven vanuit main.js, anders val-terug
    this._noise = (opts && opts.noiseTexture) ? opts.noiseTexture : this._makeNoiseTexture(size);
    
    // lengthScale: grootte van elke cascade-patch in meter
    // [0]=far/lange deining 250m, [1]=mid 17m, [2]=near/capillair 5m
    this.lengthScale = [250, 17, 5];
    this.baked = false;
    this._tick = 0;
    this._c0Accum = 0;
    this._cascades = [
      new WavesCascade(size, this._noise, this._fft, engine),
      new WavesCascade(size, this._noise, this._fft, engine),
      new WavesCascade(size, this._noise, this._fft, engine)
    ];
    if (!opts || !opts.deferInitialBake) this._initCascades();
  }

  getCascade(i) { return this._cascades[i]; }

  _initCascades() {
    let boundary1 = 0.0001;
    for (let i = 0; i < this.lengthScale.length; ++i) {
      const boundary2 = i < this.lengthScale.length - 1 ? 2*Math.PI/this.lengthScale[i+1]*6 : 9999;
      this._cascades[i].calculateInitials(this._wavesSettings, this.lengthScale[i], boundary1, boundary2);
      boundary1 = boundary2;
    }
    this.baked = true;
  }

  rebake() { this._initCascades(); }

  update(deltaTimeSec) {
    const dt = Number.isFinite(deltaTimeSec) && deltaTimeSec > 0 ? deltaTimeSec : 0;
    if (dt <= 0) return;
    this._simTime += dt;
    const time = this._simTime;
    this._tick++;
    this._c0Accum += dt;
    if ((this._tick & 1) === 0) {
      this._cascades[0].calculateWavesAtTime(time, this._c0Accum);
      this._c0Accum = 0;
    }
    this._cascades[1].calculateWavesAtTime(time, dt);
    this._cascades[2].calculateWavesAtTime(time, dt);
  }

  reset() {
    this._simTime = this._prewarmTime;
    this._tick = 0;
    this._c0Accum = 0;
  }

  dispose() {
    this._cascades.forEach(c=>c.dispose());
    if (this._noise) this._noise.dispose(); 
    this._fft.dispose();
  }

  _normalRandom() { return Math.cos(2*Math.PI*Math.random()) * Math.sqrt(-2*Math.log(Math.random())); }

  _makeNoiseTexture(size) {
    const data = new Float32Array(size*size*2);
    for (let i=0;i<size;i++) for (let j=0;j<size;j++) {
      data[j*size*2+i*2+0] = this._normalRandom();
      data[j*size*2+i*2+1] = this._normalRandom();
    }
    const tex = new BABYLON.RawTexture(data, size, size, BABYLON.Constants.TEXTUREFORMAT_RG, this._engine,
      false, false, BABYLON.Constants.TEXTURE_NEAREST_SAMPLINGMODE, BABYLON.Constants.TEXTURETYPE_FLOAT);
    tex.name = 'cpu_noise';
    return tex;
  }
}
