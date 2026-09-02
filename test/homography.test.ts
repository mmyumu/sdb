import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyH, composeH, homographyFromQuads, invertH } from '../src/core/homography.ts';
import type { Mat3 } from '../src/core/homography.ts';
import type { Pt } from '../src/core/geometry.ts';

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;

test('homographyFromQuads envoie exactement src sur dst', () => {
  // Quadrilatere en perspective typique d'une dalle photographiee de biais.
  const src: Pt[] = [
    { x: 320, y: 540 },
    { x: 780, y: 520 },
    { x: 900, y: 760 },
    { x: 210, y: 800 },
  ];
  const dst: Pt[] = [
    { x: 0, y: 0 },
    { x: 60, y: 0 },
    { x: 60, y: 60 },
    { x: 0, y: 60 },
  ];
  const h = homographyFromQuads(src, dst);
  assert.ok(h);
  for (let i = 0; i < 4; i++) {
    const q = applyH(h!, src[i]);
    assert.ok(q && near(q.x, dst[i].x, 1e-6) && near(q.y, dst[i].y, 1e-6), `coin ${i}`);
  }
});

test('invertH annule applyH', () => {
  const src: Pt[] = [
    { x: 10, y: 20 },
    { x: 400, y: 15 },
    { x: 460, y: 300 },
    { x: -20, y: 330 },
  ];
  const dst: Pt[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 80 },
    { x: 0, y: 80 },
  ];
  const h = homographyFromQuads(src, dst)!;
  const inv = invertH(h)!;
  for (const p of [{ x: 123, y: 77 }, { x: 300, y: 200 }, { x: 50, y: 310 }]) {
    const back = applyH(inv, applyH(h, p)!)!;
    assert.ok(near(back.x, p.x, 1e-6) && near(back.y, p.y, 1e-6));
  }
});

test('un rectangle non carre garde son rapport d aspect', () => {
  // Un rectangle 120 x 40 vu en perspective doit se redresser en 120 x 40,
  // pas en carre : c est ce qui rend l echelle exploitable.
  const src: Pt[] = [
    { x: 100, y: 400 },
    { x: 700, y: 380 },
    { x: 820, y: 520 },
    { x: 40, y: 560 },
  ];
  const h = homographyFromQuads(src, [
    { x: 0, y: 0 },
    { x: 120, y: 0 },
    { x: 120, y: 40 },
    { x: 0, y: 40 },
  ])!;
  const a = applyH(h, src[0])!;
  const b = applyH(h, src[1])!;
  const c = applyH(h, src[2])!;
  assert.ok(near(Math.hypot(b.x - a.x, b.y - a.y), 120, 1e-6));
  assert.ok(near(Math.hypot(c.x - b.x, c.y - b.y), 40, 1e-6));
});

test('composeH applique la mise a l echelle apres l homographie', () => {
  const h = homographyFromQuads(
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 },
      { x: 0, y: 50 },
    ],
  )!;
  const scale: Mat3 = [2, 0, 5, 0, 2, 7, 0, 0, 1];
  const q = applyH(composeH(scale, h), { x: 10, y: 10 })!;
  assert.ok(near(q.x, 50 * 2 + 5) && near(q.y, 50 * 2 + 7));
});

test('points alignes : pas d homographie', () => {
  const h = homographyFromQuads(
    [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ],
    [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 60 },
      { x: 0, y: 60 },
    ],
  );
  assert.equal(h, null);
});
