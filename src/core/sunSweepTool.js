// src/core/sunSweepTool.js
//
// M4.8 - Sun Sweep Tool als losse klasse, geknipt uit main.js.
//
// Genereert een matrix-collage van rendertegels over meerdere zonnestanden (kolommen) en
// lichtrichtingen relatief aan de camera (rijen). Bedoeld om de Rayleigh/Mie sky en de
// PBR-lichtbalans in 1 oogopslag te kalibreren.
//
// Nieuw in M4.8 ten opzichte van de inline versie:
//  1. GPU-rendertijd per tegel in de badge. Leest engine.gpuFrameTimeCounter (nanoseconden,
//     timestamp-query). Werkt alleen als de browser/driver timestamp-query toestaat; zo niet
//     dan toont de badge 'n.b.' en meten we alleen CPU-frametijd via performance.now().
//  2. SceneInstrumentation wordt tijdens de sweep gepauzeerd. De capture-vlaggen wrappen
//     scenefuncties met begin/endMonitoring en kosten CPU per geforceerd frame. Uitzetten
//     raakt het renderresultaat niet, instrumentatie observeert alleen. Na afloop zetten we
//     de oorspronkelijke vlaggen terug.
//  3. Snellere capture: standaard tekenen we het rendercanvas direct in de collage
//     (drawImage van het canvas-element). Dat slaat de JPEG/PNG encode plus Image decode
//     van CreateScreenshotAsync over, op mobiel de grootste tijdvreter. De scene staat na
//     de settle-frames stil, dus dat de browser het laatst gepresenteerde frame levert is
//     geen probleem. Geeft de directe route een leeg beeld (Adreno kan verrassen), dan
//     vallen we voor de rest van de run automatisch terug op de screenshot-route.
//  4. Herstel van de vorige staat (timeScale, zon, ambient) zit nu in een finally-blok,
//     dus ook na een fout halverwege komt de simulatie weer tot leven.
//
// Gebruik:
//   const sweep = new SunSweepTool({ engine, scene, cam, skyRig, sun, amb, matchDirector, pushLog });
//   await sweep.run();                          // standaard 4x3 matrix
//   await sweep.run({ tegelSchaal: 0.5 });      // halve resolutie per tegel, kleinere JPEG
//   await sweep.run({ captureModus: 'screenshot' }); // forceer de oude, tragere route

export class SunSweepTool {
  constructor({ engine, scene, cam, skyRig, sun, amb, matchDirector, pushLog }) {
    this.engine = engine;
    this.scene = scene;
    this.cam = cam;
    this.skyRig = skyRig;
    this.sun = sun;
    this.amb = amb;
    this.matchDirector = matchDirector;
    this.pushLog = pushLog || (() => {});

    this._bezig = false;
    this.laatsteResultaten = null;  // M4.9: leesbaar voor de telemetrie-export
    this._instState = null;      // bewaarde SceneInstrumentation vlaggen
    this._tijdelijkeInstr = null; // EngineInstrumentation voor de WebGL fallback
  }

  // M4.7 kalibratiewaarden: ambient gelift om black crush te dempen na de PBR albedo fix.
  get standaardKolommen() {
    return [
      { el: 60, sun: 3.0, amb: 0.45, label: 'Middag (60\u00b0)' },
      { el: 25, sun: 2.4, amb: 0.35, label: 'Namiddag (25\u00b0)' },
      { el: 5,  sun: 0.8, amb: 0.18, label: 'Gouden Uur (5\u00b0)' },
      { el: -1, sun: 0.0, amb: 0.05, label: 'Schemering (-1\u00b0)' }
    ];
  }

  get standaardRijen() {
    return [
      { azOffset: 180, label: 'Frontaal (Zon in rug)' },
      { azOffset: 90,  label: 'Strijklicht (Zijkant)' },
      { azOffset: 0,   label: 'Tegenlicht (Zon in beeld)' }
    ];
  }

  async run(opties = {}) {
    if (this._bezig) {
      this.pushLog('DIAG', 'Sun Sweep draait al, tweede aanroep genegeerd.', true);
      return null;
    }
    if (!this.engine || !this.scene || !this.cam || !this.skyRig || !this.sun || !this.amb) {
      this.pushLog('DIAG', 'Sun Sweep fout: mist grafische componenten.', true);
      return null;
    }

    const colsData = opties.kolommen || this.standaardKolommen;
    const rowsData = opties.rijen || this.standaardRijen;
    const tegelSchaal = opties.tegelSchaal || 1;
    const settleFrames = opties.settleFrames != null ? opties.settleFrames : 2;
    const sampleFrames = opties.sampleFrames != null ? opties.sampleFrames : 4;
    this._captureModus = opties.captureModus || 'direct';

    this._bezig = true;

    // M5.2: de rig heeft TWEE zonintensiteiten: skyRig.intensity voedt de atmosfeer-shader
    // (uSunIntensity op dome en oceaan) en sun.intensity is de DirectionalLight. De oude code
    // ving alleen sun.intensity en herstelde die in BEIDE kanalen; na elke sweep stond de
    // shader-zon daardoor op de lichtwaarde (typisch 3.0 in plaats van ~1.2) en was de lucht
    // ineens fors feller. Nu wordt elk kanaal apart bewaard en apart teruggezet.
    const prevState = {
      timeScale: this.matchDirector ? this.matchDirector.timeScale : null,
      az: this.skyRig.azDeg, el: this.skyRig.elDeg,
      skyInt: this.skyRig.intensity,
      lightInt: this.sun.intensity,
      ambInt: this.amb.intensity
    };

    const resultaten = [];

    try {
      if (this.matchDirector) this.matchDirector.setTimeScale(0);
      this._pauzeerInstrumentatie();
      const gpuTeller = this._activeerGpuTeller();

      const camDir = this.cam.getDirection(BABYLON.Axis.Z);
      let camAz = Math.atan2(camDir.x, camDir.z) * (180 / Math.PI);
      if (camAz < 0) camAz += 360;

      const cols = colsData.length;
      const rows = rowsData.length;
      const bronW = this.engine.getRenderWidth();
      const bronH = this.engine.getRenderHeight();
      const w = Math.round(bronW * tegelSchaal);
      const h = Math.round(bronH * tegelSchaal);

      const canvas = document.createElement('canvas');
      canvas.width = w * cols;
      canvas.height = h * rows;
      const ctx = canvas.getContext('2d');

      this.pushLog('DIAG', `Matrix Sweep gestart (${cols}x${rows} tegels, capture=${this._captureModus}, gpu-meting=${gpuTeller ? 'aan' : 'niet beschikbaar'}).`, false);
      const t0 = performance.now();

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const col = colsData[c];
          const row = rowsData[r];
          const targetAz = (camAz + row.azOffset) % 360;

          this.skyRig.setSun(targetAz, col.el, col.sun);
          this.amb.intensity = col.amb;
          if (this.skyRig.setLightIntensity) this.skyRig.setLightIntensity(col.sun);

          // Eerst laten inklinken (uniforms, timestamp-latency), dan meten. De timestamp
          // resultaten komen 1 tot 2 frames later terug, dus we middelen over sampleFrames.
          await this._wachtFrames(settleFrames);

          const gpuSamples = [];
          const cpuSamples = [];
          let vorigeT = performance.now();
          await this._wachtFrames(sampleFrames, () => {
            const nu = performance.now();
            cpuSamples.push(nu - vorigeT);
            vorigeT = nu;
            if (gpuTeller) {
              const ns = gpuTeller.current;
              if (ns > 0) gpuSamples.push(ns / 1e6);
            }
          });

          const gpuMs = gpuSamples.length ? gpuSamples.reduce((a, b) => a + b, 0) / gpuSamples.length : null;
          const cpuMs = cpuSamples.length ? cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length : null;

          const cx = c * w;
          const cy = r * h;
          const gebruikteModus = await this._pakTegel(ctx, cx, cy, w, h);

          this._tekenBadge(ctx, cx, cy, { row, col, targetAz, gpuMs, cpuMs });

          resultaten.push({
            rij: row.label, kolom: col.label, azimut: Math.round(targetAz),
            elevatie: col.el, zon: col.sun, ambient: col.amb,
            gpuMs: gpuMs != null ? +gpuMs.toFixed(2) : null,
            cpuMs: cpuMs != null ? +cpuMs.toFixed(2) : null,
            capture: gebruikteModus
          });
          this.pushLog('DIAG', `tegel ${r},${c} ${col.label} / ${row.label}: gpu=${gpuMs != null ? gpuMs.toFixed(2) + 'ms' : 'n.b.'} cpu=${cpuMs != null ? cpuMs.toFixed(1) + 'ms' : 'n.b.'}`, false);
        }
      }

      const link = document.createElement('a');
      link.href = canvas.toDataURL('image/jpeg', 0.85);
      link.download = `zeebeslag_zon_sweep_${Date.now()}.jpg`;
      link.click();
      // M5.8: uitdraai met de corresponderende waarden naast de afbeelding. Chrome vraagt
      // eenmalig toestemming voor meerdere downloads; daarna komen jpg en json samen binnen.
      this._downloadJson('zeebeslag_zon_sweep', resultaten);

      this.laatsteResultaten = resultaten;
      const totaalS = ((performance.now() - t0) / 1000).toFixed(1);
      this.pushLog('DIAG', `Matrix Sweep collage gegenereerd en gedownload (${totaalS}s).`, false);
    } catch (err) {
      this.pushLog('DIAG', 'Sun Sweep fout: ' + (err && err.message || err), true);
    } finally {
      // Staat altijd herstellen, ook na een fout halverwege.
      try {
        this.skyRig.setSun(prevState.az, prevState.el, prevState.skyInt);
        this.amb.intensity = prevState.ambInt;
        if (this.skyRig.setLightIntensity) this.skyRig.setLightIntensity(prevState.lightInt);
        if (this.matchDirector && prevState.timeScale != null) this.matchDirector.setTimeScale(prevState.timeScale);
      } catch (_) {}
      this._hervatInstrumentatie();
      this._ruimGpuTellerOp();
      this._bezig = false;
    }

    return resultaten;
  }

  // M5.8: gedeelde JSON-uitdraai voor alle sweeps in de familie.
  _downloadJson(basis, data) {
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${basis}_${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (_) {}
  }

  // ── frames forceren ────────────────────────────────────────────────────────
  // Via onAfterRenderObservable, niet via een eigen renderaanroep. Zo blijft de normale
  // renderloop de baas over de WebGPU submits en vermijden we buffer-contention crashes
  // op de Adreno 830.
  _wachtFrames(n, perFrame) {
    if (n <= 0) return Promise.resolve();
    return new Promise(resolve => {
      let frames = 0;
      const obs = this.scene.onAfterRenderObservable.add(() => {
        frames++;
        if (perFrame) { try { perFrame(frames); } catch (_) {} }
        if (frames >= n) {
          this.scene.onAfterRenderObservable.remove(obs);
          resolve();
        }
      });
    });
  }

  // ── GPU-tijd ───────────────────────────────────────────────────────────────
  _activeerGpuTeller() {
    const e = this.engine;
    try {
      // WebGPU: engine.js zet enableGPUTimingMeasurements al aan bij boot. De teller
      // bestaat alleen als de driver timestamp-query levert.
      if (e && e.gpuFrameTimeCounter) return e.gpuFrameTimeCounter;
    } catch (_) {}
    try {
      // WebGL2 fallback: tijdelijke EngineInstrumentation met gpu-frametijd capture.
      if (BABYLON.EngineInstrumentation) {
        this._tijdelijkeInstr = new BABYLON.EngineInstrumentation(e);
        this._tijdelijkeInstr.captureGPUFrameTime = true;
        return this._tijdelijkeInstr.gpuFrameTimeCounter;
      }
    } catch (_) {}
    return null;
  }

  _ruimGpuTellerOp() {
    if (this._tijdelijkeInstr) {
      try { this._tijdelijkeInstr.dispose(); } catch (_) {}
      this._tijdelijkeInstr = null;
    }
  }

  // ── SceneInstrumentation pauzeren ──────────────────────────────────────────
  // debug.js maakt scene.instrumentation lazy aan voor het HUD-lint. De capture-vlaggen
  // kosten CPU per frame. We zetten ze uit voor de duur van de sweep en herstellen ze
  // exact zoals ze stonden. Pure observatie, dus het renderresultaat blijft identiek.
  _pauzeerInstrumentatie() {
    this._instState = null;
    const inst = this.scene.instrumentation;
    if (!inst) return;
    const vlaggen = [
      'captureActiveMeshesEvaluationTime', 'captureRenderTargetsRenderTime',
      'captureFrameTime', 'captureInterFrameTime', 'captureParticlesRenderTime',
      'captureSpritesRenderTime', 'capturePhysicsTime', 'captureAnimationsTime',
      'captureCameraRenderTime', 'captureRenderTime'
    ];
    this._instState = {};
    for (const v of vlaggen) {
      try {
        if (v in inst) { this._instState[v] = inst[v]; inst[v] = false; }
      } catch (_) {}
    }
  }

  _hervatInstrumentatie() {
    const inst = this.scene.instrumentation;
    if (!inst || !this._instState) { this._instState = null; return; }
    for (const [v, waarde] of Object.entries(this._instState)) {
      try { inst[v] = waarde; } catch (_) {}
    }
    this._instState = null;
  }

  // ── capture ────────────────────────────────────────────────────────────────
  async _pakTegel(ctx, cx, cy, w, h) {
    if (this._captureModus === 'direct') {
      try {
        const bron = this.engine.getRenderingCanvas();
        ctx.drawImage(bron, 0, 0, bron.width, bron.height, cx, cy, w, h);
        if (!this._tegelLeeg(ctx, cx, cy, w, h)) return 'direct';
      } catch (_) {}
      // Leeg of exception: voor de rest van deze run terug naar de bewezen route.
      this._captureModus = 'screenshot';
      this.pushLog('DIAG', 'Directe canvas-capture gaf leeg beeld, val terug op screenshot-route.', true);
    }
    const dataUrl = await BABYLON.Tools.CreateScreenshotAsync(this.engine, this.cam, { width: w, height: h });
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    ctx.drawImage(img, cx, cy, w, h);
    return 'screenshot';
  }

  // Kleine steekproef in het midden van de tegel. Een mislukte drawImage laat transparante
  // pixels achter (alpha 0). Zodra 1 pixel dekking heeft is de tegel echt.
  _tegelLeeg(ctx, cx, cy, w, h) {
    try {
      const px = ctx.getImageData(cx + Math.floor(w / 2), cy + Math.floor(h / 2), 8, 8).data;
      for (let i = 3; i < px.length; i += 4) {
        if (px[i] > 0) return false;
      }
      return true;
    } catch (_) {
      return false; // steekproef zelf faalt: geef de tegel het voordeel van de twijfel
    }
  }

  // ── badge ──────────────────────────────────────────────────────────────────
  _tekenBadge(ctx, cx, cy, { row, col, targetAz, gpuMs, cpuMs }) {
    ctx.fillStyle = 'rgba(10, 15, 25, 0.8)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(cx + 20, cy + 20, 420, 168, 8);
    else ctx.rect(cx + 20, cy + 20, 420, 168);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px monospace';
    ctx.fillText(`${row.label}`, cx + 40, cy + 55);

    ctx.font = '20px monospace';
    ctx.fillStyle = '#f0c674';
    ctx.fillText(col.label, cx + 40, cy + 85);

    ctx.font = '18px monospace';
    ctx.fillStyle = '#7ee8b0';
    ctx.fillText(`Zon: ${col.sun.toFixed(2)} | Hemi: ${col.amb.toFixed(2)}`, cx + 40, cy + 115);
    ctx.fillStyle = '#a8b2c8';
    ctx.fillText(`Abs. Azimut: ${Math.round(targetAz)}\u00b0`, cx + 40, cy + 140);

    // M4.8: meetregel. GPU is de timestamp-query van de engine, CPU de frame-interval.
    ctx.fillStyle = '#8ec9ff';
    const gpuTekst = gpuMs != null ? `${gpuMs.toFixed(2)} ms` : 'n.b.';
    const cpuTekst = cpuMs != null ? `${cpuMs.toFixed(1)} ms` : 'n.b.';
    ctx.fillText(`GPU: ${gpuTekst} | Frame: ${cpuTekst}`, cx + 40, cy + 165);
  }
}
