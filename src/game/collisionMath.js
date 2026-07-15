// src/game/collisionMath.js
//
// Kleine, Babylon-onafhankelijke collisionhulpen. Deze functies worden gedeeld door
// scheepsnavigatie, projectielen en het doelregister, zodat alle systemen dezelfde
// segmentlogica gebruiken en snelle objecten niet tussen frames door doelen tunnelen.

export function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

export function pointOnSegment(from, to, t, out = null) {
  const x = from.x + (to.x - from.x) * t;
  const y = from.y + (to.y - from.y) * t;
  const z = from.z + (to.z - from.z) * t;
  if (out && typeof out.set === 'function') return out.set(x, y, z);
  if (out) { out.x = x; out.y = y; out.z = z; return out; }
  return { x, y, z };
}

// Retourneert de vroegste t in [tMin, tMax] waarop het lijnsegment de bol raakt.
// Start het segment al in de bol, dan is tMin de treffer. null betekent geen treffer.
export function segmentSphereHitT(from, to, center, radius, tMin = 0, tMax = 1) {
  if (!from || !to || !center || !Number.isFinite(radius) || radius < 0) return null;
  const lo = clamp01(Math.min(tMin, tMax));
  const hi = clamp01(Math.max(tMin, tMax));
  if (hi < lo) return null;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const a = dx * dx + dy * dy + dz * dz;

  const px = from.x + dx * lo - center.x;
  const py = from.y + dy * lo - center.y;
  const pz = from.z + dz * lo - center.z;
  const r2 = radius * radius;
  if (px * px + py * py + pz * pz <= r2) return lo;
  if (a <= 1e-12) return null;

  const mx = from.x - center.x;
  const my = from.y - center.y;
  const mz = from.z - center.z;
  const b = 2 * (mx * dx + my * dy + mz * dz);
  const c = mx * mx + my * my + mz * mz - r2;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const root = Math.sqrt(disc);
  const inv = 1 / (2 * a);
  const t0 = (-b - root) * inv;
  const t1 = (-b + root) * inv;
  if (t0 >= lo && t0 <= hi) return t0;
  if (t1 >= lo && t1 <= hi) return t1;
  return null;
}

export function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
