// src/game/smokeCards.js
//
// M3.2: Lit rookpluimen zonder atlas. Elke pluim is een gebillboarde vlak-mesh met een
// procedureel gegenereerde diffuse/alpha-textuur én een bijpassende normal map, zodat de
// scene-belichting 'm oppakt als een gewoon belicht oppervlak.
//
// M3.3: fractal randdetail, gebakken AO en randlicht, fresnel-rim, tintbanden, windschering.
//
// M3.4: ARCHITECTUURWIJZIGING. De kolom is niet langer een eenmalige set van vijf eeuwige
// kaarten, maar een doorlopende emitter. Waarom de oude opzet faalde (zichtbaar op de
// testscreenshots na lange looptijd):
//   a. Vijf kaarten met life 10800 s en rise 0.15..0.25 m/s stijgen eeuwig door, elk in eigen
//      tempo. Na 20+ minuten hangt de kolom als een uit elkaar getrokken kralenketting honderden
//      meters boven het eiland en vult niets het gat bij de voet.
//   b. Groei stond op dur 1 s, dus er was geen zichtbare ontwikkeling, alleen dat eeuwige
//      omhoogkruipen.
//   c. Vijf zachte kaarten met gaten ertussen dekken nooit dicht genoeg voor een zware brand.
// Nieuw model per kolom:
//   - Pluimen ontstaan continu bij de voet, stijgen met een afremmend profiel (snel onderin,
//     traag bovenin, zoals hete rook die afkoelt), groeien tijdens de klim, waaien met de hoogte
//     mee in de systeembrede windrichting, en doven bovenin uit.
//   - Bij ontsteking wordt de kolom voorverwarmd: de pluimen krijgen gespreide startleeftijden,
//     dus de kolom staat er direct vol in plaats van pas na een pufflevensduur.
//   - Zolang de kolom brandt (het bestaande seconds-argument) worden gedoofde pluimen onderaan
//     vervangen. De kolom blijft daardoor onbeperkt coherent, zonder drift-schade.
//   - Tint verloopt met de klim: warm bij de vuurbron, koel grijs bovenin. Materiaalwissel per
//     band, geen per-frame allocatie.
// Publieke signaturen ongewijzigd: spawnColumn(pos, height, seconds) en spawn(pos, opts)
// bestaan nog precies zo, atlasFx.heavyColumn() hoeft niet te wijzigen.
//
// Performance-kaders: alle bake-kosten eenmalig bij constructie. In update(dt) geen allocaties;
// pluim-records worden gepoold en hergebruikt, net als de meshes. Eén respawn per kolom per
// circa 3 s is het enige "werk" buiten scalaire wiskunde.

const rnd = (a, b) => a + Math.random() * (b - a);

// M3.3: gedempte tintbanden. Index 0 warm (voet, nabij de vuurbron), 2 koel grijs (top).
// M5.0: twee paletten. 'grijs' is het bestaande brandprofiel. 'olie' is de vette, roetzwarte
// koolwaterstofrook van een brandend oliereservoir: vrijwel zwart bij de voet, donkergrijs
// bovenin waar de pluim afkoelt en uitregent. De gebakken diffuse (shade tot 235) wordt met
// deze kleur vermenigvuldigd, dus 0.09 betekent effectief bijna zwart met net genoeg toon om
// de gebakken AO en randen te laten leven: precies het 'alleen contouren zichtbaar' beeld.
const TINTSETS = {
  grijs: [
    new BABYLON.Color3(0.48, 0.41, 0.34),
    new BABYLON.Color3(0.44, 0.44, 0.45),
    new BABYLON.Color3(0.40, 0.43, 0.47),
  ],
  olie: [
    new BABYLON.Color3(0.11, 0.09, 0.08),
    new BABYLON.Color3(0.13, 0.13, 0.14),
    new BABYLON.Color3(0.18, 0.19, 0.21),
  ],
};

export class SmokeCardSystem {
  constructor(scene, opts = {}) {
    this._scene = scene;
    this._texSize = opts.texSize ?? 384;
    this._variantCount = opts.variants ?? 6;
    this._maxPool = opts.maxPool ?? 240;   // M5.4: ruimte voor slierten en wrakkolommen
    this._fresnelRim = opts.fresnelRim ?? true;
    this._puffsPerColumn = opts.puffsPerColumn ?? 12;   // M3.4: dekkingsgraad per kolom

    // M3.3: één windrichting per systeem, alle kolommen leunen dezelfde kant op.
    const wa = Math.random() * Math.PI * 2;
    this._windX = Math.cos(wa);
    this._windZ = Math.sin(wa);

    this._pool = [];
    this._active = [];      // losse lobben via spawn(), ongewijzigde legacy-route
    this._columns = [];     // M3.4: emitters
    this._puffs = [];       // M3.4: levende kolompluimen
    this._recPool = [];     // M3.4: hergebruik van pluim-records, geen allocatie in update
    this._haze = [];        // M5.0: permanente damplaag-kaarten rond het eiland
    this._hazeMats = [];    // M5.2: materiaalklonen per bank, voor de zonglans
    this._hazeMult = 1;     // M5.0: dekkingsfactor voor de damplaag (DevPanel-slider)
    this._materials = {};   // M5.0: { grijs: [band][variant], olie: [band][variant] }
    this._textures = [];

    this._buildVariants();
  }

  // M3.3, materiaalkeuze: bewust StandardMaterial, geen PBRMaterial. Rook is een verstrooiend
  // volume waar geen van beide BRDF's fysisch voor klopt; de geloofwaardigheid komt uit de bake.
  // PBR op grote overlappende alpha-kaarten betekent IBL-sampling per fragment bij forse
  // overdraw, de duurste plek op mobiele WebGPU. Migratiepad staat hieronder als comment.
  // (PBRMaterial met metallic 0, roughness 1, albedoTexture plus bumpTexture, zelfde alpha-opzet.)
  _buildVariants() {
    const texPairs = [];
    for (let i = 0; i < this._variantCount; i++) {
      const pair = this._bakeCard(this._texSize, 7331 + i * 9187);
      texPairs.push(pair);
      this._textures.push(pair.diffuse, pair.normal);
    }

    for (const [setNaam, tinten] of Object.entries(TINTSETS)) {
    const bank = [];
    this._materials[setNaam] = bank;
    for (let b = 0; b < tinten.length; b++) {
      const row = [];
      for (let i = 0; i < this._variantCount; i++) {
        const { diffuse, normal } = texPairs[i];
        const mat = new BABYLON.StandardMaterial('smokeCard_' + setNaam + b + '_' + i, this._scene);
        mat.diffuseTexture = diffuse;
        mat.opacityTexture = diffuse;
        mat.bumpTexture = normal;
        mat.diffuseColor = tinten[b];
        mat.specularColor = new BABYLON.Color3(0.03, 0.03, 0.03);
        mat.specularPower = 6;
        mat.backFaceCulling = false;
        mat.disableLighting = false;
        mat.useAlphaFromDiffuseTexture = true;
        mat.alphaMode = BABYLON.Constants.ALPHA_COMBINE;

        // M3.3: kijkrichting-afhankelijke rand via de bump-verstoorde normal. De gebakken rand
        // in de diffuse is de hoofdterm; dit voegt de view-afhankelijkheid toe. Opt-out via
        // opts.fresnelRim: false.
        if (this._fresnelRim) {
          const fr = new BABYLON.FresnelParameters();
          fr.isEnabled = true;
          // M5.0: de rim schaalt mee met het palet. Op de olie-rook is een gedempte, koele rim
          // precies wat het silhouet leesbaar houdt tegen de lucht: de massa blijft zwart,
          // alleen de bloemkoolcontour vangt licht. Dit is het 'alleen contouren' effect.
          const dim = setNaam === 'olie' ? 0.55 : 1.0;
          fr.leftColor = new BABYLON.Color3(0.20 * dim, 0.21 * dim, 0.24 * dim);
          fr.rightColor = BABYLON.Color3.Black();
          fr.bias = 0.12;
          fr.power = 2.2;
          mat.emissiveFresnelParameters = fr;
          // M5.3: onveranderlijke basiswaarde voor de tegenlicht-aansturing in update().
          mat._rimBase = new BABYLON.Color3(0.20 * dim, 0.21 * dim, 0.24 * dim);
        }
        row.push(mat);
      }
      bank.push(row);
    }
    }
  }

  // Dichtheidsveld uit overlappende bollen, alpha uit de gesommeerde dichtheid, normal map uit
  // de gradient. M3.3: drie blob-schalen, gebakken AO uit een geblurde kopie, gebakken randlicht.
  // M3.4-fixes op basis van de testscreenshots:
  //   - Het randdetail wordt nu gemaskeerd door het basisveld (detail telt alleen mee waar de
  //     grote lobben al dichtheid hebben). In M3.3 konden losse randbolletjes buiten het
  //     silhouet vallen en als zwevende spikkels renderen; dat is hiermee onmogelijk.
  //   - De alphacurve is dikker gemaakt (hogere kern, iets vroegere drempel), want de pluimen
  //     oogden te ijl tegen de lichte lucht.
  _bakeCard(N, seed) {
    let s = seed >>> 0;
    const rndL = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };

    const base = new Float32Array(N * N);
    const det = new Float32Array(N * N);

    const stamp = (field, bx, by, r, amp) => {
      const r2 = r * r;
      const x0 = Math.max(0, (bx - r) | 0), x1 = Math.min(N - 1, (bx + r) | 0);
      const y0 = Math.max(0, (by - r) | 0), y1 = Math.min(N - 1, (by + r) | 0);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - bx, dy = y - by;
          const d2 = dx * dx + dy * dy;
          if (d2 < r2) {
            const f = 1 - d2 / r2;
            field[y * N + x] += amp * f * f;
          }
        }
      }
    };

    // Schaal 1: grote lobben, in het basisveld.
    const cx0 = N * 0.5, cy0 = N * 0.55;
    const bigs = [];
    for (let b = 0; b < 22; b++) {
      const bx = cx0 + (rndL() - 0.5) * N * 0.55;
      const by = cy0 + (rndL() - 0.5) * N * 0.64;
      const r = N * (0.11 + rndL() * 0.17);
      const amp = 0.6 + rndL() * 0.6;
      stamp(base, bx, by, r, amp);
      bigs.push({ bx, by, r });
    }

    // M3.3, fractal detail, nu in een apart veld dat straks door base wordt gemaskeerd.
    for (const g of bigs) {
      for (let k = 0; k < 2; k++) {   // middenschaal: interne plooien
        const ang = rndL() * Math.PI * 2;
        const d = g.r * (0.20 + rndL() * 0.45);
        stamp(det, g.bx + Math.cos(ang) * d, g.by + Math.sin(ang) * d,
              g.r * (0.30 + rndL() * 0.25), 0.42 + rndL() * 0.30);
      }
      for (let k = 0; k < 4; k++) {   // randschaal: de bloemkoolkarteling
        const ang = rndL() * Math.PI * 2;
        const d = g.r * (0.72 + rndL() * 0.36);
        stamp(det, g.bx + Math.cos(ang) * d, g.by + Math.sin(ang) * d,
              g.r * (0.14 + rndL() * 0.16), 0.30 + rndL() * 0.26);
      }
    }

    // M3.4: samenstellen met detailmasker. Detail draagt alleen bij waar de basis al rook heeft,
    // met een zachte overgang, dus karteling op de rand maar nooit losse spikkels ernaast.
    const density = base;   // hergebruik van de buffer, base wordt in-place het eindveld
    for (let i = 0; i < density.length; i++) {
      const m = Math.min(1, base[i] * 2.2);
      density[i] = base[i] + det[i] * m;
    }

    let maxD = 1e-5;
    for (let i = 0; i < density.length; i++) if (density[i] > maxD) maxD = density[i];

    // M3.3: AO-veld via separabele box blur (lopende som). Diep in de massa donker, randen licht.
    const R = Math.max(4, N >> 5);
    const tmp = new Float32Array(N * N);
    const occ = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      const row = y * N;
      let acc = 0;
      for (let i = -R; i <= R; i++) acc += density[row + Math.min(N - 1, Math.max(0, i))];
      for (let x = 0; x < N; x++) {
        tmp[row + x] = acc;
        acc += density[row + Math.min(N - 1, x + R + 1)] - density[row + Math.max(0, x - R)];
      }
    }
    for (let x = 0; x < N; x++) {
      let acc = 0;
      for (let i = -R; i <= R; i++) acc += tmp[Math.min(N - 1, Math.max(0, i)) * N + x];
      for (let y = 0; y < N; y++) {
        occ[y * N + x] = acc;
        acc += tmp[Math.min(N - 1, y + R + 1) * N + x] - tmp[Math.max(0, y - R) * N + x];
      }
    }
    let maxOcc = 1e-5;
    for (let i = 0; i < occ.length; i++) if (occ[i] > maxOcc) maxOcc = occ[i];

    const diffData = new Uint8Array(N * N * 4);
    const normData = new Uint8Array(N * N * 4);

    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const d = density[i] / maxD;

        // M3.4: dikkere alphacurve. Machtsverheffing tilt de middendichtheden op, zodat het
        // lijf van de pluim dekt en alleen de buitenste rand doorschijnend blijft.
        const a = Math.max(0, Math.min(1, Math.pow(d, 0.85) * 1.9 - 0.06));

        const ao = Math.pow(occ[i] / maxOcc, 1.25);
        const rim = Math.pow(Math.max(0, 1 - d * 1.35), 2.5) * Math.min(a * 3.5, 1);

        const topDark = 1 - (y / N) * 0.22;
        let v = 235 * topDark * (1 - 0.48 * ao) + 85 * rim;
        if (v > 255) v = 255;
        const shade = v | 0;

        const di = i * 4;
        diffData[di] = shade;
        diffData[di + 1] = shade;
        diffData[di + 2] = Math.min(255, shade + 3 + ((ao * 8) | 0));  // lichte blauwzweem in schaduw
        diffData[di + 3] = Math.round(a * 255);

        const xm = density[y * N + Math.max(0, x - 1)] / maxD;
        const xp = density[y * N + Math.min(N - 1, x + 1)] / maxD;
        const ym = density[Math.max(0, y - 1) * N + x] / maxD;
        const yp = density[Math.min(N - 1, y + 1) * N + x] / maxD;
        const nx = (xm - xp) * 3.0;
        const ny = (ym - yp) * 3.0;
        const nz = 1.0;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        normData[di]     = Math.round((nx / len * 0.5 + 0.5) * 255);
        normData[di + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
        normData[di + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
        normData[di + 3] = 255;
      }
    }

    const diffuse = new BABYLON.RawTexture(diffData, N, N, BABYLON.Constants.TEXTUREFORMAT_RGBA,
      this._scene, false, false, BABYLON.Texture.BILINEAR_SAMPLINGMODE);
    const normal = new BABYLON.RawTexture(normData, N, N, BABYLON.Constants.TEXTUREFORMAT_RGBA,
      this._scene, false, false, BABYLON.Texture.BILINEAR_SAMPLINGMODE);
    diffuse.hasAlpha = true;
    diffuse.wrapU = diffuse.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
    normal.wrapU = normal.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
    return { diffuse, normal };
  }

  _take() {
    for (const p of this._pool) if (!p._busy) return p;
    if (this._pool.length >= this._maxPool) return null;
    const mesh = BABYLON.MeshBuilder.CreatePlane('smokeCard' + this._pool.length,
      { size: 1 }, this._scene);
    mesh.isPickable = false;
    mesh.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    mesh.renderingGroupId = 1;
    mesh._busy = false;
    mesh.setEnabled(false);
    this._pool.push(mesh);
    return mesh;
  }

  // ── Legacy-route: losse lobbe met vaste levensloop, API ongewijzigd sinds M3.2. ────────────
  // spawnColumn gebruikt deze route sinds M3.4 niet meer, maar de methode blijft voor
  // bestaande en toekomstige losse aanroepen exact hetzelfde werken.
  spawn(pos, opts = {}) {
    const mesh = this._take();
    if (!mesh) return null;

    mesh._busy = true;
    mesh.setEnabled(true);

    const tint = opts.tint ?? 0.5;
    const band = tint < 0.34 ? 0 : (tint < 0.67 ? 1 : 2);
    const row = this._materials.grijs[band];
    mesh.material = row[(Math.random() * row.length) | 0];

    mesh.position.copyFrom(pos);
    mesh.rotation.z = opts.angle ?? rnd(-0.3, 0.3);
    mesh.visibility = 0;

    const size0 = opts.size0 ?? 40, size1 = opts.size1 ?? 100;
    const flip = Math.random() < 0.5 ? -1 : 1;
    mesh.scaling.set(size0 * flip, size0, size0);

    this._active.push({
      mesh, t: 0,
      dur: opts.dur ?? 1,
      life: opts.life ?? 60,
      size0, size1,
      growPow: opts.growPow ?? 0.2,
      rise: opts.rise ?? 0.2,
      angVel: opts.angVel ?? rnd(-0.01, 0.01),
      maxAlpha: opts.maxAlpha ?? 0.9,
      fadeHead: opts.fadeHead ?? 0.03,
      fadeTail: opts.fadeTail ?? 0.10,
      flip,
      x0: pos.x, z0: pos.z,
      shear: opts.shear ?? 0,
      shearTau: opts.shearTau ?? 45,
    });
    return mesh;
  }

  // ── M3.4: kolom als doorlopende emitter. Signatuur ongewijzigd, heavyColumn() in atlasFx.js
  // blijft hier onveranderd op aansluiten. `seconds` is nu de branduur van de emitter; pluimen
  // die bij het doven nog leven maken hun eigen levensloop af, dus de kolom sterft natuurlijk
  // uit in plaats van in één klap te verdwijnen. ─────────────────────────────────────────────
  // M5.0: opts maakt brandprofielen mogelijk. Zonder opts is het gedrag identiek aan M3.4.
  //   dekking     aantal pluimen in de kolom (default this._puffsPerColumn)
  //   breedte0/1  kaartgrootte als fractie van de hoogte, voet en top (default 0.26 / 0.60)
  //   lifeMult    pluim-levensduurfactor; hoger = tragere klim, dus nauwelijks zichtbare
  //               beweging bij gelijke hoogte (default 1)
  //   alpha       maximale dekking per kaart (default 0.95)
  //   leanMult    windschering-factor (default 1)
  //   tintSet     'grijs' of 'olie' (default 'grijs')
  //   topWiden    extra verbreding van de top, het aambeeld uit de referentiefoto's van
  //               pyrocumulus boven oliebranden (default 0, mega gebruikt ~1.4)
  //   fadeTop     vanaf welke levensfractie de top uitdooft (default 0.70; mega 0.86 zodat
  //               het aambeeld dik blijft in plaats van ijl uit te waaieren)
  //   angVelMult  rotatiesnelheidsfactor; laag bij mega, grote massa's tollen niet (default 1)
  spawnColumn(pos, height = 260, seconds = 10800, opts = {}) {
    // Pufflevensduur: klim van 0.9x hoogte met gemiddeld 6 a 8 m/s, dus zware kolommen leven
    // iets langer per pluim. Bij height 280 is dat ongeveer 34 s.
    const puffLife = (22 + height * 0.045) * (opts.lifeMult ?? 1);
    const count = opts.dekking ?? this._puffsPerColumn;

    const col = {
      x: pos.x, y: pos.y, z: pos.z,
      height,
      puffLife,
      interval: puffLife / count,
      emitT: 0,
      age: 0,
      emitFor: seconds,
      shear: height * 0.45 * (opts.leanMult ?? 1),
      breedte0: opts.breedte0 ?? 0.26,
      breedte1: opts.breedte1 ?? 0.60,
      alpha: opts.alpha ?? 0.95,
      tintSet: opts.tintSet ?? 'grijs',
      topWiden: opts.topWiden ?? 0,
      fadeTop: opts.fadeTop ?? 0.70,
      angVelMult: opts.angVelMult ?? 1,
      // M5.2: horizontale spreiding van de pluimvoeten als fractie van de hoogte. De oude
      // vaste 0.06 zette bij een kolom van 1500 m de voeten tot 90 m uit elkaar; samen met
      // de dubbele klimsnelheid onderin (ease-out) las de voet als losse plukjes. Dichte
      // kolommen gebruiken nu 0.02 tot 0.04.
      jitter: opts.jitter ?? 0.06,
    };
    this._columns.push(col);

    // Voorverwarmen: gespreide startleeftijden zodat de kolom er direct vol staat, alsof de
    // brand al uren woedt. Er is geen opbouwperiode; frame 1 toont de volgroeide kolom.
    for (let i = 0; i < count; i++) {
      this._emitPuff(col, (i / count) * puffLife);
    }
    return col;   // M5.8: handle voor removeColumn (sweeps spawnen en ruimen testkolommen)
  }

  // M5.8: kolom plus al zijn levende pluimen per direct opruimen. Zelfde recyclingpad als de
  // natuurlijke pluimdood in update(), dus pool en recordpool blijven kloppen.
  removeColumn(col) {
    const i = this._columns.indexOf(col);
    if (i >= 0) this._columns.splice(i, 1);
    for (let j = this._puffs.length - 1; j >= 0; j--) {
      const r = this._puffs[j];
      if (r.col !== col) continue;
      if (r.mesh) { r.mesh.setEnabled(false); r.mesh._busy = false; r.mesh = null; }
      this._recPool.push(r);
      this._puffs.splice(j, 1);
    }
  }

  // M3.4: één kolompluim. Records komen uit _recPool zodat de doorlopende emissie geen
  // allocatiedruk geeft; alleen als de pool leeg is wordt een nieuw record gemaakt, en dat
  // gebeurt in de praktijk alleen tijdens het voorverwarmen.
  _emitPuff(col, age = 0) {
    const mesh = this._take();
    if (!mesh) return;

    let r = this._recPool.pop();
    if (!r) r = {};

    r.mesh = mesh;
    r.col = col;   // M5.8: eigenaar, voor removeColumn
    r.t = age;
    r.life = col.puffLife;
    r.x0 = col.x + rnd(-1, 1) * col.height * col.jitter;
    r.z0 = col.z + rnd(-1, 1) * col.height * col.jitter;
    r.yBase = col.y;
    r.climb = col.height * 0.92;
    r.size0 = col.height * col.breedte0;
    r.size1 = col.height * col.breedte1;
    r.shear = col.shear;
    r.maxAlpha = col.alpha;
    r.tintSet = col.tintSet;
    r.topWiden = col.topWiden;
    r.fadeTop = col.fadeTop;
    r.angVel = rnd(-0.015, 0.015) * col.angVelMult;
    r.flip = Math.random() < 0.5 ? -1 : 1;
    r.variant = (Math.random() * this._variantCount) | 0;
    r.band = -1;   // forceert materiaaltoewijzing in de eerste update-tick

    mesh._busy = true;
    mesh.setEnabled(true);
    mesh.rotation.z = rnd(-0.4, 0.4);
    mesh.visibility = 0;
    mesh.position.set(r.x0, r.yBase, r.z0);
    mesh.scaling.set(r.size0 * r.flip, r.size0, r.size0);

    this._puffs.push(r);
  }

  // ── M5.0: damplaag. Permanente, traag drijvende smog rond het eiland, alsof er al uren
  // non-stop wordt gevochten. Grote kaarten, lage dekking, laag boven het terrein. De kaarten
  // lussen eindeloos langs de systeemwind (zie update), dus de laag is er altijd en beweegt
  // net genoeg om te leven. Aanroepen bij de spelstart; er is geen opbouwfase. ────────────────
  //   center  Vector3, middelpunt (eilandcentrum)
  //   radius  spreidingsstraal in meters
  //   opts.count       aantal kaarten (default 10)
  //   opts.yMin/yMax   hoogteband boven center.y (default 25..130 m)
  //   opts.sizeMin/Max kaartgrootte (default 420..900 m)
  //   opts.alphaMin/Max dekking per kaart (default 0.05..0.13; de laag als geheel leest
  //                    aanzienlijk dikker door overlap)
  // M5.2: herontwerp. Meer en fors grotere banken (tot 1400 m), lager boven het terrein, en
  // verdeeld over een ruimere straal, zodat het als mistbanken over het HELE eiland leest in
  // plaats van een plaatselijk plukje. Elke bank krijgt een eigen materiaalkloon met een
  // per-frame aangestuurde emissive: kijk je door een bank richting de zon, dan gloeit hij
  // warm op (voorwaartse verstrooiing, het klassieke zonlicht-door-mist effect). Dat is de
  // gevraagde shader-look zonder een custom shader: 16 kleurtoewijzingen per frame, nul
  // allocaties, en StandardMaterial blijft het belichtingswerk doen.
  spawnHaze(center, radius, opts = {}) {
    const count = opts.count ?? 16;
    for (let i = 0; i < count; i++) {
      const mesh = this._take();
      if (!mesh) break;
      mesh._busy = true;
      mesh.setEnabled(true);

      const ang = rnd(0, Math.PI * 2);
      const d = Math.sqrt(Math.random()) * radius;
      const size = rnd(opts.sizeMin ?? 600, opts.sizeMax ?? 1400);

      // Band 1 of 2 van het grijze palet: koel, kleurloos, geen warme voettint in de smog.
      // Kloon per bank: de zonglans stuurt emissiveColor per kaart aan, dat kan niet op een
      // gedeeld materiaal. De fresnel-rim gaat op de kloon uit; een mistbank heeft geen
      // bloemkoolcontour nodig en de rim zou met de emissive interfereren.
      const band = 1 + ((Math.random() * 2) | 0);
      const row = this._materials.grijs[band];
      const mat = row[(Math.random() * row.length) | 0].clone('hazeM' + this._haze.length);
      mat.emissiveFresnelParameters = null;
      mat.emissiveColor = new BABYLON.Color3(0, 0, 0);
      this._hazeMats.push(mat);
      mesh.material = mat;
      // M5.4: stretch > 1 maakt van de bank een langgerekte, lage sliert (rook die van het
      // eiland over het water drijft). Slierten blijven vrijwel horizontaal: nauwelijks
      // startrotatie en een vijfde van de draaisnelheid, anders worden het diagonale vegen.
      const stretch = opts.stretch ?? 1;
      mesh.rotation.z = stretch > 1 ? rnd(-0.08, 0.08) : rnd(0, Math.PI * 2);
      mesh.scaling.set(size * stretch * (Math.random() < 0.5 ? -1 : 1),
                       size * (stretch > 1 ? 0.45 : 1), size);
      mesh.visibility = 0;

      this._haze.push({
        mesh, mat,
        cx: center.x + Math.cos(ang) * d,
        cz: center.z + Math.sin(ang) * d,
        y: center.y + rnd(opts.yMin ?? 12, opts.yMax ?? 90),
        L: radius * 1.6,
        speed: rnd(2.0, 4.5),
        phase: Math.random(),
        wob: rnd(8, 26),
        bob: rnd(3, 10),
        angVel: rnd(-0.004, 0.004) * ((opts.stretch ?? 1) > 1 ? 0.2 : 1),
        alpha: rnd(opts.alphaMin ?? 0.06, opts.alphaMax ?? 0.15),
        t: rnd(0, 600),   // gespreide startfase: de laag staat er vanaf frame 1 volgroeid
      });
    }
  }

  // M5.0: dekkingsfactor voor de damplaag, 0 = uit, 1 = ontwerpwaarde, 2 = dubbel. Voor de
  // DevPanel-slider; werkt live, elke update-tick past hem toe.
  setHazeOpacity(m) { this._hazeMult = Math.max(0, m); }
  getHazeOpacity() { return this._hazeMult; }

  update(dt) {
    if (dt <= 0) return;
    if (dt > 0.5) dt = 0.5;   // M5.2: vangnet naast de klem in atlasFx

    // ── M3.4: emitters. Zolang de kolom brandt komen er onderaan pluimen bij. ──
    for (let i = this._columns.length - 1; i >= 0; i--) {
      const c = this._columns[i];
      c.age += dt;
      if (c.age >= c.emitFor) { this._columns.splice(i, 1); continue; }
      c.emitT += dt;
      while (c.emitT >= c.interval) {
        c.emitT -= c.interval;
        this._emitPuff(c, 0);
      }
    }

    // ── M3.4: kolompluimen. Alleen scalaire wiskunde, records en meshes worden hergebruikt. ──
    for (let i = this._puffs.length - 1; i >= 0; i--) {
      const r = this._puffs[i];
      r.t += dt;

      if (r.t >= r.life) {
        r.mesh.setEnabled(false);
        r.mesh._busy = false;
        r.mesh = null;
        this._recPool.push(r);
        this._puffs.splice(i, 1);
        continue;
      }

      const p = r.t / r.life;

      // Klim met ease-out: snel bij de hete voet, uitdovend bovenin waar de rook afkoelt.
      const pe = 1 - (1 - p) * (1 - p);
      const y = r.yBase + r.climb * pe;

      // Windschering: offset groeit bovenmatig met de klim, dus de top leunt duidelijk zwaarder
      // dan de voet en de kolom krijgt de kromme lean uit de referenties.
      const k = Math.pow(p, 1.6);
      r.mesh.position.set(
        r.x0 + this._windX * r.shear * k,
        y,
        r.z0 + this._windZ * r.shear * k);

      // Groei tijdens de klim, met de snelste expansie vlak boven de bron.
      let size = r.size0 + (r.size1 - r.size0) * Math.pow(p, 0.6);

      // M5.0: aambeeldverbreding. Boven 62 procent van de klim zwelt de kaart kwadratisch
      // door tot (1 + topWiden) keer de normale maat. De hete kern schiet omhoog, botst boven
      // op zijn eigen afgekoelde rook en spreidt horizontaal uit: de paddenstoelvorm uit de
      // referentiefoto. topWiden 0 (default) is exact het oude gedrag.
      if (r.topWiden > 0 && p > 0.62) {
        const tw = (p - 0.62) / 0.38;
        size *= 1 + r.topWiden * tw * tw;
      }
      r.mesh.scaling.set(size * r.flip, size, size);
      r.mesh.rotation.z += r.angVel * dt;

      // Tintband verloopt met de klim: warm onderin, koel bovenin. Wissel is een toewijzing
      // van een bestaand gedeeld materiaal, geen allocatie.
      const band = p < 0.30 ? 0 : (p < 0.62 ? 1 : 2);
      if (band !== r.band) {
        r.band = band;
        r.mesh.material = this._materials[r.tintSet || 'grijs'][band][r.variant];
      }

      // Snel indekken bij de voet, lange uitdoving bovenin. fadeTop bepaalt waar de uitdoving
      // begint; de megakolom houdt zo een dik aambeeld in plaats van een ijl uitgewaaierde top.
      const ft = r.fadeTop ?? 0.70;
      let al = r.maxAlpha * (1 - 0.25 * p);
      if (p < 0.08) al *= p / 0.08;
      if (p > ft) al *= 1 - (p - ft) / (1 - ft);
      r.mesh.visibility = al;
    }

    // ── M5.0: damplaag. Elke kaart doorloopt een eindeloze lus langs de windrichting over een
    // baan van lengte L; de dekking is een sinusvenster over die lus, dus kaarten faden in aan
    // de loefzijde en uit aan de lijzijde zonder ooit te poppen. Puur scalair, geen allocatie. ──
    // M5.2: zonrichting en camerapositie 1 keer per tick voor de zonglans van de banken.
    // M5.3: ook gebruikt voor de zilveren randen van de rookkolommen, dus de opzoek gebeurt
    // zodra er banken OF kolommen leven.
    let sx = 0, sy = 0, sz = 0, cpx = 0, cpy = 0, cpz = 0, glansKlaar = false;
    if (this._haze.length || this._columns.length) {
      if (!this._sunRef || this._sunRef._isDisposed) {
        this._sunRef = null;
        const lights = this._scene.lights || [];
        for (const l of lights) {
          if (l.getClassName && l.getClassName() === 'DirectionalLight') { this._sunRef = l; break; }
        }
      }
      const cam = this._scene.activeCamera;
      if (this._sunRef && cam) {
        // Lichtrichting wijst van zon naar wereld; naar de zon toe is de inverse.
        sx = -this._sunRef.direction.x; sy = -this._sunRef.direction.y; sz = -this._sunRef.direction.z;
        const sl = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
        sx /= sl; sy /= sl; sz /= sl;
        const cp = cam.globalPosition || cam.position;
        cpx = cp.x; cpy = cp.y; cpz = cp.z;
        glansKlaar = true;
      }
    }

    // ── M5.3: zilveren randen. Fysische basis: rook is optisch dik, maar de dunne buitenrand
    // verstrooit zonlicht voorwaarts naar de kijker zodra de zon er ACHTER staat, het klassieke
    // silver lining effect. Implementatie: de fresnel-rim die de silhouetten al tekent krijgt
    // per frame een kleur die meeloopt met de uitlijning tussen kijklijn (camera naar het
    // zwaartepunt van de kolommen) en zonrichting. Vol tegenlicht: warm oplichtende contouren
    // rond zwarte massa's. Zon opzij of in de rug: exact de oude, koele basisrim. Kosten: 36
    // kleurtoewijzingen op gedeelde materialen per frame, geen klonen, geen extra draws. ──
    if (this._fresnelRim && glansKlaar && this._columns.length) {
      let fx = 0, fy = 0, fz = 0;
      for (const c of this._columns) { fx += c.x; fy += c.y + c.height * 0.5; fz += c.z; }
      const n = this._columns.length;
      fx /= n; fy /= n; fz /= n;
      let vx = fx - cpx, vy = fy - cpy, vz = fz - cpz;
      const vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
      const uitlijning = Math.max(0, (vx * sx + vy * sy + vz * sz) / vl);
      // Macht 4: de gloed leeft in een ruime tegenlichtkegel maar domineert alleen vlak rond
      // de zon. Geschaald met de lichtsterkte zodat een gedoofde of gedimde zon geen rand geeft.
      let g = Math.pow(uitlijning, 4) * 0.9;
      if (this._sunRef) g *= Math.min(1, (this._sunRef.intensity || 0) / 2);
      for (const bank of Object.values(this._materials)) {
        for (const row of bank) {
          for (const m of row) {
            const fr = m.emissiveFresnelParameters;
            if (!fr || !m._rimBase) continue;
            fr.leftColor.set(
              m._rimBase.r + 0.85 * g,
              m._rimBase.g + 0.58 * g,
              m._rimBase.b + 0.32 * g);
          }
        }
      }
    }

    for (const hz of this._haze) {
      hz.t += dt;
      const f = (hz.t * hz.speed / hz.L + hz.phase) % 1;
      const langs = (f - 0.5) * hz.L;
      hz.mesh.position.set(
        hz.cx + this._windX * langs + Math.sin(hz.t * 0.031 + hz.phase * 9) * hz.wob,
        hz.y + Math.sin(hz.t * 0.043 + hz.phase * 17) * hz.bob,
        hz.cz + this._windZ * langs + Math.cos(hz.t * 0.027 + hz.phase * 7) * hz.wob);
      hz.mesh.rotation.z += hz.angVel * dt;
      const venster = Math.sin(f * Math.PI);
      hz.mesh.visibility = hz.alpha * Math.sqrt(venster) * this._hazeMult;

      // Zonglans: uitlijning tussen kijklijn (camera naar bank) en zonrichting. Macht 6 houdt
      // de glans in een kegel van grofweg 30 graden rond de zon; banken opzij blijven koel
      // grijs. Schaal met het lusvenster zodat een infadende bank ook zachtjes ingloeit.
      if (glansKlaar) {
        let vx = hz.mesh.position.x - cpx, vy = hz.mesh.position.y - cpy, vz = hz.mesh.position.z - cpz;
        const vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
        const a = Math.max(0, (vx * sx + vy * sy + vz * sz) / vl);
        const g = Math.pow(a, 6) * 0.55 * venster * this._hazeMult;
        hz.mat.emissiveColor.set(0.62 * g, 0.46 * g, 0.28 * g);
      }
    }

    // ── Legacy: losse lobben via spawn(), gedrag ongewijzigd sinds M3.3. ──
    for (let i = this._active.length - 1; i >= 0; i--) {
      const a = this._active[i];
      a.t += dt;

      if (a.t >= a.life) {
        a.mesh.setEnabled(false);
        a.mesh._busy = false;
        this._active.splice(i, 1);
        continue;
      }

      const T = a.t / a.life;
      const g = a.growPow === 1 ? Math.min(a.t / a.dur, 1) : Math.pow(Math.min(a.t / a.dur, 1), a.growPow);
      const size = a.size0 + (a.size1 - a.size0) * g;
      a.mesh.scaling.set(size * a.flip, size, size);
      a.mesh.position.y += a.rise * dt;
      a.mesh.rotation.z += a.angVel * dt;

      if (a.shear !== 0) {
        const k = 1 - Math.exp(-a.t / a.shearTau);
        a.mesh.position.x = a.x0 + this._windX * a.shear * k;
        a.mesh.position.z = a.z0 + this._windZ * a.shear * k;
      }

      let al = a.maxAlpha;
      if (a.fadeHead > 0 && T < a.fadeHead) al *= T / a.fadeHead;
      if (a.fadeTail > 0 && T > 1 - a.fadeTail) {
        const x = (T - (1 - a.fadeTail)) / a.fadeTail;
        al *= Math.max(0, 1 - x);
      }
      a.mesh.visibility = al;
    }
  }

  resetTransient() {
    for (const a of this._active) {
      if (!a.mesh) continue;
      a.mesh.setEnabled(false);
      a.mesh._busy = false;
    }
    this._active.length = 0;
  }

  dispose() {
    for (const a of this._active) a.mesh.setEnabled(false);
    this._active.length = 0;
    for (const r of this._puffs) if (r.mesh) r.mesh.setEnabled(false);
    this._puffs.length = 0;
    for (const hz of this._haze) hz.mesh.setEnabled(false);
    this._haze.length = 0;
    for (const m of this._hazeMats) m.dispose();
    this._hazeMats.length = 0;
    this._columns.length = 0;
    this._recPool.length = 0;
    for (const p of this._pool) p.dispose();
    this._pool.length = 0;
    for (const bank of Object.values(this._materials)) for (const row of bank) for (const m of row) m.dispose();
    this._materials = {};
    this._textures.forEach(t => t.dispose());
    this._textures.length = 0;
  }
}
