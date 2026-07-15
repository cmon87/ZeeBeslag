// M0: mechanisch uit index.html v7 geextraheerd, gedrag ongewijzigd.
// M1.5: geserialiseerde bake-keten.
// M1.8: spectrum-parameters via RawTexture in plaats van StorageBuffer.
// M1.9: de M1.8-diagnose is WEERLEGD. WavesData wordt in de WGSL in beide branches
//       geschreven en hangt niet af van de spectrum-parameters; WD=0 op alle cascades
//       bewijst dat de writes van phase1 zelf nooit landen. Hoofdverdachte: versiedrift
//       9.14 -> 9.15 (bindgroup-validatie op unfilterable-float textures), zie de pin in
//       index.html. Deze module is nu instrumenteel dichtgetimmerd: GPU error scope om de
//       bake, dispatch-tellers, geen stille catch meer, en de spectrum-texture wordt
//       eenmalig aangemaakt en per bake ge-update (geen dispose-tijdens-pending-dispatch).
import { WGSL } from './wgsl.js';
import { ComputeHelper } from './computeHelper.js';
import { pushLog } from '../core/log.js';

export class InitialSpectrum {
  constructor(engine, textureSize, noiseTexture) {
    this._engine = engine;
    this._size = textureSize;

    this._phase1 = new BABYLON.ComputeShader('initSpec1', engine, { computeSource: WGSL.initialSpectrum }, {
      bindingsMapping: {
        WavesData:{group:0,binding:1}, H0K:{group:0,binding:2}, Noise:{group:0,binding:4},
        params:{group:0,binding:5}, SpectrumParams:{group:0,binding:6}
      },
      entryPoint: 'calculateInitialSpectrum'
    });

    this.initialSpectrum = ComputeHelper.CreateStorageTexture('h0', engine, textureSize, textureSize, BABYLON.Constants.TEXTUREFORMAT_RGBA);
    this.wavesData        = ComputeHelper.CreateStorageTexture('wavesData', engine, textureSize, textureSize, BABYLON.Constants.TEXTUREFORMAT_RGBA);
    this._buffer           = ComputeHelper.CreateStorageTexture('h0k', engine, textureSize, textureSize, BABYLON.Constants.TEXTUREFORMAT_RG);

    // M1.9: eenmalig aanmaken, per bake update(). Voorkomt texture-churn en het risico dat
    // een oude texture gedisposed wordt terwijl een eerdere dispatch nog in de keten hangt.
    this.spectrumTex = new BABYLON.RawTexture(new Float32Array(16), 4, 1, BABYLON.Constants.TEXTUREFORMAT_RGBA, engine,
      false, false, BABYLON.Constants.TEXTURE_NEAREST_SAMPLINGMODE, BABYLON.Constants.TEXTURETYPE_FLOAT);
    this.spectrumTex.name = 'spectrumParams';

    this._params = new BABYLON.UniformBuffer(engine);
    this._params.addUniform('Size',1); this._params.addUniform('LengthScale',1);
    this._params.addUniform('CutoffHigh',1); this._params.addUniform('CutoffLow',1);
    this._params.addUniform('GravityAcceleration',1); this._params.addUniform('Depth',1);

    this._phase1.setStorageTexture('WavesData', this.wavesData);
    this._phase1.setStorageTexture('H0K', this._buffer);
    this._phase1.setTexture('Noise', noiseTexture, false);
    this._phase1.setTexture('SpectrumParams', this.spectrumTex, false);
    this._phase1.setUniformBuffer('params', this._params);

    this._phase2 = new BABYLON.ComputeShader('initSpec2', engine, { computeSource: WGSL.initialSpectrum2 }, {
      bindingsMapping: { H0:{group:0,binding:0}, params:{group:0,binding:5}, H0K:{group:0,binding:8} },
      entryPoint: 'calculateConjugatedSpectrum'
    });
    this._phase2.setStorageTexture('H0', this.initialSpectrum);
    this._phase2.setUniformBuffer('params', this._params);
    this._phase2.setTexture('H0K', this._buffer, false);
  }

  generate(wavesSettings, lengthScale, cutoffLow, cutoffHigh) {
    this._params.updateInt('Size', this._size);
    this._params.updateFloat('LengthScale', lengthScale);
    this._params.updateFloat('CutoffHigh', cutoffHigh);
    this._params.updateFloat('CutoffLow', cutoffLow);
    const spec16 = wavesSettings.setParametersToShader(this._params);   // Float32Array(16)
    this._params.update();

    // M1.9: geen new/dispose meer, alleen een data-upload naar de bestaande texture.
    this.spectrumTex.update(spec16);

    // Eenmalige DIAG-regel per bake: de CPU-kant van de parameters, zodat een probe met
    // GPU-nullen direct tegen de bedoelde waarden gelegd kan worden.
    pushLog('BAKE', `L=${lengthScale} a0=${spec16[4].toExponential(2)} w0=${spec16[5].toFixed(3)} a1=${spec16[12].toExponential(2)} w1=${spec16[13].toFixed(3)}`, false);

    // v9-fix: wacht op shader-compilatie, dan phase1 (H0K) en daarna phase2 (H0) in volgorde.
    // M1.5: geserialiseerd over rebakes heen.
    // M1.9: GPU error scope om de bake zodat een validatiefout (bind group, submit) een
    //       leesbare logregel wordt in plaats van geluidloos weggegooid werk. Plus expliciete
    //       fout-logging: de vorige .catch(() => {}) heeft een sessie diagnose gekost.
    this._bakeChain = (this._bakeChain || Promise.resolve())
      .then(async () => {
        const dev = this._engine._device;   // GPUDevice op WebGPUEngine, elders undefined
        if (dev && dev.pushErrorScope) dev.pushErrorScope('validation');
        await ComputeHelper.DispatchWhenReady(this._phase1, this._size, this._size, 1);
        await ComputeHelper.DispatchWhenReady(this._phase2, this._size, this._size, 1);
        if (dev && dev.popErrorScope) {
          const err = await dev.popErrorScope();
          if (err) pushLog('BAKE', `WebGPU-validatiefout in bake L=${lengthScale}: ${err.message}`, true);
          else pushLog('BAKE', `bake L=${lengthScale} gedispatcht zonder validatiefout (ph1 #${this._phase1.__zbDispatched|0}, ph2 #${this._phase2.__zbDispatched|0})`, false);
        }
      })
      .catch(e => pushLog('BAKE', `bake-chain fout L=${lengthScale}: ${e && e.message || e}`, true));
  }

  dispose() {
    this._params.dispose();
    if (this.spectrumTex) this.spectrumTex.dispose();
    this.wavesData.dispose(); this._buffer.dispose(); this.initialSpectrum.dispose();
  }
}
