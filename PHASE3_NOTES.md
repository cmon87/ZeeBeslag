# ZeeBeslag M6.4.0 — fase 3 fysieke wereld

Deze build bouwt voort op M6.3.0 en wijzigt alleen navigatie- en impactlogica.

## Nieuw

- `src/game/worldCollision.js`: heightmap-gebaseerde collision voor de scheepsromp.
- `src/game/collisionMath.js`: gedeelde segment-bol- en interpolatiefuncties.
- Missiegrenzen via de centrale configuratie in `src/main.js`.
- Swept trefferdetectie voor schepen en verdedigingswerken.
- Gesegmenteerde heightfield-tests voor terrein en water.
- Een projectiel verwerkt maximaal één, altijd de vroegste, impact.
- Collisionstatus wordt meegenomen in telemetrie en reset.

## Afbakening

- Geen visuele meshes of assets aangepast.
- Geen balanswaarden voor schade, spreiding of vuursnelheid aangepast.
- Geen triangle collision of Babylon picking toegevoegd.
- Gronding stopt of dempt de snelheid, maar veroorzaakt in deze fase nog geen schade.

## Handmatige controles op telefoon

1. Vaar recht op de kust en controleer dat de boeg vóór het land stopt.
2. Geef achteruit gas en controleer dat het schip direct weer vrij kan varen.
3. Vaar schuin langs de kust en controleer dat het schip niet hard blijft plakken.
4. Vaar naar de uiterste kaartgrens en controleer dat beweging langs de grens mogelijk blijft.
5. Vuur een salvo bij lage framerate en controleer dat granaten geen doelen of kliffen overslaan.
6. Pauzeer, hervat en herstart tweemaal om fase-2-regressie uit te sluiten.
