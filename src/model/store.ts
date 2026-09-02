import type { Scene } from './types.ts';
import { emptyScene, SCENE_VERSION } from './types.ts';

type Listener = (scene: Scene) => void;

const DB_NAME = 'sdb';
const STORE_NAME = 'scenes';
const DOC_KEY = 'current';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  const value = await new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}

/**
 * Etat de l'application. L'historique fonctionne par instantanes JSON :
 * la scene reste petite (l'image de fond mise a part, qui ne change presque jamais),
 * donc c'est largement suffisant et ca evite tout un systeme de commandes inverses.
 */
export class Store {
  private scene: Scene = emptyScene();
  private listeners = new Set<Listener>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private pendingSave: number | null = null;
  private readonly maxHistory = 60;

  get state(): Scene {
    return this.scene;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.scene);
    this.scheduleSave();
  }

  /** Modification annulable. */
  commit(fn: (scene: Scene) => void): void {
    this.undoStack.push(JSON.stringify(this.scene));
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack.length = 0;
    fn(this.scene);
    this.emit();
  }

  /**
   * Modification transitoire : pas d'entree dans l'historique.
   * Utilise pendant un glisser-deposer, ou pour l'etat purement visuel (selection).
   */
  update(fn: (scene: Scene) => void): void {
    fn(this.scene);
    this.emit();
  }

  /** Ouvre une entree d'historique sans encore modifier la scene (debut de drag). */
  beginTransaction(): void {
    this.undoStack.push(JSON.stringify(this.scene));
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Annule un beginTransaction dont il ne resulte aucun changement. */
  discardTransaction(): void {
    this.undoStack.pop();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.stringify(this.scene));
    this.scene = JSON.parse(prev) as Scene;
    this.emit();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify(this.scene));
    this.scene = JSON.parse(next) as Scene;
    this.emit();
  }

  replace(scene: Scene): void {
    this.undoStack.push(JSON.stringify(this.scene));
    this.redoStack.length = 0;
    this.scene = scene;
    this.emit();
  }

  private scheduleSave(): void {
    if (this.pendingSave !== null) clearTimeout(this.pendingSave);
    this.pendingSave = window.setTimeout(() => {
      this.pendingSave = null;
      void idbPut(DOC_KEY, this.scene).catch((err) => {
        console.warn('Sauvegarde impossible', err);
      });
    }, 400);
  }

  async load(): Promise<void> {
    try {
      const saved = await idbGet<Scene>(DOC_KEY);
      if (saved && saved.version === SCENE_VERSION) {
        this.scene = { ...emptyScene(), ...saved };
        for (const fn of this.listeners) fn(this.scene);
      }
    } catch (err) {
      console.warn('Chargement impossible', err);
    }
  }

  toJSON(): string {
    return JSON.stringify(this.scene, null, 2);
  }
}

/**
 * Applique un facteur d'echelle uniforme a toute la scene.
 * Toutes les longueurs etant en centimetres, recaler l'echelle revient a
 * multiplier chaque coordonnee et la resolution de l'image de fond.
 */
export function rescaleScene(scene: Scene, factor: number): void {
  const scalePt = (p: { x: number; y: number }) => {
    p.x *= factor;
    p.y *= factor;
  };

  if (scene.background) scene.background.cmPerPx *= factor;
  if (scene.room) scene.room.points.forEach(scalePt);
  for (const o of scene.obstacles) {
    o.points.forEach(scalePt);
    // Le diametre memorise d'une emprise ronde suit son contour, sans quoi le
    // champ afficherait une valeur devenue fausse.
    if (o.round !== undefined) o.round *= factor;
  }
  for (const m of scene.movables) {
    scalePt(m.pos);
    // Les dimensions des objets deplaces sont saisies en cm reels par
    // l'utilisateur (60 cm reste 60 cm) : elles ne suivent pas le recalage.
  }
  for (const m of scene.measurements) {
    scalePt(m.a);
    scalePt(m.b);
  }
}
