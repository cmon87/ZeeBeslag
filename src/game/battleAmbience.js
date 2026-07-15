// src/game/battleAmbience.js
//
// M3.1: BattleAmbience. Fictieve grondstrijd op het eiland.
// Cinematografische wapenprofielen, procedurele thermische gradienten en een
// native StandardMaterial fallback voor stabiele WebGPU instancing.
//
// Wijzigingen t.o.v. M2.9:
//  - Pooling-bug verholpen: instanties worden nu als bezet gemarkeerd via
//    _ambBusy, losgekoppeld van setEnabled. Elke tracer in een burst krijgt
//    zo een eigen instance in plaats van dat de hele burst er een deelt.
//  - Tracers integreren nu een eigen snelheidsvector met zwaartekracht, en de
//    streek wordt langs die vector georienteerd. Baan en orientatie lopen synchroon.
//  - Spread teruggebracht tot een echte beaten zone met een walkende burst.
//  - Muzzle flash piekt bij aanvang en dooft in grootte en alpha uit.
//  - Tracertextuur met exponentieel dovende staart (filmischer dan lineair).
//  - Inslagen worden naar het terrein gesnapt i.p.v. in de lucht gespawnd.
//  - Subtiele ricochets bij grondinslag.

const TRACER_POOL = 400;
const GRAV = 9.81;

import { FX_PATHS } from './atlasFx.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const rndInt = (a, b) => a + ((Math.random() * (b - a + 1)) | 0);

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Snelheid loopt op met kaliber: LMG traagst, autokanon snelst. De streeklengte (len) schaalt
// mee zodat een snel, groot kaliber als een lange felle veeg leest in plaats van een korte stip.
const WEAPONS = [
  {
    name: 'LMG',
    count: [8, 16], gap: 0.09,
    speed: 1000, len: 22, thick: 2.0, spread: 4.5, flash: 9
  },
  {
    name: 'HMG',
    count: [12, 25], gap: 0.06,
    speed: 1400, len: 32, thick: 3.5, spread: 2.5, flash: 12
  },
  {
    name: 'Autocannon',
    count: [3, 6], gap: 0.20,
    speed: 1900, len: 55, thick: 7.0, spread: 1.0, flash: 16
  }
];

// M3.2: statische terugvalpunten uit de eiland-geometrie (ocean_rocky_island.glb), als fractie
// van isl.bounds() (u,v in 0..1, zelfde conventie als b.x0 + u*b.span). Gebruikt wanneer build()
// geen registry krijgt, bijvoorbeeld in een preview-scene zonder gescatterde emplacements.
// Bergwand: twee ruggen boven ~48m lokale hoogte. Kust: vier laaggelegen punten, verspreid rond
// de omtrek in plaats van geclusterd op één strand.
export const ISLAND_FALLBACK_SITES = {
  ridge: [
    { u: 0.589, v: 0.589 },
    { u: 0.495, v: 0.674 },
  ],
  coast: [
    { u: 0.368, v: 0.726 },
    { u: 0.726, v: 0.347 },
    { u: 0.242, v: 0.537 },
    { u: 0.758, v: 0.537 },
  ],
};

export class BattleAmbience {
  // registry: optionele TargetRegistry. Als die aanwezig is en battery/bunker-emplacements
  // bevat, staan de rookkolommen daar exact op. Zonder registry valt build() terug op
  // ISLAND_FALLBACK_SITES.
  constructor(scene, island, fx, opts = {}) {
    this._scene = scene;
    this._island = island;
    this._fx = fx;
    this._registry = opts.registry || null;
    this._seed = opts.seed ?? 4242;

    this.enabled = true;
    this.burstRate = opts.burstRate ?? 3.5;
    this.impactRate = opts.impactRate ?? 0.85;
    // M3.2: standaard uit. Iwo Jima-stijl duldt geen vuurbal in het decor; stof en rook, geen vlam.
    this.burstChanceBig = opts.burstChanceBig ?? 0;

    this._t = 0;
    this._burstT = 0;
    this._seaT = 0;             // M5.4: klok voor near-miss salvo's op zee
    this._seaWacht = 3 + Math.random() * 3;
    this._islandCenter = null;  // M5.4: gezet in build(), gebruikt door de salvo's
    this._seaQueue = [];        // M5.4: geplande inslagen; 1 gedeeld spray-emitterpunt dwingt spreiding in de tijd af
    this._impactT = 0;
    this._live = [];

    this.friendly = [];
    this.enemy = [];

    this._flash = new BABYLON.SpriteManager('ambFlash', opts.flashUrl || FX_PATHS.muzzleFlash,
      120, { width: 256, height: 256 }, scene);
    this._flash.isPickable = false;
    this._flash.texture.hasAlpha = true;
    this._flash.blendMode = BABYLON.Constants.ALPHA_ADD;
    this._flash.disableDepthWrite = true;
    this._flash.renderingGroupId = 1;
    this._flash.fogEnabled = false;
    this._flashSprites = [];

    this._pools = {
      friendly: this._makePool('ambTracerF', new BABYLON.Color3(1.0, 0.35, 0.05)),
      enemy: this._makePool('ambTracerE', new BABYLON.Color3(0.2, 1.0, 0.2)),
    };

    this._v = new BABYLON.Vector3();
    this._dir = new BABYLON.Vector3();
    this._mid = new BABYLON.Vector3();
    this._camF = new BABYLON.Vector3();
    this._camR = new BABYLON.Vector3();
    this._camN = new BABYLON.Vector3();
    this._camToC = new BABYLON.Vector3();
    this._camMat = new BABYLON.Matrix();
  }

  _orient(mesh, dir, atPos, len, thick) {
    this._camF.copyFrom(dir);
    const cam = this._scene.activeCamera;
    if (cam) this._camToC.copyFrom(cam.globalPosition).subtractInPlace(atPos);
    else this._camToC.set(0, 1, 0);

    BABYLON.Vector3.CrossToRef(this._camF, this._camToC, this._camR);
    if (this._camR.lengthSquared() < 1e-8) {
      this._camR.set(-this._camF.y, this._camF.x, 0);
      if (this._camR.lengthSquared() < 1e-8) this._camR.set(1, 0, 0);
    }
    this._camR.normalize();

    BABYLON.Vector3.CrossToRef(this._camF, this._camR, this._camN);
    this._camN.normalize();

    BABYLON.Matrix.FromValuesToRef(
      this._camR.x, this._camR.y, this._camR.z, 0,
      this._camN.x, this._camN.y, this._camN.z, 0,
      this._camF.x, this._camF.y, this._camF.z, 0,
      0, 0, 0, 1, this._camMat);

    if (!mesh.rotationQuaternion) mesh.rotationQuaternion = BABYLON.Quaternion.Identity();
    BABYLON.Quaternion.FromRotationMatrixToRef(this._camMat, mesh.rotationQuaternion);

    // Y-scaling genegeerd op CreateGround, Z = lengte, X = dikte
    mesh.scaling.set(thick, 1, len);
  }

  _buildTracerTexture(name, color) {
    const W = 32, H = 128;
    const dtex = new BABYLON.DynamicTexture(name + 'Tex', { width: W, height: H }, this._scene, false);
    const ctx = dtex.getContext();
    const img = ctx.createImageData(W, H);

    for (let y = 0; y < H; y++) {
      // v=1 is de kop (op +Z), v=0 de staart.
      const v = 1.0 - (y / (H - 1));
      const heat = Math.pow(v, 2.5);            // withete kern nabij de kop
      const head = Math.pow(v, 0.4);            // felle, korte kop
      const tail = Math.exp(-(1.0 - v) * 3.2);  // exponentieel dovende sliert
      const lume = Math.max(head, tail * 0.5);

      // Basiskleur mengen met een withete kern op basis van hitte.
      const r = Math.min(255, (color.r * 2.0 * (1 - heat) + 1.0 * heat) * 255);
      const g = Math.min(255, (color.g * 2.0 * (1 - heat) + 0.95 * heat) * 255);
      const b = Math.min(255, (color.b * 2.0 * (1 - heat) + 0.8 * heat) * 255);

      for (let x = 0; x < W; x++) {
        const u = x / (W - 1);
        const edge = Math.sin(u * Math.PI);
        // Zachte randen (U) gekoppeld aan het lengteprofiel (V).
        const alpha = Math.round(Math.pow(edge, 3.0) * lume * 255);

        const i = (y * W + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = alpha;
      }
    }
    ctx.putImageData(img, 0, 0);
    dtex.update();
    dtex.hasAlpha = true;
    return dtex;
  }

  _makePool(name, color) {
    const tex = this._buildTracerTexture(name, color);

    const mat = new BABYLON.StandardMaterial(name + 'M', this._scene);
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    // Overbelichting om als emissieve lichtbron door de ACES tonemapper te knallen.
    mat.emissiveColor = new BABYLON.Color3(2.5, 2.5, 2.5);
    mat.diffuseColor = BABYLON.Color3.Black();
    mat.specularColor = BABYLON.Color3.Black();
    mat.disableLighting = true;
    mat.alphaMode = BABYLON.Constants.ALPHA_ADD;
    mat.disableDepthWrite = true;
    mat.backFaceCulling = false;
    mat.freeze();

    const master = BABYLON.MeshBuilder.CreateGround(name, { width: 1, height: 1, subdivisions: 1 }, this._scene);
    master.material = mat;
    master.isPickable = false;
    master.renderingGroupId = 1;
    master.position.set(0, -6000, 0);
    master.scaling.setAll(0.001);
    master.rotationQuaternion = BABYLON.Quaternion.Identity();

    const list = [];
    for (let i = 0; i < TRACER_POOL; i++) {
      const inst = master.createInstance(name + i);
      inst.isPickable = false;
      inst.rotationQuaternion = BABYLON.Quaternion.Identity();
      inst._ambBusy = false;
      inst.setEnabled(false);
      list.push(inst);
    }
    return { master, mat, list, tex };
  }

  build(opts = {}) {
    const isl = this._island;
    if (!isl || !isl.bounds || !isl.bounds()) return 0;

    const b = isl.bounds();
    const rnd2 = mulberry32(this._seed);
    const cx = isl.root.position.x;
    const minH = opts.minH ?? 8;

    const pick = (xLo, xHi, want, minDist) => {
      const out = [];
      let tries = 0;
      while (out.length < want && tries < 8000) {
        tries++;
        const x = xLo + rnd2() * (xHi - xLo);
        const z = b.z0 + b.span * 0.08 + rnd2() * b.span * 0.84;
        const h = isl.sample(x, z);
        if (h === null || h === undefined || h < minH) continue;
        let ok = true;
        for (const p of out) {
          const dx = x - p.x, dz = z - p.z;
          if (dx * dx + dz * dz < minDist * minDist) { ok = false; break; }
        }
        if (!ok) continue;
        out.push(new BABYLON.Vector3(x, h + 4, z));
      }
      return out;
    };

    const x0 = b.x0, x1 = b.x0 + b.span;
    this.friendly = pick(x0 + b.span * 0.10, cx - 60, opts.friendly ?? 9, 180);
    this.enemy = pick(cx + 60, x1 - b.span * 0.10, opts.enemy ?? 9, 180);

    this._spawnBatteryColumns(opts);

    return this.friendly.length + this.enemy.length;
  }

  // M3.2: rookkolommen op batterijposities. Voorkeur voor de echte, geseede plaatsing uit de
  // registry; ISLAND_FALLBACK_SITES alleen als er geen registry is meegegeven. Hardcoden op
  // GLB-coördinaten alleen zou de kolommen los van de daadwerkelijke batterijen zetten, want
  // targetRegistry.scatter() plaatst elke sessie opnieuw binnen minH/minDist-grenzen.
  _spawnBatteryColumns(opts = {}) {
    if (!this._fx) return;
    const isl = this._island;
    const b = isl.bounds ? isl.bounds() : null;
    if (!b) return;

    const sites = [];

    const reg = this._registry;
    if (reg && reg.list && reg.list.length) {
      for (const e of reg.list) {
        if (e.type !== 'battery' && e.type !== 'bunker') continue;
        if (!e.alive) continue;
        sites.push({ x: e.root.position.x, y: e.root.position.y, z: e.root.position.z });
      }
    }

    if (!sites.length) {
      const fall = ISLAND_FALLBACK_SITES;
      for (const p of [...fall.ridge, ...fall.coast]) {
        const x = b.x0 + p.u * b.span;
        const z = b.z0 + p.v * b.span;
        const h = isl.sample(x, z);
        if (h === null || h === undefined) continue;
        sites.push({ x, y: h, z });
      }
    }

    // ── M5.0: brandprofielen. Zes identieke kolommen lazen als kopieerwerk; een slagveld
    // waar al uren wordt gevochten heeft haarden in alle stadia. Drie profielen wisselen af,
    // met per haard nog eigen hoogte- en breedtevariatie. Alles staat volgroeid bij frame 1
    // (spawnColumn verwarmt voor), dus het beeld opent midden in de slag. ──────────────────
    // M5.2: dekking +40 procent, bredere voeten en strakkere jitter. De ease-out klim maakt
    // de voet van nature het dunst (pluimen bewegen daar het snelst), dus juist daar moeten
    // kaartgrootte en aantal het gat dichttrekken: een massieve kolom, geen kralenketting.
    const PROFIELEN = [
      { naam: 'zwaar',     h: [340, 470], breedte0: 0.34, breedte1: 0.70, alpha: 0.96,
        tintSet: 'grijs', lifeMult: 1.25, leanMult: 1.1, dekking: 18, jitter: 0.035 },
      { naam: 'brand',     h: [230, 330], breedte0: 0.32, breedte1: 0.62, alpha: 0.93,
        tintSet: 'grijs', lifeMult: 1.0,  leanMult: 1.0, dekking: 16, jitter: 0.04 },
      { naam: 'smeulend',  h: [130, 190], breedte0: 0.26, breedte1: 0.48, alpha: 0.75,
        tintSet: 'grijs', lifeMult: 0.9,  leanMult: 1.4, dekking: 12, jitter: 0.05 },
    ];

    // De megakolom: fictief getroffen oliereservoir, ruim een kilometer hoog. Op de hoogst
    // gelegen haard, zodat hij achter de bergrug vandaan de hele lucht in torent. Traag
    // (lifeMult 3.5: een pluim doet ~5 minuten over de klim, op deze schaal oogt dat als
    // stilstand waarbij alleen de contouren verraden dat hij leeft), roetzwart, en met een
    // breed aambeeld dat met de wind mee uitwaaiert.
    if (sites.length) {
      let mega = sites[0];
      for (const p of sites) if (p.y > mega.y) mega = p;
      this._fx.heavyColumn(
        new BABYLON.Vector3(mega.x, mega.y - 2, mega.z),
        1500, 10800,
        { tintSet: 'olie', dekking: 26, breedte0: 0.26, breedte1: 0.44, alpha: 0.97,
          lifeMult: 3.5, leanMult: 0.8, topWiden: 1.4, fadeTop: 0.86, angVelMult: 0.25,
          jitter: 0.02 });

      const maxFires = opts.fires ?? 6;
      let k = 0;
      for (let i = 0; i < sites.length && k < maxFires; i++) {
        const p = sites[i];
        if (p === mega) continue;   // het reservoir heeft zijn kolom al
        const prof = PROFIELEN[k % PROFIELEN.length];
        this._fx.heavyColumn(
          new BABYLON.Vector3(p.x, p.y - 2, p.z),
          prof.h[0] + Math.random() * (prof.h[1] - prof.h[0]), 10800,
          { tintSet: prof.tintSet, dekking: prof.dekking, breedte0: prof.breedte0,
            breedte1: prof.breedte1, alpha: prof.alpha, lifeMult: prof.lifeMult,
            leanMult: prof.leanMult, jitter: prof.jitter });
        k++;
      }
    }

    // ── M5.0: damplaag. Grote, traag lussende smogkaarten rond het hele eiland, alsof de
    // kruitdamp van uren strijd is blijven hangen. Dekking live regelbaar via het hoofdmenu
    // (LICHT > Slagvelddamp). ───────────────────────────────────────────────────────────
    // M5.2: bredere spreiding (0.75 van de eilandspanne) en de nieuwe, grotere bankdefaults
    // uit spawnHaze; samen dekt de laag nu het hele eiland als drijvende mistbanken.
    const center = new BABYLON.Vector3(b.x0 + b.span * 0.5, (isl.root ? isl.root.position.y : 0) + 10, b.z0 + b.span * 0.5);
    this._fx.hazeLayer(center, b.span * 0.75, { count: 16 });
    this._islandCenter = center;

    // ── M5.4: zeewaartse rookslierten. Langgerekte, lage banken op het middenplan tussen
    // eiland en schip, alsof de slagveldrook over het water uitdrijft. Zelfde lussysteem en
    // zonglans als de eilandbanken, zelfde slider (Slagvelddamp) als volumeregelaar. ─────
    const zeeCenter = new BABYLON.Vector3(center.x * 0.55, 6, center.z * 0.55);
    this._fx.hazeLayer(zeeCenter, b.span * 0.60, {
      count: 8, stretch: 2.4, sizeMin: 420, sizeMax: 880,
      yMin: 4, yMax: 26, alphaMin: 0.035, alphaMax: 0.08 });
  }

  // ── M5.4: near-misses. De kustbatterijen vuren periodiek een salvo dat te kort of te ver
  // valt: 2 tot 3 witte waterzuilen in een straddle-patroon op het water tussen eiland en
  // schip. Vertelt 'lopend zeegevecht' op het lege middenplan voor de prijs van wat spray. ──
  _seaSalvo() {
    const c = this._islandCenter;
    if (!c || !this._fx || !this._fx.waterImpact) return;
    // Richting eiland -> wereldoorsprong (de sector waar het schip vaart).
    let dx = -c.x, dz = -c.z;
    const l = Math.sqrt(dx * dx + dz * dz) || 1;
    dx /= l; dz /= l;
    const px = -dz, pz = dx;   // dwarsrichting voor het straddle-patroon

    // Inslagen worden GEPLAND, niet direct gespawnd: waterImpact deelt 1 emitterpunt, dus
    // gelijktijdige aanroepen zouden allemaal vanaf de laatste positie spuiten. Een salvo dat
    // met 0.15 tot 0.5 s tussenruimte inslaat is bovendien precies hoe een straddle valt.
    const afstand = 800 + Math.random() * 1700;
    const zijde = rnd(-620, 620);
    const n = 2 + ((Math.random() * 2) | 0);
    let vertraging = 0;
    for (let i = 0; i < n; i++) {
      vertraging += i === 0 ? 0 : rnd(0.15, 0.5);
      const langs = afstand + rnd(-70, 70);
      const dwars = zijde + rnd(-55, 55);
      this._seaQueue.push({
        t: vertraging,
        x: c.x + dx * langs + px * dwars,
        z: c.z + dz * langs + pz * dwars,
      });
    }
  }

  setEnabled(v) {
    this.enabled = v;
    if (!v) {
      for (const t of this._live) { t.mesh.setEnabled(false); t.mesh._ambBusy = false; }
      this._live.length = 0;
    }
  }

  // Pak een vrije instance. Markeer als bezet (los van enabled) zodat een burst
  // niet meerdere keren dezelfde instance grijpt.
  _take(side) {
    for (const m of this._pools[side].list) {
      if (!m._ambBusy) { m._ambBusy = true; return m; }
    }
    return null;
  }

  _flashAt(pos, delay = 0, size = 12) {
    if (this._fx) this._fx.muzzleSmoke(pos);
    if (this._flash.sprites.length >= this._flash.capacity) return;
    const s = new BABYLON.Sprite('amb', this._flash);
    s.position.copyFrom(pos);
    s.width = size; s.height = size;
    s.cellIndex = 0;
    s.angle = rnd(0, 6.28);
    s.isVisible = false;
    if (s.color) s.color.set(1, 1, 1, 1);
    this._flashSprites.push({ s, t: -delay, dur: 0.10, size });
  }

  _burst() {
    const fromFriend = Math.random() < 0.5;
    const src = fromFriend ? this.friendly : this.enemy;
    const dst = fromFriend ? this.enemy : this.friendly;
    if (!src.length || !dst.length) return;

    const side = fromFriend ? 'friendly' : 'enemy';
    const a = src[(Math.random() * src.length) | 0];
    const b = dst[(Math.random() * dst.length) | 0];

    const wpn = WEAPONS[Math.floor(Math.random() * WEAPONS.length)];
    const n = rndInt(wpn.count[0], wpn.count[1]);
    const cone = wpn.spread; // meters, per-ronde jitterradius

    // Een gedeeld richtpunt met een lichte walk zodat de burst over het doel loopt.
    const walkX = rnd(-6, 6), walkZ = rnd(-6, 6);
    const baseX = b.x + rnd(-3, 3);
    const baseY = b.y + rnd(0, 6);
    const baseZ = b.z + rnd(-3, 3);

    const burstDuration = n * wpn.gap;
    const flashCount = Math.min(4, Math.ceil(n / 4));
    for (let f = 0; f < flashCount; f++) {
      this._flashAt(a, f * (burstDuration / flashCount), wpn.flash);
    }

    for (let i = 0; i < n; i++) {
      const mesh = this._take(side);
      if (!mesh) break;

      const frac = n > 1 ? i / (n - 1) : 0; // 0..1 langs de burst
      const target = new BABYLON.Vector3(
        baseX + walkX * frac + rnd(-cone, cone),
        baseY + rnd(-cone * 0.4, cone * 0.8),
        baseZ + walkZ * frac + rnd(-cone, cone)
      );

      const dir = target.subtract(a);
      const dist = dir.length();
      if (dist < 1e-3) { mesh._ambBusy = false; continue; }
      dir.scaleInPlace(1 / dist);

      mesh.position.copyFrom(a);
      mesh.setEnabled(false);

      this._live.push({
        mesh, side,
        vel: dir.scale(wpn.speed),
        pos: a.clone(),
        target,
        t: -i * wpn.gap,
        life: dist / wpn.speed,
        len: wpn.len,
        thick: wpn.thick,
        hits: Math.random() < 0.35,
        ricochet: false,
      });
    }
  }

  // Inslag op het terrein plaatsen (gesnapt op de heightmap) plus een kans op een ricochet.
  _spawnImpact(target, side) {
    const h = this._island.sample(target.x, target.z);
    const iy = (h !== null && h !== undefined) ? h + 2 : target.y;
    const pos = new BABYLON.Vector3(target.x, iy, target.z);
    if (this._fx) this._fx.ambientImpact(pos);
    if (Math.random() < 0.5) this._ricochet(pos, side);
  }

  // Korte, felle afketser die schuin omhoog wegspringt.
  _ricochet(pos, side) {
    const mesh = this._take(side);
    if (!mesh) return;
    this._dir.set(rnd(-1, 1), rnd(0.7, 1.5), rnd(-1, 1));
    const inv = 1 / (this._dir.length() || 1);
    this._dir.scaleInPlace(inv);
    mesh.position.copyFrom(pos);
    mesh.setEnabled(false);
    this._live.push({
      mesh, side,
      vel: this._dir.scale(rnd(160, 300)),
      pos: pos.clone(),
      target: null,
      t: 0,
      life: rnd(0.15, 0.4),
      len: 9,
      thick: 1.8,
      hits: false,
      ricochet: true,
    });
  }

  update(dt) {
    if (!this.enabled || dt <= 0) return;
    if (!this.friendly.length || !this.enemy.length) return;

    this._t += dt;

    // M5.4: near-miss klok, zelfde poort (enabled + gedeelde dt) als de bursts.
    this._seaT += dt;
    if (this._seaT >= this._seaWacht) {
      this._seaT = 0;
      this._seaWacht = 2.5 + Math.random() * 4.5;
      this._seaSalvo();
    }
    if (this._seaQueue.length) {
      for (const q of this._seaQueue) q.t -= dt;
      for (let i = this._seaQueue.length - 1; i >= 0; i--) {
        if (this._seaQueue[i].t <= 0) {
          const q = this._seaQueue[i];
          this._fx.waterImpact(new BABYLON.Vector3(q.x, 0.5, q.z));
          this._seaQueue.splice(i, 1);
        }
      }
    }

    this._burstT += dt;
    const burstGap = 1 / this.burstRate;
    while (this._burstT >= burstGap) { this._burstT -= burstGap; this._burst(); }

    this._impactT += dt;
    const impGap = 1 / this.impactRate;
    while (this._impactT >= impGap && this._fx) {
      this._impactT -= impGap;
      const src = Math.random() < 0.5 ? this.friendly : this.enemy;
      const p = src[(Math.random() * src.length) | 0];
      this._v.set(p.x + rnd(-90, 90), p.y, p.z + rnd(-90, 90));
      const h = this._island.sample(this._v.x, this._v.z);
      if (h !== null && h !== undefined) this._v.y = h + 2;
      if (Math.random() < this.burstChanceBig) this._fx.ambientBurst(this._v.clone());
      else this._fx.ambientImpact(this._v.clone());
    }

    for (let i = this._live.length - 1; i >= 0; i--) {
      const t = this._live[i];
      t.t += dt;

      if (t.t < 0) continue;
      if (!t.mesh.isEnabled(false)) t.mesh.setEnabled(true);

      if (t.t >= t.life) {
        t.mesh.setEnabled(false);
        t.mesh._ambBusy = false;
        if (!t.ricochet && t.hits && this._fx && Math.random() < 0.10) {
          this._spawnImpact(t.target, t.side);
        }
        this._live.splice(i, 1);
        continue;
      }

      // Eigen snelheidsvector met zwaartekracht: baan en streekrichting lopen synchroon.
      t.vel.y -= GRAV * dt;
      t.pos.x += t.vel.x * dt;
      t.pos.y += t.vel.y * dt;
      t.pos.z += t.vel.z * dt;

      const sp = Math.hypot(t.vel.x, t.vel.y, t.vel.z) || 1;
      this._dir.set(t.vel.x / sp, t.vel.y / sp, t.vel.z / sp);

      // Middelpunt zodat de kop exact op de huidige positie zit (kop uit de vuurmond).
      this._mid.set(
        t.pos.x - this._dir.x * t.len * 0.5,
        t.pos.y - this._dir.y * t.len * 0.5,
        t.pos.z - this._dir.z * t.len * 0.5
      );
      t.mesh.position.copyFrom(this._mid);
      this._orient(t.mesh, this._dir, this._mid, t.len, t.thick);
    }

    for (let i = this._flashSprites.length - 1; i >= 0; i--) {
      const f = this._flashSprites[i];
      f.t += dt;

      if (f.t < 0) {
        f.s.isVisible = false;
        continue;
      }
      f.s.isVisible = true;

      const u = f.t / f.dur;
      if (u >= 1) { f.s.dispose(); this._flashSprites.splice(i, 1); continue; }
      f.s.cellIndex = Math.min((u * 30) | 0, 29);

      // Piek bij aanvang, dan licht krimpen en snel uitdoven.
      const sz = f.size * (1.0 - 0.45 * u);
      f.s.width = sz; f.s.height = sz;
      if (f.s.color) f.s.color.a = 1.0 - u * u;
    }
  }

  reset() {
    this._t = 0;
    this._burstT = 0;
    this._seaT = 0;
    this._impactT = 0;
    this._seaWacht = 3 + Math.random() * 3;
    this._seaQueue.length = 0;

    for (const t of this._live) {
      if (t.mesh) {
        t.mesh.setEnabled(false);
        t.mesh._ambBusy = false;
      }
    }
    this._live.length = 0;

    for (const f of this._flashSprites) {
      try { f.s.dispose(); } catch (_) {}
    }
    this._flashSprites.length = 0;
  }

  dispose() {
    for (const f of this._flashSprites) f.s.dispose();
    this._flashSprites.length = 0;
    this._flash.dispose();
    for (const k of ['friendly', 'enemy']) {
      const p = this._pools[k];
      if (p.tex) p.tex.dispose();
      p.list.forEach(m => m.dispose());
      p.master.dispose();
      p.mat.dispose();
    }
    this._live.length = 0;
  }
}
