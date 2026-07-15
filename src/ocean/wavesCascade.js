// M0: mechanisch uit index.html v7 geextraheerd, gedrag ongewijzigd.
import { WGSL } from './wgsl.js';
import { ComputeHelper } from './computeHelper.js';
import { InitialSpectrum } from './initialSpectrum.js';
import { pushLog } from '../core/log.js';

export class WavesCascade {
  constructor(size, noiseTexture, fft, engine) {
    this._engine = engine;
    this._size = size;
    this._fft = fft;
    this._lambda = 0;
    this._pingPongTurb = false;

    this._initialSpectrum = new InitialSpectrum(engine, size, noiseTexture);

    this._timedSpec = new BABYLON.ComputeShader('timedSpec', engine, { computeSource: WGSL.timeDependentSpectrum }, {
      bindingsMapping: {
        H0:{group:0,binding:1}, WavesData:{group:0,binding:3}, params:{group:0,binding:4},
        DxDz:{group:0,binding:5}, DyDxz:{group:0,binding:6}, DyxDyz:{group:0,binding:7}, DxxDzz:{group:0,binding:8}
      },
      entryPoint: 'calculateAmplitudes'
    });

    this._buffer = ComputeHelper.CreateStorageTexture('buf', engine, size, size, BABYLON.Constants.TEXTUREFORMAT_RG);
    this._DxDz   = ComputeHelper.CreateStorageTexture('DxDz', engine, size, size, BABYLON.Constants.TEXTUREFORMAT_RG);
    this._DyDxz  = ComputeHelper.CreateStorageTexture('DyDxz', engine, size, size, BABYLON.Constants.TEXTUREFORMAT_RG);
    this._DyxDyz = ComputeHelper.CreateStorageTexture('DyxDyz', engine, size, size, BABYLON.Constants.TEXTUREFORMAT_RG);
    this._DxxDzz = ComputeHelper.CreateStorageTexture('DxxDzz', engine, size, size, BABYLON.Constants.TEXTUREFORMAT_RG);

    this._timedParams = new BABYLON.UniformBuffer(engine);
    this._timedParams.addUniform('Time', 1);
    this._timedSpec.setTexture('H0', this._initialSpectrum.initialSpectrum, false);
    this._timedSpec.setTexture('WavesData', this._initialSpectrum.wavesData, false);
    this._timedSpec.setUniformBuffer('params', this._timedParams);
    this._timedSpec.setStorageTexture('DxDz', this._DxDz);
    this._timedSpec.setStorageTexture('DyDxz', this._DyDxz);
    this._timedSpec.setStorageTexture('DyxDyz', this._DyxDyz);
    this._timedSpec.setStorageTexture('DxxDzz', this._DxxDzz);

    this._merger = new BABYLON.ComputeShader('merger', engine, { computeSource: WGSL.wavesTexturesMerger }, {
      bindingsMapping: {
        params:{group:0,binding:0}, Displacement:{group:0,binding:1}, Derivatives:{group:0,binding:2},
        TurbulenceRead:{group:0,binding:3}, TurbulenceWrite:{group:0,binding:4},
        DxDz:{group:0,binding:5}, DyDxz:{group:0,binding:6}, DyxDyz:{group:0,binding:7}, DxxDzz:{group:0,binding:8}
      },
      entryPoint: 'fillResultTextures'
    });

    this.displacement = ComputeHelper.CreateStorageTexture('displacement', engine, size, size,
      BABYLON.Constants.TEXTUREFORMAT_RGBA, BABYLON.Constants.TEXTURETYPE_HALF_FLOAT, BABYLON.Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
    this.derivatives  = ComputeHelper.CreateStorageTexture('derivatives', engine, size, size,
      BABYLON.Constants.TEXTUREFORMAT_RGBA, BABYLON.Constants.TEXTURETYPE_HALF_FLOAT, BABYLON.Constants.TEXTURE_TRILINEAR_SAMPLINGMODE, true);
    this._turb  = ComputeHelper.CreateStorageTexture('turb', engine, size, size,
      BABYLON.Constants.TEXTUREFORMAT_RGBA, BABYLON.Constants.TEXTURETYPE_HALF_FLOAT, BABYLON.Constants.TEXTURE_TRILINEAR_SAMPLINGMODE, true);
    this._turb2 = ComputeHelper.CreateStorageTexture('turb2', engine, size, size,
      BABYLON.Constants.TEXTUREFORMAT_RGBA, BABYLON.Constants.TEXTURETYPE_HALF_FLOAT, BABYLON.Constants.TEXTURE_TRILINEAR_SAMPLINGMODE, true);

    this._mergerParams = new BABYLON.UniformBuffer(engine);
    this._mergerParams.addUniform('Lambda', 1);
    this._mergerParams.addUniform('DeltaTime', 1);
    this._merger.setUniformBuffer('params', this._mergerParams);
    this._merger.setStorageTexture('Displacement', this.displacement);
    this._merger.setStorageTexture('Derivatives', this.derivatives);
    this._merger.setTexture('DxDz', this._DxDz, false);
    this._merger.setTexture('DyDxz', this._DyDxz, false);
    this._merger.setTexture('DyxDyz', this._DyxDyz, false);
    this._merger.setTexture('DxxDzz', this._DxxDzz, false);
  }

  get turbulence() { return this._pingPongTurb ? this._turb2 : this._turb; }

  calculateInitials(wavesSettings, lengthScale, cutoffLow, cutoffHigh) {
    this._lambda = wavesSettings.lambda;
    this._initialSpectrum.generate(wavesSettings, lengthScale, cutoffLow, cutoffHigh);
  }

  calculateWavesAtTime(time, deltaTimeSec) {
    this._timedParams.updateFloat('Time', time);
    this._timedParams.update();
    ComputeHelper.Dispatch(this._timedSpec, this._size, this._size, 1);

    this._fft.IFFT2D(this._DxDz, this._buffer);
    this._fft.IFFT2D(this._DyDxz, this._buffer);
    this._fft.IFFT2D(this._DyxDyz, this._buffer);
    this._fft.IFFT2D(this._DxxDzz, this._buffer);

    let dt = deltaTimeSec;
    if (dt > 0.5) dt = 0.5;
    this._mergerParams.updateFloat('Lambda', this._lambda);
    this._mergerParams.updateFloat('DeltaTime', dt);
    this._mergerParams.update();

    this._pingPongTurb = !this._pingPongTurb;
    this._merger.setTexture('TurbulenceRead', this._pingPongTurb ? this._turb : this._turb2, false);
    this._merger.setStorageTexture('TurbulenceWrite', this._pingPongTurb ? this._turb2 : this._turb);
    ComputeHelper.Dispatch(this._merger, this._size, this._size, 1);

    // M1.6 perf: derivatives-mips elke stap (specular-aliasing in de verte is direct zichtbaar),
    // turbulentie-mips om de stap. Turbulentie stuurt alleen foam; foam voorbij ~2600m valt onder
    // de vroege uitstap in de shader en dichtbij wordt mip 0 gesampeld. Inferentie: halvering van
    // deze render-passes is onzichtbaar; verifieer met de timing-splitsing in de HUD.
    try {
      this._engine.generateMipmaps(this.derivatives.getInternalTexture());
      // M1.10: turbulentie-mips ELKE stap regenereren. De oude M1.6-besparing deed ze om de stap,
      // waardoor de hoge mip-niveaus de helft van de tijd stale waren. Juist die hoge mips sampelt
      // de horizon (grazing angle), dus dat gaf een knipperende horizonbalk: verse mip 0 dichtbij,
      // om-en-om verouderde mip ver weg. Elke stap regenereren kost op een 128x128-textuur weinig.
      this._engine.generateMipmaps((this._pingPongTurb ? this._turb2 : this._turb).getInternalTexture());
    } catch(mipErr) {
      if (!this.__mipWarned) { this.__mipWarned = true; pushLog('FFT', 'generateMipmaps faalt: ' + (mipErr.message||mipErr), true); }
    }
  }

  dispose() {
    this._initialSpectrum.dispose(); this._timedParams.dispose();
    this._buffer.dispose(); this._DxDz.dispose(); this._DyDxz.dispose();
    this._DyxDyz.dispose(); this._DxxDzz.dispose(); this._mergerParams.dispose();
  }
}
