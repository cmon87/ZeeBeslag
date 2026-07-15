# ZeeBeslag fase 1: kritieke logica

Build: `M6.2.1 Fase 1 logica-herstel`

## Uitgevoerd

### 1. Line-of-sight

- Babylon `pickWithRay()` is verwijderd uit de spottingloop.
- `IslandTarget.hasLineOfSight()` bemonstert de bestaande heightmap tussen schip en doel.
- De visuele eilandmeshes blijven niet-pickable, zodat LOS niet afhankelijk is van de zware GLB-hiërarchie.
- Begin- en eindmarges voorkomen zelfocclusie bij schip en emplacement.

### 2. Doeltypen en vijandelijk vuur

- Centrale, immutable emplacementprofielen toegevoegd.
- Alleen `battery` en legacytype `arty` hebben `canFire: true`.
- Radar, bunker en depot hebben geen kanonmesh meer.
- Zowel `main.js` als `CombatController.enemyFire()` controleren `canFire`.
- Standaardlabels zijn nu typecorrect: KUSTBATTERIJ, BUNKER, RADAR en MUNITIEDEPOT.

### 3. Fysieke kwetsbaarheid

- `TargetRegistry.hitTest()` en `applyBlast()` negeren de spottingstate niet meer.
- Een onbekend doel kan fysiek worden geraakt en vernietigd.
- HUD-selectie en markers blijven onbekende doelen wel negeren.

### 4. VFX-assetfallback

- De ontbrekende `smoke2_atlas.png` wordt niet meer standaard aangevraagd.
- Atlas-kanaal 2 valt terug op de bestaande rookatlas.
- Frame-indexen worden begrensd en dispose is null-safe.

### 5. Defensive checks

- Ongeldige of disposed roots worden geweigerd voordat vijandelijk vuur wordt berekend.
- Eilandladen controleert op een leeg GLB-resultaat en op dispose tijdens async laden.
- Eiland- en emplacement-dispose zijn idempotent.
- JSON-import van emplacements is transactioneel.
- `MatchDirector.setMode()` weigert onbekende modi.
- `Emplacement.reset()` wist nu ook `lastFireT`.

## Nieuwe controles

Gebruik vanuit de projectroot:

```bash
npm run test:phase1
npm run check
```

Resultaat bij oplevering:

- 20 gerichte regressie-asserties geslaagd.
- 46 van 46 JavaScriptmodules syntactisch geldig.
- 61 van 61 relatieve imports en exports geldig.
- Alle letterlijk gerefereerde model- en geluidsassets aanwezig.
- Geen `pickWithRay()` meer in de spottingcode.

## Niet gewijzigd in deze fase

- Centrale pauze- en resettransactie.
- Schip-terreincollision en missiegrens.
- Swept projectile collision.
- Render scaling, LOD, WakeManager en assetoptimalisatie.
- Lokale Babylon-vendorbestanden. De build gebruikt nog de CDN-fallback.

Een volledige browser/WebGPU-run kon in de auditomgeving niet worden uitgevoerd, omdat de lokale Babylon-vendorbestanden ontbreken en externe DNS niet beschikbaar was. De module-, import-, asset- en gerichte logicatests zijn wel uitgevoerd.
