import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bboxOf, circlePolygon, polygonArea, polygonCentroid } from '../src/core/geometry.ts';
import { rescaleScene } from '../src/model/store.ts';
import { emptyScene } from '../src/model/types.ts';
import {
  dropRoundness,
  insertPolygonVertex,
  insertRoomVertex,
  removePolygonVertex,
  obstacleSize,
  removeRoomVertex,
  resizeObstacleTo,
  resizeRoundObstacle,
  scaleObstacle,
} from '../src/model/room.ts';
import type { Room } from '../src/model/types.ts';

/** Carré 100x100, sommets dans l'ordre, aucune ouverture. */
const square = (doors: number[] = []): Room => ({
  points: [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ],
  doors: [...doors],
});

test('insertRoomVertex place le sommet juste apres son arete', () => {
  const room = square();
  assert.equal(insertRoomVertex(room, 0, { x: 50, y: 0 }), true);
  assert.equal(room.points.length, 5);
  assert.deepEqual(room.points[1], { x: 50, y: 0 });
});

test('insertRoomVertex decale les ouvertures situees apres', () => {
  const room = square([2]);
  insertRoomVertex(room, 0, { x: 50, y: 0 });
  // L'arête 2 est devenue l'arête 3.
  assert.deepEqual(room.doors, [3]);
});

test('couper une arete traversable garde ses deux moities traversables', () => {
  const room = square([1]);
  insertRoomVertex(room, 1, { x: 100, y: 50 });
  assert.deepEqual(room.doors, [1, 2]);
});

test('une ouverture avant le point d insertion ne bouge pas', () => {
  const room = square([0]);
  insertRoomVertex(room, 2, { x: 50, y: 100 });
  assert.deepEqual(room.doors, [0]);
});

test('removeRoomVertex fusionne les deux aretes voisines', () => {
  const room = square();
  insertRoomVertex(room, 0, { x: 50, y: 0 });
  assert.equal(removeRoomVertex(room, 1), true);
  assert.equal(room.points.length, 4);
  assert.deepEqual(room.points[1], { x: 100, y: 0 });
});

test('supprimer un sommet reporte l ouverture sur l arete fusionnee', () => {
  const room = square([1]);
  insertRoomVertex(room, 1, { x: 100, y: 50 }); // doors [1, 2]
  removeRoomVertex(room, 2); // on retire le sommet ajouté
  assert.deepEqual(room.doors, [1]);
  assert.equal(room.points.length, 4);
});

test('supprimer le sommet 0 reporte la fusion en fin de contour', () => {
  // Arêtes : 0 (0,0)->(100,0) … 3 (0,100)->(0,0). Retirer le sommet 0 les fusionne.
  const room = square([3]);
  assert.equal(removeRoomVertex(room, 0), true);
  assert.equal(room.points.length, 3);
  // La fusion des arêtes 3 et 0 devient la dernière arête du nouveau contour.
  assert.deepEqual(room.doors, [2]);
  assert.deepEqual(room.points[0], { x: 100, y: 0 });
});

test('les ouvertures restent uniques et triees', () => {
  const room = square([0, 1]);
  removeRoomVertex(room, 1); // fusionne les arêtes 0 et 1
  assert.deepEqual(room.doors, [0]);
});

test('un triangle ne peut pas perdre de sommet', () => {
  const room: Room = { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], doors: [] };
  assert.equal(removeRoomVertex(room, 0), false);
  assert.equal(room.points.length, 3);
});

test('index hors bornes : rien ne bouge', () => {
  const room = square([1]);
  assert.equal(insertRoomVertex(room, 9, { x: 0, y: 0 }), false);
  assert.equal(removeRoomVertex(room, -1), false);
  assert.equal(room.points.length, 4);
  assert.deepEqual(room.doors, [1]);
});

test('les emprises de meubles suivent les memes regles, sans ouvertures', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 60, y: 0 },
    { x: 60, y: 60 },
    { x: 0, y: 60 },
  ];
  assert.equal(insertPolygonVertex(points, 1, { x: 60, y: 30 }), true);
  assert.equal(points.length, 5);
  assert.equal(removePolygonVertex(points, 2), true);
  assert.equal(points.length, 4);
  // Descendre sous le triangle est refusé.
  removePolygonVertex(points, 0);
  assert.equal(removePolygonVertex(points, 0), false);
});

test('resizeRoundObstacle change le diametre autour du centre', () => {
  const o = {
    id: 'o1',
    label: 'Lavabo',
    points: circlePolygon({ x: 100, y: 100 }, 40, 32),
    color: '#fff',
    round: 40,
  };
  assert.equal(resizeRoundObstacle(o, 60), true);
  assert.equal(o.round, 60);
  // Le centre n'a pas bougé.
  const c = polygonCentroid(o.points);
  assert.ok(Math.abs(c.x - 100) < 0.1);
  assert.ok(Math.abs(c.y - 100) < 0.1);
  // Un polygone à 32 côtés approche le cercle par l'intérieur : l'aire est un
  // peu inférieure à celle du disque, mais le rapport suit bien le carré.
  const area = polygonArea(o.points);
  assert.ok(Math.abs(area / polygonArea(circlePolygon({ x: 0, y: 0 }, 40, 32)) - 2.25) < 1e-6);
});

test('une emprise qui n est pas ronde refuse le redimensionnement', () => {
  const o = {
    id: 'o2',
    label: 'Meuble',
    points: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 }],
    color: '#fff',
  };
  assert.equal(resizeRoundObstacle(o, 80), false);
  assert.equal(polygonArea(o.points), 3600);
});

test('un diametre nul ou negatif est refuse', () => {
  const o = { id: 'o3', label: 'L', points: circlePolygon({ x: 0, y: 0 }, 40, 32), color: '#fff', round: 40 };
  assert.equal(resizeRoundObstacle(o, 0), false);
  assert.equal(resizeRoundObstacle(o, -5), false);
  assert.equal(o.round, 40);
});

test('deplacer un sommet fait perdre la rondeur', () => {
  const o = { id: 'o4', label: 'L', points: circlePolygon({ x: 0, y: 0 }, 40, 32), color: '#fff', round: 40 };
  dropRoundness(o);
  assert.equal(o.round, undefined);
  assert.equal(resizeRoundObstacle(o, 60), false);
});

test('un recalage d echelle emporte le diametre memorise', () => {
  const scene = {
    ...emptyScene(),
    obstacles: [
      { id: 'o5', label: 'Lavabo', points: circlePolygon({ x: 100, y: 100 }, 40, 32), color: '#fff', round: 40 },
    ],
  };
  rescaleScene(scene, 2);
  assert.equal(scene.obstacles[0].round, 80);
  // Et le contour a suivi : le champ affiche bien ce qui est dessiné.
  const box = bboxOf(scene.obstacles[0].points);
  assert.ok(Math.abs(box.maxX - box.minX - 80) < 0.6);
});

const lShape = () => [
  { x: 0, y: 0 },
  { x: 80, y: 0 },
  { x: 80, y: 40 },
  { x: 40, y: 40 },
  { x: 40, y: 60 },
  { x: 0, y: 60 },
];

test('scaleObstacle agrandit sans deformer, autour du centre', () => {
  const o = { id: 'p1', label: 'L', points: lShape(), color: '#fff' };
  const before = bboxOf(o.points);
  const centerBefore = { x: (before.minX + before.maxX) / 2, y: (before.minY + before.maxY) / 2 };
  const areaBefore = polygonArea(o.points);

  assert.equal(scaleObstacle(o, 1.5), true);

  const after = bboxOf(o.points);
  // Le centre n'a pas bougé : le meuble grandit sur place.
  assert.ok(Math.abs((after.minX + after.maxX) / 2 - centerBefore.x) < 1e-9);
  assert.ok(Math.abs((after.minY + after.maxY) / 2 - centerBefore.y) < 1e-9);
  // Les deux dimensions ont suivi le même rapport, l'aire le rapport au carré.
  assert.ok(Math.abs((after.maxX - after.minX) / (before.maxX - before.minX) - 1.5) < 1e-9);
  assert.ok(Math.abs((after.maxY - after.minY) / (before.maxY - before.minY) - 1.5) < 1e-9);
  assert.ok(Math.abs(polygonArea(o.points) / areaBefore - 2.25) < 1e-9);
});

test('resizeObstacleTo donne la dimension demandee et preserve les proportions', () => {
  const o = { id: 'p2', label: 'L', points: lShape(), color: '#fff' };
  // 80 x 60 au départ : porter la largeur à 120 doit donner 120 x 90.
  assert.equal(resizeObstacleTo(o, 'width', 120), true);
  const size = obstacleSize(o);
  assert.ok(Math.abs(size.width - 120) < 1e-9);
  assert.ok(Math.abs(size.depth - 90) < 1e-9);

  // Et par la profondeur, dans l'autre sens.
  assert.equal(resizeObstacleTo(o, 'depth', 60), true);
  const back = obstacleSize(o);
  assert.ok(Math.abs(back.width - 80) < 1e-9);
  assert.ok(Math.abs(back.depth - 60) < 1e-9);
});

test('redimensionner une emprise ronde par sa largeur met le diametre a jour', () => {
  const o = { id: 'p3', label: 'L', points: circlePolygon({ x: 0, y: 0 }, 40, 32), color: '#fff', round: 40 };
  resizeObstacleTo(o, 'width', 80);
  // Le champ Ø doit rester en accord avec ce qui est dessiné.
  assert.ok(Math.abs((o.round as number) - 80) < 0.6);
});

test('les valeurs invalides ne touchent pas a l emprise', () => {
  const o = { id: 'p4', label: 'L', points: lShape(), color: '#fff' };
  const area = polygonArea(o.points);
  assert.equal(scaleObstacle(o, 0), false);
  assert.equal(scaleObstacle(o, -2), false);
  assert.equal(resizeObstacleTo(o, 'width', 0), false);
  assert.equal(polygonArea(o.points), area);
});
