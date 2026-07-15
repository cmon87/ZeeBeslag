// M1.6: radiale camera-volgende oceaan-mesh.
// Probleem met de oude CreateGround (200x200 over 10.5km): ~52m tussen vertices, terwijl de
// mid- en near-cascade golflengtes van 17m en 5m hebben. Die cascades werden wel berekend maar
// droegen niet bij aan het silhouet, alleen aan de belichting.
// Oplossing: een polaire schijf met geometrisch groeiende ringafstand. Vertexafstand ~1.7m bij
// het centrum (camera), oplopend naar ~200m aan de rand. De mid-cascade (17m) wordt nu volledig
// bemonsterd tot ~200m afstand en de near-cascade (5m) tot ~30m, precies waar je het ziet.
// De mesh volgt de camera continu (geen grid-snap meer nodig: de UV's zijn wereld-verankerd,
// dus het golfveld staat vast in de wereld ongeacht waar de vertices liggen).
//
// Budget: rings*segments+1 vertices. Default 96x256 = 24.577 verts / ~48.9k tris.
// Feit: dat is minder dan de helft van de driehoeken die een uniform 300x300-grid zou kosten
// voor dezelfde near-dichtheid, bij gelijke visuele dekking.

export function createOceanMesh(scene, opts = {}) {
  const radius    = opts.radius    ?? 5000;
  const rings     = opts.rings     ?? 96;
  const segments  = opts.segments  ?? 256;
  const innerStep = opts.innerStep ?? 1.7;   // meters tussen ring 0 en 1

  // Groeifactor g zo kiezen dat de ringafstanden (innerStep * g^i) samen precies radius vullen.
  const total = g => innerStep * (Math.pow(g, rings) - 1) / (g - 1);
  let lo = 1.0001, hi = 1.5;
  while (total(hi) < radius) hi *= 1.2;
  for (let it = 0; it < 64; it++) { const m = (lo + hi) / 2; if (total(m) < radius) lo = m; else hi = m; }
  const g = (lo + hi) / 2;

  const radii = new Float64Array(rings + 1);
  let r = 0, step = innerStep;
  for (let i = 1; i <= rings; i++) { r += step; step *= g; radii[i] = r; }
  radii[rings] = radius;   // rand exact op de schijfstraal, zodat de alpha-fade in de shader klopt

  const vertCount = 1 + rings * segments;
  const positions = new Float32Array(vertCount * 3);
  const uvs       = new Float32Array(vertCount * 2);   // shader gebruikt wereld-UV's; attribute moet wel bestaan
  const dTheta = (Math.PI * 2) / segments;

  // centrum
  positions[0] = 0; positions[1] = 0; positions[2] = 0;
  uvs[0] = 0.5; uvs[1] = 0.5;

  for (let i = 1; i <= rings; i++) {
    const rr = radii[i];
    const off = (i % 2) * 0.5 * dTheta;   // halve-segment offset per ring: betere driehoekskwaliteit
    for (let j = 0; j < segments; j++) {
      const a = j * dTheta + off;
      const v = 1 + (i - 1) * segments + j;
      positions[v * 3 + 0] = Math.cos(a) * rr;
      positions[v * 3 + 1] = 0;
      positions[v * 3 + 2] = Math.sin(a) * rr;
      uvs[v * 2 + 0] = 0.5 + (positions[v * 3 + 0] / radius) * 0.5;
      uvs[v * 2 + 1] = 0.5 + (positions[v * 3 + 2] / radius) * 0.5;
    }
  }

  const triCount = segments + (rings - 1) * segments * 2;
  const indices = new Uint32Array(triCount * 3);
  let k = 0;
  const rv = (i, j) => 1 + (i - 1) * segments + ((j % segments + segments) % segments);

  // fan van centrum naar ring 1
  for (let j = 0; j < segments; j++) {
    indices[k++] = 0; indices[k++] = rv(1, j); indices[k++] = rv(1, j + 1);
  }
  // quads tussen ring i en i+1 (met de halve-segment offset blijft j-paring geldig)
  for (let i = 1; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = rv(i, j), b = rv(i, j + 1), c = rv(i + 1, j), d = rv(i + 1, j + 1);
      indices[k++] = a; indices[k++] = c; indices[k++] = b;
      indices[k++] = b; indices[k++] = c; indices[k++] = d;
    }
  }

  const mesh = new BABYLON.Mesh('ocean', scene);
  const vd = new BABYLON.VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.uvs = uvs;
  vd.applyToMesh(mesh, false);

  mesh.isPickable = false;
  mesh.doNotSyncBoundingInfo = true;
  mesh.alwaysSelectAsActiveMesh = true;   // mesh schuift elke frame onder de camera; culling zou hem wegcullen

  return { mesh, radius, innerStep, rings, segments, tris: triCount };
}
