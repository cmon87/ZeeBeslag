# Assetinventaris fase 7

Alle bestanden onder `models/` en `sound/` moeten voorkomen in `tools/runtime-manifest.mjs`. De productionbuild kopieert uitsluitend die expliciete lijst.

## Actieve runtime-assets

- `models/Schip1.glb`
- `models/land/ocean_rocky_island.glb`
- `models/planes/plane_zero.glb`
- `models/rookatlas.png`
- zes hit- en vuuratlassen onder `models/hits/`
- twee muzzleflash-atlassen onder `models/muzzleflash/`

Level 1 gebruikt nog geen audio. Het laatste kanonschotbestand is daarom uit het runtime-manifest en de repository verwijderd.

## Verwijderd in fase 6 en 7

De volgende bestanden blijven herstelbaar vanuit de Git-geschiedenis:

- ongebruikte HDR-, EXR-, MP4- en WebM-bronbestanden;
- ongebruikte kanonschoten en muziekbestanden;
- `sound/SFX/firemainguns.mp3` zolang audio niet is geïmplementeerd;
- `src/main.js.bak`.
