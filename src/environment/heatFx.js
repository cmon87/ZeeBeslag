// src/environment/heatFx.js
//
// M3.1: HeatFx. Eén WGSL post-process pass met drie effecten:
//   1. Hitteschittering, een screen-space UV-distortie in een verticale band rond de horizon,
//      globaal opgevoerd door uHeat (een puls uit het gevecht).
//   2. Compacte bloom, een golden-angle spiral rond elk pixel. Draait NA de forward-grade, dus
//      op een al getonemapte LDR-frame. Geen brede filmische bloom, maar genoeg om tracers,
//      mondingsvlammen en de zon te laten gloeien.
//   3. Film grain, sterker in de middentonen dan in diep zwart of fel wit.
//
// Waarom één pass: de telemetrie bewees dat een enkele post-process pass de Adreno 830 onder
// WebGPU overleeft (nul errors, 59,5 fps). De oude black-screen kwam niet door post-processing
// maar door een uniform buffer size-mismatch op een sun-licht. Zolang je geen probleemlicht
// toevoegt, is deze pass veilig.
//
// De grade (ACES, contrast, exposure, vignette, colorCurves) zit al in de forward pass op
// scene.imageProcessingConfiguration. Deze pass voegt daar bovenop toe en dupliceert de vignette
// bewust NIET.

const SHADER_BASE = 'heatFx';

const WGSL_TEMPLATE = /* wgsl */ `
varying vUV: vec2f;

var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

uniform uTime: f32;
uniform uHeat: f32;
uniform uAmount: f32;
uniform uResolution: vec2f;
uniform uBloomThreshold: f32;
uniform uBloomIntensity: f32;
uniform uGrain: f32;
uniform uBandLo: f32;
uniform uBandHi: f32;

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 345.45));
  q += dot(q, q + 34.345);
  return fract(q.x * q.y);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash21(i + vec2f(0.0, 0.0));
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let uv = input.vUV;
  let t = uniforms.uTime;

  // ── Hitteschittering ────────────────────────────────────────────────
  // Band rond de horizon waar de hete eilandlucht staat, plus een globale puls uit het gevecht.
  let band = smoothstep(uniforms.uBandLo, (uniforms.uBandLo + uniforms.uBandHi) * 0.5, uv.y)
           * (1.0 - smoothstep((uniforms.uBandLo + uniforms.uBandHi) * 0.5, uniforms.uBandHi, uv.y));
  let heat = clamp(uniforms.uHeat, 0.0, 2.0);
  let baseAmp = uniforms.uAmount * (0.35 + heat);

  let n1 = vnoise(vec2f(uv.x * 60.0,  uv.y * 22.0 - t * 1.6));
  let n2 = vnoise(vec2f(uv.x * 130.0 + t * 0.9, uv.y * 48.0 - t * 2.7));
  let wob = (n1 - 0.5) * 0.7 + (n2 - 0.5) * 0.3;

  let amp = baseAmp * band;
  let duv = vec2f(wob * amp, wob * amp * 0.5);
  let suv = uv + duv;

  var col = textureSample(textureSampler, textureSamplerSampler, suv).rgb;

  // ── Compacte bloom (LDR, na tonemap) ────────────────────────────────
  let texel = vec2f(1.0) / uniforms.uResolution;
  let radius = 7.0;
  let thr = uniforms.uBloomThreshold;
  var bloom = vec3f(0.0);
  let GA = 2.399963229;
  for (var i: i32 = 0; i < __BLOOM_SAMPLES__; i = i + 1) {
    let fi = f32(i);
    let ang = fi * GA;
    let r = radius * sqrt((fi + 0.5) / __BLOOM_SAMPLES_F__);
    let off = vec2f(cos(ang), sin(ang)) * r * texel;
    let s = textureSample(textureSampler, textureSamplerSampler, suv + off).rgb;
    let l = luma(s);
    let e = max(l - thr, 0.0) / max(1.0 - thr, 0.001);
    bloom += s * e;
  }
  bloom = bloom / __BLOOM_SAMPLES_F__;
  col += bloom * uniforms.uBloomIntensity;

  // ── Film grain ──────────────────────────────────────────────────────
  let g = hash21(uv * uniforms.uResolution + vec2f(t * 91.7, t * 47.3)) - 0.5;
  let lm = luma(col);
  let grainMask = 1.0 - abs(lm - 0.5) * 2.0;
  col += vec3f(g * uniforms.uGrain * grainMask);

  fragmentOutputs.color = vec4f(col, 1.0);
}
`;

function registerShader(shaderName, bloomSamples) {
  const store = BABYLON.ShaderStore.ShadersStoreWGSL;
  if (!store[shaderName + 'FragmentShader']) {
    const n = Math.max(4, Math.min(16, Math.round(bloomSamples || 12)));
    store[shaderName + 'FragmentShader'] = WGSL_TEMPLATE
      .replaceAll('__BLOOM_SAMPLES__', String(n))
      .replaceAll('__BLOOM_SAMPLES_F__', `${n}.0`);
  }
}

export class HeatFx {
  constructor(scene, camera, engine, opts = {}) {
    this.scene = scene;
    this.camera = camera;
    this.engine = engine;

    this.time = 0;
    this.heat = 0;
    this.heatDecay = opts.heatDecay ?? 2.2;
    this.ratio = Math.max(0.5, Math.min(1, Number(opts.ratio ?? 1)));
    this.bloomSamples = Math.max(4, Math.min(16, Math.round(opts.bloomSamples ?? 12)));
    this.shaderName = `${SHADER_BASE}${this.bloomSamples}`;

    this.params = {
      amount: opts.amount ?? 0.0016,
      bloomThreshold: opts.bloomThreshold ?? 0.72,
      bloomIntensity: opts.bloomIntensity ?? 0.55,
      grain: opts.grain ?? 0.045,
      bandLo: opts.bandLo ?? 0.18,
      bandHi: opts.bandHi ?? 0.92,
    };

    this.pp = null;
    this._enabled = false;
    if (opts.enabled !== false) this.enable(true);
  }

  enable(on) {
    if (on && !this.pp) {
      registerShader(this.shaderName, this.bloomSamples);
      // Positionele constructor. De options-object-vorm wordt door Babylon 9.14 niet herkend,
      // waardoor engine en camera wegvielen en Babylon crashte op createDrawContext. Hier staat
      // de engine expliciet op positie 8 en shaderLanguage als laatste argument, zodat WGSL
      // wordt gekozen en de engine gegarandeerd gezet is.
      this.pp = new BABYLON.PostProcess(
        this.shaderName,                               // name
        this.shaderName,                               // shaderstore-sleutel
        [                                              // uniforms
          'uTime', 'uHeat', 'uAmount', 'uResolution',
          'uBloomThreshold', 'uBloomIntensity', 'uGrain', 'uBandLo', 'uBandHi',
        ],
        null,                                          // samplers (textureSampler is impliciet)
        this.ratio,                                    // ratio
        this.camera,                                   // camera
        BABYLON.Texture.BILINEAR_SAMPLINGMODE,         // samplingMode
        this.engine,                                   // engine (expliciet, dit was de bug)
        false,                                         // reusable
        null,                                          // defines
        BABYLON.Constants.TEXTURETYPE_UNSIGNED_BYTE,   // textureType
        'postprocess',                                 // vertexUrl (Babylon levert WGSL-variant)
        undefined,                                     // indexParameters
        false,                                         // blockCompilation
        BABYLON.Constants.TEXTUREFORMAT_RGBA,          // textureFormat
        BABYLON.ShaderLanguage.WGSL                    // shaderLanguage
      );

      this.pp.onApply = (effect) => {
        const w = this.pp.width || this.engine.getRenderWidth();
        const h = this.pp.height || this.engine.getRenderHeight();
        effect.setFloat('uTime', this.time);
        effect.setFloat('uHeat', this.heat);
        effect.setFloat('uAmount', this.params.amount);
        effect.setFloat2('uResolution', w, h);
        effect.setFloat('uBloomThreshold', this.params.bloomThreshold);
        effect.setFloat('uBloomIntensity', this.params.bloomIntensity);
        effect.setFloat('uGrain', this.params.grain);
        effect.setFloat('uBandLo', this.params.bandLo);
        effect.setFloat('uBandHi', this.params.bandHi);
      };
      this._enabled = true;

    } else if (!on && this.pp) {
      this.pp.dispose(this.camera);
      this.pp = null;
      this._enabled = false;
    }
  }

  get enabled() { return this._enabled; }

  // Korte hittepuls, bijvoorbeeld bij een inslag. Stapelt niet, neemt het maximum.
  pulse(strength = 0.9) {
    this.heat = Math.max(this.heat, strength);
  }

  update(dt) {
    if (dt > 0) this.time += dt;
    if (this.heat > 0) {
      this.heat -= this.heat * this.heatDecay * dt;
      if (this.heat < 1e-3) this.heat = 0;
    }
  }

  reset() {
    this.time = 0;
    this.heat = 0;
  }

  dispose() {
    if (this.pp) { this.pp.dispose(this.camera); this.pp = null; }
    this._enabled = false;
  }
}
