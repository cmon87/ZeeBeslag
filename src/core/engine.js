// src/core/engine.js
// Aangepast: geen DirectionalLight meer, alleen HemisphericLight.
// De oceaan gebruikt eigen zon‑uniforms (uSunDir, uSunIntensity).
// Het schip en eiland krijgen indirect licht via de HDR‑omgeving.

import { pushLog } from './log.js';

export const EXPECTED_BABYLON = '9.14.0';

export async function boot() {
  const canvas = document.getElementById('renderCanvas');
  let engine;

  try {
    const supported = await BABYLON.WebGPUEngine.IsSupportedAsync;
    if (!supported) throw new Error('WebGPU niet ondersteund door deze browser/device');
    engine = new BABYLON.WebGPUEngine(canvas, {
      antialias: false,
      adaptToDeviceRatio: false,
      powerPreference: 'high-performance',
      // M4.9: timestamp-query expliciet aanvragen bij device-creatie. De telemetrie van
      // 13-07 liet zien dat de Adreno 830 adapter de feature WEL levert, maar het device
      // alleen met core-features-and-limits werd aangemaakt; gpuFrameTimeCounter bleef
      // daardoor leeg (GPU: n.b. in de Sun Sweep). Babylon filtert requiredFeatures tegen
      // wat de adapter kan, dus op hardware zonder de feature faalt de init niet.
      deviceDescriptor: { requiredFeatures: ['timestamp-query'] }
    });
    await engine.initAsync();
    pushLog('ENGINE', 'WebGPUEngine actief', false);
  } catch (err) {
    pushLog('ENGINE', 'WebGPU init mislukt: ' + (err.message || err), true);
    pushLog('ENGINE', 'Val terug op WebGL2', true);
    engine = new BABYLON.Engine(canvas, true, {
      preserveDrawingBuffer: false, stencil: false,
      disableWebGL2Support: false, powerPreference: 'high-performance',
      adaptToDeviceRatio: false
    });
  }

  const ver = (BABYLON.Engine && BABYLON.Engine.Version) || '?';
  const drift = !String(ver).startsWith(EXPECTED_BABYLON);
  pushLog('ENGINE', `Babylon ${ver}` + (drift ? ` [AFWIJKEND, verwacht ${EXPECTED_BABYLON}: versiedrift, pin/vendor controleren!]` : ' (gepind, OK)'), drift);

  // WebGPU‑validatiefouten afvangen
  try {
    const dev = engine._device;
    if (dev && dev.addEventListener) {
      dev.addEventListener('uncapturederror', ev => {
        const msg = (ev && ev.error && ev.error.message) || String(ev && ev.error || ev);
        pushLog('WEBGPU', 'uncapturederror: ' + msg, true);
      });
    }
  } catch (_) {}

  try { if ('enableGPUTimingMeasurements' in engine) engine.enableGPUTimingMeasurements = true; } catch (_) {}

  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.05, 0.08, 0.12, 1);

  const cam = new BABYLON.UniversalCamera('cam', new BABYLON.Vector3(0, 55, -120), scene);
  cam.setTarget(new BABYLON.Vector3(0, 40, 0));
  cam.minZ = 1.0; cam.maxZ = 22000.0;

  // ── M4.7: Fysiek correcte lichtbalans ──────────────────────────────────────────────
  const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.5, -0.6, -0.6), scene);
  sun.intensity = 3.0;
  sun.diffuse = new BABYLON.Color3(1.00, 0.96, 0.88);
  sun.specular = new BABYLON.Color3(1.00, 0.97, 0.90);

  // M4.7: HemisphericLight iets gelift naar 0.45 om de diepste black crush in te vullen
  // nadat we het PBR albedo gedrag hebben opgelost.
  const amb = new BABYLON.HemisphericLight('amb', new BABYLON.Vector3(0, 1, 0), scene);
  amb.intensity = 0.45;
  amb.diffuse = new BABYLON.Color3(0.40, 0.60, 0.90);
  amb.groundColor = new BABYLON.Color3(0.10, 0.15, 0.20);

  const isWebGPU = engine instanceof BABYLON.WebGPUEngine;
  pushLog('ENGINE', `Backend: ${isWebGPU ? 'WebGPU' : 'WebGL2 (fallback)'} (className=${engine.getClassName ? engine.getClassName() : '?'})`, false);

  return { engine, scene, cam, sun, amb, isWebGPU };
}
