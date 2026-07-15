// src/environment/skyRig.js

import { pushLog } from '../core/debug.js';

const DEFAULT_AZ = 146;
const DEFAULT_EL = 48;
const DEFAULT_INTENSITY = 3.2;

export class SkyRig {
    constructor(scene, sunLight = null) {
        this.scene = scene;
        this.sunLight = sunLight;
        this.oceanMat = null;

        this.azDeg = DEFAULT_AZ;
        this.elDeg = DEFAULT_EL;
        this.intensity = DEFAULT_INTENSITY;
        this.toSun = null;

        this.sunOn = true;
        this.dome = null;
        this.domeMat = null;
    }

    async build() {
        this._ensureDome();
        pushLog('SKY', 'HDR verwijderd. Atmosferische scattering (km-geschaald) actief.', false);
    }

    applySky(oceanRig) {
        this.oceanMat = (oceanRig && oceanRig.mat) ? oceanRig.mat : null;
        this.setSun(this.azDeg, this.elDeg, this.intensity);
        this.setSunEnabled(this.sunOn);
        if (this.oceanMat) this.oceanMat.setFloat('uSkyMode', 1);
        pushLog('SKY', this.oceanMat ? 'SkyRig gekoppeld aan oceaan' : 'SkyRig zonder oceaan', !this.oceanMat);
    }

    setSunEnabled(on) {
        this.sunOn = !!on;
        if (this.sunLight) {
            if (!this.sunOn) {
                this._liBefore = this.sunLight.intensity;
                this.sunLight.intensity = 0;
            } else {
                this.sunLight.intensity = (this._liBefore && this._liBefore > 0) ? this._liBefore : 3.0;
            }
        }
        if (this.dome) this.dome.setEnabled(this.sunOn);
        pushLog('SKY', 'zon (licht + glinstering) ' + (this.sunOn ? 'aan' : 'uit'), false);
        return this;
    }

    setLightIntensity(v) {
        if (this.sunLight) this.sunLight.intensity = v;
        const now = performance.now();
        if (!this._lastLiLog || (now - this._lastLiLog) > 500) {   
            this._lastLiLog = now;
            pushLog('SKY', 'zonlicht (directional) intensiteit ' + Number(v).toFixed(2), false);
        }
        return this;
    }

    setSun(azDeg = this.azDeg, elDeg = this.elDeg, intensity = this.intensity) {
        this.azDeg = azDeg; this.elDeg = elDeg; this.intensity = intensity;
        const _now = performance.now();
        const _mayLog = !this._lastSunLog || (_now - this._lastSunLog) > 500;
        if (_mayLog) this._lastSunLog = _now;

        const az = azDeg * Math.PI / 180;
        const el = elDeg * Math.PI / 180;
        const ce = Math.cos(el);
        const toSun = new BABYLON.Vector3(ce * Math.sin(az), Math.sin(el), ce * Math.cos(az)).normalize();
        this.toSun = toSun;

        if (this.sunLight) {
            this.sunLight.direction.copyFrom(toSun).scaleInPlace(-1);
        }

        if (this.oceanMat) {
            this.oceanMat.setVector3('uSunDir', toSun);
            this.oceanMat.setFloat('uSunIntensity', intensity);
        }
        if (this.domeMat) {
            this.domeMat.setVector3('uSunDir', toSun);
            this.domeMat.setFloat('uSunIntensity', intensity);
            this.domeMat.setVector3('uCamPos', this.scene.activeCamera ? this.scene.activeCamera.globalPosition : BABYLON.Vector3.Zero());
        }

        if (_mayLog) pushLog('SKY', `zon az=${azDeg.toFixed(1)} hoogte=${elDeg.toFixed(1)} intensiteit=${intensity.toFixed(2)}`, false);
        return this;
    }

    getSun() {
        return {
            azimut: +this.azDeg.toFixed(2), hoogte: +this.elDeg.toFixed(2), intensiteit: +this.intensity.toFixed(2),
            richtingNaarZon: this.toSun ? { x: +this.toSun.x.toFixed(4), y: +this.toSun.y.toFixed(4), z: +this.toSun.z.toFixed(4) } : null,
            lichtIntensiteit: this.sunLight ? +this.sunLight.intensity.toFixed(2) : null,
            lucht: 'atmosfeer',
        };
    }

    _ensureDome() {
        if (this.dome) return;

        BABYLON.Effect.ShadersStore['atmosSkyVertexShader'] = `
            precision highp float;
            attribute vec3 position;
            uniform mat4 world;
            uniform mat4 worldViewProjection;
            varying vec3 vWorldPos;
            
            void main() {
                vec4 p = vec4(position, 1.0);
                vWorldPos = (world * p).xyz;
                gl_Position = worldViewProjection * p;
            }
        `;

        BABYLON.Effect.ShadersStore['atmosSkyFragmentShader'] = `
            precision highp float;
            varying vec3 vWorldPos;
            uniform vec3 uSunDir;
            uniform float uSunIntensity;
            uniform vec3 uCamPos;

            #define STEPS 10
            #define STEPS_LIGHT 4

            vec2 rsi(vec3 r0, vec3 rd, float sr) {
                float b = dot(r0, rd);
                float c = dot(r0, r0) - sr * sr;
                float d = b * b - c;
                if (d < 0.0) return vec2(-1.0);
                return vec2(-b - sqrt(d), -b + sqrt(d));
            }

            void main() {
                vec3 dir = normalize(vWorldPos - uCamPos);
                vec3 sunDir = normalize(uSunDir);
                
                float rPlanet = 6371.0; 
                float rAtmo = 6471.0;
                vec3 origin = vec3(0.0, rPlanet + 0.15, 0.0); 

                vec2 p = rsi(origin, dir, rAtmo);
                if (p.y < 0.0) {
                    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
                    return;
                }
                
                float dMax = p.y;
                vec2 pPlanet = rsi(origin, dir, rPlanet);
                if (pPlanet.x > 0.0) dMax = min(dMax, pPlanet.x);

                float rayLen = dMax / float(STEPS);
                float t = 0.0;

                vec3 betaR = vec3(5.5e-3, 13.0e-3, 22.4e-3);
                vec3 betaM = vec3(21.0e-3);
                float hR = 7.994; 
                float hM = 1.200; 

                float depthR = 0.0;
                float depthM = 0.0;
                vec3 colorR = vec3(0.0);
                vec3 colorM = vec3(0.0);

                for (int i = 0; i < STEPS; i++) {
                    vec3 pos = origin + dir * (t + rayLen * 0.5);
                    float height = length(pos) - rPlanet;

                    float hR_d = exp(-height / hR) * rayLen;
                    float hM_d = exp(-height / hM) * rayLen;
                    depthR += hR_d;
                    depthM += hM_d;

                    float dLight = rsi(pos, sunDir, rAtmo).y;
                    float rayLenLight = dLight / float(STEPS_LIGHT);
                    float tLight = 0.0;
                    float depthRLight = 0.0;
                    float depthMLight = 0.0;
                    bool shadow = false;

                    for (int j = 0; j < STEPS_LIGHT; j++) {
                        vec3 posLight = pos + sunDir * (tLight + rayLenLight * 0.5);
                        float heightLight = length(posLight) - rPlanet;
                        if (heightLight < 0.0) { shadow = true; break; }
                        depthRLight += exp(-heightLight / hR) * rayLenLight;
                        depthMLight += exp(-heightLight / hM) * rayLenLight;
                        tLight += rayLenLight;
                    }

                    if (!shadow) {
                        vec3 tau = betaR * (depthR + depthRLight) + betaM * 1.1 * (depthM + depthMLight);
                        vec3 attenuation = exp(-tau);
                        colorR += attenuation * hR_d;
                        colorM += attenuation * hM_d;
                    }
                    t += rayLen;
                }

                float mu = dot(dir, sunDir);
                float phaseR = 0.0596831 * (1.0 + mu * mu);
                
                float g = 0.985;
                float phaseM = 0.1193662 * (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5);

                float sunDisk = smoothstep(0.9998, 0.99995, mu);
                phaseM += sunDisk * 25.0;

                // M4.6: Zon vermenigvuldiger fors verhoogd (* 8.0) omdat we de basis 
                // hebben verlaagd om het schip niet uit te laten branden. 
                vec3 sunIntensity = vec3(uSunIntensity * 8.0); 
                vec3 finalColor = (colorR * betaR * phaseR + colorM * betaM * phaseM) * sunIntensity;

                float horizonBlend = exp(-max(0.0, dir.y) * 15.0);
                finalColor += vec3(0.05, 0.08, 0.12) * horizonBlend * (uSunIntensity * 0.5);

                // M5.2: filmische compressie. Zonder tonemap clipte alles boven 1.0 hard naar
                // wit; de brede Mie-halo (g 0.985) keer intensiteit keer 8 satureerde daardoor
                // een enorm deel van de lucht tot een witte vlek. De exponentiele curve
                // comprimeert die piek tot een compacte zon met een natuurlijk uitlopend
                // verloop en laat de middentonen van de lucht vrijwel ongemoeid. De
                // zonneschijf-boost is tegelijk gehalveerd (50 naar 25), die hoeft niet meer
                // tegen het clippen op te boksen.
                finalColor = vec3(1.0) - exp(-finalColor * 1.15);

                gl_FragColor = vec4(finalColor, 1.0);
            }
        `;

        const dome = BABYLON.MeshBuilder.CreateBox('zbSkyDome', { size: 20000 }, this.scene);
        const m = new BABYLON.ShaderMaterial('zbProcSky', this.scene, 'atmosSky', {
            attributes: ['position'],
            uniforms: ['worldViewProjection', 'world', 'uSunDir', 'uSunIntensity', 'uCamPos'],
        });
        
        m.backFaceCulling = false;
        m.disableDepthWrite = true;
        dome.material = m;
        dome.infiniteDistance = true;
        dome.applyFog = false;
        dome.isPickable = false;
        dome.renderingGroupId = 0;
        
        if (this.toSun) {
            m.setVector3('uSunDir', this.toSun);
            m.setFloat('uSunIntensity', this.intensity);
        }
        m.setVector3('uCamPos', this.scene.activeCamera ? this.scene.activeCamera.globalPosition : BABYLON.Vector3.Zero());
        
        dome.setEnabled(true);
        this.dome = dome; this.domeMat = m;
    }

    setSkyMode(mode) {
        pushLog('SKY', 'setSkyMode genegeerd; atmosfeer is standaard.', false);
        return this;
    }

    update(camPos) {
        if (this.domeMat) {
            this.domeMat.setVector3('uCamPos', camPos);
        }
    }

    dispose() {
        if (this.dome) { this.dome.dispose(); this.dome = null; }
        if (this.domeMat) { this.domeMat.dispose(); this.domeMat = null; }
        pushLog('SKY', 'SkyRig resources opgeschoond', false);
    }
}
