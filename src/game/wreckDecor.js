// src/game/wreckDecor.js
//
// M5.4 - Brandend wrak op het middenplan.
//
// Een tweede instantie van Schip1.glb, half gezonken en slagzij makend tussen het eigen schip
// en het eiland. Puur decor: geen doel, geen physics, geen registratie in de targetRegistry.
//
// De draw-call strategie is het hart van deze module. Schip1.glb telt 474 meshes; die als
// hierarchie neerzetten zou het drawbudget verdubbelen. Een wrak op anderhalve kilometer is
// echter een zwartgeblakerd silhouet, dus alle geometrie wordt na het laden samengevoegd tot
// EEN mesh met EEN donker materiaal: 474 meshes worden 1 draw call, en de multimateriaal-
// detaillering die we toch niet meer zien gaat verloren zonder dat het beeld het merkt.
// Mislukt het samenvoegen (afwijkende vertexformaten kunnen dat veroorzaken), dan ruimen we
// alles op en slaan we het wrak over; liever geen wrak dan 474 extra draws.
//
// Gebruik vanuit main.js, na de eilandload, niet-blokkerend:
//   buildWreck({ scene, fx, pushLog, islandCenter }).then(w => { ... });

export async function buildWreck({ scene, fx, pushLog, islandCenter }) {
  const log = pushLog || (() => {});
  let res = null;
  try {
    res = await BABYLON.SceneLoader.ImportMeshAsync('', './models/', 'Schip1.glb', scene);
  } catch (e) {
    log('WRAK', 'wrak-GLB laden mislukt: ' + (e.message || e), true);
    return null;
  }

  const bronnen = res.meshes.filter(m => m.getTotalVertices && m.getTotalVertices() > 0);
  let romp = null;
  try {
    // Eén mesh, één materiaal (multiMaterial false), bronnen weggooien, 32-bit indices voor
    // de gecombineerde vertexaantallen.
    romp = BABYLON.Mesh.MergeMeshes(bronnen, true, true, undefined, false, false);
  } catch (e) {
    romp = null;
    log('WRAK', 'samenvoegen mislukt: ' + (e.message || e), true);
  }
  if (!romp) {
    for (const m of res.meshes) { try { m.dispose(); } catch (_) {} }
    return null;
  }
  // Restanten van de import (lege transformnodes, __root__) opruimen.
  for (const m of res.meshes) { if (m !== romp && !m.isDisposed()) { try { m.dispose(); } catch (_) {} } }

  romp.name = 'wrakRomp';
  romp.isPickable = false;
  romp.freezeWorldMatrix ? null : null;

  // Zwartgeblakerd: vrijwel geen diffuus, geen speculair. Het silhouet leeft op de rimlight
  // van de zon en de gloed van zijn eigen rookkolommen.
  const mat = new BABYLON.StandardMaterial('wrakMat', scene);
  mat.diffuseColor = new BABYLON.Color3(0.05, 0.045, 0.04);
  mat.specularColor = new BABYLON.Color3(0.03, 0.03, 0.03);
  mat.emissiveColor = new BABYLON.Color3(0.012, 0.006, 0.003);
  romp.material = mat;

  // Positie: op 55 procent van de lijn eiland-oorsprong, ruim opzij van de richtas zodat het
  // wrak het vizier op het eiland nooit blokkeert. Gezonken tot het dek, forse slagzij.
  const c = islandCenter || new BABYLON.Vector3(3200, 0, 0);
  romp.position.set(c.x * 0.55, -2.2, c.z * 0.55 + 620);
  romp.rotation = new BABYLON.Vector3(0.06, 2.35, 0.30);
  romp.computeWorldMatrix(true);
  romp.freezeWorldMatrix();   // statisch decor: geen matrix-updates per frame

  // Twee smeulende kolommen uit het bestaande profielsysteem: een vette donkere uit het
  // middenschip en een lichtere uit de boeg. Voorverwarmd, dus het wrak brandt vanaf frame 1.
  if (fx) {
    const p = romp.position;
    fx.heavyColumn(new BABYLON.Vector3(p.x, 2, p.z), 190, 10800,
      { tintSet: 'olie', dekking: 12, breedte0: 0.30, breedte1: 0.55, alpha: 0.92,
        lifeMult: 1.2, leanMult: 1.3, jitter: 0.04 });
    fx.heavyColumn(new BABYLON.Vector3(p.x + 34, 1, p.z + 12), 110, 10800,
      { dekking: 9, breedte0: 0.26, breedte1: 0.48, alpha: 0.70, lifeMult: 0.9,
        leanMult: 1.6, jitter: 0.05 });
  }

  log('WRAK', `brandend wrak geplaatst op (${Math.round(romp.position.x)}, ${Math.round(romp.position.z)}), 1 draw call`, false);
  return romp;
}
