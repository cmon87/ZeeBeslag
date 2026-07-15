# ZeeBeslag M6.5.0 — fase 4

## Doel

Fase 4 geeft radar, munitiedepots, bunkers en kustbatterijen ieder een eigen tactische rol. Speler-spotting is niet langer de voorwaarde voor vijandelijk vuur: de vijand gebruikt een apart detectienetwerk.

## Nieuwe spelregels

- **Kustbatterij**: 110 HP, bereik 3200 m, eigen zicht 1800 m, reactietijd 2,2 s, draaisnelheid 12°/s en basis-herlaadtijd 4,8 s.
- **Radar**: 70 HP. Een levende radar kan het schip tot 3800 m detecteren wanneer de radar zichtlijn heeft. Radarcontact verkort de reactietijd en verbetert de nauwkeurigheid van alle batterijen.
- **Munitiedepot**: 90 HP. Zolang minstens één depot leeft, gebruiken batterijen hun normale herlaadtijd. Zonder depot wordt de herlaadtijd 1,55 keer langer.
- **Bunker**: 150 HP en verwerkt slechts 65% van inkomende explosieschade.
- **Contactgeheugen**: na verlies van radar- of zichtcontact blijft de laatst bekende positie maximaal 8 seconden bruikbaar. Vuur op geheugencontact is duidelijk onnauwkeuriger.

## Architectuur

- `defenseNetwork.js` beheert detectie, netwerkstatus, moeilijkheid, contactgeheugen en vuurleidingsmodifiers.
- `emplacement.js` bevat data-profielen, weerstand, batterijrichting en afzonderlijke AI-contactstatus.
- `targetRegistry.js` beheert spottingevents en expliciete missieobjectieven.
- `combatController.js` verwerkt reactietijd, draaisnelheid, bereik, nauwkeurigheid en dynamische cooldown.

## Moeilijkheid

In `src/main.js`:

```js
 enemyDifficulty: 'normal', // easy | normal | hard
```

De drie profielen wijzigen bereik, spreiding, herlaadtijd en reactietijd zonder de doelbestanden aan te passen.

## Regressie

- Speler-spotting blijft uitsluitend bepalend voor markers, HUD en doelselectie.
- Onbekende doelen blijven fysiek raakbaar.
- Pauze stopt sensoren, richten, cooldowns en vuur.
- Reset wist alle radarcontacten, doelgeheugen en batterijstanden.
- Fase 1, 2, 3 en het scheepsmodel blijven ongewijzigd slagen.
