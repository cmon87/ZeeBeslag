// src/environment/megaPlume.js
//
// M5.7 - Achtergrondpluim uit video-atlas (Rookver1).
//
// Een monumentale rookkolom van ruim 2 kilometer hoog achter het eiland, gebouwd uit een
// 4x4 atlas (models/rookatlas.png) die uit 16 gekeyde videoframes bestaat: echte
// pyrocumulus-billowing met vuurgloed aan de voet, tegen transparant.
//
// Weergavetechniek: TWEE gestapelde Y-billboards op dezelfde plek. Plaat A toont atlascel i,
// plaat B cel i+1, en hun dekkingen crossfaden in ~9 seconden van A naar B. Daarna schuift
// het venster een cel op. De reeks wordt ping-pong doorlopen (0..15..0), dus er bestaat geen
// lusnaad. Zestien cellen keer 9 seconden heen en terug is een cyclus van bijna 5 minuten:
// de pluim leeft zichtbaar maar beweegt zo traag als een gebergte, exact het gewenste
// megakolom-gevoel. Y-billboard (alleen om de verticale as) zodat een kolom van 2 km niet
// meekantelt met de camerapitch.
//
// Kosten: 2 draw calls, 1 texture van 1024x2048, en per frame 1 scalaire crossfade.
//
// Gebruik vanuit main.js, na de eilandload:
//   megaPlume = buildMegaPlume({ scene, islandCenter, pushLog });
//   megaPlume.setEnabled(false);   // toggle in het hoofdmenu
//   megaPlume.dispose();

const CELLEN = 16, KOLOMMEN = 4, RIJEN = 4;
const STAP_DUUR = 9;          // seconden per celovergang
const HOOGTE = 2200;          // meter
const BREEDTE = HOOGTE * 0.5; // celverhouding 256x512

export function buildMegaPlume({ scene, islandCenter, pushLog, url = './models/rookatlas.png' }) {
  const log = pushLog || (() => {});
  const c = islandCenter || new BABYLON.Vector3(3200, 0, 0);

  // Achter het eiland vanaf de speler gezien: het eilandcentrum ligt van de oorsprong af,
  // dus doorschuiven langs diezelfde richting zet de pluim erachter. De bergrug snijdt de
  // voet af, wat de schaalillusie juist versterkt.
  const l = Math.sqrt(c.x * c.x + c.z * c.z) || 1;
  const px = c.x + (c.x / l) * 1150;
  const pz = c.z + (c.z / l) * 1150 - 450;   // iets uit de richtas, niet pal achter het vizier

  const maakPlaat = (naam) => {
    const mesh = BABYLON.MeshBuilder.CreatePlane(naam, { width: BREEDTE, height: HOOGTE }, scene);
    mesh.position.set(px, HOOGTE * 0.5 - 60, pz);   // voet net onder de horizon/rug
    mesh.billboardMode = BABYLON.Mesh.BILLBOARDMODE_Y;
    mesh.isPickable = false;
    mesh.renderingGroupId = 1;

    const tex = new BABYLON.Texture(url, scene, false, false, BABYLON.Texture.BILINEAR_SAMPLINGMODE);
    tex.hasAlpha = true;
    tex.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
    tex.uScale = 1 / KOLOMMEN;
    tex.vScale = 1 / RIJEN;

    const mat = new BABYLON.StandardMaterial(naam + 'M', scene);
    mat.diffuseTexture = tex;
    mat.opacityTexture = tex;
    mat.specularColor = BABYLON.Color3.Black();
    // Lichte emissieve vloer: de gebakken vuurgloed en plooien blijven ook bij lage
    // zonnestanden leesbaar, zonder dat de pluim 's nachts oplicht als een lamp.
    mat.emissiveColor = new BABYLON.Color3(0.05, 0.05, 0.055);
    mat.backFaceCulling = false;
    mesh.material = mat;
    return { mesh, tex, mat };
  };

  const A = maakPlaat('megaPluimA');
  const B = maakPlaat('megaPluimB');

  // Atlascel i (rij-groot vanaf linksboven) naar uv-offset. PNG-rij 0 is boven, Babylon's
  // v-as loopt omhoog, dus de rij wordt gespiegeld.
  const zetCel = (tex, i) => {
    tex.uOffset = (i % KOLOMMEN) / KOLOMMEN;
    tex.vOffset = (RIJEN - 1 - ((i / KOLOMMEN) | 0)) / RIJEN;
  };

  const staat = {
    i: 0, richting: 1, f: 0, t: 0,
    enabled: true,
    timeScale: 1,
    elapsed: 0,
  };
  zetCel(A.tex, 0);
  zetCel(B.tex, 1);

  const obs = scene.onBeforeRenderObservable.add(() => {
    if (!staat.enabled) return;
    // Eigen dt met klem: een schermwissel mag de crossfade niet in 1 tik voltooien.
    const dt = Math.min(scene.getEngine().getDeltaTime() * 0.001, 0.1) * staat.timeScale;
    if (dt <= 0) return;
    staat.t += dt;
    staat.elapsed += dt;
    staat.f = Math.min(1, staat.t / STAP_DUUR);

    // Zachte S-curve op de overgang, plus een nauwelijks waarneembare ademhaling in de
    // schaal (0.4 procent, periode ~37 s) zodat de kolom nooit helemaal bevriest.
    const s = staat.f * staat.f * (3 - 2 * staat.f);
    A.mesh.visibility = 1 - s;
    B.mesh.visibility = s;
    const adem = 1 + 0.004 * Math.sin(staat.elapsed * 0.17);
    A.mesh.scaling.y = adem; B.mesh.scaling.y = adem;

    if (staat.f >= 1) {
      // Venster opschuiven: B wordt de nieuwe A, en B laadt de volgende cel (ping-pong).
      staat.i += staat.richting;
      if (staat.i >= CELLEN - 1) { staat.i = CELLEN - 1; staat.richting = -1; }
      else if (staat.i <= 0) { staat.i = 0; staat.richting = 1; }
      zetCel(A.tex, staat.i);
      zetCel(B.tex, Math.min(CELLEN - 1, Math.max(0, staat.i + staat.richting)));
      staat.t = 0; staat.f = 0;
      A.mesh.visibility = 1; B.mesh.visibility = 0;
    }
  });

  log('PLUIM', `achtergrondpluim actief op (${Math.round(px)}, ${Math.round(pz)}), ${HOOGTE} m hoog, 2 draws`, false);

  return {
    get enabled() { return staat.enabled; },
    setEnabled(v) {
      staat.enabled = !!v;
      A.mesh.setEnabled(staat.enabled);
      B.mesh.setEnabled(staat.enabled);
    },
    setTimeScale(v) {
      const n = Number(v);
      staat.timeScale = Number.isFinite(n) && n > 0 ? n : 0;
    },
    reset() {
      staat.i = 0; staat.richting = 1; staat.f = 0; staat.t = 0; staat.elapsed = 0;
      zetCel(A.tex, 0); zetCel(B.tex, 1);
      A.mesh.visibility = 1; B.mesh.visibility = 0;
      A.mesh.scaling.y = 1; B.mesh.scaling.y = 1;
    },
    dispose() {
      scene.onBeforeRenderObservable.remove(obs);
      for (const p of [A, B]) { p.mesh.dispose(); p.mat.dispose(); p.tex.dispose(); }
    },
  };
}
