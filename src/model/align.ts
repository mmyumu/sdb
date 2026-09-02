/**
 * Redressement d'un plan sur la grille.
 *
 * Un releve du casque arrive dans le repere ou se trouvait le porteur : les murs
 * tombent de travers a l'ecran alors qu'ils sont d'equerre dans la realite. Deux
 * operations distinctes, volontairement separees :
 *
 * - la rotation ne change *aucune* mesure, elle ne fait que tourner le plan ;
 * - l'equerrage, lui, deplace des sommets — c'est une correction, pas un affichage.
 */

import type { Pt } from '../core/geometry.ts';
import { bboxOf, dist } from '../core/geometry.ts';
import type { Scene } from './types.ts';

/**
 * Orientation dominante des aretes, ramenee dans [-45°, 45°] et exprimee en radians.
 *
 * Les murs d'une piece sont a 0°, 90°, 180° ou 270° les uns des autres : leurs
 * directions sont donc equivalentes modulo 90°. On quadruple l'angle pour ramener
 * ce modulo a un tour complet, on fait la moyenne circulaire ponderee par les
 * longueurs — un grand mur pese plus qu'un petit — puis on divise par quatre.
 */
export function dominantAngle(points: Pt[]): number {
  if (points.length < 2) return 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const length = dist(a, b);
    if (length < 1e-9) continue;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    sx += length * Math.cos(4 * angle);
    sy += length * Math.sin(4 * angle);
  }
  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) return 0;
  return Math.atan2(sy, sx) / 4;
}

/**
 * Aligne les aretes proches d'un axe sur cet axe.
 *
 * Chaque arete quasi horizontale voit ses deux extremites ramenees a la meme
 * ordonnee, chaque arete quasi verticale a la meme abscisse. Corriger une arete
 * derange ses voisines, d'ou les quelques passes : la suite converge vite sur un
 * contour rectiligne, et les aretes franchement obliques ne sont jamais touchees.
 */
export function squareUp(points: Pt[], toleranceDeg = 8, passes = 4): void {
  const tol = (toleranceDeg * Math.PI) / 180;
  const n = points.length;
  if (n < 3) return;

  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.hypot(dx, dy) < 1e-9) continue;
      const angle = Math.atan2(dy, dx);
      // Ecart a l'horizontale et a la verticale, ramenes dans [0, pi/2].
      const toHorizontal = Math.abs(wrap(angle));
      const toVertical = Math.abs(wrap(angle - Math.PI / 2));
      if (toHorizontal <= tol && toHorizontal <= toVertical) {
        const y = (a.y + b.y) / 2;
        a.y = y;
        b.y = y;
      } else if (toVertical <= tol) {
        const x = (a.x + b.x) / 2;
        a.x = x;
        b.x = x;
      }
    }
  }
}

/** Ramene un angle dans [-pi/2, pi/2] : une arete et son opposee sont la meme direction. */
function wrap(angle: number): number {
  let a = angle;
  while (a > Math.PI / 2) a -= Math.PI;
  while (a < -Math.PI / 2) a += Math.PI;
  return a;
}

/** Tourne toute la scene autour de `pivot`. Les longueurs sont conservees. */
export function rotateScene(scene: Scene, angle: number, pivot: Pt): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const turn = (p: Pt): void => {
    const dx = p.x - pivot.x;
    const dy = p.y - pivot.y;
    p.x = pivot.x + dx * cos - dy * sin;
    p.y = pivot.y + dx * sin + dy * cos;
  };

  if (scene.room) scene.room.points.forEach(turn);
  for (const o of scene.obstacles) o.points.forEach(turn);
  for (const m of scene.measurements) {
    turn(m.a);
    turn(m.b);
  }
  for (const m of scene.movables) {
    turn(m.pos);
    // L'objet tourne avec la piece : sa largeur reste sa largeur.
    m.angle += angle;
  }
}

/** Replace le plan dans le quadrant positif, avec la meme marge que l'import. */
export function normalizeSceneOrigin(scene: Scene, margin = 15): void {
  const all: Pt[] = [];
  if (scene.room) all.push(...scene.room.points);
  for (const o of scene.obstacles) all.push(...o.points);
  if (!all.length) return;

  const box = bboxOf(all);
  const dx = margin - box.minX;
  const dy = margin - box.minY;
  const shift = (p: Pt): void => {
    p.x += dx;
    p.y += dy;
  };
  if (scene.room) scene.room.points.forEach(shift);
  for (const o of scene.obstacles) o.points.forEach(shift);
  for (const m of scene.measurements) {
    shift(m.a);
    shift(m.b);
  }
  for (const m of scene.movables) shift(m.pos);
}

export interface AlignOptions {
  /** Aligne aussi les aretes proches d'un axe sur cet axe (deplace des sommets). */
  square?: boolean;
  toleranceDeg?: number;
  margin?: number;
}

/**
 * Redresse la scene : le mur dominant devient horizontal.
 * Renvoie l'angle applique, en radians.
 */
export function alignSceneToGrid(scene: Scene, options: AlignOptions = {}): number {
  const reference = scene.room?.points.length ? scene.room.points : null;
  if (!reference) return 0;

  const angle = -dominantAngle(reference);
  const box = bboxOf(reference);
  const pivot = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
  if (Math.abs(angle) > 1e-9) rotateScene(scene, angle, pivot);
  if (options.square && scene.room) squareUp(scene.room.points, options.toleranceDeg ?? 8);
  normalizeSceneOrigin(scene, options.margin ?? 15);
  return angle;
}
