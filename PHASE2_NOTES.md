# ZeeBeslag M6.3.0 — fase 2 lifecycle-herstel

## Doel

Pauze, game-over en herstart gebruiken nu één centrale lifecycle en één gameplayklok. De fase wijzigt geen collision-, balans- of grafische kwaliteitsinstellingen.

## Lifecycle

De geldige states zijn:

- `loading`
- `playing`
- `paused`
- `gameOver`
- `resetting`

`GameClock` laat `gameTime` alleen vooruitlopen in `playing`. Combat, AI, spotting, schipbeweging, projectielen, wake, VFX, hitte, eskader en oceaan worden vanuit dezelfde gameplay-delta bijgewerkt.

## Pauze en game-over

- De pauzeknop schakelt via state, niet meer via de numerieke tijdschaal.
- De FFT-oceaan gebruikt gesimuleerde tijd in plaats van `performance.now()`.
- Wake-data wordt niet meer gestempeld bij delta nul.
- Particle systems krijgen bij pauze exact `updateSpeed = 0`.
- Lopende geluidklonen worden gestopt en vrijgegeven.
- Game-over annuleert nog geplande salvo’s en blokkeert verdere gameplay-updates.
- Het resultaatscherm bevat een werkende knop **HERSTART MISSIE**.

## Volledige reset

Een reset herstelt onder meer:

- gameplayklok en tijdschaal;
- salvo-wachtrij en cooldown;
- actieve projectielen;
- spelerpositie, HP, zinkstatus, koers, pitch, roll en turrets;
- doelen en batterijcooldowns;
- wake-texture en scheepswake-cache;
- tijdelijke inslag-, rook-, puin-, shockwave- en schuimeffecten;
- slagveldtracers, HUD, markers en hitte-effect;
- eskaderroute en camera-status;
- achtergrondpluim en oceaantijd;
- joysticks, hoogte-input, actief doel, mikpunt en hulpmiddelen.

## Testen

```bash
npm run check
npm run test:phase1
node tools/ship_model_regression.mjs
npm run test:phase2
```

Resultaat bij oplevering:

- 47/47 JavaScriptmodules parsen;
- 62/62 relatieve imports en exports kloppen;
- 20 fase-1-assertions geslaagd;
- 10 scheepsmodelassertions geslaagd;
- 43 lifecycle-assertions geslaagd.

## Handmatige controle op telefoon

1. Start een salvo en pauzeer midden in de burst. Er mogen tijdens pauze geen extra granaten vertrekken.
2. Controleer dat zee, wake, rook, vliegtuigen, projectielen en cooldown stilstaan.
3. Hervat. Er mag geen sprong in golven of timers optreden.
4. Laat het schip zinken. Besturing en combat moeten stoppen.
5. Druk op **HERSTART MISSIE**. Het schip en alle doelen moeten terugkeren naar de beginstand.
6. Herhaal de reset tweemaal om achterblijvende effecten of salvo’s uit te sluiten.

## Bekende externe afhankelijkheid

De build bevat geen lokale `vendor/`-map en laadt Babylon.js 9.14.0 via het CDN. Daardoor kon in de auditomgeving geen volledige offline WebGPU-browserrun worden uitgevoerd.
