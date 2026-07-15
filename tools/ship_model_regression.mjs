import assert from 'node:assert/strict';

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  copyFrom(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  add(v) { return new Vector3(this.x + v.x, this.y + v.y, this.z + v.z); }
  subtract(v) { return new Vector3(this.x - v.x, this.y - v.y, this.z - v.z); }
  scale(s) { return new Vector3(this.x * s, this.y * s, this.z * s); }
  static TransformCoordinatesToRef(v, _m, out) { out.copyFrom(v); }
}
class Matrix { clone() { return new Matrix(); } invert() { return this; } }
class TransformNode {
  constructor(name, scene) {
    this.name = name; this.scene = scene; this.parent = null;
    this.position = new Vector3(); this.rotation = new Vector3(); this.rotationQuaternion = null;
    this.scaling = new Vector3(1, 1, 1); this.scaling.setAll = s => this.scaling.set(s, s, s);
    this._disposed = false; scene.nodes.push(this);
  }
  computeWorldMatrix() { return new Matrix(); }
  getWorldMatrix() { return new Matrix(); }
  getAbsolutePosition() { return this.position.clone(); }
  getChildren() { return []; }
  dispose() { this._disposed = true; }
  isDisposed() { return this._disposed; }
}
class Mesh extends TransformNode {
  constructor(name, scene, min, max, vertices = 8) {
    super(name, scene); this.min = min; this.max = max; this.vertices = vertices;
    this.material = null; this.isPickable = true;
  }
  getTotalVertices() { return this.vertices; }
  getBoundingInfo() {
    const corners = [];
    for (const x of [this.min.x, this.max.x]) for (const y of [this.min.y, this.max.y]) for (const z of [this.min.z, this.max.z]) corners.push(new Vector3(x, y, z));
    return { boundingBox: { vectorsWorld: corners } };
  }
  getClassName() { return 'Mesh'; }
  getChildMeshes() { return []; }
}
const scene = {
  nodes: [],
  getTransformNodeByName(name) { return this.nodes.find(n => n.name === name && !(n instanceof Mesh)) || null; },
  getMeshByName(name) { return this.nodes.find(n => n.name === name && n instanceof Mesh) || null; },
};
const importedRoot = new Mesh('__root__', scene, new Vector3(), new Vector3(), 0);
const hull = new Mesh('hull', scene, new Vector3(-10, -5, -50), new Vector3(10, 15, 50));
hull.parent = importedRoot;

globalThis.BABYLON = {
  Vector3,
  TransformNode,
  SceneLoader: { ImportMeshAsync: async () => ({ meshes: [importedRoot, hull], transformNodes: [] }) },
};

const { Ship } = await import('../src/game/ship.js');
const swell = { getHeight: () => 0 };
const ship = new Ship(scene, swell, { length: 150 });
ship.addTurret(new Vector3(0, 6.5, 17));
ship.addTurret(new Vector3(0, 6.5, 2));
ship.addTurret(new Vector3(0, 6.5, -13));
const result = await ship.loadGLB('./models/', 'Schip1.glb');

assert.equal(result.meshCount, 1);
assert.equal(result.turretsBound, 0);
assert.equal(result.modelScale, 1.5);
assert.equal(result.modelLength, 150);
assert.equal(result.modelHeight, 30);
assert.equal(ship.glbHolder.position.y, 7.5);
assert.equal(ship.isModelLoaded(), true);
assert.deepEqual(ship.turrets.map(t => [t.node.position.x, t.node.position.y, t.node.position.z]), [
  [0, 6.5, 17], [0, 6.5, 2], [0, 6.5, -13],
]);
assert.equal(ship.turrets.every(t => t.bound === false), true);
console.log('Ship model regression: 10 assertions passed.');
