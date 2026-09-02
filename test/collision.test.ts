import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collisionReport, moveWithCollision, rotateWithCollision } from '../src/model/collision.ts';
import { emptyScene } from '../src/model/types.ts';
import type { Movable, Scene } from '../src/model/types.ts';

/** Piece rectangulaire de 300 x 250 cm, coin haut-gauche a l'origine. */
function room(scene: Scene, doors: number[] = []): Scene {
  scene.room = {
    points: [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 250 },
      { x: 0, y: 250 },
    ],
    doors,
  };
  return scene;
}

function machine(x: number, y: number, w = 60, h = 60): Movable {
  return { id: 'm', label: 'Lave-linge', kind: 'rect', w, h, pos: { x, y }, angle: 0, color: '#fff' };
}

function scenario(doors: number[] = []): { scene: Scene; m: Movable } {
  const scene = room(emptyScene(), doors);
  const m = machine(150, 125);
  scene.movables.push(m);
  return { scene, m };
}

test('un objet bute contre le mur au lieu de le traverser', () => {
  const { scene, m } = scenario();
  const pos = moveWithCollision(scene, m, { x: 1000, y: 125 });
  // Le mur droit est en x = 300, la demi-largeur vaut 30.
  assert.ok(pos.x > 269 && pos.x <= 270, `x=${pos.x}`);
  assert.ok(Math.abs(pos.y - 125) < 1e-6);
});

test('un objet glisse le long du mur au lieu de se figer', () => {
  const { scene, m } = scenario();
  // Deplacement en diagonale vers le mur droit : le composant vertical doit passer.
  const pos = moveWithCollision(scene, m, { x: 1000, y: 200 });
  assert.ok(pos.x > 269 && pos.x <= 270, `bloque en x: ${pos.x}`);
  assert.ok(Math.abs(pos.y - 200) < 0.5, `glissement vertical incomplet: ${pos.y}`);
});

test('une arete marquee porte laisse sortir l objet', () => {
  const { scene, m } = scenario([1]); // arete 1 = mur droit
  const pos = moveWithCollision(scene, m, { x: 600, y: 125 });
  assert.ok(Math.abs(pos.x - 600) < 1e-6, `bloque a ${pos.x}`);
});

test('sans porte, aucune sortie possible', () => {
  const { scene, m } = scenario([]);
  const pos = moveWithCollision(scene, m, { x: 600, y: 125 });
  assert.ok(pos.x < 271);
});

test('un meuble bloque le passage', () => {
  const { scene, m } = scenario();
  scene.obstacles.push({
    id: 'o',
    label: 'Baignoire',
    color: '#fff',
    points: [
      { x: 200, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 250 },
      { x: 200, y: 250 },
    ],
  });
  const pos = moveWithCollision(scene, m, { x: 280, y: 125 });
  assert.ok(pos.x > 169 && pos.x <= 170, `x=${pos.x}`);
  assert.deepEqual(collisionReport(scene, m, { x: 250, y: 125 }).obstacles, ['o']);
});

/** Deux meubles laissant un couloir de `gap` cm centre sur x = 150. */
function corridor(scene: Scene, gap: number): void {
  const half = gap / 2;
  scene.obstacles.push(
    {
      id: 'a',
      label: 'Gauche',
      color: '#fff',
      points: [
        { x: 0, y: 100 },
        { x: 150 - half, y: 100 },
        { x: 150 - half, y: 140 },
        { x: 0, y: 140 },
      ],
    },
    {
      id: 'b',
      label: 'Droite',
      color: '#fff',
      points: [
        { x: 150 + half, y: 100 },
        { x: 300, y: 100 },
        { x: 300, y: 140 },
        { x: 150 + half, y: 140 },
      ],
    },
  );
}

test('un couloir plus large que la machine laisse passer', () => {
  const scene = room(emptyScene());
  corridor(scene, 66);
  const m = machine(150, 200);
  scene.movables.push(m);
  const pos = moveWithCollision(scene, m, { x: 150, y: 40 });
  assert.ok(Math.abs(pos.y - 40) < 1e-6, `bloque a y=${pos.y}`);
});

test('un couloir plus etroit que la machine bloque', () => {
  const scene = room(emptyScene());
  corridor(scene, 56);
  const m = machine(150, 200);
  scene.movables.push(m);
  const pos = moveWithCollision(scene, m, { x: 150, y: 40 });
  assert.ok(pos.y > 165, `la machine a traverse un passage de 56 cm: y=${pos.y}`);
});

test('le jeu de securite retrecit les passages', () => {
  const scene = room(emptyScene());
  corridor(scene, 66);
  scene.clearance = 5; // 60 + 2 x 5 = 70 cm d encombrement
  const m = machine(150, 200);
  scene.movables.push(m);
  const pos = moveWithCollision(scene, m, { x: 150, y: 40 });
  assert.ok(pos.y > 165, `le jeu de securite n a pas ete pris en compte: y=${pos.y}`);
});

test('desactiver les collisions laisse tout passer', () => {
  const { scene, m } = scenario();
  scene.collisionEnabled = false;
  const pos = moveWithCollision(scene, m, { x: 5000, y: 5000 });
  assert.deepEqual(pos, { x: 5000, y: 5000 });
});

test('la rotation est bloquee quand elle ferait mordre un mur', () => {
  const scene = room(emptyScene());
  // Objet long en travers de la piece : le tourner le ferait sortir (280 > 250 cm).
  const m = machine(150, 125, 280, 40);
  scene.movables.push(m);
  assert.equal(collisionReport(scene, m).hit, false, 'position initiale libre');
  const angle = rotateWithCollision(scene, m, Math.PI / 2);
  assert.ok(Math.abs(angle) < Math.PI / 2 - 0.01, `rotation non bridee: ${angle}`);
});

test('un objet deja en collision reste librement deplacable', () => {
  const { scene, m } = scenario();
  m.pos = { x: 295, y: 125 }; // pose a cheval sur le mur
  assert.equal(collisionReport(scene, m).hit, true);
  const pos = moveWithCollision(scene, m, { x: 150, y: 125 });
  assert.deepEqual(pos, { x: 150, y: 125 });
});
