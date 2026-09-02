import type { Pt } from '../core/geometry.ts';
import { circlePolygon, dist, distanceToSegment, pointInPolygon, sub } from '../core/geometry.ts';
import { moveWithCollision, movablePolygon, rotateWithCollision } from '../model/collision.ts';
import type { Store } from '../model/store.ts';
import type { Movable, Obstacle } from '../model/types.ts';
import { FURNITURE_COLORS, uid } from '../model/types.ts';
import {
  dropRoundness,
  insertPolygonVertex,
  insertRoomVertex,
  removePolygonVertex,
  removeRoomVertex,
} from '../model/room.ts';
import type { Mode, Overlay, Renderer } from './render.ts';
import type { Viewport } from './viewport.ts';

type Drag =
  | { kind: 'none' }
  | { kind: 'pan'; last: Pt }
  | { kind: 'move-movable'; id: string; grabOffset: Pt }
  | { kind: 'rotate-movable'; id: string }
  | { kind: 'move-obstacle'; id: string; grabOffset: Pt }
  | { kind: 'move-vertex'; id: string; index: number }
  | { kind: 'move-room-vertex'; index: number }
  | { kind: 'measure'; start: Pt }
  | { kind: 'circle'; center: Pt };

const VERTEX_HIT_PX = 12;
const EDGE_HIT_PX = 14;

export class CanvasController {
  overlay: Overlay = { mode: 'select', draft: [], cursor: null, hoverEdge: null };

  /** Notifie le panneau lateral quand l'outil actif change (raccourci clavier, fin de trace). */
  onModeChange: (() => void) | null = null;

  private drag: Drag = { kind: 'none' };
  private pointers = new Map<number, Pt>();
  private pinchDistance = 0;
  private shift = false;
  private spaceHeld = false;
  private movedDuringDrag = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private store: Store,
    private vp: Viewport,
    private renderer: Renderer,
    private requestRedraw: () => void,
  ) {
    this.attach();
  }

  get mode(): Mode {
    return this.overlay.mode;
  }

  setMode(mode: Mode): void {
    this.overlay.mode = mode;
    this.overlay.draft = [];
    this.overlay.cursor = null;
    this.overlay.hoverEdge = null;
    this.canvas.style.cursor = mode === 'select' ? 'default' : 'crosshair';
    this.onModeChange?.();
    this.requestRedraw();
  }

  cancelDraft(): void {
    this.overlay.draft = [];
    this.overlay.cursor = null;
    this.requestRedraw();
  }

  // --- conversions -------------------------------------------------------

  private local(e: PointerEvent | WheelEvent | MouseEvent): Pt {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private world(e: PointerEvent | WheelEvent | MouseEvent): Pt {
    return this.vp.toWorld(this.local(e));
  }

  // --- accroche ----------------------------------------------------------

  /** Accroche aux sommets existants, puis contrainte orthogonale avec Maj. */
  private snap(world: Pt, from: Pt | null): Pt {
    const scene = this.store.state;
    const tol = VERTEX_HIT_PX / this.vp.scale;
    let best: Pt | null = null;
    let bestD = tol;

    const consider = (p: Pt) => {
      const d = dist(p, world);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    };
    if (scene.room) scene.room.points.forEach(consider);
    for (const o of scene.obstacles) o.points.forEach(consider);
    for (const p of this.overlay.draft) consider(p);
    if (best) return { x: (best as Pt).x, y: (best as Pt).y };

    if (this.shift && from) {
      const d = sub(world, from);
      const angle = Math.atan2(d.y, d.x);
      const step = Math.PI / 4;
      const snapped = Math.round(angle / step) * step;
      const l = Math.hypot(d.x, d.y);
      return { x: from.x + Math.cos(snapped) * l, y: from.y + Math.sin(snapped) * l };
    }
    return world;
  }

  // --- tests de survol ---------------------------------------------------

  private movableAt(world: Pt): Movable | null {
    const scene = this.store.state;
    for (let i = scene.movables.length - 1; i >= 0; i--) {
      const m = scene.movables[i];
      if (pointInPolygon(world, movablePolygon(m))) return m;
    }
    return null;
  }

  private obstacleAt(world: Pt): Obstacle | null {
    const scene = this.store.state;
    for (let i = scene.obstacles.length - 1; i >= 0; i--) {
      const o = scene.obstacles[i];
      if (o.points.length >= 3 && pointInPolygon(world, o.points)) return o;
    }
    return null;
  }

  private vertexAt(world: Pt): { id: string; index: number } | null {
    const scene = this.store.state;
    const tol = VERTEX_HIT_PX / this.vp.scale;
    for (const o of scene.obstacles) {
      if (o.id !== scene.selectedId) continue;
      for (let i = 0; i < o.points.length; i++) {
        if (dist(o.points[i], world) < tol) return { id: o.id, index: i };
      }
    }
    return null;
  }

  private roomVertexAt(world: Pt): number | null {
    const room = this.store.state.room;
    if (!room) return null;
    const tol = VERTEX_HIT_PX / this.vp.scale;
    for (let i = 0; i < room.points.length; i++) {
      if (dist(room.points[i], world) < tol) return i;
    }
    return null;
  }

  private roomEdgeAt(world: Pt): number | null {
    const room = this.store.state.room;
    if (!room || room.points.length < 2) return null;
    const tol = EDGE_HIT_PX / this.vp.scale;
    let best: number | null = null;
    let bestD = tol;
    const n = room.points.length;
    for (let i = 0; i < n; i++) {
      const d = distanceToSegment(world, room.points[i], room.points[(i + 1) % n]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Arete du meuble selectionne sous le curseur. */
  private obstacleEdgeAt(world: Pt): { id: string; index: number } | null {
    const scene = this.store.state;
    const tol = EDGE_HIT_PX / this.vp.scale;
    for (const o of scene.obstacles) {
      if (o.id !== scene.selectedId || o.points.length < 2) continue;
      for (let i = 0; i < o.points.length; i++) {
        const a = o.points[i];
        const b = o.points[(i + 1) % o.points.length];
        if (distanceToSegment(world, a, b) < tol) return { id: o.id, index: i };
      }
    }
    return null;
  }

  // --- evenements --------------------------------------------------------

  private attach(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', this.onPointerDown);
    c.addEventListener('pointermove', this.onPointerMove);
    c.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('pointercancel', this.onPointerUp);
    c.addEventListener('wheel', this.onWheel, { passive: false });
    c.addEventListener('dblclick', this.onDoubleClick);
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.vp.zoomAt(this.local(e), factor);
    this.requestRedraw();
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.local(e));

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDistance = dist(a, b);
      this.drag = { kind: 'none' };
      return;
    }

    const isPanButton = e.button === 1 || e.button === 2 || this.spaceHeld;
    if (isPanButton) {
      this.drag = { kind: 'pan', last: this.local(e) };
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    const world = this.world(e);
    this.movedDuringDrag = false;

    switch (this.overlay.mode) {
      case 'select':
        this.startSelectDrag(world);
        break;
      case 'room':
      case 'obstacle':
        this.overlay.draft.push(this.snap(world, this.overlay.draft.at(-1) ?? null));
        this.requestRedraw();
        break;
      case 'door': {
        const edge = this.roomEdgeAt(world);
        if (edge !== null) this.toggleDoor(edge);
        break;
      }
      case 'measure': {
        const p = this.snap(world, null);
        this.drag = { kind: 'measure', start: p };
        this.overlay.draft = [p];
        this.requestRedraw();
        break;
      }
      case 'circle': {
        // Du centre vers le bord : c'est ainsi qu'on connait un lavabo ou une
        // colonne, par son diametre et non par ses coins.
        this.drag = { kind: 'circle', center: world };
        this.overlay.draft = [world];
        this.overlay.cursor = world;
        this.requestRedraw();
        break;
      }
    }
  };

  private startSelectDrag(world: Pt): void {
    const scene = this.store.state;

    const selectedMovable = scene.movables.find((m) => m.id === scene.selectedId);
    if (selectedMovable) {
      const handle = this.renderer.rotationHandleScreen(selectedMovable);
      if (dist(this.vp.toScreen(world), handle) < 14) {
        this.store.beginTransaction();
        this.drag = { kind: 'rotate-movable', id: selectedMovable.id };
        return;
      }
    }

    const vertex = this.vertexAt(world);
    if (vertex) {
      this.store.beginTransaction();
      this.drag = { kind: 'move-vertex', id: vertex.id, index: vertex.index };
      return;
    }

    const movable = this.movableAt(world);
    if (movable) {
      this.store.update((s) => {
        s.selectedId = movable.id;
      });
      this.store.beginTransaction();
      this.drag = { kind: 'move-movable', id: movable.id, grabOffset: sub(movable.pos, world) };
      return;
    }

    const roomVertex = this.roomVertexAt(world);
    if (roomVertex !== null) {
      this.store.beginTransaction();
      this.drag = { kind: 'move-room-vertex', index: roomVertex };
      return;
    }

    const obstacle = this.obstacleAt(world);
    if (obstacle) {
      this.store.update((s) => {
        s.selectedId = obstacle.id;
      });
      this.store.beginTransaction();
      this.drag = {
        kind: 'move-obstacle',
        id: obstacle.id,
        grabOffset: sub(obstacle.points[0], world),
      };
      return;
    }

    this.store.update((s) => {
      s.selectedId = null;
    });
    this.drag = { kind: 'pan', last: this.vp.toScreen(world) };
  }

  private onPointerMove = (e: PointerEvent): void => {
    const local = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, local);

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = dist(a, b);
      if (this.pinchDistance > 0) {
        const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.vp.zoomAt(center, d / this.pinchDistance);
      }
      this.pinchDistance = d;
      this.requestRedraw();
      return;
    }

    const world = this.vp.toWorld(local);

    if (this.overlay.mode === 'door') {
      const edge = this.roomEdgeAt(world);
      if (edge !== this.overlay.hoverEdge) {
        this.overlay.hoverEdge = edge;
        this.requestRedraw();
      }
    }

    if (this.overlay.mode === 'room' || this.overlay.mode === 'obstacle') {
      this.overlay.cursor = this.snap(world, this.overlay.draft.at(-1) ?? null);
      this.requestRedraw();
    }

    switch (this.drag.kind) {
      case 'pan': {
        this.vp.panBy(local.x - this.drag.last.x, local.y - this.drag.last.y);
        this.drag.last = local;
        this.requestRedraw();
        break;
      }
      case 'move-movable': {
        const offset = this.drag.grabOffset;
        const id = this.drag.id;
        this.movedDuringDrag = true;
        this.store.update((s) => {
          const m = s.movables.find((x) => x.id === id);
          if (!m) return;
          const target = { x: world.x + offset.x, y: world.y + offset.y };
          m.pos = moveWithCollision(s, m, target);
        });
        break;
      }
      case 'rotate-movable': {
        const id = this.drag.id;
        this.movedDuringDrag = true;
        this.store.update((s) => {
          const m = s.movables.find((x) => x.id === id);
          if (!m) return;
          const d = sub(world, m.pos);
          let angle = Math.atan2(d.x, -d.y);
          if (this.shift) {
            const step = Math.PI / 12;
            angle = Math.round(angle / step) * step;
          }
          m.angle = rotateWithCollision(s, m, angle);
        });
        break;
      }
      case 'move-obstacle': {
        const id = this.drag.id;
        const offset = this.drag.grabOffset;
        this.movedDuringDrag = true;
        this.store.update((s) => {
          const o = s.obstacles.find((x) => x.id === id);
          if (!o) return;
          const target = { x: world.x + offset.x, y: world.y + offset.y };
          const delta = sub(target, o.points[0]);
          o.points = o.points.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y }));
        });
        break;
      }
      case 'move-vertex': {
        const { id, index } = this.drag;
        this.movedDuringDrag = true;
        this.store.update((s) => {
          const o = s.obstacles.find((x) => x.id === id);
          if (!o) return;
          o.points[index] = world;
          // Un sommet deplace : ce n'est plus un cercle, le diametre n'a plus de sens.
          dropRoundness(o);
        });
        break;
      }
      case 'move-room-vertex': {
        const index = this.drag.index;
        this.movedDuringDrag = true;
        this.store.update((s) => {
          if (s.room) s.room.points[index] = this.snap(world, null);
        });
        break;
      }
      case 'measure': {
        this.overlay.draft = [this.drag.start];
        this.overlay.cursor = this.snap(world, this.drag.start);
        this.requestRedraw();
        break;
      }
      case 'circle': {
        this.overlay.draft = [this.drag.center];
        this.overlay.cursor = world;
        this.requestRedraw();
        break;
      }
      case 'none':
        break;
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchDistance = 0;

    if (this.drag.kind === 'circle') {
      const center = this.drag.center;
      const edge = this.overlay.cursor ?? center;
      const diameter = round(dist(center, edge) * 2);
      if (diameter >= 1) {
        this.store.commit((s) => {
          const o: Obstacle = {
            id: uid('obs'),
            label: `Meuble rond Ø ${diameter} cm`,
            // Un cercle est approche par un polygone : le reste de l'app
            // (collision, edition, rendu) n'a rien de particulier a savoir.
            points: circlePolygon(center, diameter),
            color: FURNITURE_COLORS[s.obstacles.length % FURNITURE_COLORS.length],
            round: diameter,
          };
          s.obstacles.push(o);
          s.selectedId = o.id;
        });
      }
      this.overlay.draft = [];
      this.overlay.cursor = null;
    } else if (this.drag.kind === 'measure') {
      const start = this.drag.start;
      const end = this.overlay.cursor ?? start;
      if (dist(start, end) > 0.3) {
        this.store.commit((s) => {
          s.measurements.push({ id: uid('mes'), a: start, b: end });
        });
      }
      this.overlay.draft = [];
      this.overlay.cursor = null;
    } else if (this.drag.kind !== 'none' && this.drag.kind !== 'pan') {
      // Un drag ouvre une transaction des le pointerdown : on la referme ici.
      if (!this.movedDuringDrag) this.store.discardTransaction();
    }

    this.drag = { kind: 'none' };
    this.canvas.style.cursor = this.overlay.mode === 'select' ? 'default' : 'crosshair';
    this.requestRedraw();
  };

  /**
   * Pendant un trace, le double-clic ferme le polygone. En selection, il retouche
   * le contour : sur un sommet il l'enleve, sur une arete il en ajoute un.
   * Un releve du casque rend des rectangles ; c'est ainsi qu'on lui ajoute la
   * niche ou le coffrage qu'il a lisses.
   */
  private onDoubleClick = (e: MouseEvent): void => {
    if (this.overlay.mode === 'room' || this.overlay.mode === 'obstacle') {
      this.finishDraft();
      return;
    }
    if (this.overlay.mode !== 'select') return;
    const world = this.world(e);

    const roomVertex = this.roomVertexAt(world);
    if (roomVertex !== null) {
      this.store.commit((s) => {
        if (s.room) removeRoomVertex(s.room, roomVertex);
      });
      return;
    }

    const vertex = this.vertexAt(world);
    if (vertex) {
      this.store.commit((s) => {
        const o = s.obstacles.find((x) => x.id === vertex.id);
        if (o && removePolygonVertex(o.points, vertex.index)) dropRoundness(o);
      });
      return;
    }

    const obstacleEdge = this.obstacleEdgeAt(world);
    if (obstacleEdge) {
      this.store.commit((s) => {
        const o = s.obstacles.find((x) => x.id === obstacleEdge.id);
        if (o && insertPolygonVertex(o.points, obstacleEdge.index, world)) dropRoundness(o);
      });
      return;
    }

    const roomEdge = this.roomEdgeAt(world);
    if (roomEdge !== null) {
      this.store.commit((s) => {
        if (s.room) insertRoomVertex(s.room, roomEdge, world);
      });
    }
  };

  /** Valide le polygone en cours de trace. */
  finishDraft(): void {
    const points = this.overlay.draft;
    if (points.length < 3) {
      this.cancelDraft();
      return;
    }
    const mode = this.overlay.mode;
    const copy = points.map((p) => ({ ...p }));

    this.store.commit((s) => {
      if (mode === 'room') {
        s.room = { points: copy, doors: [] };
      } else {
        const color = FURNITURE_COLORS[s.obstacles.length % FURNITURE_COLORS.length];
        const o: Obstacle = {
          id: uid('obs'),
          label: `Meuble ${s.obstacles.length + 1}`,
          points: copy,
          color,
        };
        s.obstacles.push(o);
        s.selectedId = o.id;
      }
    });
    this.overlay.draft = [];
    this.overlay.cursor = null;
    this.setMode('select');
  }

  private toggleDoor(edge: number): void {
    this.store.commit((s) => {
      if (!s.room) return;
      const idx = s.room.doors.indexOf(edge);
      if (idx >= 0) s.room.doors.splice(idx, 1);
      else s.room.doors.push(edge);
    });
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Shift') this.shift = true;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)) {
      return;
    }

    if (e.code === 'Space') {
      this.spaceHeld = true;
      e.preventDefault();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.store.redo();
      else this.store.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.store.redo();
      return;
    }

    if (e.key === 'Escape') {
      if (this.overlay.draft.length > 0) this.cancelDraft();
      else this.setMode('select');
      return;
    }

    if (e.key === 'Enter') {
      this.finishDraft();
      return;
    }

    if (e.key === 'Backspace' && this.overlay.draft.length > 0) {
      this.overlay.draft.pop();
      this.requestRedraw();
      return;
    }

    const scene = this.store.state;
    const selected = scene.movables.find((m) => m.id === scene.selectedId);
    if (!selected) return;

    if (e.key === 'r' || e.key === 'R') {
      const dir = e.shiftKey ? -1 : 1;
      this.store.commit((s) => {
        const m = s.movables.find((x) => x.id === selected.id);
        if (m) m.angle = rotateWithCollision(s, m, m.angle + (dir * Math.PI) / 2);
      });
      return;
    }

    if (e.key === 'Delete') {
      this.store.commit((s) => {
        s.movables = s.movables.filter((m) => m.id !== selected.id);
        s.selectedId = null;
      });
      return;
    }

    const nudge: Record<string, Pt> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    const step = nudge[e.key];
    if (step) {
      e.preventDefault();
      const amount = e.shiftKey ? 10 : 1;
      this.store.commit((s) => {
        const m = s.movables.find((x) => x.id === selected.id);
        if (!m) return;
        m.pos = moveWithCollision(s, m, {
          x: m.pos.x + step.x * amount,
          y: m.pos.y + step.y * amount,
        });
      });
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === 'Shift') this.shift = false;
    if (e.code === 'Space') {
      this.spaceHeld = false;
      if (this.drag.kind === 'pan') this.drag = { kind: 'none' };
      this.canvas.style.cursor = this.overlay.mode === 'select' ? 'default' : 'crosshair';
    }
  };

}

/** Diametres au demi-centimetre : plus fin n'a pas de sens sur un relevé. */
function round(cm: number): number {
  return Math.round(cm * 2) / 2;
}
