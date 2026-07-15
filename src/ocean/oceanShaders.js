// src/ocean/oceanShaders.js
//
// M0: mechanisch uit index.html v7 geextraheerd.
// M1.2: atmosferisch perspectief + ruwheid-LOD + getemperde schittering.
// M1.3: procedurele blauwe lucht met eigen zon, schakelbaar via uSkyMode (0=HDR, 1=blauw).
// M1.4: perf. Sin-vrije hash, en vroege uitstap in de verte die mid/near-cascade fetches en
//       de fbm-noise overslaat (zichtbaar niets, want de haze dekt de verte af).

BABYLON.Effect.ShadersStore["oceanCascadeVertexShader"] = `
  precision highp float;
  attribute vec3 position;
  attribute vec2 uv;
  uniform mat4 worldViewProjection;
  uniform mat4 world;
  uniform sampler2D uDisp0;
  uniform sampler2D uDisp1;
  uniform sampler2D uDisp2;
  uniform float uLen0;
  uniform float uLen1;
  uniform float uLen2;
  uniform float uDiskRadius;
  uniform vec3 uCamPos;
  uniform float uLodScale;

  // M1.33: luwte-demping. Het schip breekt de golven; in kanaal G van de wake-map staat de
  // luwte, en daar verlagen we de golfhoogte. Zo wordt het water vlak rond/achter het schip.
  uniform sampler2D uWakeMap;
  uniform vec2 uWakeCenter;
  uniform float uWakeSize;
  uniform float uWakeFlatten;

  varying vec3  vPosW;
  varying vec2  vUV0;
  varying vec2  vUV1;
  varying vec2  vUV2;
  varying vec4  vLodScales;
  varying float vDist;
  varying vec4  vClip;   // M1.29: clip-coords voor contactschuim (screen-UV + oog-diepte)

  void main(void){
    float dist = length(position.xz);
    float edge = clamp(dist/uDiskRadius,0.0,1.0);
    float taper= pow(max(0.0,1.0-edge*1.12),2.0);

    vec3 worldPos = (world * vec4(position,1.0)).xyz;
    vec3 viewVec  = uCamPos - worldPos;
    float viewDist= length(viewVec);

    float lod0 = min(uLodScale * uLen0 / viewDist, 1.0);
    float lod1 = min(uLodScale * uLen1 / viewDist, 1.0);
    float lod2 = min(uLodScale * uLen2 / viewDist, 1.0);

    vec2 uv0 = worldPos.xz / uLen0;
    vec2 uv1 = worldPos.xz / uLen1;
    vec2 uv2 = worldPos.xz / uLen2;

    vec3 disp = texture2D(uDisp0, uv0).xyz * lod0;
    float largeBias = disp.y;
    // M1.16 PERF: de mid en near cascade dragen voorbij hun fade vrijwel niets meer bij
    // (lod < 0.4%), maar de fetches werden wel gedaan. Met het gevechtsbereik op 840m is
    // het grootste deel van de zichtbare mesh zo'n verre vertex: twee texture-fetches per
    // vertex bespaard, beeld-identiek (afkap onder de f16-precisie van de cascade zelf).
    if (lod1 > 0.004) disp += texture2D(uDisp1, uv1).xyz * lod1;
    if (lod2 > 0.004) disp += texture2D(uDisp2, uv2).xyz * lod2;

    // M1.5: NaN-guard op de displacement zelf. Het fragment had al een vangnet, maar een NaN
    // hier poisont gl_Position en laat driehoeken verdwijnen (zwart-oceaan symptoom).
    if (disp.x != disp.x || disp.y != disp.y || disp.z != disp.z) disp = vec3(0.0);

    // Horizon-flikker: voorbij ~1800m loopt de ringstap op naar ~260m, grover dan de 250m-deining.
    // De silhouetlijn verspringt dan per frame. De haze dekt die band toch af (e-fold ~2200m),
    // dus faden we de displacement daar lineair uit tot vlak op ~3500m.
    // M1.33: golfdemping in de luwte. Sample kanaal G op de vlakke positie en verlaag de
    // golfhoogte waar het schip de golven breekt. Vlak water rond en achter het schip.
    if (uWakeFlatten > 0.001) {
      vec2 fuv = (worldPos.xz - uWakeCenter) / uWakeSize + 0.5;
      if (fuv.x > 0.0 && fuv.x < 1.0 && fuv.y > 0.0 && fuv.y < 1.0) {
        float shelter = textureLod(uWakeMap, fuv, 0.0).g;
        disp *= (1.0 - uWakeFlatten * smoothstep(0.15, 0.7, shelter));
      }
    }

    float farFade = 1.0 - clamp((viewDist - 1800.0) / 1700.0, 0.0, 1.0);
    disp *= taper * farFade;
    worldPos += disp;

    vPosW = worldPos;
    vUV0 = uv0; vUV1 = uv1; vUV2 = uv2;
    vLodScales = vec4(lod0, lod1, lod2, max(disp.y - largeBias*0.8, 0.0));
    vDist = dist;

    gl_Position = worldViewProjection * vec4(position + (disp), 1.0);
    vClip = gl_Position;
  }
`;

BABYLON.Effect.ShadersStore["oceanCascadeFragmentShader"] = `
  precision highp float;

  varying vec3  vPosW;
  varying vec2  vUV0;
  varying vec2  vUV1;
  varying vec2  vUV2;
  varying vec4  vLodScales;
  varying float vDist;
  varying vec4  vClip;

  uniform sampler2D uDeriv0;
  uniform sampler2D uDeriv1;
  uniform sampler2D uDeriv2;
  uniform sampler2D uTurb0;
  uniform sampler2D uTurb1;
  uniform sampler2D uTurb2;
  uniform samplerCube uEnvMap;
  uniform vec3  uCamPos;
  uniform vec3  uSunDir;
  uniform float uSunIntensity;    // 🔧 NIEUW: intensiteit van de zon
  uniform float uDiskRadius;
  uniform float uFoamBias0;
  uniform float uFoamBias1;
  uniform float uFoamBias2;
  uniform float uFoamScale;
  uniform float uTime;
  uniform float uDebugView;
  uniform float uSkyMode;   // 0 = HDR half-bewolkt, 1 = procedureel blauw

  // M1.29: contactschuim (OceanDemo-techniek). uDepthTex = scene-diepte (schip) uit de
  // DepthRenderer; vClip.w = eigen oppervlaktediepte. Schuim in de band waar het schip
  // het water raakt. uContactFoam 0 = uit.
  uniform sampler2D uDepthTex;
  uniform float uCamFar;
  uniform float uContactFoam;
  uniform float uContactWidth;

  // M1.31: kielzog-spoor. uWakeMap is een top-down schuimveld dat het schip in stempelt en
  // dat vervaagt. We mappen de wereldpositie naar de textuur en tellen het als schuim mee.
  uniform sampler2D uWakeMap;
  uniform vec2 uWakeCenter;
  uniform float uWakeSize;
  uniform float uWakeStrength;

  float fresnel(vec3 n, vec3 v){ return clamp(0.02+0.98*pow(1.0-max(dot(n,v),0.0),5.0),0.0,1.0); }
  // sin-vrije hash (Hoskins): goedkoper op mobiele GPU dan een sin() en betere spreiding
  float hash(vec2 p){
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float noise(vec2 p){
    vec2 i=floor(p);
    vec2 f=fract(p);
    vec2 u=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);
  }

  // Analytische heldere lucht: verloop horizon->zenit + zonneschijf met halo.
  vec3 proceduralSky(vec3 dir, vec3 sunDir){
    dir = normalize(dir);
    float h = clamp(dir.y, 0.0, 1.0);
    vec3 zenith  = vec3(0.09, 0.28, 0.65);   // diep blauw boven
    vec3 horizon = vec3(0.58, 0.74, 0.92);   // lichter/waziger bij de horizon
    vec3 sky = mix(horizon, zenith, pow(h, 0.42));
    float sd = max(dot(dir, normalize(sunDir)), 0.0);
    float disc = smoothstep(0.9993, 0.9997, sd);                                  // scherpe zonneschijf
    float halo = pow(sd, 350.0)*0.5 + pow(sd, 30.0)*0.18 + pow(sd, 6.0)*0.05;      // gloed eromheen
    sky += vec3(1.0, 0.93, 0.78) * (disc*10.0 + halo*2.2);
    sky = mix(sky, vec3(0.85,0.90,0.98), pow(sd,3.0)*0.12);                        // aerosol-waas rond de zon
    return sky;
  }

  // Reflectiekleur van de lucht, afhankelijk van de modus.
  vec3 skyReflect(vec3 dir, vec3 sunDir){
    if (uSkyMode > 0.5) return proceduralSky(dir, sunDir);
    return textureCube(uEnvMap, normalize(dir)).rgb * vec3(0.50,0.76,1.16) + vec3(0.03,0.07,0.14);
  }

  void main(void){
    if(vDist>uDiskRadius) discard;

    // render-debugview 5: knalroze, los van alle berekening. Test of de mesh überhaupt tekent.
    if (uDebugView > 4.5) { gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); return; }

    vec3 V = normalize(uCamPos - vPosW);
    vec3 L = uSunDir;
    float camD = length(uCamPos - vPosW);

    // Vroege uitstap: voorbij ~2600m dekt de haze de zee bijna volledig af. Daar slaan we de
    // mid/near-cascade fetches en de fbm-noise over. Debugviews willen wel altijd het volle beeld.
    bool wantDetail = (camD < 2600.0) || (uDebugView > 0.5);

    // ── Derivatives blenden over cascades -> slope -> normaal ──────────
    vec2 gx1 = dFdx(vUV1 * 128.0); vec2 gy1 = dFdy(vUV1 * 128.0);
    vec2 gx2 = dFdx(vUV2 * 128.0); vec2 gy2 = dFdy(vUV2 * 128.0);
    float lodD1 = clamp(0.5 * log2(max(dot(gx1,gx1), dot(gy1,gy1))), 0.0, 4.0);
    float lodD2 = clamp(0.5 * log2(max(dot(gx2,gx2), dot(gy2,gy2))), 0.0, 4.0);

    vec4 deriv = texture2D(uDeriv0, vUV0);
    float turb = texture2D(uTurb0, vUV0).x;
    if (wantDetail) {
      deriv += textureLod(uDeriv1, vUV1, lodD1) * vLodScales.y;
      if (vLodScales.z > 0.02) deriv += textureLod(uDeriv2, vUV2, lodD2) * vLodScales.z;
      turb  += textureLod(uTurb1, vUV1, lodD1).x + textureLod(uTurb2, vUV2, lodD2).x;
    }
    vec2 slope = vec2(deriv.x, deriv.y) / max(1.0 + deriv.zw, vec2(0.15));
    vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));

    // ── Foam uit turbulentie ────────────────────────────────────────────
    turb = (turb == turb) ? turb : 0.0;
    float jacobian = clamp((-turb + uFoamBias2) * uFoamScale, 0.0, 1.0);
    jacobian *= 1.0 - clamp((camD - 900.0) / 1800.0, 0.0, 1.0) * 0.75;

    // render-debugview: 1=normaal 2=derivatives 3=lucht-reflectie 4=foam/jacobian
    if (uDebugView > 0.5) {
      if (uDebugView < 1.5) { gl_FragColor = vec4(N*0.5+0.5, 1.0); return; }
      if (uDebugView < 2.5) { gl_FragColor = vec4(clamp(abs(deriv.xyz),0.0,1.0), 1.0); return; }
      if (uDebugView < 3.5) { gl_FragColor = vec4(skyReflect(reflect(-V,N), L), 1.0); return; }
      gl_FragColor = vec4(vec3(jacobian), 1.0); return;
    }

    // ── Ruwheid-LOD: ver water vlakt af ────────────────────────────────
    float distFade = clamp(camD / 3000.0, 0.0, 1.0);
    N = normalize(mix(N, vec3(0.0, 1.0, 0.0), distFade * 0.82));

    float fr = fresnel(N, V);
    vec3 R = reflect(-V, N);
    vec3 Rsky = R; Rsky.y = abs(Rsky.y);
    vec3 env = skyReflect(Rsky, L);

    // ── Zonneschittering (glinstering) ────────────────────────────────
    // 🔧 Gebruik uSunIntensity om de glinstering te schalen
    float specPow = mix(220.0, 55.0, distFade);
    float glit = pow(max(dot(R,L),0.0), specPow) * 9.0 * uSunIntensity;
    glit = min(glit, 4.0) * (1.0 - distFade * 0.55);
    env += vec3(1.0,0.95,0.82) * glit;

    // ── Subsurface scattering ──────────────────────────────────────────
    // 🔧 Ook hier uSunIntensity toepassen
    float sss = pow(max(dot(V,-L),0.0),3.0) * vLodScales.w * 2.4 * uSunIntensity;
    vec3 sssC = vec3(0.02,0.22,0.14) * sss;

    // ── Diepte-kleurverloop ────────────────────────────────────────────
    float depthT = clamp(0.5 - vPosW.y * 0.10, 0.0, 1.0);
    vec3 deepCol    = vec3(0.003, 0.016, 0.050);
    vec3 shallowCol = vec3(0.022, 0.115, 0.205);
    vec3 waterBody  = mix(shallowCol, deepCol, depthT);
    vec3 base = mix(waterBody, vec3(0.028,0.125,0.250), fr*0.5);
    vec3 color = mix(base, env, fr*0.58) + sssC;

    // ── Schuim ──────────────────────────────────────────────────────────
    float foamMask = 0.0;
    if (wantDetail && jacobian > 0.02) {
      float foamN = noise(vPosW.xz*0.08 + uTime*0.05) * noise(vPosW.xz*0.21 - uTime*0.03);
      foamMask = smoothstep(0.15, 0.55, foamN) * jacobian;
    }
    vec3 foamColor = vec3(0.95,0.98,1.00);

    // ── Contactschuim rond de romp ──────────────────────────────────────
    float contact = 0.0;
    if (uContactFoam > 0.001 && wantDetail) {
      vec2 sUV = vClip.xy / vClip.w * 0.5 + 0.5;
      float bg = textureLod(uDepthTex, sUV, 0.0).r * uCamFar;
      if (bg < uCamFar * 0.999) {
        float dd = max(0.0, bg - vClip.w);
        float bandF = 1.0 - smoothstep(0.0, uContactWidth, dd);
        float cf = noise(vPosW.xz*0.30 + uTime*0.5) * noise(vPosW.xz*0.12 - uTime*0.35);
        contact = uContactFoam * bandF * smoothstep(0.12, 0.62, cf + bandF*0.4);
      }
    }

    // ── Kielzog-spoor ──────────────────────────────────────────────────
    float wake = 0.0;
    if (uWakeStrength > 0.001) {
      vec2 wuv = (vPosW.xz - uWakeCenter) / uWakeSize + 0.5;
      if (wuv.x > 0.0 && wuv.x < 1.0 && wuv.y > 0.0 && wuv.y < 1.0) {
        float wv = textureLod(uWakeMap, wuv, 0.0).r;
        float wn = 0.55 + 0.45 * noise(vPosW.xz * 0.5 + uTime * 0.6);
        wake = uWakeStrength * smoothstep(0.16, 0.78, wv) * wn;
      }
    }

    color = mix(color, foamColor, clamp(jacobian*0.85 + foamMask*0.3 + contact + wake, 0.0, 1.0));

    // ── Atmosferisch perspectief ────────────────────────────────────────
    vec3 skyDir = normalize(vec3(-V.x, 0.02, -V.z));
    vec3 skyHorizon;
    if (uSkyMode > 0.5) {
      skyHorizon = proceduralSky(skyDir, L);
    } else {
      skyHorizon = textureCube(uEnvMap, skyDir).rgb * vec3(0.90,0.94,1.02) + vec3(0.01,0.02,0.03);
    }
    float haze = 1.0 - exp(-camD * (1.0/2200.0));
    haze = pow(clamp(haze,0.0,1.0), 1.3);
    float horizonBlend = clamp((camD - 3200.0) / 1500.0, 0.0, 1.0);
    color = mix(color, skyHorizon, max(haze * 0.92, horizonBlend));

    float alpha = 1.0 - smoothstep(uDiskRadius*0.80, uDiskRadius*0.98, vDist);
    if (!(color.x == color.x) || !(color.y == color.y) || !(color.z == color.z)) color = vec3(0.02, 0.06, 0.12);
    gl_FragColor = vec4(color, alpha);
  }
`;

// ── Skybox-shader voor de procedurele blauwe lucht ──────────────────────
BABYLON.Effect.ShadersStore["proceduralSkyVertexShader"] = `
  precision highp float;
  attribute vec3 position;
  uniform mat4 worldViewProjection;
  varying vec3 vDir;
  void main(void){
    vDir = position;
    vec4 clip = worldViewProjection * vec4(position, 1.0);
    gl_Position = clip.xyww;
  }
`;

BABYLON.Effect.ShadersStore["proceduralSkyFragmentShader"] = `
  precision highp float;
  varying vec3 vDir;
  uniform vec3 uSunDir;

  vec3 proceduralSky(vec3 dir, vec3 sunDir){
    dir = normalize(dir);
    float h = clamp(dir.y, 0.0, 1.0);
    vec3 zenith  = vec3(0.09, 0.28, 0.65);
    vec3 horizon = vec3(0.58, 0.74, 0.92);
    vec3 sky = mix(horizon, zenith, pow(h, 0.42));
    float sd = max(dot(dir, normalize(sunDir)), 0.0);
    float disc = smoothstep(0.9993, 0.9997, sd);
    float halo = pow(sd, 350.0)*0.5 + pow(sd, 30.0)*0.18 + pow(sd, 6.0)*0.05;
    sky += vec3(1.0, 0.93, 0.78) * (disc*10.0 + halo*2.2);
    sky = mix(sky, vec3(0.85,0.90,0.98), pow(sd,3.0)*0.12);
    return sky;
  }

  void main(void){
    gl_FragColor = vec4(proceduralSky(normalize(vDir), uSunDir), 1.0);
  }
`;