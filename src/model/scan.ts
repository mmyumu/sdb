/**
 * Conversion d'un releve de surfaces 3D (Quest 3 / WebXR) en plan 2D.
 *
 * Le module ne connait ni WebXR ni le casque : il prend des polygones en metres
 * dans un repere ou Y pointe vers le haut, et rend le meme modele `Scene` que
 * le parcours photo. C'est ce qui permet de le tester sans materiel.
 */

import type { Pt } from '../core/geometry.ts';
import {
  bboxOf,
  convexHull,
  dist,
  distanceToSegment,
  farthestPair,
  lineIntersection,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  projectionParam,
  simplifyPolygon,
} from '../core/geometry.ts';
import type { Obstacle, RawScan, Room, Scene, ScanPlane, Vec3 } from './types.ts';
import { FURNITURE_COLORS, emptyScene, uid } from './types.ts';

export type { ScanPlane, Vec3 };

export interface ScanOptions {
  /** Ecart max entre deux extremites de murs pour les considerer jointes (cm). */
  jointTolerance?: number;
  /** Ecart max entre une porte et le mur auquel on la rattache (cm). */
  doorTolerance?: number;
  /** Marge entre le bord du plan et l'origine du monde (cm). */
  margin?: number;
  /** Aire minimale d'une emprise de meuble retenue (cm²). */
  minObstacleArea?: number;
  /** Longueur minimale d'un mur ou d'une porte exploitable (cm). */
  minSegment?: number;
  /** Position du casque pendant le releve : designe la piece a retenir. */
  viewer?: Vec3 | null;
}

/** D'ou vient le contour de la piece : chainage des murs, ou polygone du sol. */
export type ContourSource = 'walls' | 'floor' | 'none';

/**
 * Une piece du releve. Le casque renvoie l'integralite de son modele d'espace :
 * la piece de jeu, la salle de bain, tout ce qui a ete configure un jour. Il faut
 * donc les separer, puis n'en garder qu'une.
 */
export interface ScanRoom {
  id: string;
  points: Pt[];
  doors: number[];
  obstacles: Obstacle[];
  /** Aire au sol, en cm². */
  area: number;
  /** Le porteur du casque s'y tenait au moment du releve. */
  containsViewer: boolean;
  source: ContourSource;
}

export interface ScanPlan {
  /** Toutes les pieces trouvees, deja recalees, de la plus grande a la plus petite. */
  rooms: ScanRoom[];
  /** Index de la piece retenue dans `rooms`, -1 s'il n'y en a aucune. */
  selected: number;
  room: Room | null;
  obstacles: Obstacle[];
  source: ContourSource;
  warnings: string[];
}

interface Seg {
  a: Pt;
  b: Pt;
}

const DEFAULTS: Required<ScanOptions> = {
  jointTolerance: 35,
  doorTolerance: 45,
  margin: 15,
  minObstacleArea: 300,
  minSegment: 20,
  viewer: null,
};

/**
 * Etiquettes qui ne sont pas une emprise au sol : elles decrivent l'enveloppe de
 * la piece ou un element accroche a un mur.
 */
const NOT_FURNITURE = new Set([
  'floor',
  'ceiling',
  'wall',
  'wall face',
  'invisible wall face',
  'door',
  'door frame',
  'window',
  'window frame',
  'wall art',
  'screen',
  'global mesh',
]);

const DOOR_LABELS = new Set(['door', 'door frame']);

const FURNITURE_NAMES: Record<string, string> = {
  table: 'Table',
  desk: 'Bureau',
  couch: 'Canapé',
  bed: 'Lit',
  storage: 'Rangement',
  shelf: 'Étagère',
  cabinet: 'Meuble',
  plant: 'Plante',
  lamp: 'Lampe',
  other: 'Objet',
};

/** Uniformise les variantes d'ecriture des etiquettes ('WALL_ART', 'wall-art'…). */
export function normalizeLabel(raw: string): string {
  return raw.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Vue de dessus : X du monde devient X du plan, Z devient Y.
 * Vu depuis le dessus avec Y vers le haut, +Z va vers le bas de l'image, ce qui
 * correspond deja au sens du canvas — il n'y a pas de miroir a appliquer.
 */
const project = (p: Vec3): Pt => ({ x: p.x * 100, y: p.z * 100 });

const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const mid = (a: Pt, b: Pt): Pt => lerp(a, b, 0.5);

/** Empreinte au sol d'un plan vertical : ses deux points projetes les plus eloignes. */
function footprint(plane: ScanPlane, minLength: number): Seg | null {
  const pair = farthestPair(plane.polygon.map(project));
  if (!pair || dist(pair[0], pair[1]) < minLength) return null;
  return { a: pair[0], b: pair[1] };
}

/** Prolonge une chaine de segments en piochant, a chaque pas, le plus proche du bout libre. */
function extend(chain: Seg[], pool: Seg[], tol: number, forward: boolean): void {
  for (;;) {
    const tail = forward ? chain[chain.length - 1].b : chain[0].a;
    let bestI = -1;
    let bestD = Infinity;
    let flip = false;
    for (let i = 0; i < pool.length; i++) {
      const da = dist(tail, pool[i].a);
      const db = dist(tail, pool[i].b);
      if (da < bestD) {
        bestD = da;
        bestI = i;
        flip = !forward;
      }
      if (db < bestD) {
        bestD = db;
        bestI = i;
        flip = forward;
      }
    }
    if (bestI < 0 || bestD > tol) return;
    const [s] = pool.splice(bestI, 1);
    const oriented = flip ? { a: s.b, b: s.a } : s;
    if (forward) chain.push(oriented);
    else chain.unshift(oriented);
  }
}

/**
 * Contours fermes a partir des empreintes de murs.
 *
 * Les murs du casque sont des rectangles independants qui ne se rejoignent pas
 * exactement : on les chaine par proximite, puis chaque coin est pris comme
 * l'intersection des deux droites porteuses plutot que comme un point mesure.
 * Un mur manquant laisse un trou, qu'on referme par un segment droit signale.
 *
 * Le releve couvre toutes les pieces configurees dans le casque : quand la chaine
 * ne trouve plus de voisin, c'est qu'on a fait le tour d'une piece, et les murs
 * restants appartiennent a une autre. D'ou la boucle exterieure.
 */
function contoursFromWalls(segments: Seg[], tol: number): { points: Pt[]; gaps: number }[] {
  const pool = segments.slice();
  const out: { points: Pt[]; gaps: number }[] = [];

  while (pool.length >= 3) {
    const chain: Seg[] = [pool.shift() as Seg];
    extend(chain, pool, tol, true);
    extend(chain, pool, tol, false);
    if (chain.length < 3) continue;

    const n = chain.length;
    const points: Pt[] = [];
    let gaps = 0;
    for (let i = 0; i < n; i++) {
      const prev = chain[(i - 1 + n) % n];
      const cur = chain[i];
      if (dist(prev.b, cur.a) <= tol) {
        const corner = lineIntersection(prev.a, prev.b, cur.a, cur.b);
        points.push(corner && dist(corner, cur.a) <= tol * 3 ? corner : mid(prev.b, cur.a));
      } else {
        // Mur absent : on relie les deux bouts libres tels quels.
        gaps++;
        points.push(prev.b);
        points.push(cur.a);
      }
    }

    const simplified = simplifyPolygon(points, 2);
    if (simplified.length >= 3) out.push({ points: simplified, gaps });
  }
  return out;
}

interface Span {
  t0: number;
  t1: number;
}

/**
 * Rattache chaque porte a l'arete du contour dont elle est la plus proche, en
 * decoupant cette arete pour que seule la largeur reelle de la porte devienne
 * traversable — et non le mur entier.
 */
function insertDoors(
  points: Pt[],
  doors: Seg[],
  tol: number,
  minSegment: number,
): { points: Pt[]; doors: number[]; attached: number } {
  const n = points.length;
  const spans = new Map<number, Span[]>();
  let attached = 0;

  for (const door of doors) {
    let bestEdge = -1;
    let bestScore = Infinity;
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      const score = Math.max(distanceToSegment(door.a, a, b), distanceToSegment(door.b, a, b));
      if (score < bestScore) {
        bestScore = score;
        bestEdge = i;
      }
    }
    if (bestEdge < 0 || bestScore > tol) continue;

    const a = points[bestEdge];
    const b = points[(bestEdge + 1) % n];
    const length = dist(a, b);
    if (length < minSegment) continue;

    let t0 = Math.max(0, Math.min(1, projectionParam(door.a, a, b)));
    let t1 = Math.max(0, Math.min(1, projectionParam(door.b, a, b)));
    if (t0 > t1) [t0, t1] = [t1, t0];
    if ((t1 - t0) * length < minSegment) continue;
    // Une porte qui affleure un coin : on la fait coincider avec lui plutot que
    // de creer une arete de quelques millimetres.
    if (t0 * length < minSegment) t0 = 0;
    if ((1 - t1) * length < minSegment) t1 = 1;

    const list = spans.get(bestEdge) ?? [];
    list.push({ t0, t1 });
    spans.set(bestEdge, list);
    attached++;
  }

  if (!attached) return { points, doors: [], attached: 0 };

  const out: Pt[] = [];
  const doorEdges: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    out.push(a);
    for (const span of mergeSpans(spans.get(i) ?? [])) {
      if (span.t0 > 0) out.push(lerp(a, b, span.t0));
      doorEdges.push(out.length - 1);
      if (span.t1 < 1) out.push(lerp(a, b, span.t1));
    }
  }
  return { points: out, doors: doorEdges, attached };
}

function mergeSpans(list: Span[]): Span[] {
  const sorted = list.slice().sort((p, q) => p.t0 - q.t0);
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span.t0 <= last.t1) last.t1 = Math.max(last.t1, span.t1);
    else out.push({ ...span });
  }
  return out;
}

/** Traduit un releve de surfaces en une ou plusieurs pieces exploitables. */
export function planFromScan(planes: ScanPlane[], options: ScanOptions = {}): ScanPlan {
  const opt = { ...DEFAULTS, ...options };
  const warnings: string[] = [];
  const labelled = planes.map((p) => ({ label: normalizeLabel(p.label), polygon: p.polygon }));

  const floorPolygons = labelled
    .filter((p) => p.label === 'floor' && p.polygon.length >= 3)
    .map((p) => simplifyPolygon(p.polygon.map(project), 2))
    .filter((poly) => poly.length >= 3);

  const wallSegments = labelled
    .filter((p) => p.label === 'wall' || p.label === 'wall face')
    .map((p) => footprint(p, opt.minSegment))
    .filter((s): s is Seg => s !== null);

  const candidates: { points: Pt[]; source: ContourSource; gaps: number }[] = contoursFromWalls(
    wallSegments,
    opt.jointTolerance,
  ).map((c) => ({ points: c.points, source: 'walls' as ContourSource, gaps: c.gaps }));

  // Le sol d'une piece la decrit mieux que ses murs des lors qu'il n'est pas un
  // simple rectangle. Et un sol qui ne tombe dans aucun contour signale une piece
  // dont les murs n'ont pas ete reconstruits.
  for (const floor of floorPolygons) {
    const host = candidates.findIndex((c) => pointInPolygon(polygonCentroid(floor), c.points));
    if (host < 0) {
      candidates.push({ points: floor, source: 'floor', gaps: 0 });
    } else if (floor.length > candidates[host].points.length) {
      candidates[host] = { points: floor, source: 'floor', gaps: 0 };
    }
  }

  if (!candidates.length) {
    warnings.push("Aucun mur ni sol exploitable dans le relevé. La configuration de la pièce est-elle faite ?");
    return { rooms: [], selected: -1, room: null, obstacles: [], source: 'none', warnings };
  }

  const doorSegments = labelled
    .filter((p) => DOOR_LABELS.has(p.label))
    .map((p) => footprint(p, opt.minSegment))
    .filter((s): s is Seg => s !== null);

  const furniture = labelled
    .filter((p) => !NOT_FURNITURE.has(p.label) && p.polygon.length >= 3)
    .map((p) => ({ label: p.label, hull: simplifyPolygon(convexHull(p.polygon.map(project)), 2) }))
    .filter((f) => f.hull.length >= 3 && polygonArea(f.hull) >= opt.minObstacleArea);

  const viewer = opt.viewer ? project(opt.viewer) : null;
  const rooms: ScanRoom[] = [];
  let totalGaps = 0;
  let attachedDoors = 0;

  for (const candidate of candidates) {
    const mine = doorSegments.filter((d) => nearestCandidate(d, candidates) === candidate);
    const withDoors = insertDoors(candidate.points, mine, opt.doorTolerance, opt.minSegment);
    attachedDoors += withDoors.attached;
    totalGaps += candidate.gaps;

    const obstacles: Obstacle[] = [];
    for (const f of furniture) {
      if (!pointInPolygon(polygonCentroid(f.hull), candidate.points)) continue;
      obstacles.push({
        id: uid('obs'),
        label: FURNITURE_NAMES[f.label] ?? capitalize(f.label),
        points: f.hull,
        color: FURNITURE_COLORS[obstacles.length % FURNITURE_COLORS.length],
        fromScan: true,
      });
    }

    // Le repere WebXR est centre sur le casque : chaque piece est ramenee dans le
    // quadrant positif, comme le fait le parcours photo.
    const box = bboxOf(withDoors.points.concat(...obstacles.map((o) => o.points)));
    const dx = opt.margin - box.minX;
    const dy = opt.margin - box.minY;
    const shift = (pt: Pt): Pt => ({ x: pt.x + dx, y: pt.y + dy });

    rooms.push({
      id: uid('room'),
      points: withDoors.points.map(shift),
      doors: withDoors.doors,
      obstacles: obstacles.map((o) => ({ ...o, points: o.points.map(shift) })),
      area: polygonArea(candidate.points),
      containsViewer: viewer ? pointInPolygon(viewer, candidate.points) : false,
      source: candidate.source,
    });
  }

  rooms.sort((a, b) => b.area - a.area);

  // Se tenir dans la pièce à relever est le geste naturel : c'est le meilleur
  // signal dont on dispose pour choisir. À défaut, la plus grande.
  let selected = rooms.findIndex((r) => r.containsViewer);
  if (selected < 0) selected = 0;

  if (rooms.length > 1) {
    warnings.push(
      rooms[selected].containsViewer
        ? `${rooms.length} pièces dans le relevé du casque : celle où tu te tenais a été retenue.`
        : `${rooms.length} pièces dans le relevé du casque : la plus grande a été retenue, à changer ci-dessous.`,
    );
  }
  if (totalGaps > 0) {
    warnings.push(
      `${totalGaps} mur${totalGaps > 1 ? 's' : ''} manquant${totalGaps > 1 ? 's' : ''} : le contour a été refermé en ligne droite.`,
    );
  }
  if (doorSegments.length > attachedDoors) {
    const lost = doorSegments.length - attachedDoors;
    warnings.push(`${lost} porte${lost > 1 ? 's' : ''} n'a pas pu être rattachée à un mur.`);
  }

  const chosen = rooms[selected];
  return {
    rooms,
    selected,
    room: { points: chosen.points, doors: chosen.doors },
    obstacles: chosen.obstacles,
    source: chosen.source,
    warnings,
  };
}

/** La piece dont une porte est la plus proche, pour ne l'inserer qu'une fois. */
function nearestCandidate<T extends { points: Pt[] }>(door: Seg, candidates: T[]): T | null {
  let best: T | null = null;
  let bestScore = Infinity;
  const target = mid(door.a, door.b);
  for (const candidate of candidates) {
    for (let i = 0; i < candidate.points.length; i++) {
      const a = candidate.points[i];
      const b = candidate.points[(i + 1) % candidate.points.length];
      const score = distanceToSegment(target, a, b);
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
  }
  return best;
}

/** Le releve porte lui-meme la position du porteur : inutile de la repasser. */
export function planFromRawScan(scan: RawScan, options: ScanOptions = {}): ScanPlan {
  return planFromScan(scan.planes, { ...options, viewer: scan.viewer });
}

/**
 * Scene batie sur une piece precise du releve.
 * Le releve brut reste attache a la scene : c'est ce qui permet de recalculer le
 * plan plus tard, sans remettre le casque.
 */
export function sceneFromRoom(room: ScanRoom, name: string, scan: RawScan | null = null): Scene {
  return {
    ...emptyScene(),
    name,
    room: { points: room.points, doors: room.doors },
    obstacles: room.obstacles,
    scan,
  };
}

/** Scene complete prete a etre chargee dans le store, plus le compte rendu du releve. */
export function sceneFromScan(
  scan: RawScan,
  name: string,
  options?: ScanOptions,
): { scene: Scene; plan: ScanPlan } {
  const plan = planFromRawScan(scan, options);
  const scene: Scene =
    plan.selected >= 0
      ? sceneFromRoom(plan.rooms[plan.selected], name, scan)
      : { ...emptyScene(), name, scan };
  return { scene, plan };
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
