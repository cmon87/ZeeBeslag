# Assetinventaris fase 6

Alle bestanden onder `models/` en `sound/` moeten voorkomen in `tools/runtime-manifest.mjs`. De productionbuild kopieert uitsluitend die expliciete lijst.

## Actieve runtime-assets

- `models/Schip1.glb`
- `models/land/ocean_rocky_island.glb`
- `models/planes/plane_zero.glb`
- `models/rookatlas.png`
- zes hit- en vuuratlassen onder `models/hits/`
- twee muzzleflash-atlassen onder `models/muzzleflash/`
- `sound/SFX/firemainguns.mp3`

## Verwijderd in fase 6

De volgende bestanden hadden geen runtimeverwijzing en zijn uit de GitHub-branch verwijderd. Ze blijven herstelbaar vanuit de Git-geschiedenis van M6.6.0:

- ongebruikte HDR-, EXR-, MP4- en WebM-bronbestanden;
- ongebruikte kanonschoten en muziekbestanden;
- `src/main.js.bak`.

Netto verwijdering uit GitHub: ongeveer 45,3 MiB. De lokale ZIP bevatte daarnaast een `_backup/`-map en het dubbele eilandmodel `ocean_rocky_island1.glb`; die waren bij de eerste GitHub-upload al niet meegekomen.
