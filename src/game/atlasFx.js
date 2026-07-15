// src/game/atlasFx.js
//
import { SmokeCardSystem } from './smokeCards.js';
//
// M2.9: VFX. Gepoold, geen runtime-allocatie meer, plus echte inslagatlassen.
//
// ── WAAROM HET SPEL HAPERDE BIJ INSLAG ──────────────────────────────────────
//
// shipShatter() werd aangeroepen voor ELKE granaat. Een salvo is drie torens maal drie granaten,
// en die landen binnen ongeveer een kwart seconde. Per aanroep deed de oude code:
//
//   3..7 x MeshBuilder.CreateBox   -> elk een nieuwe geometrie: positie-, normaal-, uv- en
//                                     indexbuffer. Vier GPU-buffers per stuk.
//   3   x _debrisMat.clone()       -> een nieuw StandardMaterial: nieuwe uniform buffer,
//                                     nieuwe bind group, effect-lookup.
//
// Negen granaten geven dus ongeveer 45 nieuwe meshes, 180 GPU-buffers en 27 materialen in
// hetzelfde frame, en een paar seconden later 45 disposes. Waterinslagen deden er per stuk nog
// een CreateDisc plus StandardMaterial bovenop. Op een Adreno via WebGPU is createBuffer een
// synchrone allocatie plus map; honderden per frame is een stall van tientallen milliseconden.
// Dat is de hapering. En het verklaart de RangeError uit de telemetrie:
//   "createBuffer ... size (524288) is too large ... when mappedAtCreation == true"
// gevolgd door een verloren device en een zwart scherm.
//
// Oplossing: alles vooraf aanmaken.
//   - koud puin: EEN doosgeometrie plus 48 instanties. Instanties delen de buffers.
//   - heet puin: 6 meshes die dezelfde geometrie klonen, elk met een vooraf gemaakt materiaal.
//   - schuimringen: 10 stuks vooraf, hergebruikt.
// Runtime maakt niets meer aan en gooit niets meer weg. Alleen setEnabled.
//
// Daarnaast is het aantal grote inslageffecten begrensd: minimaal 0,22 seconde ertussen en 70
// procent kans. Een salvo van negen levert zo een of twee explosies op in plaats van negen. Dat
// is ook cinematografisch beter: negen identieke explosies op een kluitje leest als een glitch,
// niet als artillerie.
//
// ── ATLASSEN ────────────────────────────────────────────────────────────────
// A1  rook_mix_atlas.png        10x6 van 326x196
// A2  smoke2_atlas.png           8x8 van 384x576
// MF  muzzle_flash_atlas.png     6x5 van 256x256, additief
// MS  muzzle_smoke_atlas.png     8x6 van 256x256
// H1  hit1_atlas.png             6x6 van 100x144  grondinslag, smalle kolom, anker onderaan
// H2  hit2_atlas.png             6x6 van 192x108  grote explosie, anker onderaan, zeldzaam
// H3  hit3_atlas.png             8x8 van 112x140  luchtinslag, volledige levenscyclus
// FL  fireloop_atlas.png         6x6 van 112x120  naadloze loop, na een H2
//
// Schaal is in meters HOOGTE; breedte volgt uit de celverhouding.

// ── PADEN ────────────────────────────────────────────────────────────────────
// Alle acht atlaspaden staan hier, relatief aan index.html en niet aan deze module. main.js geeft
// er geen enkele meer door. Verhuis je een map, dan is dit de enige plek.
//
//   models/hits/        alles wat met inslag en nawerking te maken heeft
//   models/muzzleflash/ alles wat uit de loop komt
//   models/smoke/       mist en atmosfeer, nog niet in gebruik
//   models/textures/    oceaantextuur
export const FX_PATHS = {
  muzzleFlash: './models/muzzleflash/muzzle_flash_atlas.png',
  muzzleSmoke: './models/muzzleflash/muzzle_smoke_atlas.png',

  hits:        './models/hits/',                      // hit1_, hit2_, hit3_, fireloop_, fireball_atlas.png
  rookMix:     './models/hits/rook_mix_atlas.png',    // 10x6 van 326x196, generieke rook en waterinslag
  // Optioneel legacy-atlaspad. De standaardbuild bevat dit bestand niet; zonder expliciete
  // override gebruikt atlas-kanaal 2 veilig rookMix en ontstaat er geen 404.
  smoke2:      null,
};

const A1 = { cols: 10, rows: 6, frames: 60, aspect: 326 / 196 };
// A2 smoke2_atlas.png is één doorlopende rookplume-afbeelding, geen sprite-grid. _mgr2 gebruikt
// 'm al zo (cellSize = volledige 384x576). cols/rows/frames blijven op 1 om dat overal consistent
// te houden, ook in heavyColumn hieronder dat animatie over meerdere frames verwachtte.
const A2 = { cols: 1,  rows: 1, frames: 1, cw: 384, ch: 576, aspect: 384 / 576 };
const MF = { cols: 6,  rows: 5, frames: 30, cw: 256, ch: 256, aspect: 1 };
const MS = { cols: 8,  rows: 6, frames: 48, cw: 256, ch: 256, aspect: 1 };
const H1 = { cols: 6,  rows: 6, frames: 36, cw: 100, ch: 144, aspect: 100 / 144 };
const H2 = { cols: 6,  rows: 6, frames: 36, cw: 192, ch: 108, aspect: 192 / 108 };
const H3 = { cols: 8,  rows: 8, frames: 64, cw: 112, ch: 140, aspect: 112 / 140 };
const FL = { cols: 6,  rows: 6, frames: 36, cw: 112, ch: 120, aspect: 112 / 120 };
const FB = { cols: 5,  rows: 5, frames: 25, cw: 128, ch: 128, aspect: 1 };   // vuurbal, additief

// ── ZICHTBAARHEID ────────────────────────────────────────────────────────────
// Op 1680 meter beslaat een fysiek correcte 305mm inslag (ongeveer 12 m vuurbal) zo'n 11 pixels
// op een scherm van 1249 hoog. Dat is realistisch en het is onzichtbaar.
//
// M2.6: alles verdubbeld, de rookkolom maal vijf. Zichtbare hoogte op 1680 meter:
//   flits    110 m -> 102 px      hit1  164 m -> 152 px
//   hit3     124 m -> 115 px      hit2  210 m -> 195 px
//   vuurloop 290 m -> 270 px
// Dat is zes keer de werkelijkheid. Bewust. Filmische artillerie, geen ballistiek.
// Terug naar de natuurkunde: HIT_SCALE op 0.17 en FIRE_SCALE op 0.07.
// M2.7: het eiland is met de nieuwe tuning 2880 bij 3851 meter en 354 meter hoog. De standoff
// gaat van 1680 naar 3200 meter, dus de doelen liggen tussen 1760 en 4640 meter in plaats van
// allemaal op 1680. Alles staat gemiddeld 1,9x zo ver weg. FX_WORLD compenseert dat.
//
// Zichtbare hoogte na deze schaling:
//                       @1760m   @3200m   @4640m
//   flits    176 m       156 px    86 px    59 px
//   hit3     198 m       176 px    97 px    67 px
//   hit1     262 m       232 px   128 px    88 px
//   hit2     336 m       298 px   164 px   113 px
//   vuurloop 464 m       412 px   226 px   156 px
//
// Ter vergelijking: het eiland is 354 meter hoog. hit2 is 95 procent daarvan, de rookkolom
// torent erboven. Dat is de verhouding die je wilt bij een munitiedepot dat de lucht in gaat.
const FX_WORLD = 1.6;
const HIT_SCALE = 2.0 * FX_WORLD;
const FIRE_SCALE = 5.0 * FX_WORLD;

// De DUUR is niet letterlijk verdubbeld, en dat is opzet. hit1 en hit2 hebben 36 frames. Speel je
// die over 6 seconden af, dan zie je 6 beelden per seconde: een diavoorstelling. In plaats daarvan
// gaat de frameanimatie 1,4x langzamer (10 tot 18 fps) en gaat de rest naar `hold`, de procedurele
// nadissipatie waarin de sprite blijft uitzetten, draaien, opstijgen en vervagen. Netto leeft elk
// effect ongeveer twee keer zo lang, zonder dat je frames gaat tellen.
//   hit3  17,8 fps, 6,2 s        hit1  10,0 fps, 8,0 s        hit2  10,6 fps, 8,4 s

const COLD_DEBRIS = 64;
const HOT_DEBRIS = 4;
const FOAM_RINGS = 10;
const SHOCK_WAVES = 4;
const MAX_SPRITES = 420;
const MAX_FIRE_LOOPS = 8;

const HIT_MIN_GAP = 0.22;    // seconden tussen twee grote inslageffecten
const HIT_CHANCE = 0.70;

const rnd = (a, b) => a + Math.random() * (b - a);
const rndInt = (a, b) => a + ((Math.random() * (b - a + 1)) | 0);

export class AtlasFX {
  // Geen url-argumenten meer. Alles komt uit FX_PATHS. De oude signatuur
  // new AtlasFX(scene, './rook_mix_atlas.png', './smoke2_atlas.png') liet twee atlaspaden buiten
  // FX_PATHS vallen, en een SpriteManager met een 404 tekent stilletjes niets zonder foutmelding.
  constructor(scene, opts = {}) {
    const urlMain       = opts.rookMix     || FX_PATHS.rookMix;
    const urlSmoke2     = opts.smoke2      || FX_PATHS.smoke2;
    const urlMuzzleFlash = opts.muzzleFlash || FX_PATHS.muzzleFlash;
    const urlMuzzleSmoke = opts.muzzleSmoke || FX_PATHS.muzzleSmoke;
    const urlHits       = opts.hits        || FX_PATHS.hits;
    const capacity      = opts.capacity    || 96;
    this._scene = scene;
    this._now = 0;
    this._lastHitT = -10;
    this._fireLoops = 0;

    this._mgr1 = new BABYLON.SpriteManager('fxAtlas1', urlMain, capacity, { width: 326, height: 196 }, scene);
    this._mgr2 = urlSmoke2
      ? new BABYLON.SpriteManager('fxAtlas2', urlSmoke2, 16, { width: 384, height: 576 }, scene)
      : null;
    this._def2 = this._mgr2 ? A2 : A1;
    for (const m of [this._mgr1, this._mgr2].filter(Boolean)) {
      m.isPickable = false;
      if (m.texture) m.texture.hasAlpha = true;
    }

    this._urlMain = urlMain;
    this._urlMF = urlMuzzleFlash;
    this._urlMS = urlMuzzleSmoke;

    // Capaciteiten ruim. Een SpriteManager die vol zit tekent stilletjes niets meer, zonder
    // waarschuwing. Per inslag: 1 flits + 4..6 stofrok + 1 hoofdatlas + 2..3 nadrijvende rook.
    // Een vuurloop is 3 sprites die drie minuten blijven staan, dus 8 loops zijn 24 sprites.
    this._mgrH1 = this._sprMgr('fxHit1', urlHits + 'hit1_atlas.png', 10, H1);
    this._mgrH2 = this._sprMgr('fxHit2', urlHits + 'hit2_atlas.png', 8, H2);
    this._mgrH3 = this._sprMgr('fxHit3', urlHits + 'hit3_atlas.png', 14, H3);
    this._mgrFL = this._sprMgr('fxFire', urlHits + 'fireloop_atlas.png', MAX_FIRE_LOOPS * 3 + 4, FL);

    // Gedeelde managers voor de extra inslaglagen. Niet per turret: een inslag heeft geen kanaal.
    this._mgrFlash = this._sprMgr('fxHitFlash', urlMuzzleFlash, 12, MF);
    this._mgrFlash.blendMode = BABYLON.Constants.ALPHA_ADD;
    this._mgrFlash.disableDepthWrite = true;
    this._mgrFlash.renderingGroupId = 1;
    this._mgrDust = this._sprMgr('fxHitDust', urlMuzzleSmoke, 192, MS);

    // M3.2: eigen pool voor zware, permanente rookkolommen. Losgekoppeld van _mgrDust, want die
    // wordt per schot gebruikt voor kruitdamp en impactstof. Zonder eigen pool loopt een kolom
    // van vijf gestapelde lobben per brandhaard binnen enkele branden tegen de gedeelde cap aan,
    // en tekent Babylon stilletjes niets meer. 8 branden x 5 lobben = 40, plus marge.
    // M3.2: rookkolommen niet langer via SpriteManager/atlas. SmokeCardSystem gebruikt echte,
    // belichte vlak-meshes met procedureel gebakken diffuse+normal map, geen png-afhankelijkheid.
    this._smokeCards = new SmokeCardSystem(scene);

    // De vuurbal. Additief en op renderingGroupId 1, dus hij wordt na alles getekend en kan niet
    // door scheeps- of rotsgeometrie worden afgesneden. Zonder dit krijg je een kaarsrechte
    // snijlijn dwars door de vlam zodra hij een mesh raakt.
    this._mgrFB = this._sprMgr('fxFireball', urlHits + 'fireball_atlas.png', 24, FB);
    this._mgrFB.blendMode = BABYLON.Constants.ALPHA_ADD;
    this._mgrFB.disableDepthWrite = true;
    this._mgrFB.fogEnabled = false;

    // De EXP2-mist haalt op 1680 meter 17 procent van het contrast weg en trekt een oranje
    // vuurbal naar het lichtblauw van de nevel. Inslagen zijn hete, heldere bronnen; die horen
    // niet in de mist te verdwijnen. De rooksprites van de monding wel.
    for (const m of [this._mgrH1, this._mgrH2, this._mgrH3, this._mgrFL, this._mgrFlash]) m.fogEnabled = false;

    this._embers = this._buildEmbers(scene);

    this._mfMgrs = [];
    this._msMgrs = [];
    this._muzzleMgrs = [];

    this._active = [];
    this._timeScale = 1;
    this._wind = new BABYLON.Vector3(0.6, 0, 0.25);

    this._debris = [];
    this._spray = this._buildSpray(scene);
    this._initPools(scene);

    this._obs = scene.onBeforeRenderObservable.add(() => {
      // M5.2: klem op 100 ms. Chrome pauzeert requestAnimationFrame zodra de app naar de
      // achtergrond gaat; bij terugkeer levert getDeltaTime de volledige weggeweest-tijd in
      // 1 frame (soms minuten). Alle rookpluimen sprongen dan in 1 tik voorbij hun levensduur
      // en stierven tegelijk, waarna de emitters de kolom vanaf de voet moesten herbouwen:
      // het 'rook stopt na schermwissel' beeld. Met de klem is een schermwissel gewoon 1
      // frame van 0.1 s en staat de kolom er bij terugkeer nog exact zo bij.
      const dt = Math.min(scene.getEngine().getDeltaTime() * 0.001, 0.1) * this._timeScale;
      this._tick(dt);
      this._smokeCards.update(dt);
    });
  }

  _sprMgr(name, url, cap, def) {
    const m = new BABYLON.SpriteManager(name, url, cap, { width: def.cw, height: def.ch }, this._scene);
    m.isPickable = false;
    m.texture.hasAlpha = true;
    return m;
  }

  setTimeScale(s) {
    this._timeScale = s;
    const scale = Number.isFinite(s) ? Math.max(0, s) : 0;
    if (this._embers) this._embers.updateSpeed = 0.01 * scale;
    if (this._spray) this._spray.updateSpeed = 0.01 * scale;
  }
  setWind(v) { this._wind.copyFrom(v); }

  // ── Pools. Alles hier wordt eenmalig aangemaakt en daarna alleen aan- en uitgezet. ──
  _initPools(scene) {
    this._coldMat = new BABYLON.StandardMaterial('debrisColdM', scene);
    this._coldMat.diffuseColor = new BABYLON.Color3(0.10, 0.10, 0.11);
    this._coldMat.specularColor = new BABYLON.Color3(0.15, 0.15, 0.15);
    this._coldMat.freeze();

    // Het bronmesh blijft ingeschakeld, anders renderen zijn instanties ook niet. We parkeren
    // hem onder de zeebodem met een verwaarloosbare schaal.
    // Was een kubus. Een geroteerde kubus van tien meter met een emissive van (1.0, 0.42, 0.12)
    // wordt door ACES en bloom een geel blok. Een platte icosfeer leest als een brok rots.
    this._debrisMaster = BABYLON.MeshBuilder.CreateIcoSphere('debrisMaster', { radius: 0.5, subdivisions: 1, flat: true }, scene);
    this._debrisMaster.material = this._coldMat;
    this._debrisMaster.isPickable = false;
    this._debrisMaster.position.set(0, -5000, 0);
    this._debrisMaster.scaling.setAll(0.001);

    this._coldPool = [];
    for (let i = 0; i < COLD_DEBRIS; i++) {
      const inst = this._debrisMaster.createInstance('deb' + i);
      inst.isPickable = false;
      inst.setEnabled(false);
      this._coldPool.push(inst);
    }

    // Heet puin gloeit na en heeft dus een eigen emissive per stuk. Zes vooraf gemaakte
    // materialen; nooit meer clone() tijdens het spel. clone() op de mesh deelt de geometrie,
    // dus dit kost geen extra GPU-buffers.
    this._hotPool = [];
    for (let i = 0; i < HOT_DEBRIS; i++) {
      const m = this._debrisMaster.clone('debHot' + i);
      m.isPickable = false;
      m.scaling.setAll(1);
      const mat = new BABYLON.StandardMaterial('debrisHotM' + i, scene);
      mat.diffuseColor = new BABYLON.Color3(0.09, 0.08, 0.07);
      mat.specularColor = new BABYLON.Color3(0.10, 0.10, 0.10);
      mat.emissiveColor = new BABYLON.Color3(0, 0, 0);
      m.material = mat;
      m.setEnabled(false);
      this._hotPool.push(m);
    }

    // Drukgolf. Een bol met een fresnel-opaciteit is aan de rand zichtbaar en in het midden
    // doorzichtig. Uitzettend leest dat als een schokfront in de lucht. Vier stuks, vooraf.
    this._shockPool = [];
    for (let i = 0; i < SHOCK_WAVES; i++) {
      const sph = BABYLON.MeshBuilder.CreateSphere('shock' + i, { diameter: 1, segments: 18 }, scene);
      sph.isPickable = false;
      sph.renderingGroupId = 1;
      const mat = new BABYLON.StandardMaterial('shockM' + i, scene);
      mat.emissiveColor = new BABYLON.Color3(0.88, 0.92, 1.0);
      mat.disableLighting = true;
      mat.backFaceCulling = false;
      mat.disableDepthWrite = true;
      mat.alpha = 0;
      mat.opacityFresnelParameters = new BABYLON.FresnelParameters();
      mat.opacityFresnelParameters.bias = 0.0;
      mat.opacityFresnelParameters.power = 6.5;
      mat.opacityFresnelParameters.leftColor = BABYLON.Color3.White();
      mat.opacityFresnelParameters.rightColor = BABYLON.Color3.Black();
      sph.material = mat;
      sph.setEnabled(false);
      this._shockPool.push({ mesh: sph, mat, t: 0, dur: 0.42, r0: 6, r1: 110, busy: false });
    }

    this._foamPool = [];
    for (let i = 0; i < FOAM_RINGS; i++) {
      const disc = BABYLON.MeshBuilder.CreateDisc('foamRing' + i, { radius: 1, tessellation: 24 }, scene);
      disc.rotation.x = Math.PI / 2;
      disc.isPickable = false;
      const mat = new BABYLON.StandardMaterial('foamRingM' + i, scene);
      mat.emissiveColor = new BABYLON.Color3(0.93, 0.97, 1.0);
      mat.disableLighting = true;
      mat.alpha = 0.75;
      disc.material = mat;
      disc.setEnabled(false);
      this._foamPool.push({ mesh: disc, mat, t: 0, dur: 1.6, busy: false });
    }
  }

  // ── Publieke effecten ─────────────────────────────────────────────────

  setMuzzleChannels(count) {
    for (const m of this._mfMgrs) m.dispose();
    for (const m of this._msMgrs) m.dispose();
    for (const m of this._muzzleMgrs) m.dispose();
    this._mfMgrs = []; this._msMgrs = []; this._muzzleMgrs = [];

    for (let i = 0; i < count; i++) {
      const f = this._sprMgr('fxMuzFlash' + i, this._urlMF, 6, MF);
      f.blendMode = BABYLON.Constants.ALPHA_ADD;
      f.disableDepthWrite = true;
      // Additieve sprites die door de koepel steken worden door de dieptetest doormidden
      // gesneden: dat zijn de losse rechte randen. Op renderingGroupId 1 wordt de dieptebuffer
      // eerst gewist, dus de flits wordt altijd heel getekend.
      f.renderingGroupId = 1;
      f.fogEnabled = false;
      this._mfMgrs.push(f);
      this._msMgrs.push(this._sprMgr('fxMuzSmoke' + i, this._urlMS, 32, MS));
    }
  }

  muzzleBlast(pos, dir, channel) {
    const ch = (channel !== undefined && this._mfMgrs[channel] !== undefined) ? channel : -1;
    if (ch < 0) return this._muzzleBlastLegacy(pos, dir);

    // De sprite is gecentreerd. Zonder deze offset ligt de helft van de flits ACHTER de monding,
    // dus in de koepel. Vandaar de rechte rand langs de loop.
    this._spawn({
      mgr: this._mfMgrs[ch], def: MF,
      pos: pos.add(dir.scale(2.4 + 12 * 0.42)), vel: dir.scale(9),
      dur: 0.10, hold: 0.03, f0: 0, f1: MF.frames - 1,
      size0: 5.5, size1: 12, growPow: 0.7,
      rise: 0.3, damp: 0.35, angle: rnd(-0.18, 0.18),
      fadeTail: 0.35, ignoreWind: true,
    });

    for (let i = 0; i < 4; i++) {
      const side = new BABYLON.Vector3(-dir.z, 0, dir.x).scale(rnd(-1.6, 1.6));
      this._spawn({
        mgr: this._msMgrs[ch], def: MS,
        pos: pos.add(dir.scale(2.0 + i * 3.1)).add(side),
        vel: dir.scale(12.5 - i * 2.3).add(side.scale(0.8)),
        delay: i * 0.045,
        dur: rnd(1.35, 1.75) + i * 0.30,
        hold: rnd(1.4, 2.0) + i * 0.45,
        f0: rndInt(0, 3), f1: MS.frames - 1,
        size0: (4.0 + i * 1.5) * rnd(0.88, 1.12),
        size1: (14 + i * 5.0) * rnd(0.88, 1.12),
        growPow: 0.55, rise: rnd(1.0, 1.5), damp: 0.45,
        angle: rnd(0, Math.PI * 2), angVel: rnd(-0.34, 0.34),
        invertU: Math.random() < 0.5,
        fadeTail: 0.48, alphaPow: 1.7,
      });
    }
  }

  _muzzleBlastLegacy(pos, dir) {
    this._spawn({ pos: pos.add(dir.scale(3)), vel: dir.scale(6),
      dur: 0.16, f0: 12, f1: 17, size0: 5, size1: 8, rise: 0.5 });
    for (let i = 0; i < 5; i++) {
      this._spawn({
        pos: pos.add(dir.scale(2 + i * 2.5)), vel: dir.scale(11 - i * 1.6),
        delay: i * 0.07, dur: 1.8 + i * 0.35, f0: 18 + i * 4, f1: 59,
        size0: 3.5 + i * 1.2, size1: 12 + i * 4, rise: 1.4, damp: 0.55,
      });
    }
  }

  // Gewone granaatinslag op land of op een doel. Elke granaat geeft wat puin, maar niet elke
  // granaat geeft een explosie: dat is de rate limit.
  shipShatter(pos) {
    this._burstDebris(pos, rndInt(3, 6));
    if (this._hitAllowed()) this._playHit(pos, false);
  }

  // Puin viel altijd door tot y = 0,4 en maakte daar een waterplons, ook als het op een rots van
  // driehonderd meter hoog ontstond. De bodem is nu het inslagpunt zelf.

  // Een verdedigingswerk gaat de lucht in. Altijd de grote explosie, altijd de vuurloop.
  emplacementDestroyed(pos) {
    this._lastHitT = this._now;
    this._burstDebris(pos, 14);
    this._playHit(pos, true);
  }

  _hitAllowed() {
    if (this._now - this._lastHitT < HIT_MIN_GAP) return false;
    if (Math.random() > HIT_CHANCE) return false;
    this._lastHitT = this._now;
    return true;
  }

  // hit3 is de enige bron met een volledige levenscyclus (begint leeg, eindigt leeg) en is dus
  // de standaard. hit1 is een grondkolom. hit2 is de secundaire detonatie en trekt een vuurloop
  // van drie minuten achter zich aan.
  _playHit(pos, forceBig) {
    const r = Math.random();
    const big = forceBig || r < 0.10;

    // Laag 1: de flits. Additief, 0,16 seconde, geen mist. Dit is wat een inslag op afstand
    // leesbaar maakt: eerst licht, dan pas vorm.
    this._spawn({
      mgr: this._mgrFlash, def: MF,
      pos: pos.add(new BABYLON.Vector3(0, 8, 0)), vel: BABYLON.Vector3.Zero(),
      dur: 0.16, hold: 0.05, f0: 0, f1: MF.frames - 1,
      size0: (big ? 55 : 40) * FX_WORLD, size1: (big ? 150 : 110) * FX_WORLD, growPow: 0.55,
      rise: 2, damp: 0.4, angle: rnd(0, 6.28),
      fadeTail: 0.45, alphaPow: 1.8, ignoreWind: true,
    });

    // Laag 1b: DE VUURBAL. Additief, uit de eerste 26 frames van hit2, waar de luminantie 211 is.
    // Twee exemplaren: een hete kern en een tragere, bredere mantel. Dit is wat er ontbrak: de
    // alfageblende atlassen laten vuur op 3200 meter door de mist en de kleurcurves grijs zien.
    for (let i = 0; i < 2; i++) {
      this._spawn({
        mgr: this._mgrFB, def: FB,
        pos: pos.add(new BABYLON.Vector3(rnd(-6, 6), 10 + i * 14, rnd(-6, 6))),
        vel: new BABYLON.Vector3(rnd(-3, 3), 0, rnd(-3, 3)),
        delay: i * 0.05,
        dur: (big ? 0.85 : 0.62) + i * 0.22,
        hold: (big ? 0.5 : 0.32),
        f0: rndInt(0, 2), f1: FB.frames - 1,
        size0: (big ? 60 : 38) * FX_WORLD * (1 + i * 0.35),
        size1: (big ? 210 : 130) * FX_WORLD * (1 + i * 0.35),
        growPow: 0.5, rise: 6 + i * 4, damp: 0.4,
        angle: rnd(0, 6.28), angVel: rnd(-0.5, 0.5),
        invertU: Math.random() < 0.5,
        fadeTail: 0.55, alphaPow: 2.0, ignoreWind: true,
      });
    }

    // Laag 1c: de drukgolf. Een uitzettende fresnel-schil, radius als wortel t.
    this._takeShock(pos.add(new BABYLON.Vector3(0, 12 * FX_WORLD, 0)),
                    (big ? 150 : 95) * (FX_WORLD / 1.6), (big ? 0.48 : 0.36));

    // Laag 2: de vonkenregen. Een gepoold ParticleSystem, geen allocatie.
    this._embers.emitter.copyFrom(pos);
    this._embers.manualEmitCount += (big ? 200 : 100);

    // Laag 3: de stofrok. Vier lage, brede rookpluimen die radiaal wegschieten. Dit leest als de
    // schokgolf zonder dat er een platte ring in de rotsen klipt.
    const skirt = big ? 6 : 4;
    for (let i = 0; i < skirt; i++) {
      const a = (i / skirt) * Math.PI * 2 + rnd(-0.4, 0.4);
      const d = new BABYLON.Vector3(Math.cos(a), 0, Math.sin(a));
      this._spawn({
        mgr: this._mgrDust, def: MS,
        pos: pos.add(d.scale(rnd(4, 14))).add(new BABYLON.Vector3(0, rnd(1, 5), 0)),
        vel: d.scale(rnd(28, 52) * FX_WORLD * (big ? 1.5 : 1)),
        delay: rnd(0, 0.06),
        dur: rnd(2.0, 2.8), hold: rnd(3.0, 4.5),
        f0: rndInt(0, 4), f1: MS.frames - 1,
        size0: (big ? 34 : 24) * FX_WORLD * rnd(0.85, 1.15),
        size1: (big ? 170 : 110) * FX_WORLD * rnd(0.85, 1.15),
        growPow: 0.5, rise: rnd(0.5, 1.4), damp: 0.30,
        angle: rnd(0, 6.28), angVel: rnd(-0.22, 0.22),
        invertU: Math.random() < 0.5,
        fadeTail: 0.5, alphaPow: 1.7,
      });
    }

    // Laag 4: het hoofdeffect uit de video-atlassen.
    if (big) {
      this._spawn({
        mgr: this._mgrH2, def: H2, anchor: 'base',
        pos: pos.clone(), vel: BABYLON.Vector3.Zero(),
        dur: 3.4, hold: 5.0, f0: 0, f1: H2.frames - 1,
        size0: 28 * HIT_SCALE, size1: 105 * HIT_SCALE, growPow: 0.62,
        rise: 2.2, damp: 0.6,
        angle: 0, invertU: Math.random() < 0.5,
        fadeTail: 0.42, alphaPow: 1.6,
      });
      this._driftSmoke(pos, 4, 42 * HIT_SCALE, 150 * HIT_SCALE, 55);
      this._haze(pos, 3, 260, 620, 130);
      this.fireLoop(pos, 180);
      return;
    }

    if (r < 0.42) {
      this._spawn({
        mgr: this._mgrH1, def: H1, anchor: 'base',
        pos: pos.clone(), vel: BABYLON.Vector3.Zero(),
        dur: 3.6, hold: 4.4, f0: 0, f1: H1.frames - 1,
        size0: 18 * HIT_SCALE, size1: 82 * HIT_SCALE, growPow: 0.6,
        rise: 1.4, damp: 0.7,
        invertU: Math.random() < 0.5,
        fadeTail: 0.45, alphaPow: 1.7,
      });
      this._driftSmoke(pos, 3, 28 * HIT_SCALE, 100 * HIT_SCALE, 16);
      this._haze(pos, 2, 180, 420, 90);
      return;
    }

    // hit3: luchtinslag, stijgt op, doet zijn eigen uitfade al in de frames.
    this._spawn({
      mgr: this._mgrH3, def: H3,
      pos: pos.add(new BABYLON.Vector3(0, 6, 0)),
      vel: new BABYLON.Vector3(rnd(-1.5, 1.5), 0, rnd(-1.5, 1.5)),
      dur: 3.6, hold: 2.6, f0: 0, f1: H3.frames - 1,
      size0: 14 * HIT_SCALE, size1: 62 * HIT_SCALE, growPow: 0.6,
      rise: rnd(4.0, 6.0), damp: 0.5,
      angle: rnd(-0.12, 0.12), angVel: rnd(-0.10, 0.10),
      invertU: Math.random() < 0.5,
      fadeTail: 0.18, alphaPow: 1.4,
    });
    this._driftSmoke(pos, 2, 21 * HIT_SCALE, 76 * HIT_SCALE, 16);
    this._haze(pos, 2, 140, 340, 70);
  }

  // Laag 6: nevel. Enorm, bijna doorzichtig, tot twee minuten. Dit is de laag die een slagveld
  // zijn atmosfeer geeft: je ziet hem niet als rook maar als vuil in de lucht dat langzaam
  // wegtrekt. Lage alfa, geen rotatie te zien, volledig aan de wind overgeleverd (damp 0,995).
  _haze(pos, n, s0, s1, life) {
    for (let i = 0; i < n; i++) {
      this._spawn({
        mgr: this._mgrDust, def: MS,
        pos: pos.add(new BABYLON.Vector3(rnd(-40, 40), 40 + i * 45, rnd(-40, 40))),
        vel: new BABYLON.Vector3(rnd(-1.5, 1.5), 0, rnd(-1.5, 1.5)),
        delay: 1.5 + i * 1.2,
        dur: 8 + i * 2, hold: life,
        f0: rndInt(10, 24), f1: MS.frames - 1,
        size0: s0 * rnd(0.8, 1.25), size1: s1 * rnd(0.8, 1.25),
        growPow: 0.30, rise: rnd(0.5, 1.2), damp: 0.995,
        angle: rnd(0, 6.28), angVel: rnd(-0.02, 0.02),
        invertU: Math.random() < 0.5,
        color: new BABYLON.Color4(1, 1, 1, 0.30),
        fadeHead: 0.06, fadeTail: 0.55, alphaPow: 1.5,
      });
    }
  }

  // Laag 5: trage rook die na de explosie blijft hangen en met de wind wegdrijft. Dit is wat een
  // inslag nawerking geeft; zonder deze laag is het effect voorbij zodra de atlas is afgespeeld.
  _driftSmoke(pos, n, s0, s1, life) {
    for (let i = 0; i < n; i++) {
      this._spawn({
        mgr: this._mgrDust, def: MS,
        pos: pos.add(new BABYLON.Vector3(rnd(-14, 14), (rnd(10, 32) + i * 18) * FX_WORLD, rnd(-14, 14))),
        vel: new BABYLON.Vector3(rnd(-3, 3), 0, rnd(-3, 3)),
        delay: 0.3 + i * 0.5,
        dur: rnd(3.5, 4.5), hold: life,
        f0: rndInt(0, 6), f1: MS.frames - 1,
        size0: s0 * rnd(0.8, 1.2), size1: s1 * rnd(0.8, 1.2),
        growPow: 0.42, rise: rnd(2.4, 4.2), damp: 0.90,
        angle: rnd(0, 6.28), angVel: rnd(-0.12, 0.12),
        invertU: Math.random() < 0.5,
        fadeHead: 0.04, fadeTail: 0.35, alphaPow: 1.8,
      });
    }
  }

  // Naadloze brandende rook op de inslagplek. Standaard drie minuten.
  fireLoop(pos, seconds = 180) {
    if (this._fireLoops >= MAX_FIRE_LOOPS) return;
    this._fireLoops++;

    // Drie exemplaren met verschillende schaal, cyclus en draaisnelheid. Een enkele sprite die drie
    // minuten dezelfde 36 frames herhaalt leest binnen twintig seconden als een loop. Drie op
    // parallax, met de wind mee, doet dat niet.
    for (let i = 0; i < 3; i++) {
      const sc = [1.0, 0.72, 0.55][i];
      this._spawn({
        mgr: this._mgrFL, def: FL, anchor: 'base',
        pos: pos.add(new BABYLON.Vector3(rnd(-24, 24), i * 20, rnd(-24, 24))),
        vel: BABYLON.Vector3.Zero(),
        loop: true, cycle: rnd(4.0, 5.6),
        life: seconds - i * 4, dur: 1, f0: rndInt(0, 8), f1: FL.frames - 1,
        size0: 26 * FIRE_SCALE * sc, size1: 58 * FIRE_SCALE * sc, growPow: 0.30,
        rise: 0.6 + i * 0.2, damp: 1.0,
        angVel: rnd(-0.03, 0.03) * (i % 2 ? -1 : 1),
        invertU: i % 2 === 1,
        fadeHead: 0.010, fadeTail: 0.12, alphaPow: 1.4,
        onEnd: i === 0 ? () => { this._fireLoops = Math.max(0, this._fireLoops - 1); } : null,
      });
    }
  }

  // ── Slagvelddecor. BattleAmbience gebruikt deze drie. Ze omzeilen de rate limit van de speler
  // en zijn bewust klein en goedkoop.

  // Kleine inslagpuf van een NPC-granaat.
  ambientImpact(pos) {
    this._spawn({
      mgr: this._mgrFlash, def: MF,
      pos: pos.add(new BABYLON.Vector3(0, 4, 0)), vel: BABYLON.Vector3.Zero(),
      dur: 0.10, hold: 0.02, f0: 0, f1: MF.frames - 1,
      size0: 14, size1: 38, growPow: 0.6, rise: 2, damp: 0.4,
      angle: rnd(0, 6.28), fadeTail: 0.5, alphaPow: 1.6, ignoreWind: true,
    });
    this._spawn({
      mgr: this._mgrDust, def: MS,
      pos: pos.add(new BABYLON.Vector3(rnd(-4, 4), 6, rnd(-4, 4))),
      vel: new BABYLON.Vector3(rnd(-4, 4), 0, rnd(-4, 4)),
      dur: rnd(1.4, 2.0), hold: rnd(4, 8),
      f0: rndInt(0, 6), f1: MS.frames - 1,
      size0: 18, size1: 70 * rnd(0.8, 1.2), growPow: 0.5,
      rise: rnd(2, 4), damp: 0.6,
      angle: rnd(0, 6.28), angVel: rnd(-0.2, 0.2), invertU: Math.random() < 0.5,
      color: new BABYLON.Color4(1, 1, 1, 0.8),
      fadeTail: 0.5, alphaPow: 1.6,
    });
  }

  // Iets grotere NPC-explosie, met vuurbal en vonken maar zonder drukgolf.
  ambientBurst(pos) {
    this._spawn({
      mgr: this._mgrFB, def: FB,
      pos: pos.add(new BABYLON.Vector3(0, 8, 0)), vel: BABYLON.Vector3.Zero(),
      dur: 0.55, hold: 0.3, f0: rndInt(0, 3), f1: FB.frames - 1,
      size0: 30, size1: 90, growPow: 0.5, rise: 6, damp: 0.4,
      angle: rnd(0, 6.28), angVel: rnd(-0.4, 0.4), invertU: Math.random() < 0.5,
      fadeTail: 0.55, alphaPow: 2.0, ignoreWind: true,
    });
    this._embers.emitter.copyFrom(pos);
    this._embers.manualEmitCount += 28;
    this.ambientImpact(pos);
  }

  // Permanente, traag lussende rookkolom. Oude, lichte variant. Blijft bestaan voor plekken waar
  // een subtiele pluim volstaat; voor brandhaarden op batterijen gebruik heavyColumn hieronder.
  ambientColumn(pos, height = 120, seconds = 600) {
    this._spawn({
      mgr: this._mgrDust, def: MS, anchor: 'base',
      pos: pos.clone(), vel: BABYLON.Vector3.Zero(),
      loop: true, cycle: rnd(5, 8), life: seconds, dur: 1,
      f0: rndInt(0, 10), f1: MS.frames - 1,
      size0: height * 0.5, size1: height, growPow: 0.25,
      rise: 0.5, damp: 1.0,
      angVel: rnd(-0.02, 0.02), invertU: Math.random() < 0.5,
      color: new BABYLON.Color4(1, 1, 1, 0.62),
      fadeHead: 0.02, fadeTail: 0.15, alphaPow: 1.4,
    });
  }

  // M3.2: zware, donkere rookkolom voor brandende batterijen. De feitelijke lobben-opbouw en
  // het lit-materiaal zitten nu in SmokeCardSystem (smokeCards.js). Deze methode blijft bestaan
  // als stabiele aanroepnaam voor battleAmbience.js, zodat daar niets hoeft te wijzigen.
  heavyColumn(pos, height = 260, seconds = 10800, opts = undefined) {
    // M5.0: opts (brandprofiel) gaat 1-op-1 door naar SmokeCardSystem.spawnColumn.
    this._smokeCards.spawnColumn(pos, height, seconds, opts);

    // Gloed onderaan via het bestaande embersysteem. Geen vuurbal: dat hoort niet bij deze stijl.
    this._embers.emitter.copyFrom(pos);
    this._embers.manualEmitCount += 6;
  }

  // M5.0: damplaag rond het eiland, doorgeefluik naar SmokeCardSystem. battleAmbience roept dit
  // eenmalig aan bij de spelstart; de slider in het hoofdmenu stuurt setHazeOpacity live aan.
  hazeLayer(center, radius, opts) { this._smokeCards.spawnHaze(center, radius, opts); }
  get smokeCardsRef() { return this._smokeCards; }   // M5.8: voor de Rook Sweep
  setHazeOpacity(m) { this._smokeCards.setHazeOpacity(m); }
  getHazeOpacity() { return this._smokeCards.getHazeOpacity(); }

  // M3.2: kruitdamp bij de vuurmond. Laag, grijs, kort, snel wegdrijvend. Los van ambientImpact,
  // die hoort bij de inslag, dit hoort bij het schot.
  muzzleSmoke(pos) {
    this._spawn({
      mgr: this._mgrDust, def: MS,
      pos: pos.add(new BABYLON.Vector3(rnd(-2, 2), 3, rnd(-2, 2))),
      vel: new BABYLON.Vector3(rnd(-3, 3), 0, rnd(-3, 3)),
      dur: rnd(0.8, 1.2), hold: rnd(1.5, 3),
      f0: rndInt(0, 6), f1: MS.frames - 1,
      size0: 6, size1: 20, growPow: 0.5,
      rise: rnd(1, 2), damp: 0.7,
      color: new BABYLON.Color4(0.55, 0.55, 0.55, 0.7),
      fadeTail: 0.4, alphaPow: 1.5,
    });
  }

  waterImpact(pos) {
    this._spray.emitter.copyFrom(pos);
    this._spray.manualEmitCount += 90;
    this._takeFoamRing(pos);
    this._spawn({
      pos: pos.add(new BABYLON.Vector3(0, 1.5, 0)), vel: BABYLON.Vector3.Zero(),
      dur: 0.9, f0: 42, f1: 55, size0: 4, size1: 10, rise: 7.0,
      color: new BABYLON.Color4(0.82, 0.90, 1.0, 1.0),
    });
    this._spawn({
      pos: pos.add(new BABYLON.Vector3(0, 0.5, 0)), vel: BABYLON.Vector3.Zero(),
      delay: 0.12, dur: 1.3, f0: 46, f1: 59, size0: 6, size1: 13, rise: 3.0,
      color: new BABYLON.Color4(0.85, 0.92, 1.0, 1.0),
    });
  }

  shipImpact(pos) {
    this.emplacementDestroyed(pos);
    this._spawn({
      atlas: 2, anchor: 'base',
      pos: pos.clone(), vel: new BABYLON.Vector3(0.4, 0, 0.2),
      delay: 0.15, dur: 13.2, f0: 0, f1: 63,
      size0: 15, size1: 55, rise: 0, fadeTail: 0.12,
    });
  }

  resetTransient() {
    for (const a of this._active) {
      try { a.sprite.dispose(); } catch (_) {}
    }
    this._active.length = 0;
    this._fireLoops = 0;
    this._lastHitT = -10;
    this._now = 0;

    for (const d of this._debris) {
      if (d.mesh) d.mesh.setEnabled(false);
    }
    this._debris.length = 0;

    for (const w of this._shockPool) {
      w.busy = false;
      w.t = 0;
      w.mesh.setEnabled(false);
    }
    for (const r of this._foamPool) {
      r.busy = false;
      r.t = 0;
      r.mesh.setEnabled(false);
    }

    for (const ps of [this._embers, this._spray]) {
      if (!ps) continue;
      ps.manualEmitCount = 0;
      try { if (typeof ps.reset === 'function') ps.reset(); } catch (_) {}
    }
    if (this._smokeCards && typeof this._smokeCards.resetTransient === 'function') {
      this._smokeCards.resetTransient();
    }
  }

  dispose() {
    this._scene.onBeforeRenderObservable.remove(this._obs);
    this._active.forEach(a => a.sprite.dispose());
    this._foamPool.forEach(r => { r.mat.dispose(); r.mesh.dispose(); });
    this._shockPool.forEach(w => { w.mat.dispose(); w.mesh.dispose(); });
    this._coldPool.forEach(m => m.dispose());
    this._hotPool.forEach(m => { if (m.material) m.material.dispose(); m.dispose(); });
    this._debrisMaster.dispose();
    this._coldMat.dispose();
    this._spray.dispose();
    if (this._embers) this._embers.dispose();
    this._mfMgrs.forEach(m => m.dispose());
    this._msMgrs.forEach(m => m.dispose());
    this._muzzleMgrs.forEach(m => m.dispose());
    const managers = new Set([this._mgr1, this._mgr2, this._mgrH1, this._mgrH2, this._mgrH3, this._mgrFL,
      this._mgrFlash, this._mgrDust, this._mgrFB].filter(Boolean));
    managers.forEach(m => { try { m.dispose(); } catch (_) {} });
    if (this._smokeCards) this._smokeCards.dispose();
  }

  // ── Intern ────────────────────────────────────────────────────────────

  _spawn(o) {
    if (this._active.length >= MAX_SPRITES) return;

    const two = o.atlas === 2;
    const def = o.def || (two ? this._def2 : A1);
    const mgr = o.mgr || (two ? (this._mgr2 || this._mgr1) : this._mgr1);
    if (!mgr || !def) return;

    // Babylon rendert stilletjes niets meer zodra een manager over zijn capaciteit gaat.
    if (mgr.sprites.length >= mgr.capacity) return;

    const maxFrame = Math.max(0, (def.frames ?? 1) - 1);
    const f0 = Math.min(maxFrame, Math.max(0, o.f0 ?? 0));
    const f1 = Math.min(maxFrame, Math.max(f0, o.f1 ?? f0));

    const s = new BABYLON.Sprite('fx', mgr);
    s.cellIndex = f0;
    s.width = o.size0 * def.aspect; s.height = o.size0;
    s.angle = (o.angle !== undefined) ? o.angle
            : (o.anchor === 'base' ? 0 : (Math.random() - 0.5) * 0.5);
    if (o.invertU) s.invertU = true;
    if (o.color) s.color = o.color;
    s.isVisible = !(o.delay > 0);

    const dur = o.dur ?? 1;
    const e = {
      sprite: s, aspect: def.aspect,
      t: -(o.delay || 0),
      dur,
      loop: !!o.loop,
      cycle: o.cycle ?? dur,
      life: o.life ?? (dur + (o.hold ?? 0)),
      f0, f1,
      pos: o.pos.clone(), vel: (o.vel || BABYLON.Vector3.Zero()).clone(),
      damp: o.damp ?? 1.0,
      size0: o.size0, size1: o.size1,
      growPow: o.growPow ?? 1.0,
      rise: o.rise ?? 0,
      angVel: o.angVel ?? 0,
      ignoreWind: !!o.ignoreWind,
      anchor: o.anchor || 'center',
      fadeHead: o.fadeHead ?? 0,
      fadeTail: o.fadeTail ?? 0,
      alphaPow: o.alphaPow ?? 1.0,
      onEnd: o.onEnd || null,
      baseColor: o.color ? o.color.clone() : new BABYLON.Color4(1, 1, 1, 1),
    };
    this._placeSprite(e, o.size0);
    this._active.push(e);
  }

  _placeSprite(e, size) {
    if (e.anchor === 'base') e.sprite.position.set(e.pos.x, e.pos.y + size * 0.5, e.pos.z);
    else e.sprite.position.copyFrom(e.pos);
  }

  // ── Gepoold puin ──────────────────────────────────────────────────────
  _burstDebris(pos, count) {
    // Brokken van 3 tot 14 meter. Op 3200 meter is een blok van 1 meter een derde pixel; dat zie
    // je nooit. Op deze schaal is het puin en geen ruis.
    const S = 3.6 * FX_WORLD;   // brokken van 2,3 tot 9,5 meter
    const floorY = pos.y - 2;             // land onder het inslagpunt, niet de zeespiegel
    const overWater = pos.y < 3;

    for (let i = 0; i < count; i++) {
      const hot = i === 0;          // een gloeiend brok per inslag, niet twee
      const mesh = hot ? this._takeHot() : this._takeCold();
      if (!mesh) continue;

      mesh.scaling.set((0.4 + Math.random() * 1.3) * S, (0.25 + Math.random() * 0.8) * S, (0.4 + Math.random() * 1.3) * S);
      mesh.position.set(pos.x + (Math.random() - 0.5) * 20, pos.y + 6 + Math.random() * 20, pos.z + (Math.random() - 0.5) * 20);
      mesh.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
      mesh.setEnabled(true);

      const ang = Math.random() * Math.PI * 2;
      const lat = (3 + Math.random() * 10) * FX_WORLD * 1.6;
      this._debris.push({
        mesh, hot: hot && !!(mesh.material && mesh.material.emissiveColor),
        vel: new BABYLON.Vector3(Math.cos(ang) * lat, (9 + Math.random() * 15) * FX_WORLD * 1.6, Math.sin(ang) * lat),
        angVel: new BABYLON.Vector3((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9),
        t: 0, floorY, overWater,
      });
    }
  }

  _takeCold() { for (const m of this._coldPool) if (!m.isEnabled(false)) return m; return null; }
  _takeHot()  { for (const m of this._hotPool)  if (!m.isEnabled(false)) return m; return this._takeCold(); }

  _takeShock(pos, r1, dur) {
    const w = this._shockPool.find(x => !x.busy);
    if (!w) return;
    w.busy = true; w.t = 0; w.dur = dur; w.r1 = r1;
    w.mesh.position.copyFrom(pos);
    w.mesh.scaling.setAll(w.r0);
    w.mat.alpha = 0.55;
    w.mesh.setEnabled(true);
  }

  _takeFoamRing(pos) {
    const r = this._foamPool.find(x => !x.busy);
    if (!r) return;
    r.busy = true; r.t = 0;
    r.mesh.position.set(pos.x, pos.y + 0.15, pos.z);
    r.mesh.setEnabled(true);
    r.mat.alpha = 0.75;
  }

  _tick(dt) {
    if (dt <= 0) return;
    this._now += dt;

    for (let i = this._active.length - 1; i >= 0; i--) {
      const a = this._active[i];
      a.t += dt;
      if (a.t < 0) continue;
      if (!a.sprite.isVisible) a.sprite.isVisible = true;

      if (a.t >= a.life) {
        a.sprite.dispose();
        if (a.onEnd) a.onEnd();
        this._active.splice(i, 1);
        continue;
      }

      const T = a.t / a.life;

      if (a.loop) {
        const u = (a.t % a.cycle) / a.cycle;
        a.sprite.cellIndex = a.f0 + Math.min(Math.floor(u * (a.f1 - a.f0 + 1)), a.f1 - a.f0);
      } else {
        const fu = Math.min(a.t / a.dur, 1);
        a.sprite.cellIndex = Math.min(a.f0 + Math.floor(fu * (a.f1 - a.f0 + 1)), a.f1);
      }

      if (a.angVel) a.sprite.angle += a.angVel * dt;

      const k = Math.pow(a.damp, dt);
      a.vel.scaleInPlace(k);
      let wx = 0, wz = 0;
      if (!a.ignoreWind) {
        const grip = 1 - k;
        wx = this._wind.x * grip * 6; wz = this._wind.z * grip * 6;
      }
      a.pos.x += (a.vel.x + wx) * dt;
      a.pos.z += (a.vel.z + wz) * dt;
      a.pos.y += (a.vel.y + a.rise) * dt;

      const g = a.growPow === 1 ? T : Math.pow(T, a.growPow);
      const size = a.size0 + (a.size1 - a.size0) * g;
      a.sprite.width = size * a.aspect; a.sprite.height = size;
      this._placeSprite(a, size);

      let al = 1;
      if (a.fadeHead > 0 && T < a.fadeHead) al = T / a.fadeHead;
      if (a.fadeTail > 0 && T > 1 - a.fadeTail) {
        const x = (T - (1 - a.fadeTail)) / a.fadeTail;
        al = Math.min(al, Math.pow(1 - x, a.alphaPow));
      }
      if (al < 1 || a.baseColor.a !== 1) {
        a.sprite.color = new BABYLON.Color4(a.baseColor.r, a.baseColor.g, a.baseColor.b, a.baseColor.a * al);
      }
    }

    for (let i = this._debris.length - 1; i >= 0; i--) {
      const d = this._debris[i];
      d.t += dt;
      d.vel.y -= 9.81 * dt;
      d.mesh.position.addInPlace(d.vel.scale(dt));
      d.mesh.rotation.x += d.angVel.x * dt; d.mesh.rotation.y += d.angVel.y * dt; d.mesh.rotation.z += d.angVel.z * dt;
      if (d.hot) {
        // Sneller doven en veel donkerder. Bloom tilt dit alsnog op; een emissive van 1,0 gaf
        // gele blokken. Kubisch verval houdt alleen de eerste halve seconde echt heet.
        const c = Math.pow(Math.max(1 - d.t / 1.4, 0), 3);
        d.mesh.material.emissiveColor.set(0.85 * c, 0.26 * c, 0.05 * c);
      }
      const landed = d.vel.y < 0 && d.mesh.position.y <= d.floorY;
      if (landed || d.t > 7) {
        if (landed && d.overWater) { this._spray.emitter.copyFrom(d.mesh.position); this._spray.manualEmitCount += 10; }
        d.mesh.setEnabled(false);            // terug in de pool, geen dispose
        this._debris.splice(i, 1);
      }
    }

    for (const w of this._shockPool) {
      if (!w.busy) continue;
      w.t += dt;
      const f = w.t / w.dur;
      if (f >= 1) { w.busy = false; w.mesh.setEnabled(false); continue; }
      // Radius groeit als wortel t: een schokfront vertraagt sterk. Alfa valt kwadratisch.
      const r = w.r0 + (w.r1 - w.r0) * Math.pow(f, 0.5);
      w.mesh.scaling.setAll(r);
      // Dunne, doorschijnende schil die snel wegtrekt. Lage piek-alfa (0.22) en kubische fade,
      // zodat je een RAND ziet en geen gevulde bol die in het terrein snijdt.
      w.mat.alpha = 0.22 * (1 - f) * (1 - f) * (1 - f);
    }

    for (const r of this._foamPool) {
      if (!r.busy) continue;
      r.t += dt;
      const f = r.t / r.dur;
      if (f >= 1) { r.busy = false; r.mesh.setEnabled(false); continue; }
      const rad = 1.5 + f * 9;
      r.mesh.scaling.set(rad, rad, 1);
      r.mat.alpha = 0.75 * (1 - f) * (1 - f);
    }
  }

  // Vonken. Een gepoold ParticleSystem met manualEmitCount, dus geen allocatie per inslag.
  // Deeltjes van 6 tot 18 meter: op 1680 meter is dat 5 tot 17 pixels, net zichtbaar als vonk.
  _buildEmbers(scene) {
    const size = 32;
    const dtex = new BABYLON.DynamicTexture('emberTex', size, scene, false);
    const ctx = dtex.getContext();
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0.0, 'rgba(255,240,200,1)');
    g.addColorStop(0.35, 'rgba(255,150,40,0.9)');
    g.addColorStop(1.0, 'rgba(120,30,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
    dtex.update();
    dtex.hasAlpha = true;

    const ps = new BABYLON.ParticleSystem('emberPS', 320, scene);
    ps.particleTexture = dtex;
    ps.emitter = new BABYLON.Vector3(0, -1000, 0);
    ps.createSphereEmitter(10, 0.9);
    ps.minEmitPower = 55; ps.maxEmitPower = 140;
    ps.minLifeTime = 1.4; ps.maxLifeTime = 3.4;
    ps.minSize = 10; ps.maxSize = 30;      // op 3200 m is dat 5 tot 15 px: net zichtbaar als vonk
    ps.gravity = new BABYLON.Vector3(0, -38, 0);
    ps.addColorGradient(0.0, new BABYLON.Color4(1.0, 0.92, 0.60, 1.0));
    ps.addColorGradient(0.35, new BABYLON.Color4(1.0, 0.48, 0.10, 0.9));
    ps.addColorGradient(1.0, new BABYLON.Color4(0.35, 0.08, 0.0, 0.0));
    ps.addSizeGradient(0.0, 1.0);
    ps.addSizeGradient(1.0, 0.25);
    ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
    ps.emitRate = 0;
    ps.manualEmitCount = 0;
    ps.start();
    return ps;
  }

  _buildSpray(scene) {
    const size = 64;
    const dtex = new BABYLON.DynamicTexture('sprayTex', size, scene, false);
    const ctx = dtex.getContext();
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0.0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(240,248,255,0.8)');
    g.addColorStop(1.0, 'rgba(230,240,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
    dtex.update();
    dtex.hasAlpha = true;

    const ps = new BABYLON.ParticleSystem('sprayPS', 400, scene);
    ps.particleTexture = dtex;
    ps.emitter = new BABYLON.Vector3(0, -1000, 0);
    ps.createConeEmitter(2.2, 0.45);
    ps.minEmitPower = 9;  ps.maxEmitPower = 19;
    ps.minLifeTime = 0.45; ps.maxLifeTime = 1.0;
    ps.minSize = 0.7; ps.maxSize = 2.6;
    ps.gravity = new BABYLON.Vector3(0, -22, 0);
    ps.addColorGradient(0.0, new BABYLON.Color4(1.0, 1.0, 1.0, 0.95));
    ps.addColorGradient(0.55, new BABYLON.Color4(0.88, 0.94, 1.0, 0.55));
    ps.addColorGradient(1.0, new BABYLON.Color4(0.85, 0.92, 1.0, 0.0));
    ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
    ps.emitRate = 0;
    ps.manualEmitCount = 0;
    ps.start();
    return ps;
  }
}
