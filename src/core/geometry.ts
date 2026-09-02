/** Geometrie 2D. Toutes les coordonnees "monde" sont en centimetres. */

export interface Pt {
  x: number;
  y: number;
}

export const pt = (x: number, y: number): Pt => ({ x, y });
export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
export const cross = (a: Pt, b: Pt): number => a.x * b.y - a.y * b.x;
export const len = (a: Pt): number => Math.hypot(a.x, a.y);
export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

export function norm(a: Pt): Pt {
  const l = len(a);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

export function rotate(p: Pt, angle: number): Pt {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** Rectangle centre en `center`, tourne de `angle`, renvoye comme polygone de 4 sommets. */
export function rectPolygon(center: Pt, w: number, h: number, angle: number): Pt[] {
  const hw = w / 2;
  const hh = h / 2;
  const corners: Pt[] = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
  return corners.map((c) => add(center, rotate(c, angle)));
}

/** Approxime un cercle par un polygone regulier (suffisant pour la detection de collision). */
export function circlePolygon(center: Pt, diameter: number, segments = 32): Pt[] {
  const r = diameter / 2;
  const out: Pt[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push({ x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r });
  }
  return out;
}

export interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function bboxOf(points: Pt[]): Bbox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function bboxOverlap(a: Bbox, b: Bbox, margin = 0): boolean {
  return (
    a.minX - margin <= b.maxX &&
    a.maxX + margin >= b.minX &&
    a.minY - margin <= b.maxY &&
    a.maxY + margin >= b.minY
  );
}

/** Intersection stricte de deux segments (les contacts par une extremite comptent). */
export function segmentsIntersect(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const d1 = sub(a2, a1);
  const d2 = sub(b2, b1);
  const denom = cross(d1, d2);
  const diff = sub(b1, a1);

  if (Math.abs(denom) < 1e-12) {
    // Paralleles : intersection seulement si colineaires et chevauchants.
    if (Math.abs(cross(diff, d1)) > 1e-9) return false;
    const l = dot(d1, d1);
    if (l < 1e-12) return false;
    const t0 = dot(diff, d1) / l;
    const t1 = t0 + dot(d2, d1) / l;
    const lo = Math.min(t0, t1);
    const hi = Math.max(t0, t1);
    return hi >= 0 && lo <= 1;
  }

  const t = cross(diff, d2) / denom;
  const u = cross(diff, d1) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** Ray casting. Fonctionne aussi pour les polygones concaves. */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const intersects =
      a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-12) return dist(p, a);
  let t = dot(sub(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, add(a, mul(ab, t)));
}

/**
 * Deux polygones (concaves autorises) se chevauchent-ils ?
 * Vrai si une arete en croise une autre, ou si l'un est entierement contenu dans l'autre.
 */
export function polygonsOverlap(a: Pt[], b: Pt[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  if (!bboxOverlap(bboxOf(a), bboxOf(b))) return false;

  for (let i = 0; i < a.length; i++) {
    const a1 = a[i];
    const a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j];
      const b2 = b[(j + 1) % b.length];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  // Pas d'arete croisee : soit disjoints, soit l'un contient l'autre.
  return pointInPolygon(a[0], b) || pointInPolygon(b[0], a);
}

/** Le polygone traverse-t-il le segment (un mur) ? */
export function polygonCrossesSegment(poly: Pt[], s1: Pt, s2: Pt): boolean {
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i];
    const p2 = poly[(i + 1) % poly.length];
    if (segmentsIntersect(p1, p2, s1, s2)) return true;
  }
  // Segment entierement a l'interieur du polygone.
  return pointInPolygon(s1, poly);
}

export function polygonArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function polygonCentroid(poly: Pt[]): Pt {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const f = p.x * q.y - q.x * p.y;
    a += f;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const b = bboxOf(poly);
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  }
  a *= 3;
  return { x: cx / a, y: cy / a };
}

/**
 * Intersection de deux droites infinies portees par (a1,a2) et (b1,b2).
 * Renvoie null si elles sont trop paralleles pour que le point soit exploitable.
 */
export function lineIntersection(a1: Pt, a2: Pt, b1: Pt, b2: Pt, minSin = 1e-3): Pt | null {
  const d1 = sub(a2, a1);
  const d2 = sub(b2, b1);
  const denom = cross(d1, d2);
  const scale = len(d1) * len(d2);
  if (scale < 1e-12 || Math.abs(denom) < minSin * scale) return null;
  const t = cross(sub(b1, a1), d2) / denom;
  return add(a1, mul(d1, t));
}

/** Abscisse curviligne normalisee de la projection de `p` sur (a,b), non bornee. */
export function projectionParam(p: Pt, a: Pt, b: Pt): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-12) return 0;
  return dot(sub(p, a), ab) / l2;
}

/** Les deux points les plus eloignes d'un nuage. Renvoie null en dessous de deux points. */
export function farthestPair(points: Pt[]): [Pt, Pt] | null {
  if (points.length < 2) return null;
  let best: [Pt, Pt] = [points[0], points[1]];
  let bestD = -1;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = dist(points[i], points[j]);
      if (d > bestD) {
        bestD = d;
        best = [points[i], points[j]];
      }
    }
  }
  return bestD > 0 ? best : null;
}

/** Enveloppe convexe (parcours monotone d'Andrew), sens trigonometrique, sans point colineaire. */
export function convexHull(points: Pt[]): Pt[] {
  if (points.length < 3) return points.slice();
  const sorted = points.slice().sort((p, q) => (p.x === q.x ? p.y - q.y : p.x - q.x));
  const build = (src: Pt[]): Pt[] => {
    const out: Pt[] = [];
    for (const p of src) {
      while (out.length >= 2 && cross(sub(out[out.length - 1], out[out.length - 2]), sub(p, out[out.length - 2])) <= 0) {
        out.pop();
      }
      out.push(p);
    }
    out.pop();
    return out;
  };
  const hull = build(sorted).concat(build(sorted.reverse()));
  return hull.length >= 3 ? hull : points.slice();
}

/** Aire algebrique : positive en sens horaire dans un repere ecran (y vers le bas). */
export function signedArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Supprime les sommets quasi confondus, puis ceux qui sont quasi alignes. */
export function simplifyPolygon(poly: Pt[], mergeDist = 1, flatSin = 0.02): Pt[] {
  const merged: Pt[] = [];
  for (const p of poly) {
    if (!merged.length || dist(merged[merged.length - 1], p) > mergeDist) merged.push(p);
  }
  while (merged.length > 3 && dist(merged[0], merged[merged.length - 1]) <= mergeDist) merged.pop();
  if (merged.length < 4) return merged;

  const out: Pt[] = [];
  for (let i = 0; i < merged.length; i++) {
    const prev = merged[(i - 1 + merged.length) % merged.length];
    const cur = merged[i];
    const next = merged[(i + 1) % merged.length];
    const a = sub(cur, prev);
    const b = sub(next, cur);
    const scale = len(a) * len(b);
    if (scale > 1e-9 && Math.abs(cross(a, b)) / scale < flatSin) continue;
    out.push(cur);
  }
  return out.length >= 3 ? out : merged;
}
