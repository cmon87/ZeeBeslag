# ZeeBeslag

ZeeBeslag is een mobiele 3D-zeeslaggame in Babylon.js met WebGPU als voorkeursbackend en WebGL2 als terugval.

## Ontwikkelstart

Start de projectroot via een lokale HTTP-server. Open `index.html` niet rechtstreeks met `file://`, omdat ES-modules en GLB-assets dan door browserbeveiliging kunnen worden geblokkeerd.

```bash
python -m http.server 8899
```

Open daarna `http://127.0.0.1:8899/`.

De ontwikkelpagina probeert eerst lokale Babylon-bestanden uit `vendor/`. Als die ontbreken, gebruikt zij tijdelijk de gepinde CDN-versie.

## Lokale Babylon-dependencies

```bash
npm run vendor
```

Dit haalt Babylon.js **9.14.0** en de bijbehorende glTF-loaders op en valideert de bestanden voordat ze worden geplaatst.

## Controles

```bash
npm run test:all
```

De regressieset controleert syntax, imports, gameplayfasen, scheepsschaal, lifecycle, collisions, tactische AI, mobiele performance en distributie.

## Productionbuild

```bash
npm run build
```

De build:

- downloadt ontbrekende gepinde vendorbestanden;
- kopieert alleen expliciet gebruikte runtime-assets;
- verwijdert alle CDN-fallbacks uit de productionpagina;
- schrijft SHA-256-hashes naar `dist/build-manifest.json`;
- valideert de volledige map `dist/`.

Na de eerste vendor-download kan offline worden gebouwd:

```bash
npm run build:offline
```

De map `dist/` is de publiceerbare versie.

## Branchbeleid

`main` blijft de stabiele lijn. Nieuwe fases en fixes worden via een aparte branch en pull request toegevoegd.
