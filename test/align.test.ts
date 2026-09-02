import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignSceneToGrid, dominantAngle, squareUp } from '../src/model/align.ts';
import { bboxOf, polygonArea } from '../src/core/geometry.ts';
import type { Pt } from '../src/core/geometry.ts';
import { emptyScene, uid } from '../src/model/types.ts';
import type { Scene } from '../src/model/types.ts';

const deg = (r: number) => (r * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

function rotated(points: Pt[], angle: number): Pt[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return points.map((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }));
}

const rect = (w: number, h: number): Pt[] => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];

function sceneWith(points: Pt[]): Scene {
  return {
    ...emptyScene(),
    room: { points: points.map((p) => ({ ...p })), doors: [] },
    obstacles: [
      { id: uid('obs'), label: 'Meuble', points: rect(40, 30), color: '#fff' },
    ],
  };
}

test('dominantAngle retrouve l inclinaison d un rectangle', () => {
  assert.ok(Math.abs(deg(dominantAngle(rect(300, 200)))) < 1e-9);
  const tilted = rotated(rect(300, 200), rad(12));
  assert.ok(Math.abs(deg(dominantAngle(tilted)) - 12) < 1e-6);
});

test('dominantAngle est defini modulo 90 degres', () => {
  // Tourner d'un quart de tour ne change pas l'orientation d'un contour d'equerre.
  const a = deg(dominantAngle(rotated(rect(300, 200), rad(7))));
  const b = deg(dominantAngle(rotated(rect(300, 200), rad(97))));
  assert.ok(Math.abs(a - b) < 1e-6);
});

test('les grands murs pesent plus que les petits', () => {
  // Contour en L dont un seul petit segment est de travers.
  const l: Pt[] = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 400, y: 200 },
    { x: 205, y: 190 },
    { x: 200, y: 300 },
    { x: 0, y: 300 },
  ];
  assert.ok(Math.abs(deg(dominantAngle(l))) < 3);
});

test('alignSceneToGrid remet le mur dominant a l horizontale', () => {
  const scene = sceneWith(rotated(rect(300, 200), rad(17)));
  const before = polygonArea(scene.room!.points);
  const angle = alignSceneToGrid(scene);
  assert.ok(Math.abs(deg(angle) + 17) < 1e-6);
  // Une rotation ne change aucune mesure.
  assert.ok(Math.abs(polygonArea(scene.room!.points) - before) < 1e-6);
  assert.ok(Math.abs(deg(dominantAngle(scene.room!.points))) < 1e-9);
});

test('la rotation entraine meubles, mesures et objets deplaces', () => {
  const scene = sceneWith(rotated(rect(300, 200), rad(20)));
  scene.movables.push({
    id: uid('mov'), label: 'Lave-linge', kind: 'rect',
    w: 60, h: 60, pos: { x: 100, y: 50 }, angle: 0, color: '#fff',
  });
  const obstacleBefore = polygonArea(scene.obstacles[0].points);
  alignSceneToGrid(scene);
  // Le meuble a tourne avec la piece, sans se deformer.
  assert.ok(Math.abs(polygonArea(scene.obstacles[0].points) - obstacleBefore) < 1e-6);
  // L'objet deplace garde ses dimensions, et suit la rotation.
  assert.equal(scene.movables[0].w, 60);
  assert.ok(Math.abs(deg(scene.movables[0].angle) + 20) < 1e-6);
});

test('le plan reste dans le quadrant positif apres redressement', () => {
  const scene = sceneWith(rotated(rect(300, 200), rad(33)));
  alignSceneToGrid(scene);
  const box = bboxOf(scene.room!.points.concat(scene.obstacles[0].points));
  assert.ok(Math.abs(box.minX - 15) < 1e-6);
  assert.ok(Math.abs(box.minY - 15) < 1e-6);
});

test('squareUp aligne les aretes presque droites sur les axes', () => {
  // Un relevé réel : des murs à un ou deux degrés près.
  const points: Pt[] = [
    { x: 0, y: 0 },
    { x: 300, y: 4 },
    { x: 297, y: 200 },
    { x: 2, y: 197 },
  ];
  squareUp(points);
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const off = Math.min(Math.abs(a.y - b.y), Math.abs(a.x - b.x));
    assert.ok(off < 1e-6, `arête ${i} non alignée : ${off}`);
  }
});

test('squareUp ne touche pas a un mur franchement oblique', () => {
  // Un pan coupé à 45° doit le rester.
  const points: Pt[] = [
    { x: 0, y: 0 },
    { x: 300, y: 0 },
    { x: 200, y: 100 },
    { x: 0, y: 100 },
  ];
  squareUp(points);
  assert.deepEqual(points[1], { x: 300, y: 0 });
  assert.deepEqual(points[2], { x: 200, y: 100 });
});

test('redresser et équerrer ensemble donne un rectangle net', () => {
  const scene = sceneWith(rotated([
    { x: 0, y: 0 },
    { x: 300, y: 3 },
    { x: 298, y: 200 },
    { x: 1, y: 198 },
  ], rad(25)));
  alignSceneToGrid(scene, { square: true });
  const pts = scene.room!.points;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    assert.ok(Math.min(Math.abs(a.y - b.y), Math.abs(a.x - b.x)) < 1e-6);
  }
});

test('une scene sans piece est laissee telle quelle', () => {
  const scene = emptyScene();
  assert.equal(alignSceneToGrid(scene), 0);
  assert.equal(scene.room, null);
});
