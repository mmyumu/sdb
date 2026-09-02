import type { Pt } from '../core/geometry.ts';

export const SCENE_VERSION = 1;

/** Point 3D en metres, dans le repere du casque (Y vers le haut). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Une surface telle que le casque la renvoie, sans interpretation. */
export interface ScanPlane {
  label: string;
  polygon: Vec3[];
}

/**
 * Le releve brut, conserve tel quel.
 *
 * On garde la matiere premiere et pas seulement le plan qu'on en tire : la facon
 * de la convertir va continuer d'evoluer, et il serait absurde de devoir remettre
 * le casque a chaque fois. Un releve pese quelques dizaines de kilo-octets.
 */
export interface RawScan {
  capturedAt: string;
  planes: ScanPlane[];
  /** Ou se tenait le porteur : sert a choisir la piece parmi celles du releve. */
  viewer: Vec3 | null;
}

/** Photo redressée servant de calque de fond. Placée à l'origine du monde. */
export interface Background {
  /** Image redressée encodée (data URL). */
  dataUrl: string;
  widthPx: number;
  heightPx: number;
  /** Centimètres représentés par un pixel de l'image. */
  cmPerPx: number;
  opacity: number;
}

/**
 * Contour de la pièce. `doors` liste les index des arêtes traversables :
 * l'arete i va de points[i] a points[(i + 1) % n].
 */
export interface Room {
  points: Pt[];
  doors: number[];
}

/** Emprise au sol d'un meuble ou d'un obstacle fixe. */
export interface Obstacle {
  id: string;
  label: string;
  points: Pt[];
  color: string;
  /**
   * Vrai quand l'emprise vient du releve du casque.
   *
   * Recalculer le plan reconstruit ces emprises-la et conserve les autres : ce
   * qu'on a ajoute a la main — un lavabo, que le casque ne sait pas nommer —
   * n'a aucune raison de disparaitre.
   */
  fromScan?: true;
  /**
   * Diametre en cm quand l'emprise est ronde.
   *
   * Le contour reste un polygone — collision et rendu n'ont rien de particulier a
   * savoir — mais garder le diametre permet de le redimensionner comme un cercle
   * plutot que sommet par sommet. Deplacer un sommet efface cette qualite : la
   * forme n'est alors plus un cercle.
   */
  round?: number;
}

export type MovableKind = 'rect' | 'circle';

/** Objet que l'on déplace pour tester le passage (machine à laver, meuble…). */
export interface Movable {
  id: string;
  label: string;
  kind: MovableKind;
  /** Largeur en cm. Pour un cercle, c'est le diamètre. */
  w: number;
  /** Profondeur en cm. Ignorée pour un cercle. */
  h: number;
  pos: Pt;
  angle: number;
  color: string;
}

/** Segment mesuré sur le plan, utilisé aussi pour recaler l'échelle. */
export interface Measurement {
  id: string;
  a: Pt;
  b: Pt;
}

export interface Scene {
  version: number;
  name: string;
  /** Identifiant du plan dans le depot partage, quand il y a ete envoye. */
  remoteId: string | null;
  /** Releve d'origine, s'il vient du casque. Permet de recalculer le plan. */
  scan: RawScan | null;
  background: Background | null;
  room: Room | null;
  obstacles: Obstacle[];
  movables: Movable[];
  measurements: Measurement[];
  /** Jeu minimal exigé autour de l'objet déplacé, en cm. */
  clearance: number;
  collisionEnabled: boolean;
  selectedId: string | null;
}

export function emptyScene(): Scene {
  return {
    version: SCENE_VERSION,
    name: 'Salle de bain',
    remoteId: null,
    scan: null,
    background: null,
    room: null,
    obstacles: [],
    movables: [],
    measurements: [],
    clearance: 0,
    collisionEnabled: true,
    selectedId: null,
  };
}

let counter = 0;
export function uid(prefix = 'id'): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/** Gabarits d'électroménager (largeur × profondeur en cm, hors tout). */
export interface Preset {
  label: string;
  w: number;
  h: number;
}

export const APPLIANCE_PRESETS: Preset[] = [
  { label: 'Lave-linge (standard)', w: 60, h: 60 },
  { label: 'Lave-linge (tuyaux inclus)', w: 60, h: 68 },
  { label: 'Lave-linge slim', w: 60, h: 45 },
  { label: 'Sèche-linge', w: 60, h: 62 },
  { label: 'Lave-vaisselle', w: 60, h: 57 },
  { label: 'Meuble vasque 80', w: 80, h: 46 },
  { label: 'Machine dans son carton', w: 66, h: 68 },
];

export const FURNITURE_COLORS = [
  '#6b7bb5',
  '#b57b6b',
  '#6bb58a',
  '#b5a06b',
  '#8a6bb5',
  '#b56b9e',
];
