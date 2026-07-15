# ZeeBeslag M6.6.0 — fase 6 distributie

## Doel

De runtime is losgemaakt van toevallige bronbestanden en van een verplichte CDN-verbinding. De ontwikkelpagina behoudt een gecontroleerde CDN-terugval, maar de productionbuild gebruikt uitsluitend lokale, gepinde Babylon-bestanden.

## Uitgevoerd

- productionbuild naar `dist/` zonder externe runtime-CDN;
- automatische download en validatie van Babylon.js 9.14.0 plus loaders;
- expliciet runtime-assetmanifest;
- SHA-256-buildmanifest;
- distributievalidatie;
- CI-controle voor alle regressietests en de productionbuild;
- oude back-ups en aantoonbaar ongebruikte assets verwijderd;
- projectdocumentatie en third-party notices toegevoegd.

## Regressieregel

Een nieuw bestand onder `models/` of `sound/` veroorzaakt een fase-6-testfout totdat het bewust aan `tools/runtime-manifest.mjs` is toegevoegd. Daardoor kan een asset niet per ongeluk ongebruikt in de productiebuild belanden of juist stil ontbreken.
