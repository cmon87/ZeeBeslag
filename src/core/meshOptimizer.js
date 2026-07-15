// src/core/meshOptimizer.js
// M6.6: regressieveilige runtime-samenvoeging van statische GLB-meshes per materiaal.
// Brongeometrie wordt pas weggegooid nadat Babylon een geldige merged mesh heeft gemaakt.

function isDisposed(node) {
  return !!(node && node.isDisposed && node.isDisposed());
}

function isRenderable(mesh) {
  return !!(mesh && !isDisposed(mesh) && mesh.getTotalVertices && mesh.getTotalVertices() > 0);
}

function canMerge(mesh, protect) {
  if (!isRenderable(mesh) || !mesh.material) return false;
  if (protect && protect(mesh)) return false;
  if (mesh.skeleton || mesh.morphTargetManager) return false;
  if (mesh.hasInstances === true || (mesh.instances && mesh.instances.length)) return false;
  try {
    if (mesh.getChildMeshes && mesh.getChildMeshes(false).length > 0) return false;
  } catch (_) {}
  return true;
}

function cleanupEmptyNodes(nodes, keep) {
  const list = [...(nodes || [])].reverse();
  for (let pass = 0; pass < 3; pass++) {
    for (const node of list) {
      if (!node || node === keep || isDisposed(node)) continue;
      // Renderbare singleton- of beschermde meshes zijn geldige resultaten, geen lege nodes.
      if (node.getTotalVertices && node.getTotalVertices() > 0) continue;
      let children = [];
      try { children = node.getChildren ? node.getChildren() : []; } catch (_) {}
      if (children.length === 0) {
        try { node.dispose(false, false); } catch (_) {}
      }
    }
  }
}

export function mergeStaticMeshesByMaterial(meshes, opts = {}) {
  const source = (meshes || []).filter(isRenderable);
  const stats = {
    sourceMeshes: source.length,
    resultMeshes: source.length,
    mergedGroups: 0,
    mergedSources: 0,
    failedGroups: 0,
    frozenMaterials: 0,
    supported: !!(globalThis.BABYLON && BABYLON.Mesh && typeof BABYLON.Mesh.MergeMeshes === 'function'),
  };

  if (!opts.enabled || !stats.supported || source.length < 2) {
    return { meshes: source, stats };
  }

  const passthrough = [];
  const groups = new Map();
  for (const mesh of source) {
    mesh.isPickable = false;
    if (!canMerge(mesh, opts.protect)) {
      passthrough.push(mesh);
      continue;
    }
    const material = mesh.material;
    if (!groups.has(material)) groups.set(material, []);
    groups.get(material).push(mesh);
  }

  const result = [...passthrough];
  let groupIndex = 0;
  const maxVertices = Math.max(1000, Number(opts.maxVerticesPerMerge || 250000));
  for (const [material, materialGroup] of groups) {
    const batches = [];
    let batch = [], batchVertices = 0;
    for (const mesh of materialGroup) {
      const vertices = Math.max(0, Number(mesh.getTotalVertices ? mesh.getTotalVertices() : 0));
      if (batch.length && batchVertices + vertices > maxVertices) {
        batches.push(batch); batch = []; batchVertices = 0;
      }
      batch.push(mesh); batchVertices += vertices;
    }
    if (batch.length) batches.push(batch);

    for (const group of batches) {
      if (group.length < 2) {
        result.push(...group);
        continue;
      }

      try {
        for (const mesh of group) mesh.computeWorldMatrix && mesh.computeWorldMatrix(true);
        // disposeSource=false is de rollbackgarantie. Pas na een succesvolle merge worden de
        // bronmeshes verwijderd. multiMultiMaterials=false, want iedere groep deelt materiaal.
        const merged = BABYLON.Mesh.MergeMeshes(group, false, true, undefined, false, false);
        if (!merged || !isRenderable(merged)) throw new Error('MergeMeshes leverde geen renderbare mesh');

        merged.name = `${opts.namePrefix || 'mergedStatic'}_${groupIndex++}`;
        merged.material = material;
        merged.isPickable = false;
        merged.receiveShadows = group.some(mesh => mesh.receiveShadows === true);
        merged.renderingGroupId = group[0].renderingGroupId || 0;
        merged.visibility = group[0].visibility ?? 1;
        merged.isVisible = group.some(mesh => mesh.isVisible !== false);
        if (opts.holder) merged.parent = opts.holder;

        for (const mesh of group) {
          try { mesh.dispose(false, false); } catch (_) {}
        }
        result.push(merged);
        stats.mergedGroups++;
        stats.mergedSources += group.length;
      } catch (_) {
        stats.failedGroups++;
        result.push(...group.filter(mesh => !isDisposed(mesh)));
      }
    }
  }

  if (opts.freezeMaterials) {
    const materials = new Set(result.map(mesh => mesh.material).filter(Boolean));
    for (const material of materials) {
      try {
        if (typeof material.freeze === 'function') {
          material.freeze();
          stats.frozenMaterials++;
        }
      } catch (_) {}
    }
  }

  cleanupEmptyNodes(opts.nodes, opts.holder);
  const unique = [];
  const seen = new Set();
  for (const mesh of result) {
    if (!isRenderable(mesh) || seen.has(mesh)) continue;
    seen.add(mesh);
    unique.push(mesh);
  }
  stats.resultMeshes = unique.length;
  return { meshes: unique, stats };
}
