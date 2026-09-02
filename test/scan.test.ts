import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFromRawScan, planFromScan, sceneFromRoom, sceneFromScan } from '../src/model/scan.ts';
import type { ScanPlane } from '../src/model/scan.ts';
import { bboxOf, dist, polygonArea } from '../src/core/geometry.ts';

/** Mur vertical entre deux points du sol, en metres. */
function wall(x1: number, z1: number, x2: number, z2: number, label = 'wall'): ScanPlane {
  return {
    label,
    polygon: [
      { x: x1, y: 0, z: z1 },
      { x: x2, y: 0, z: z2 },
      { x: x2, y: 2.4, z: z2 },
      { x: x1, y: 2.4, z: z1 },
    ],
  };
}

/** Surface horizontale a la hauteur `y`. */
function slab(label: string, corners: [number, number][], y = 0): ScanPlane {
  return { label, polygon: corners.map(([x, z]) => ({ x, y, z })) };
}

/** Les quatre murs d'une piece rectangulaire, retrecis de `shrink` a chaque bout. */
function rectWalls(w: number, d: number, shrink = 0): ScanPlane[] {
  const s = shrink;
  return [
    wall(s, 0, w - s, 0),
    wall(w, s, w, d - s),
    wall(w - s, d, s, d),
    wall(0, d - s, 0, s),
  ];
}

test('quatre murs donnent un contour ferme aux bonnes dimensions', () => {
  const plan = planFromScan(rectWalls(3, 2));
  assert.equal(plan.source, 'walls');
  assert.equal(plan.warnings.length, 0);
  assert.ok(plan.room);
  assert.equal(plan.room.points.length, 4);
  // 3 m x 2 m = 6 m^2, exprimes en cm^2.
  assert.ok(Math.abs(polygonArea(plan.room.points) - 60000) < 1);
});

test('les coins sont reconstruits meme quand les murs ne se touchent pas', () => {
  // Le casque renvoie des rectangles independants : ici chacun est 3 cm trop court
  // aux deux bouts. Le coin doit venir de l'intersection des droites, pas des bouts.
  const plan = planFromScan(rectWalls(3, 2, 0.03));
  assert.ok(plan.room);
  assert.equal(plan.room.points.length, 4);
  assert.ok(Math.abs(polygonArea(plan.room.points) - 60000) < 1);
});

test('le plan est ramene dans le quadrant positif avec une marge', () => {
  // Piece a cheval sur l'origine : le repere WebXR est centre sur le casque.
  const plan = planFromScan([
    wall(-1.5, -1, 1.5, -1),
    wall(1.5, -1, 1.5, 1),
    wall(1.5, 1, -1.5, 1),
    wall(-1.5, 1, -1.5, -1),
  ]);
  assert.ok(plan.room);
  const box = bboxOf(plan.room.points);
  assert.ok(Math.abs(box.minX - 15) < 1e-6);
  assert.ok(Math.abs(box.minY - 15) < 1e-6);
});

test('une porte decoupe le mur au lieu de le rendre traversable en entier', () => {
  const plan = planFromScan([...rectWalls(3, 2), wall(1.0, 0, 1.8, 0, 'door')]);
  assert.ok(plan.room);
  // Deux sommets inseres sur le mur du bas.
  assert.equal(plan.room.points.length, 6);
  assert.equal(plan.room.doors.length, 1);

  const i = plan.room.doors[0];
  const a = plan.room.points[i];
  const b = plan.room.points[(i + 1) % plan.room.points.length];
  assert.ok(Math.abs(dist(a, b) - 80) < 1);
  // Le reste du contour n'a pas bouge.
  assert.ok(Math.abs(polygonArea(plan.room.points) - 60000) < 1);
});

test('une porte qui affleure un coin ne cree pas de micro-arete', () => {
  const plan = planFromScan([...rectWalls(3, 2), wall(0.005, 0, 0.9, 0, 'door')]);
  assert.ok(plan.room);
  assert.equal(plan.room.doors.length, 1);
  const i = plan.room.doors[0];
  // La porte demarre sur le coin existant : un seul sommet ajoute.
  assert.equal(plan.room.points.length, 5);
  assert.ok(Math.abs(dist(plan.room.points[i], plan.room.points[i + 1]) - 90) < 1);
});

test('un mur manquant referme le contour et le signale', () => {
  const walls = rectWalls(3, 2);
  walls.splice(2, 1);
  const plan = planFromScan(walls);
  assert.ok(plan.room);
  assert.equal(plan.room.points.length, 4);
  assert.match(plan.warnings.join(' '), /manquant/);
});

test('une piece en L est chainee dans le bon ordre', () => {
  const corners: [number, number][] = [
    [0, 0],
    [4, 0],
    [4, 2],
    [2, 2],
    [2, 3],
    [0, 3],
  ];
  const walls = corners.map((c, i) => {
    const n = corners[(i + 1) % corners.length];
    return wall(c[0], c[1], n[0], n[1]);
  });
  const plan = planFromScan(walls);
  assert.equal(plan.source, 'walls');
  assert.ok(plan.room);
  assert.equal(plan.room.points.length, 6);
  // 4x2 + 2x1 = 10 m^2.
  assert.ok(Math.abs(polygonArea(plan.room.points) - 100000) < 1);
});

test('le polygone du sol prime quand il decrit mieux la piece que des murs rectangulaires', () => {
  const floor = slab('floor', [
    [0, 0],
    [4, 0],
    [4, 2],
    [2, 2],
    [2, 3],
    [0, 3],
  ]);
  // Des murs qui ne decrivent qu'une enveloppe rectangulaire grossiere.
  const plan = planFromScan([floor, ...rectWalls(4, 3)]);
  assert.equal(plan.source, 'floor');
  assert.ok(plan.room);
  assert.equal(plan.room.points.length, 6);
});

test('le sol sert de secours quand il y a trop peu de murs', () => {
  const plan = planFromScan([slab('floor', [[0, 0], [3, 0], [3, 2], [0, 2]]), wall(0, 0, 3, 0)]);
  assert.equal(plan.source, 'floor');
  assert.ok(plan.room);
  assert.ok(Math.abs(polygonArea(plan.room.points) - 60000) < 1);
});

test('les meubles deviennent des emprises au sol, pas les elements muraux', () => {
  const plan = planFromScan([
    ...rectWalls(3, 2),
    slab('table', [[0.5, 0.5], [1.1, 0.5], [1.1, 1.1], [0.5, 1.1]], 0.75),
    slab('storage', [[2.4, 0.2], [2.9, 0.2], [2.9, 1.2], [2.4, 1.2]], 0.4),
    // Accroches au mur : leur projection au sol est un simple trait.
    wall(0.5, 0, 1.2, 0, 'wall art'),
    wall(2, 2, 2.6, 2, 'window'),
  ]);
  assert.equal(plan.obstacles.length, 2);
  assert.deepEqual(plan.obstacles.map((o) => o.label).sort(), ['Rangement', 'Table']);
  const table = plan.obstacles.find((o) => o.label === 'Table')!;
  assert.ok(Math.abs(polygonArea(table.points) - 3600) < 1);
});

test('les meubles subissent le meme recalage que la piece', () => {
  const plan = planFromScan([
    wall(-1.5, -1, 1.5, -1),
    wall(1.5, -1, 1.5, 1),
    wall(1.5, 1, -1.5, 1),
    wall(-1.5, 1, -1.5, -1),
    slab('table', [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], 0.75),
  ]);
  assert.ok(plan.room);
  assert.equal(plan.obstacles.length, 1);
  // La table reste au centre de la piece apres translation.
  const room = bboxOf(plan.room.points);
  const table = bboxOf(plan.obstacles[0].points);
  assert.ok(Math.abs((table.minX + table.maxX) / 2 - (room.minX + room.maxX) / 2) < 1e-6);
  assert.ok(Math.abs((table.minY + table.maxY) / 2 - (room.minY + room.maxY) / 2) < 1e-6);
});

test('un releve vide est signale plutot que de produire un plan bancal', () => {
  const plan = planFromScan([]);
  assert.equal(plan.room, null);
  assert.equal(plan.source, 'none');
  assert.equal(plan.warnings.length, 1);
});

test("les variantes d'ecriture des etiquettes sont reconnues", () => {
  const plan = planFromScan([
    ...rectWalls(3, 2).map((w) => ({ ...w, label: 'WALL' })),
    { ...wall(1.0, 0, 1.8, 0), label: 'Door_Frame' },
  ]);
  assert.equal(plan.source, 'walls');
  assert.equal(plan.room?.doors.length, 1);
});

/** Murs d'une piece rectangulaire posee a l'origine (ox, oz). */
function room(ox: number, oz: number, w: number, d: number): ScanPlane[] {
  const c: [number, number][] = [
    [ox, oz],
    [ox + w, oz],
    [ox + w, oz + d],
    [ox, oz + d],
  ];
  return c.map((p, i) => {
    const n = c[(i + 1) % c.length];
    return wall(p[0], p[1], n[0], n[1]);
  });
}

test('deux pieces dans un meme releve sont separees', () => {
  // Le casque renvoie tout son modele d'espace : le salon configuré pour jouer
  // et la salle de bain relevée ensuite.
  const plan = planFromScan([...room(0, 0, 4, 3), ...room(10, 0, 2, 1.5)]);
  assert.equal(plan.rooms.length, 2);
  // Triees de la plus grande a la plus petite.
  assert.ok(Math.abs(plan.rooms[0].area - 120000) < 1);
  assert.ok(Math.abs(plan.rooms[1].area - 30000) < 1);
  assert.match(plan.warnings.join(' '), /2 pièces/);
});

test('la piece ou se tient le porteur est celle qui est retenue', () => {
  const planes = [...room(0, 0, 4, 3), ...room(10, 0, 2, 1.5)];
  // Debout au milieu de la petite piece.
  const plan = planFromScan(planes, { viewer: { x: 11, y: 1.6, z: 0.75 } });
  assert.equal(plan.rooms[plan.selected].containsViewer, true);
  assert.ok(Math.abs(plan.rooms[plan.selected].area - 30000) < 1);
  assert.ok(Math.abs(polygonArea(plan.room!.points) - 30000) < 1);
  assert.match(plan.warnings.join(' '), /où tu te tenais/);
});

test('sans position connue, la plus grande piece est retenue et signalee', () => {
  const plan = planFromScan([...room(0, 0, 4, 3), ...room(10, 0, 2, 1.5)]);
  assert.equal(plan.selected, 0);
  assert.equal(plan.rooms[0].containsViewer, false);
  assert.match(plan.warnings.join(' '), /la plus grande/);
});

test('chaque meuble et chaque porte va dans sa propre piece', () => {
  const plan = planFromScan([
    ...room(0, 0, 4, 3),
    ...room(10, 0, 2, 1.5),
    slab('couch', [[1, 1], [2, 1], [2, 1.8], [1, 1.8]], 0.4),
    slab('storage', [[10.2, 0.2], [10.8, 0.2], [10.8, 0.7], [10.2, 0.7]], 0.5),
    wall(10.5, 0, 11.3, 0, 'door'),
  ]);
  const big = plan.rooms[0];
  const small = plan.rooms[1];
  assert.deepEqual(big.obstacles.map((o) => o.label), ['Canapé']);
  assert.deepEqual(small.obstacles.map((o) => o.label), ['Rangement']);
  // La porte n'est rattachée qu'à la petite pièce.
  assert.equal(small.doors.length, 1);
  assert.equal(big.doors.length, 0);
});

test('chaque piece est recalee independamment dans le quadrant positif', () => {
  const plan = planFromScan([...room(-5, -5, 4, 3), ...room(10, 10, 2, 1.5)]);
  for (const r of plan.rooms) {
    const box = bboxOf(r.points);
    assert.ok(Math.abs(box.minX - 15) < 1e-6);
    assert.ok(Math.abs(box.minY - 15) < 1e-6);
  }
});

test('le releve brut est conservé dans la scene et permet de recalculer', () => {
  const raw = {
    capturedAt: '2026-09-02T19:00:00.000Z',
    planes: [...room(0, 0, 4, 3), ...room(10, 0, 2, 1.5)],
    viewer: { x: 11, y: 1.6, z: 0.75 },
  };
  const { scene, plan } = sceneFromScan(raw, 'Salle de bain');
  // La matiere premiere voyage avec la scene : plus besoin du casque pour rejouer.
  assert.equal(scene.scan, raw);
  assert.ok(Math.abs(polygonArea(scene.room!.points) - 30000) < 1);

  // Rejoue sans casque, et bascule sur l'autre piece.
  const replayed = planFromRawScan(scene.scan!);
  assert.equal(replayed.rooms.length, 2);
  assert.equal(replayed.selected, plan.selected);
  const other = sceneFromRoom(replayed.rooms[0], scene.name, scene.scan);
  assert.ok(Math.abs(polygonArea(other.room!.points) - 120000) < 1);
  assert.equal(other.scan, raw);
});
