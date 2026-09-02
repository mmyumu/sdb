/**
 * Retouche du contour d'une piece.
 *
 * Un releve du casque simplifie : les murs reviennent en rectangles, et une niche
 * ou un coffrage disparait. Pouvoir ajouter et retirer un coin est donc la
 * premiere chose qui manque une fois le plan importe.
 *
 * La difficulte n'est pas geometrique mais comptable : `Room.doors` designe les
 * aretes par leur index, et toute insertion ou suppression les decale.
 */

import type { Pt } from '../core/geometry.ts';
import { bboxOf, circlePolygon } from '../core/geometry.ts';
import type { Obstacle, Room } from './types.ts';

/** Nombre minimal de sommets pour que le contour reste un polygone. */
const MIN_POINTS = 3;

/**
 * Insere un sommet sur l'arete `edge`. La nouvelle arete prend l'index `edge + 1`,
 * et une ouverture qui portait sur l'arete coupee couvre desormais ses deux moities.
 */
export function insertRoomVertex(room: Room, edge: number, point: Pt): boolean {
  const n = room.points.length;
  if (edge < 0 || edge >= n) return false;

  room.points.splice(edge + 1, 0, { ...point });
  room.doors = normalize(
    room.doors.flatMap((d) => {
      if (d === edge) return [edge, edge + 1];
      return [d < edge ? d : d + 1];
    }),
  );
  return true;
}

/**
 * Retire le sommet `index`. Les deux aretes qui s'y rejoignaient n'en font plus
 * qu'une, traversable si l'une des deux l'etait.
 */
export function removeRoomVertex(room: Room, index: number): boolean {
  const n = room.points.length;
  if (index < 0 || index >= n || n <= MIN_POINTS) return false;

  room.points.splice(index, 1);
  // Retirer le sommet 0 fusionne la derniere arete avec la premiere : la fusion
  // se retrouve donc en fin de contour, et non a l'endroit du sommet.
  const merged = index === 0 ? n - 2 : index - 1;
  room.doors = normalize(
    room.doors.map((d) => {
      if (index === 0) return d === 0 || d === n - 1 ? merged : d - 1;
      if (d === index - 1 || d === index) return merged;
      return d > index ? d - 1 : d;
    }),
  );
  return true;
}

/** Insere un sommet dans un polygone sans ouvertures (emprise de meuble). */
export function insertPolygonVertex(points: Pt[], edge: number, point: Pt): boolean {
  if (edge < 0 || edge >= points.length) return false;
  points.splice(edge + 1, 0, { ...point });
  return true;
}

export function removePolygonVertex(points: Pt[], index: number): boolean {
  if (index < 0 || index >= points.length || points.length <= MIN_POINTS) return false;
  points.splice(index, 1);
  return true;
}

function normalize(doors: number[]): number[] {
  return [...new Set(doors)].filter((d) => d >= 0).sort((a, b) => a - b);
}

/** Diametres exploitables : en dessous d'un centimetre il n'y a plus d'emprise. */
const MIN_DIAMETER = 1;

/**
 * Agrandit ou retrecit une emprise sans la deformer.
 *
 * Le centre de l'englobant sert de point fixe : le meuble grandit sur place,
 * ce qui est ce qu'on attend en voyant un chiffre changer. Il est repris du
 * contour plutot que memorise, et suit donc les deplacements tout seul.
 */
export function scaleObstacle(obstacle: Obstacle, factor: number): boolean {
  if (!(factor > 0) || obstacle.points.length < 3) return false;
  if (Math.abs(factor - 1) < 1e-12) return true;

  const box = bboxOf(obstacle.points);
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  for (const p of obstacle.points) {
    p.x = cx + (p.x - cx) * factor;
    p.y = cy + (p.y - cy) * factor;
  }
  if (obstacle.round !== undefined) obstacle.round *= factor;
  return true;
}

/**
 * Redimensionne l'emprise pour que son encombrement sur `axis` vaille `cm`.
 * L'autre dimension suit dans le meme rapport : la forme est preservee.
 */
export function resizeObstacleTo(obstacle: Obstacle, axis: 'width' | 'depth', cm: number): boolean {
  if (!(cm >= MIN_DIAMETER) || obstacle.points.length < 3) return false;
  const box = bboxOf(obstacle.points);
  const current = axis === 'width' ? box.maxX - box.minX : box.maxY - box.minY;
  if (!(current > 1e-9)) return false;
  return scaleObstacle(obstacle, cm / current);
}

/** Encombrement de l'emprise, tel qu'affiche dans le panneau. */
export function obstacleSize(obstacle: Obstacle): { width: number; depth: number } {
  const box = bboxOf(obstacle.points);
  return { width: box.maxX - box.minX, depth: box.maxY - box.minY };
}

/**
 * Redimensionne une emprise ronde par son diametre.
 * Le contour est reconstruit plutot que mis a l'echelle : un cercle reste ainsi
 * exactement un cercle, sans derive au fil des redimensionnements.
 */
export function resizeRoundObstacle(obstacle: Obstacle, diameter: number): boolean {
  if (obstacle.round === undefined || !(diameter >= MIN_DIAMETER)) return false;
  const box = bboxOf(obstacle.points);
  const center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
  obstacle.points = circlePolygon(center, diameter, obstacle.points.length);
  obstacle.round = diameter;
  return true;
}

/** Une emprise dont on a bouge un sommet n'est plus un cercle. */
export function dropRoundness(obstacle: Obstacle): void {
  delete obstacle.round;
}
