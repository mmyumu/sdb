import type { Pt } from '../core/geometry.ts';
import {
  circlePolygon,
  polygonCrossesSegment,
  polygonsOverlap,
  rectPolygon,
} from '../core/geometry.ts';
import type { Movable, Scene } from './types.ts';

/**
 * Emprise de l'objet, elargie du jeu de securite.
 * Un cercle est approxime par un polygone : la detection reste uniforme.
 */
export function movablePolygon(
  m: Movable,
  clearance = 0,
  pos: Pt = m.pos,
  angle: number = m.angle,
): Pt[] {
  const pad = clearance * 2;
  if (m.kind === 'circle') return circlePolygon(pos, m.w + pad);
  return rectPolygon(pos, m.w + pad, m.h + pad, angle);
}
export interface CollisionReport {
  hit: boolean;
  /** Index des aretes de la piece heurtees (les portes sont ignorees). */
  walls: number[];
  /** Identifiants des meubles heurtes. */
  obstacles: string[];
}
export function collisionReport(
  scene: Scene,
  m: Movable,
  pos: Pt = m.pos,
  angle: number = m.angle,
): CollisionReport {
  const poly = movablePolygon(m, scene.clearance, pos, angle);
  const walls: number[] = [];
  const obstacles: string[] = [];
  const room = scene.room;
  if (room && room.points.length >= 2) {
    const doors = new Set(room.doors);
    const n = room.points.length;
    for (let i = 0; i < n; i++) {
      if (doors.has(i)) continue;
      const a = room.points[i];
      const b = room.points[(i + 1) % n];
      if (polygonCrossesSegment(poly, a, b)) walls.push(i);
    }
  }
  for (const o of scene.obstacles) {
    if (o.points.length < 3) continue;
    if (polygonsOverlap(poly, o.points)) obstacles.push(o.id);
  }
  return { hit: walls.length > 0 || obstacles.length > 0, walls, obstacles };
}
export function isFree(scene: Scene, m: Movable, pos: Pt, angle: number): boolean {
  return !collisionReport(scene, m, pos, angle).hit;
}
/** Plus petite dimension de l'objet : borne la taille d'un pas de balayage. */
function smallestSide(m: Movable): number {
  return m.kind === 'circle' ? m.w : Math.min(m.w, m.h);
}
/** Dichotomie entre une position libre et une position bloquee. */
function refine(scene: Scene, m: Movable, free: Pt, blocked: Pt, angle: number): Pt {
  let lo = free;
  let hi = blocked;
  for (let i = 0; i < 12; i++) {
    const mid = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 };
    if (isFree(scene, m, mid, angle)) lo = mid;
    else hi = mid;
  }
  return lo;
}
/**
 * Plus grande fraction de `delta` parcourable sans collision.
 *
 * Le trajet est balaye pas a pas : tester uniquement le point d'arrivee laisserait
 * l'objet franchir un mur ou un couloir trop etroit d'un seul bond. Le pas reste
 * petit devant l'objet, ce qui rend ce saut impossible.
 */
function advance(scene: Scene, m: Movable, from: Pt, delta: Pt, angle: number): Pt {
  const distance = Math.hypot(delta.x, delta.y);
  if (distance < 1e-9) return from;
  const maxStep = Math.max(0.5, smallestSide(m) / 4);
  const steps = Math.min(2000, Math.max(1, Math.ceil(distance / maxStep)));
  let last = from;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const candidate = { x: from.x + delta.x * t, y: from.y + delta.y * t };
    if (isFree(scene, m, candidate, angle)) {
      last = candidate;
      continue;
    }
    return refine(scene, m, last, candidate, angle);
  }
  return last;
}
/**
 * Deplace l'objet vers `target` en butant sur les obstacles.
 * Quand le trajet direct est bloque, on consomme le reste du deplacement
 * axe par axe : l'objet glisse le long des murs au lieu de se figer.
 */
export function moveWithCollision(scene: Scene, m: Movable, target: Pt): Pt {
  if (!scene.collisionEnabled) return target;
  const from = m.pos;
  const delta = { x: target.x - from.x, y: target.y - from.y };
  if (delta.x === 0 && delta.y === 0) return from;
  // Si la position de depart est deja en collision (objet pose a la main,
  // jeu de securite augmente...), on laisse l'utilisateur s'en degager.
  if (!isFree(scene, m, from, m.angle)) return target;
  let pos = advance(scene, m, from, delta, m.angle);
  const remaining = { x: target.x - pos.x, y: target.y - pos.y };
  if (Math.abs(remaining.x) > 1e-6) {
    pos = advance(scene, m, pos, { x: remaining.x, y: 0 }, m.angle);
  }
  const remainingY = target.y - pos.y;
  if (Math.abs(remainingY) > 1e-6) {
    pos = advance(scene, m, pos, { x: 0, y: remainingY }, m.angle);
  }
  return pos;
}
/**
 * Rotation bloquee : conserve le dernier angle sans collision.
 * Balayee elle aussi, sinon un objet long pourrait pivoter au travers d'un mur.
 */
export function rotateWithCollision(scene: Scene, m: Movable, targetAngle: number): number {
  if (!scene.collisionEnabled) return targetAngle;
  if (!isFree(scene, m, m.pos, m.angle)) return targetAngle;
  const sweep = targetAngle - m.angle;
  if (Math.abs(sweep) < 1e-9) return targetAngle;
  // Un pas d'arc d'au plus un quart de la plus petite dimension de l'objet.
  const radius = Math.max(1, Math.hypot(m.w, m.h) / 2);
  const maxStep = Math.max(0.01, smallestSide(m) / 4 / radius);
  const steps = Math.min(720, Math.max(1, Math.ceil(Math.abs(sweep) / maxStep)));
  let last = m.angle;
  for (let i = 1; i <= steps; i++) {
    const candidate = m.angle + (sweep * i) / steps;
    if (isFree(scene, m, m.pos, candidate)) {
      last = candidate;
      continue;
    }
    let lo = last;
    let hi = candidate;
    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) / 2;
      if (isFree(scene, m, m.pos, mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }
  return last;
}
