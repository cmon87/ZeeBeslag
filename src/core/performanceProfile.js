// src/core/performanceProfile.js
// M6.6: expliciet, reproduceerbaar renderbudget voor mobiel en desktop.
// Babylon krijgt geen impliciete device-ratio meer; deze module bepaalt exact hoeveel
// fysieke pixels worden gerenderd en levert dezelfde kwaliteitskeuzes aan oceaan, wake en FX.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const PERFORMANCE_PROFILES = Object.freeze({
  mobileBalanced: Object.freeze({
    id: 'mobile-balanced',
    renderScale: 0.44,
    minPixelRatio: 1.25,
    maxPixelRatio: 1.65,
    oceanRings: 80,
    oceanSegments: 192,
    wakeResolution: 256,
    wakeUpdateHz: 20,
    wakeMaxParts: 48,
    wakeMaxInterpolationStamps: 24,
    postProcessRatio: 0.85,
    bloomSamples: 8,
    uiUpdateHz: 30,
    mergeStaticMeshes: true,
    maxMergeVertices: 220000,
    freezeStaticMaterials: true,
  }),
  desktopHigh: Object.freeze({
    id: 'desktop-high',
    renderScale: 0.72,
    minPixelRatio: 1,
    maxPixelRatio: 2,
    oceanRings: 96,
    oceanSegments: 256,
    wakeResolution: 384,
    wakeUpdateHz: 24,
    wakeMaxParts: 64,
    wakeMaxInterpolationStamps: 40,
    postProcessRatio: 1,
    bloomSamples: 12,
    uiUpdateHz: 60,
    mergeStaticMeshes: true,
    maxMergeVertices: 450000,
    freezeStaticMaterials: true,
  }),
});

export function createPerformanceProfile(env = globalThis) {
  const nav = env.navigator || {};
  const uaMobile = nav.userAgentData && typeof nav.userAgentData.mobile === 'boolean'
    ? nav.userAgentData.mobile
    : /Android|iPhone|iPad|Mobile/i.test(nav.userAgent || '');
  const memory = Number(nav.deviceMemory || 0);
  const cores = Number(nav.hardwareConcurrency || 0);
  const narrow = Number(env.innerWidth || 0) > 0 && Number(env.innerWidth || 0) <= 900;
  const constrained = (memory > 0 && memory <= 4) || (cores > 0 && cores <= 4);

  const base = (uaMobile || narrow || constrained)
    ? PERFORMANCE_PROFILES.mobileBalanced
    : PERFORMANCE_PROFILES.desktopHigh;

  // Kopieer zodat runtime-instrumentatie veilig eigen velden kan toevoegen.
  return { ...base, detectedMobile: !!uaMobile, deviceMemoryGB: memory || null, cores: cores || null };
}

export function calculateRenderResolution(profile, env = globalThis) {
  const dpr = Math.max(1, Number(env.devicePixelRatio || 1));
  const cssWidth = Math.max(1, Math.round(Number(env.innerWidth || 1)));
  const cssHeight = Math.max(1, Math.round(Number(env.innerHeight || 1)));
  const scaledRatio = dpr * clamp(Number(profile.renderScale || 1), 0.1, 1);
  const minRatio = Math.min(dpr, Number(profile.minPixelRatio || 1));
  const maxRatio = Math.max(minRatio, Math.min(dpr, Number(profile.maxPixelRatio || dpr)));
  const pixelRatio = clamp(scaledRatio, minRatio, maxRatio);

  return {
    dpr,
    cssWidth,
    cssHeight,
    pixelRatio,
    nativeFraction: pixelRatio / dpr,
    hardwareScaling: 1 / pixelRatio,
    renderWidth: Math.max(1, Math.round(cssWidth * pixelRatio)),
    renderHeight: Math.max(1, Math.round(cssHeight * pixelRatio)),
  };
}

export function applyRenderResolution(engine, profile, env = globalThis) {
  const result = calculateRenderResolution(profile, env);
  if (!engine || typeof engine.setHardwareScalingLevel !== 'function') {
    throw new Error('Ongeldige Babylon-engine voor renderresolutie');
  }
  engine.setHardwareScalingLevel(result.hardwareScaling);
  return result;
}
