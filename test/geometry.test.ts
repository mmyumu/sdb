import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  circlePolygon,
  convexHull,
  farthestPair,
  lineIntersection,
  projectionParam,
  simplifyPolygon,
  pointInPolygon,
  polygonArea,
  polygonCrossesSegment,
  polygonsOverlap,
  rectPolygon,
  segmentsIntersect,
} from '../src/core/geometry.ts';

const square = (x: number, y: number, s: number) => [
  { x, y },
  { x: x + s, y },
  { x: x + s, y: y + s },
  { x, y: y + s },
];

test('segmentsIntersect detecte croisement et disjonction', () => {
  assert.equal(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }), true);
  assert.equal(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 5, y: 5 }, { x: 6, y: 6 }), false);
  // Colineaires chevauchants.
  assert.equal(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 15, y: 0 }), true);
  // Contact par une extremite : compte comme collision.
  assert.equal(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }), true);
});

test('pointInPolygon gere les polygones concaves', () => {
  // Forme en L.
  const l = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 4 },
    { x: 4, y: 4 },
    { x: 4, y: 10 },
    { x: 0, y: 10 },
  ];
  assert.equal(pointInPolygon({ x: 2, y: 2 }, l), true);
  assert.equal(pointInPolygon({ x: 8, y: 8 }, l), false);
  assert.equal(pointInPolygon({ x: 8, y: 2 }, l), true);
});

test('polygonsOverlap : croisement, inclusion, disjonction', () => {
  assert.equal(polygonsOverlap(square(0, 0, 10), square(5, 5, 10)), true, 'aretes croisees');
  assert.equal(polygonsOverlap(square(0, 0, 100), square(40, 40, 10)), true, 'inclusion totale');
  assert.equal(polygonsOverlap(square(40, 40, 10), square(0, 0, 100)), true, 'inclusion inverse');
  assert.equal(polygonsOverlap(square(0, 0, 10), square(20, 20, 10)), false, 'disjoints');
});

test('polygonCrossesSegment detecte un mur traverse', () => {
  const wall1 = { x: 5, y: -5 };
  const wall2 = { x: 5, y: 15 };
  assert.equal(polygonCrossesSegment(square(0, 0, 10), wall1, wall2), true);
  assert.equal(polygonCrossesSegment(square(20, 0, 10), wall1, wall2), false);
  // Mur entierement contenu dans le polygone.
  assert.equal(polygonCrossesSegment(square(0, 0, 100), { x: 10, y: 10 }, { x: 20, y: 20 }), true);
});

test('rectPolygon tourne autour de son centre', () => {
  const r = rectPolygon({ x: 0, y: 0 }, 60, 20, Math.PI / 2);
  // Apres un quart de tour, l'emprise fait 20 de large et 60 de haut.
  const xs = r.map((p) => p.x);
  const ys = r.map((p) => p.y);
  assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 20) < 1e-9);
  assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - 60) < 1e-9);
});

test('circlePolygon approche l aire du disque', () => {
  const area = polygonArea(circlePolygon({ x: 0, y: 0 }, 100, 64));
  assert.ok(Math.abs(area - Math.PI * 50 * 50) / (Math.PI * 2500) < 0.002);
});

test('convexHull enveloppe le nuage et ignore les points interieurs', () => {
  const hull = convexHull([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
    { x: 5, y: 5 },
    { x: 2, y: 8 },
  ]);
  assert.equal(hull.length, 4);
  assert.equal(polygonArea(hull), 100);
});

test('lineIntersection prolonge les droites au-dela des segments', () => {
  // Deux bouts de mur qui ne se touchent pas : le coin est leur intersection.
  const corner = lineIntersection({ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 100, y: 10 }, { x: 100, y: 90 });
  assert.ok(corner);
  assert.ok(Math.abs(corner.x - 100) < 1e-9);
  assert.ok(Math.abs(corner.y) < 1e-9);
  // Paralleles : pas de coin exploitable.
  assert.equal(lineIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 }), null);
});

test('farthestPair donne l’empreinte au sol d’un mur projete', () => {
  // Les quatre coins d'un mur vu de dessus se reduisent a deux positions.
  const pair = farthestPair([
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 0 },
    { x: 0, y: 0 },
  ]);
  assert.ok(pair);
  assert.equal(Math.abs(pair[0].x - pair[1].x), 200);
});

test('simplifyPolygon fusionne les doublons et supprime les points alignes', () => {
  const cleaned = simplifyPolygon([
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 100.2, y: 100 },
    { x: 0, y: 100 },
  ]);
  assert.equal(cleaned.length, 4);
  assert.equal(polygonArea(cleaned), 10000);
});

test('projectionParam situe un point le long d’une arete', () => {
  assert.equal(projectionParam({ x: 25, y: 8 }, { x: 0, y: 0 }, { x: 100, y: 0 }), 0.25);
});
