// M1.7: analytisch deiningsveld op de CPU.
// Doel: schepen en projectielen een goedkope, consistente waterhoogte geven ZONDER de
// GPU-displacement uit te lezen (readback stalt de pipeline en is op Adreno duur).
// Aanpak: drie sinuscomponenten waarvan golflengte en amplitude uit dezelfde JONSWAP-relaties
// komen als het FFT-spectrum (peakOmega-formule identiek aan wavesSettings.js), plus de
// diepwater-dispersierelatie omega = sqrt(g*k). De fase matcht de FFT niet exact (dat kan
// principieel niet zonder readback), maar frequentie, richting en schaal kloppen, dus het
// schip beweegt overtuigend mee op de grote deining.
// Buoyancy en projectiel-inslag gebruiken allebei DIT veld, dus die twee zijn per definitie
// consistent met elkaar (eis uit de opdracht).

export class SwellField {
  constructor() {
    this._c = [];
    this._t = 0;
  }

  // Zelfde presetwaarden als applyState in main.js doorgeven.
  setFromPreset(windSpeed, fetch, windDirDeg) {
    const g = 9.81;
    const w = Math.max(windSpeed, 1);
    // Identiek aan wavesSettings._jonswapPeak: piekfrequentie van het spectrum.
    const peakOmega = 22 * Math.pow(w * fetch / g / g, -0.33);
    const lambda = 2 * Math.PI * g / (peakOmega * peakOmega);   // dominante golflengte
    // Significante golfhoogte, fully-developed benadering, gecapt. Amplitude = Hs/2, en 0.8
    // marge zodat het schip eerder iets te laag dan te hoog op de visuele golven ligt.
    const Hs = Math.min(0.21 * w * w / g, 12);
    const a = Hs * 0.5 * 0.8;
    const dir = windDirDeg * Math.PI / 180;

    this._c = [
      this._comp(a,        lambda,        dir,        0.0),
      this._comp(a * 0.45, lambda * 0.62, dir + 0.42, 1.7),
      this._comp(a * 0.22, lambda * 0.31, dir - 0.35, 3.9),
    ];
  }

  _comp(a, lambda, dir, phase) {
    const k = 2 * Math.PI / Math.max(lambda, 1);
    const omega = Math.sqrt(9.81 * k);   // diepwater-dispersie
    return { a, kx: Math.cos(dir) * k, kz: Math.sin(dir) * k, omega, phase };
  }

  // Zelfde klok als uTime in de shader (simTime uit main.js).
  update(timeSec) { this._t = timeSec; }

  getHeight(x, z) {
    let y = 0;
    for (let i = 0; i < this._c.length; i++) {
      const c = this._c[i];
      y += c.a * Math.sin(c.kx * x + c.kz * z - c.omega * this._t + c.phase);
    }
    return y;
  }

  // Helling (dY/dx, dY/dz) voor wie een analytische normaal wil (bv. spatrichting bij inslag).
  getSlope(x, z, out) {
    let sx = 0, sz = 0;
    for (let i = 0; i < this._c.length; i++) {
      const c = this._c[i];
      const cs = c.a * Math.cos(c.kx * x + c.kz * z - c.omega * this._t + c.phase);
      sx += c.kx * cs; sz += c.kz * cs;
    }
    out.x = sx; out.z = sz;
    return out;
  }
}
