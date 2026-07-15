// M0: mechanisch uit index.html v7 geextraheerd, gedrag ongewijzigd.
export class WavesSettings {
  constructor() {
    this.g = 9.81;
    this.depth = 3;
    this.lambda = 1;
    // local: korte, lokaal opgewekte golven (windzee)
    this.local = { scale:0.5, windSpeed:1.5, windDirection:-29.81, fetch:100000, spreadBlend:1, swell:0.198, peakEnhancement:3.3, shortWavesFade:0.01 };
    // swell: lange deining van ver weg
    this.swell = { scale:0.5, windSpeed:1.5, windDirection:90, fetch:300000, spreadBlend:1, swell:1, peakEnhancement:3.3, shortWavesFade:0.01 };
    this.spectrums = [
      {scale:0,angle:0,spreadBlend:0,swell:0,alpha:0,peakOmega:0,gamma:0,shortWavesFade:0},
      {scale:0,angle:0,spreadBlend:0,swell:0,alpha:0,peakOmega:0,gamma:0,shortWavesFade:0}
    ];
  }
  // M1.8: geen StorageBuffer-write meer (upload landde niet op de S25, zie initialSpectrum.js).
  // Retourneert de 16 floats; InitialSpectrum zet ze in een RawTexture.
  setParametersToShader(params) {
    params.updateFloat('GravityAcceleration', this.g);
    params.updateFloat('Depth', this.depth);
    this._fill(this.local, this.spectrums[0]);
    this._fill(this.swell, this.spectrums[1]);
    const buf = [];
    this._linearize(this.spectrums[0], buf);
    this._linearize(this.spectrums[1], buf);
    return new Float32Array(buf);
  }
  _linearize(s, buf) { buf.push(s.scale,s.angle,s.spreadBlend,s.swell,s.alpha,s.peakOmega,s.gamma,s.shortWavesFade); }
  _fill(d, s) {
    s.scale = d.scale;
    s.angle = d.windDirection / 180 * Math.PI;
    s.spreadBlend = d.spreadBlend;
    s.swell = Math.min(Math.max(d.swell, 0.01), 1);
    s.alpha = this._jonswapAlpha(this.g, d.fetch, d.windSpeed);
    s.peakOmega = this._jonswapPeak(this.g, d.fetch, d.windSpeed);
    s.gamma = d.peakEnhancement;
    s.shortWavesFade = d.shortWavesFade;
  }
  _jonswapAlpha(g, fetch, w) { return 0.076 * Math.pow(g*fetch/w/w, -0.22); }
  _jonswapPeak(g, fetch, w)  { return 22 * Math.pow(w*fetch/g/g, -0.33); }
}
