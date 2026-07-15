// src/ocean/oceanMaterial.js
// Definitieve versie – eigen zon‑uniforms en geen light‑inclusies.

import './oceanShaders.js';
import { createOceanMesh } from './oceanGeometry.js';

function makePlaceholderEnv(scene) {
  const face = new Uint8Array([15, 35, 65, 255]);
  const t = new BABYLON.RawCubeTexture(scene, [face, face, face, face, face, face],
    1, BABYLON.Constants.TEXTUREFORMAT_RGBA, BABYLON.Constants.TEXTURETYPE_UNSIGNED_BYTE,
    false, false, BABYLON.Constants.TEXTURE_NEAREST_SAMPLINGMODE);
  return t;
}

export function buildOcean(scene, engine, envTexture, quality = {}) {
  const DISK_RADIUS = quality.radius ?? 3000;
  const rings = quality.rings ?? 96;
  const segments = quality.segments ?? 256;
  const geoInfo = createOceanMesh(scene, { radius: DISK_RADIUS, rings, segments });
  
  const mat = new BABYLON.ShaderMaterial('oceanCascade', scene,
    { vertex: 'oceanCascade', fragment: 'oceanCascade' },
    {
      attributes: ['position', 'uv'],
      uniforms: [
        'worldViewProjection', 'world', 'uLen0', 'uLen1', 'uLen2', 'uDiskRadius', 'uCamPos',
        'uLodScale', 'uFoamBias0', 'uFoamBias1', 'uFoamBias2', 'uFoamScale',
        'uTime', 'uDebugView', 'uSunDir', 'uSunIntensity', 'uSkyMode',
        'uCamFar', 'uContactFoam', 'uContactWidth',
        'uWakeCenter', 'uWakeSize', 'uWakeStrength', 'uWakeFlatten'
      ],
      samplers: [
        'uDisp0', 'uDisp1', 'uDisp2', 'uDeriv0', 'uDeriv1', 'uDeriv2',
        'uTurb0', 'uTurb1', 'uTurb2', 'uEnvMap', 'uDepthTex', 'uWakeMap'
      ]
    }
  );
  
  mat.setFloat('uDiskRadius', DISK_RADIUS);
  mat.setFloat('uLodScale', 7.13);
  mat.setFloat('uFoamBias0', 0.84);
  mat.setFloat('uFoamBias1', 1.83);
  mat.setFloat('uFoamBias2', 2.72);
  mat.setFloat('uFoamScale', 2.4);
  mat.setFloat('uDebugView', 0);
  mat.setFloat('uSkyMode', 0);
  mat.setFloat('uSunIntensity', 3.2);   // initiële intensiteit
  mat.setVector3('uSunDir', new BABYLON.Vector3(0.555, 0.740, 0.379).normalize());

  const envPlaceholder = envTexture ? null : makePlaceholderEnv(scene);
  mat.setTexture('uEnvMap', envTexture || envPlaceholder);

  const dummyDepth = new BABYLON.RawTexture(new Float32Array([1,1,1,1]), 1, 1, BABYLON.Constants.TEXTUREFORMAT_RGBA, scene, false, false, BABYLON.Constants.TEXTURE_NEAREST_SAMPLINGMODE, BABYLON.Constants.TEXTURETYPE_FLOAT);
  mat.setTexture('uDepthTex', dummyDepth);
  mat.setFloat('uCamFar', 22000.0);
  mat.setFloat('uContactFoam', 0.0);
  mat.setFloat('uContactWidth', 6.0);

  const dummyWake = new BABYLON.RawTexture(new Uint8Array([0, 0]), 1, 1, BABYLON.Constants.TEXTUREFORMAT_RG, scene, false, false, BABYLON.Constants.TEXTURE_NEAREST_SAMPLINGMODE, BABYLON.Constants.TEXTURETYPE_UNSIGNED_BYTE);
  mat.setTexture('uWakeMap', dummyWake);
  mat.setVector2('uWakeCenter', BABYLON.Vector2.Zero());
  mat.setFloat('uWakeSize', 2000.0);
  mat.setFloat('uWakeStrength', 0.0);
  mat.setFloat('uWakeFlatten', 0.0);

  mat.needAlphaBlending = () => true;
  mat.alphaMode = BABYLON.Engine.ALPHA_PREMULTIPLIED_PORTERDUFF;
  mat.forceDepthWrite = false;
  mat.disableDepthWrite = false;

  geoInfo.mesh.material = mat;
  return { ocean: geoInfo.mesh, mat, geoInfo, envPlaceholder, quality: { rings, segments, radius: DISK_RADIUS } };
}