// M0: mechanisch uit index.html v7 geextraheerd, gedrag ongewijzigd.
import { WGSL } from './wgsl.js';
import { ComputeHelper } from './computeHelper.js';

export class FFT {
  constructor(engine, size) {
    this._engine = engine;
    this._size = size;
    const logSize = Math.log2(size) | 0;

    const cs = new BABYLON.ComputeShader('twiddle', engine, { computeSource: WGSL.fftPrecompute }, {
      bindingsMapping: { PrecomputeBuffer:{group:0,binding:0}, params:{group:0,binding:1} },
      entryPoint: 'precomputeTwiddleFactorsAndInputIndices'
    });
    this._precomputed = ComputeHelper.CreateStorageTexture('twiddle', engine, logSize, size, BABYLON.Constants.TEXTUREFORMAT_RGBA);

    this._params = new BABYLON.UniformBuffer(engine);
    this._params.addUniform('Step', 1);
    this._params.addUniform('Size', 1);
    cs.setStorageTexture('PrecomputeBuffer', this._precomputed);
    cs.setUniformBuffer('params', this._params);
    this._params.updateInt('Size', size);
    this._params.update();
    // v9-fix: eenmalige twiddle-precompute via dispatchWhenReady; sync dispatch vóór
    // compilatie is een no-op, waardoor de butterfly-factoren nul blijven en elke IFFT nul geeft.
    ComputeHelper.DispatchWhenReady(cs, logSize, size/2, 1);

    this._horiz = new BABYLON.ComputeShader('fftH', engine, { computeSource: WGSL.fftHorizontal }, {
      bindingsMapping: { params:{group:0,binding:1}, PrecomputedData:{group:0,binding:3}, InputBuffer:{group:0,binding:5}, OutputBuffer:{group:0,binding:6} },
      entryPoint: 'horizontalStepInverseFFT'
    });
    this._horiz.setUniformBuffer('params', this._params);
    this._horiz.setTexture('PrecomputedData', this._precomputed, false);

    this._vert = new BABYLON.ComputeShader('fftV', engine, { computeSource: WGSL.fftVertical }, {
      bindingsMapping: { params:{group:0,binding:1}, PrecomputedData:{group:0,binding:3}, InputBuffer:{group:0,binding:5}, OutputBuffer:{group:0,binding:6} },
      entryPoint: 'verticalStepInverseFFT'
    });
    this._vert.setUniformBuffer('params', this._params);
    this._vert.setTexture('PrecomputedData', this._precomputed, false);

    this._permute = new BABYLON.ComputeShader('fftP', engine, { computeSource: WGSL.fftPermute }, {
      bindingsMapping: { InputBuffer:{group:0,binding:5}, OutputBuffer:{group:0,binding:6} },
      entryPoint: 'permute'
    });
  }

  IFFT2D(input, buffer) {
    const logSize = Math.log2(this._size) | 0;
    let pingPong = false;

    for (let i = 0; i < logSize; ++i) {
      pingPong = !pingPong;
      this._params.updateInt('Step', i);
      this._params.update();
      this._horiz.setTexture('InputBuffer', pingPong ? input : buffer, false);
      this._horiz.setStorageTexture('OutputBuffer', pingPong ? buffer : input);
      ComputeHelper.Dispatch(this._horiz, this._size, this._size, 1);
    }
    for (let i = 0; i < logSize; ++i) {
      pingPong = !pingPong;
      this._params.updateInt('Step', i);
      this._params.update();
      this._vert.setTexture('InputBuffer', pingPong ? input : buffer, false);
      this._vert.setStorageTexture('OutputBuffer', pingPong ? buffer : input);
      ComputeHelper.Dispatch(this._vert, this._size, this._size, 1);
    }
    if (pingPong) ComputeHelper.CopyTexture(buffer, input, this._engine);

    this._permute.setTexture('InputBuffer', input, false);
    this._permute.setStorageTexture('OutputBuffer', buffer);
    ComputeHelper.Dispatch(this._permute, this._size, this._size, 1);
    ComputeHelper.CopyTexture(buffer, input, this._engine);
  }

  dispose() { this._precomputed.dispose(); this._params.dispose(); }
}
