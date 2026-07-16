# ZeeBeslag

ZeeBeslag is een mobiele 3D-artilleriegame in Babylon.js. De oceaansimulatie gebruikt WebGPU-compute; een browser en toestel met WebGPU zijn daarom vereist.

## Level 1: Bruggenhoofd

Het schip ligt voor anker voor het eiland en ondersteunt een geallieerde landing. De speler voltooit drie opeenvolgende vuurmissies:

1. een kustbatterij uitschakelen;
2. een strandbunker neutraliseren;
3. inlandse artillerie vernietigen.

### Mobiele bediening

- speel in landscape;
- sleep op de linkerzijde van het scherm om het inslagpunt te corrigeren;
- wacht tot minimaal één geschutstoren gereed staat;
- gebruik de rode vuurknop rechtsonder;
- gebruik de cameraknop voor de lage doelcamera of hoge overzichtscamera;
- gebruik pauze om alle gameplaytimers en projectielen stil te zetten.

Level 1 bevat bewust geen vaarbesturing, keyboard/muisbediening of audio.

## Ontwikkelstart

Start de projectroot via een lokale HTTP-server. Open `index.html` niet rechtstreeks met `file://`, omdat ES-modules en GLB-assets dan door browserbeveiliging kunnen worden geblokkeerd.

```bash
python -m http.server 8899
```

Open daarna `http://127.0.0.1:8899/` op een mobiele WebGPU-browser.

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

De regressieset controleert syntax, imports, scheepsschaal, lifecycle, collisions, tactische AI, mobiele performance, distributie en de volledige level-1-missielogica.

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

## Ontwikkelaarsmenu

Het technische menu is in normale gameplay verborgen. Voeg `?dev=1` aan de URL toe om het te tonen.

## Branchbeleid

`main` blijft de stabiele lijn. Nieuwe fases en fixes worden via een aparte branch en pull request toegevoegd.
