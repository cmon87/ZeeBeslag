// M0: mechanisch uit index.html v7 geextraheerd.
// M1.10: vijf natuurgetrouwe intensiteiten i.p.v. drie. windSpeed is de hoofdknop voor de
//        golfhoogte (ruwweg de Beaufort-schaal), fetch bepaalt of de zee jong/kort of volgroeid/
//        lang is, lambda is de choppiness (ronde vs. steile toppen) en foam is een multiplier op
//        de basis-schuimschaal (uFoamScale = 2.4). De rustigste stand is nagenoeg vlak.
//        Meet de golfhoogte objectief via 'disp max' in de HUD-diagnose en stem daarop af.
//
//  stand    ~Beaufort   sfeer
//  spiegel  0 tot 1     bijna spiegelglad, minimale rimpeling
//  rimpel   2           lichte kabbeling, kleine golfjes
//  calm     3           matige zee, rustiger dan de oude calm
//  swell    5 tot 6     lange oceaandeining
//  storm    8           steile, brekende toppen
export const PRESETS = {
  spiegel: { windSpeed:1.2,  fetch:8000,   windDir:-20, lambda:0.25, foam:0.12 },
  rimpel:  { windSpeed:2.2,  fetch:25000,  windDir:-20, lambda:0.40, foam:0.35 },
  calm:    { windSpeed:3.2,  fetch:45000,  windDir:-20, lambda:0.55, foam:0.60 },
  swell:   { windSpeed:9.0,  fetch:180000, windDir:-25, lambda:1.00, foam:1.00 },
  storm:   { windSpeed:19.0, fetch:400000, windDir:-30, lambda:1.40, foam:1.35 }
};
