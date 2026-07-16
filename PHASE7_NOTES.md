# Fase 7: Level 1 Bruggenhoofd

## Spelontwerp

Level 1 is een afgebakende mobiele vuursteunmissie. Het schip ligt permanent voor anker en ondersteunt een geallieerde landing door drie doelen in vaste volgorde uit te schakelen.

## Nieuwe systemen

- data-gedreven levelconfiguratie in `src/levels/level1.js`;
- `MissionDirector` voor briefing, doelactivatie, timers, voortgang, observercorrecties, winst en verlies;
- `MissionHUD` met vuurmissie, timer en geallieerde opmars;
- centrale touch-only `MobileInputController`;
- veilige pointer-cancelafhandeling;
- missiestatussen waardoor toekomstige doelen niet kunnen schieten of schade ontvangen;
- betrouwbare gereedcontrole per geschutstoren, inclusief logische fallbackturrets zonder GLB-node;
- alleen gereedstaande torens nemen deel aan een salvo;
- readinessbarrière voor schip, eiland en missie voordat de startknop verschijnt.

## Bewuste beperkingen

- geen vaarbesturing;
- geen keyboard/muisinput;
- geen audio;
- geen echte grondtroepen-AI;
- geen munitietypen of upgrades;
- geen vrije camera in normale gameplay.

## Validatie

`tools/phase7_regression.mjs` controleert onder andere geannuleerde touches, verankering, target-isolatie, logische turretbesturing, ready-only salvo's en missievoortgang.
