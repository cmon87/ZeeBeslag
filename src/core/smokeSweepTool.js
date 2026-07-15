// src/core/smokeSweepTool.js
//
// M5.8 - Rook Sweep: het zusje van de Sun Sweep, gericht op de rookkolommen.
//
// Erft de complete machinerie van SunSweepTool (simulatie pauzeren, instrumentatie-pauze,
// GPU-frametijdmeting, tegelcapture met directe-canvas fallback, herstel in finally) en
// definieert alleen een eigen matrix:
//
//   kolommen  dekking (aantal kaarten per kolom): 8, 12, 18, 26
//   rijen     karakterprofielen: Grijs brand, Zwaar breed, Olie mega-stijl
//
// Per tegel wordt EEN voorverwarmde testkolom op zee voor de camera gezet (900 m, vaste
// hoogte 360 m zodat elke tegel identiek kadert), gemeten, vastgelegd en weer verwijderd
// via smokeCards.removeColumn. De bestaande slagveldrook blijft op de achtergrond staan;
// dat is juist bruikbare context. Oplevering: een 4x3 collage-JPEG met badges (profiel,
// dekking, alpha, tint, kaartaantal, GPU- en frametijd) plus een JSON-uitdraai met exact
// dezelfde waarden per tegel.

import { SunSweepTool } from './sunSweepTool.js';

export class SmokeSweepTool extends SunSweepTool {
  constructor(deps) {
    super(deps);
    // M5.9: smokeCards mag ook een functie zijn die de referentie pas bij run() oplevert.
    // Nodig omdat AtlasFX in main.js pas binnen initGame() ontstaat, na de constructie van
    // deze sweep; een directe referentie was op dat moment altijd null.
    this.smoke = deps.smokeCards || null;
  }

  _smoke() { return (typeof this.smoke === 'function') ? this.smoke() : this.smoke; }

  get dekkingen() { return [8, 12, 18, 26]; }

  get profielen() {
    return [
      { label: 'Grijs brand',     tintSet: 'grijs', breedte0: 0.32, breedte1: 0.62,
        alpha: 0.93, lifeMult: 1.0,  leanMult: 1.0, topWiden: 0,   fadeTop: 0.70, jitter: 0.04 },
      { label: 'Zwaar breed',     tintSet: 'grijs', breedte0: 0.34, breedte1: 0.70,
        alpha: 0.96, lifeMult: 1.25, leanMult: 1.1, topWiden: 0,   fadeTop: 0.70, jitter: 0.035 },
      { label: 'Olie mega-stijl', tintSet: 'olie',  breedte0: 0.26, breedte1: 0.44,
        alpha: 0.97, lifeMult: 3.5,  leanMult: 0.8, topWiden: 1.4, fadeTop: 0.86, jitter: 0.02 },
    ];
  }

  async run(opties = {}) {
    if (this._bezig) {
      this.pushLog('DIAG', 'Rook Sweep draait al, tweede aanroep genegeerd.', true);
      return null;
    }
    const smoke = this._smoke();
    if (!this.engine || !this.scene || !this.cam || !smoke) {
      this.pushLog('DIAG', 'Rook Sweep fout: mist componenten (engine/scene/cam/smokeCards).', true);
      return null;
    }

    const dekkingen = opties.dekkingen || this.dekkingen;
    const profielen = opties.profielen || this.profielen;
    const hoogte = opties.hoogte ?? 360;
    const settleFrames = opties.settleFrames != null ? opties.settleFrames : 2;
    const sampleFrames = opties.sampleFrames != null ? opties.sampleFrames : 4;
    this._captureModus = opties.captureModus || 'direct';
    this._bezig = true;

    const prevTime = this.matchDirector ? this.matchDirector.timeScale : null;
    const resultaten = [];

    try {
      if (this.matchDirector) this.matchDirector.setTimeScale(0);
      this._pauzeerInstrumentatie();
      const gpuTeller = this._activeerGpuTeller();

      // Testpositie: 900 m voor de camera op zeeniveau. Vaste plek en hoogte per run, dus
      // elke tegel kadert identiek en verschillen komen puur uit de profielparameters.
      const fwd = this.cam.getDirection(BABYLON.Axis.Z);
      const cp = this.cam.globalPosition || this.cam.position;
      const testPos = new BABYLON.Vector3(cp.x + fwd.x * 900, 0, cp.z + fwd.z * 900);

      const cols = dekkingen.length;
      const rows = profielen.length;
      const w = this.engine.getRenderWidth();
      const h = this.engine.getRenderHeight();
      const canvas = document.createElement('canvas');
      canvas.width = w * cols;
      canvas.height = h * rows;
      const ctx = canvas.getContext('2d');

      this.pushLog('DIAG', `Rook Sweep gestart (${cols}x${rows} tegels, capture=${this._captureModus}, gpu-meting=${gpuTeller ? 'aan' : 'niet beschikbaar'}).`, false);
      const t0 = performance.now();

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const prof = profielen[r];
          const dekking = dekkingen[c];

          const kolom = smoke.spawnColumn(testPos, hoogte, 99999, { ...prof, dekking });

          await this._wachtFrames(settleFrames);
          const gpuSamples = [], cpuSamples = [];
          let vorigeT = performance.now();
          await this._wachtFrames(sampleFrames, () => {
            const nu = performance.now();
            cpuSamples.push(nu - vorigeT);
            vorigeT = nu;
            if (gpuTeller) { const ns = gpuTeller.current; if (ns > 0) gpuSamples.push(ns / 1e6); }
          });
          const gpuMs = gpuSamples.length ? gpuSamples.reduce((a, b) => a + b, 0) / gpuSamples.length : null;
          const cpuMs = cpuSamples.length ? cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length : null;

          const cx = c * w, cy = r * h;
          await this._pakTegel(ctx, cx, cy, w, h);
          this._tekenRookBadge(ctx, cx, cy, { prof, dekking, hoogte, gpuMs, cpuMs });

          smoke.removeColumn(kolom);
          await this._wachtFrames(1);   // 1 frame zodat de opgeruimde kaarten echt weg zijn

          resultaten.push({
            profiel: prof.label, dekking, hoogte,
            tintSet: prof.tintSet, alpha: prof.alpha,
            breedte0: prof.breedte0, breedte1: prof.breedte1,
            lifeMult: prof.lifeMult, leanMult: prof.leanMult,
            topWiden: prof.topWiden, fadeTop: prof.fadeTop, jitter: prof.jitter,
            gpuMs: gpuMs != null ? +gpuMs.toFixed(2) : null,
            cpuMs: cpuMs != null ? +cpuMs.toFixed(2) : null,
          });
          this.pushLog('DIAG', `tegel ${r},${c} ${prof.label} dekking=${dekking}: gpu=${gpuMs != null ? gpuMs.toFixed(2) + 'ms' : 'n.b.'} cpu=${cpuMs != null ? cpuMs.toFixed(1) + 'ms' : 'n.b.'}`, false);
        }
      }

      const link = document.createElement('a');
      link.href = canvas.toDataURL('image/jpeg', 0.85);
      link.download = `zeebeslag_rook_sweep_${Date.now()}.jpg`;
      link.click();
      this._downloadJson('zeebeslag_rook_sweep', resultaten);

      this.laatsteResultaten = resultaten;
      const totaalS = ((performance.now() - t0) / 1000).toFixed(1);
      this.pushLog('DIAG', `Rook Sweep collage en JSON-uitdraai gedownload (${totaalS}s).`, false);
    } catch (err) {
      this.pushLog('DIAG', 'Rook Sweep fout: ' + (err && err.message || err), true);
    } finally {
      if (this.matchDirector && prevTime != null) this.matchDirector.setTimeScale(prevTime);
      this._hervatInstrumentatie();
      this._ruimGpuTellerOp();
      this._bezig = false;
    }
    return resultaten;
  }

  _tekenRookBadge(ctx, cx, cy, { prof, dekking, hoogte, gpuMs, cpuMs }) {
    ctx.fillStyle = 'rgba(10, 15, 25, 0.8)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(cx + 20, cy + 20, 440, 168, 8);
    else ctx.rect(cx + 20, cy + 20, 440, 168);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px monospace';
    ctx.fillText(prof.label, cx + 40, cy + 55);

    ctx.font = '20px monospace';
    ctx.fillStyle = '#f0c674';
    ctx.fillText(`Dekking: ${dekking} kaarten | ${hoogte} m`, cx + 40, cy + 85);

    ctx.font = '18px monospace';
    ctx.fillStyle = '#7ee8b0';
    ctx.fillText(`Alpha ${prof.alpha.toFixed(2)} | ${prof.tintSet} | breedte ${prof.breedte0}-${prof.breedte1}`, cx + 40, cy + 115);
    ctx.fillStyle = '#a8b2c8';
    ctx.fillText(`lifeMult ${prof.lifeMult} | topWiden ${prof.topWiden} | jitter ${prof.jitter}`, cx + 40, cy + 140);

    ctx.fillStyle = '#8ec9ff';
    const gpuTekst = gpuMs != null ? `${gpuMs.toFixed(2)} ms` : 'n.b.';
    const cpuTekst = cpuMs != null ? `${cpuMs.toFixed(1)} ms` : 'n.b.';
    ctx.fillText(`GPU: ${gpuTekst} | Frame: ${cpuTekst}`, cx + 40, cy + 165);
  }
}
