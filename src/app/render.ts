import type { Pt } from '../core/geometry.ts';
import {
  bboxOf,
  circlePolygon,
  dist,
  pointInPolygon,
  polygonCentroid,
  rectPolygon,
} from '../core/geometry.ts';
import { collisionReport, movablePolygon } from '../model/collision.ts';
import type { Movable, Scene } from '../model/types.ts';
import type { Viewport } from './viewport.ts';

export type Mode = 'select' | 'room' | 'door' | 'obstacle' | 'circle' | 'measure';

export interface Overlay {
  mode: Mode;
  /** Polygone ou segment en cours de trace. */
  draft: Pt[];
  /** Position courante du curseur en coordonnees monde (apercu du trace). */
  cursor: Pt | null;
  /** Arete de la piece survolee, pour l'outil Porte. */
  hoverEdge: number | null;
}

const COLORS = {
  bg: '#12141a',
  grid: '#1e222c',
  gridMajor: '#2a303d',
  wall: '#e6e9f0',
  door: '#4ec9b0',
  draft: '#7aa2f7',
  measure: '#e0af68',
  text: '#c8ccd6',
  textDim: '#7d8494',
  danger: '#f7768e',
  ok: '#9ece6a',
  selection: '#7aa2f7',
};

/** Dimension d'objet : entier quand c'est possible, sinon une decimale. */
function fmtNum(cm: number): string {
  return Number.isInteger(cm) ? String(cm) : cm.toFixed(1);
}

function fmt(cm: number): string {
  if (cm >= 100) return `${(cm / 100).toFixed(2)} m`;
  return `${fmtNum(cm)} cm`;
}

/** Cache des images de fond decodees, indexe par data URL. */
const imageCache = new Map<string, HTMLImageElement>();

export function getBackgroundImage(dataUrl: string, onLoad: () => void): HTMLImageElement | null {
  const cached = imageCache.get(dataUrl);
  if (cached) return cached.complete ? cached : null;
  const img = new Image();
  img.onload = onLoad;
  img.src = dataUrl;
  imageCache.set(dataUrl, img);
  return null;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;

  constructor(
    private canvas: HTMLCanvasElement,
    private vp: Viewport,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D indisponible');
    this.ctx = ctx;
  }

  /** Ajuste la taille du buffer au conteneur et au ratio de pixels. */
  resize(): { width: number; height: number } {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    return { width: w, height: h };
  }

  draw(scene: Scene, overlay: Overlay, requestRedraw: () => void): void {
    const { width, height } = this.resize();
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, width, height);

    this.drawGrid(width, height);
    this.drawBackground(scene, requestRedraw);
    this.drawRoom(scene, overlay);
    this.drawObstacles(scene);
    this.drawMovables(scene);
    this.drawMeasurements(scene);
    this.drawDraft(overlay);
    this.drawScaleBar(width, height);
  }

  private drawGrid(width: number, height: number): void {
    const ctx = this.ctx;
    // Pas de grille adapte au zoom : 10 cm, 50 cm, 1 m, 5 m...
    const candidates = [1, 5, 10, 25, 50, 100, 250, 500, 1000];
    const step = candidates.find((c) => this.vp.px(c) >= 12) ?? 1000;
    const major = step * (step === 25 || step === 250 ? 4 : 5);

    const topLeft = this.vp.toWorld({ x: 0, y: 0 });
    const bottomRight = this.vp.toWorld({ x: width, y: height });

    ctx.lineWidth = 1;
    for (const [size, color] of [
      [step, COLORS.grid],
      [major, COLORS.gridMajor],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      const x0 = Math.floor(topLeft.x / size) * size;
      for (let x = x0; x <= bottomRight.x; x += size) {
        const sx = Math.round(this.vp.toScreen({ x, y: 0 }).x) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, height);
      }
      const y0 = Math.floor(topLeft.y / size) * size;
      for (let y = y0; y <= bottomRight.y; y += size) {
        const sy = Math.round(this.vp.toScreen({ x: 0, y }).y) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(width, sy);
      }
      ctx.stroke();
    }
  }

  private drawBackground(scene: Scene, requestRedraw: () => void): void {
    const bg = scene.background;
    if (!bg) return;
    const img = getBackgroundImage(bg.dataUrl, requestRedraw);
    if (!img) return;
    const ctx = this.ctx;
    const origin = this.vp.toScreen({ x: 0, y: 0 });
    const w = this.vp.px(bg.widthPx * bg.cmPerPx);
    const h = this.vp.px(bg.heightPx * bg.cmPerPx);
    ctx.save();
    ctx.globalAlpha = bg.opacity;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, origin.x, origin.y, w, h);
    ctx.restore();
  }

  private drawRoom(scene: Scene, overlay: Overlay): void {
    const room = scene.room;
    if (!room || room.points.length < 2) return;
    const ctx = this.ctx;
    const pts = room.points.map((p) => this.vp.toScreen(p));
    const doors = new Set(room.doors);
    const n = room.points.length;

    // Interieur legerement teinte pour lire le volume disponible.
    if (n >= 3) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(122, 162, 247, 0.06)';
      ctx.fill();
    }

    ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const isDoor = doors.has(i);
      const hovered = overlay.mode === 'door' && overlay.hoverEdge === i;

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      if (isDoor) {
        ctx.setLineDash([10, 8]);
        ctx.strokeStyle = COLORS.door;
        ctx.lineWidth = hovered ? 6 : 4;
      } else {
        ctx.setLineDash([]);
        ctx.strokeStyle = hovered ? COLORS.door : COLORS.wall;
        ctx.lineWidth = hovered ? 8 : 5;
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Cote de l'arete, posee a l'exterieur du contour pour ne pas couvrir le mur.
      const pa = room.points[i];
      const pb = room.points[(i + 1) % n];
      const lengthCm = dist(pa, pb);
      if (this.vp.px(lengthCm) > 44) {
        const lw = lengthCm || 1;
        let nx = -(pb.y - pa.y) / lw;
        let ny = (pb.x - pa.x) / lw;
        const probe = { x: (pa.x + pb.x) / 2 + nx * 2, y: (pa.y + pb.y) / 2 + ny * 2 };
        if (n >= 3 && pointInPolygon(probe, room.points)) {
          nx = -nx;
          ny = -ny;
        }
        // Le repere ecran ne fait qu'echelle et translation : la normale garde son sens.
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.label(
          fmt(lengthCm),
          mid.x + nx * 16,
          mid.y + ny * 16,
          isDoor ? COLORS.door : COLORS.textDim,
          true,
        );
      }
    }

    ctx.fillStyle = COLORS.wall;
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawObstacles(scene: Scene): void {
    const ctx = this.ctx;
    for (const o of scene.obstacles) {
      if (o.points.length < 2) continue;
      const pts = o.points.map((p) => this.vp.toScreen(p));
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fillStyle = o.color + '55';
      ctx.fill();
      ctx.strokeStyle = o.id === scene.selectedId ? COLORS.selection : o.color;
      ctx.lineWidth = o.id === scene.selectedId ? 3 : 2;
      ctx.stroke();

      if (o.points.length >= 3) {
        const c = this.vp.toScreen(polygonCentroid(o.points));
        this.label(o.label, c.x, c.y, COLORS.text, true);
      }
      if (o.id === scene.selectedId) {
        ctx.fillStyle = COLORS.selection;
        for (const p of pts) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  private drawMovables(scene: Scene): void {
    const ctx = this.ctx;
    for (const m of scene.movables) {
      const report = collisionReport(scene, m);
      const selected = m.id === scene.selectedId;

      if (scene.clearance > 0) {
        const pad = movablePolygon(m, scene.clearance).map((p) => this.vp.toScreen(p));
        ctx.beginPath();
        ctx.moveTo(pad[0].x, pad[0].y);
        for (let i = 1; i < pad.length; i++) ctx.lineTo(pad[i].x, pad[i].y);
        ctx.closePath();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = report.hit ? COLORS.danger : COLORS.ok;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const body =
        m.kind === 'circle' ? circlePolygon(m.pos, m.w, 48) : rectPolygon(m.pos, m.w, m.h, m.angle);
      const pts = body.map((p) => this.vp.toScreen(p));
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fillStyle = report.hit ? COLORS.danger + '55' : m.color + '77';
      ctx.fill();
      ctx.strokeStyle = report.hit ? COLORS.danger : selected ? COLORS.selection : m.color;
      ctx.lineWidth = selected ? 3 : 2;
      ctx.stroke();

      const c = this.vp.toScreen(m.pos);

      // Repere d'orientation : trait vers la face avant du rectangle.
      if (m.kind === 'rect') {
        const front = this.vp.toScreen({
          x: m.pos.x + Math.sin(m.angle) * (m.h / 2),
          y: m.pos.y - Math.cos(m.angle) * (m.h / 2),
        });
        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(front.x, front.y);
        ctx.strokeStyle = report.hit ? COLORS.danger : m.color;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Les dimensions tiennent dans la forme, le nom se pose juste en dessous :
      // un libelle complet centre deborderait sur les objets voisins.
      const tone = report.hit ? COLORS.danger : COLORS.text;
      const dims =
        m.kind === 'circle' ? `Ø${fmtNum(m.w)}` : `${fmtNum(m.w)}×${fmtNum(m.h)}`;
      this.label(dims, c.x, c.y, tone, true);
      const bottom = Math.max(...pts.map((p) => p.y));
      this.label(m.label, c.x, bottom + 14, tone, true);

      if (selected) {
        ctx.fillStyle = COLORS.selection;
        for (const p of pts) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fill();
        }
        // Poignee de rotation, decalee au-dela de la face avant.
        const handle = this.rotationHandleScreen(m);
        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(handle.x, handle.y);
        ctx.strokeStyle = COLORS.selection;
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, 7, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.selection;
        ctx.fill();
      }
    }
  }

  /** Position ecran de la poignee de rotation d'un objet. */
  rotationHandleScreen(m: Movable): Pt {
    const radius = (m.kind === 'circle' ? m.w / 2 : Math.max(m.w, m.h) / 2) + 0;
    const c = this.vp.toScreen(m.pos);
    const offset = this.vp.px(radius) + 28;
    return { x: c.x + Math.sin(m.angle) * offset, y: c.y - Math.cos(m.angle) * offset };
  }

  private drawMeasurements(scene: Scene): void {
    const ctx = this.ctx;
    for (const mes of scene.measurements) {
      const a = this.vp.toScreen(mes.a);
      const b = this.vp.toScreen(mes.b);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = COLORS.measure;
      ctx.lineWidth = 2;
      ctx.stroke();

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      const nx = (-dy / l) * 7;
      const ny = (dx / l) * 7;
      ctx.beginPath();
      ctx.moveTo(a.x - nx, a.y - ny);
      ctx.lineTo(a.x + nx, a.y + ny);
      ctx.moveTo(b.x - nx, b.y - ny);
      ctx.lineTo(b.x + nx, b.y + ny);
      ctx.stroke();

      this.label(fmt(dist(mes.a, mes.b)), (a.x + b.x) / 2, (a.y + b.y) / 2 - 14, COLORS.measure, true);
    }
  }

  private drawDraft(overlay: Overlay): void {
    if (overlay.draft.length === 0) return;

    const ctx = this.ctx;

    // Le meuble rond se trace du centre vers le bord : l'apercu est un cercle,
    // pas une ligne brisee.
    if (overlay.mode === 'circle') {
      const center = overlay.draft[0];
      const edge = overlay.cursor ?? center;
      const radius = Math.hypot(edge.x - center.x, edge.y - center.y);
      const c = this.vp.toScreen(center);
      ctx.save();
      ctx.strokeStyle = COLORS.draft;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(1, this.vp.px(radius)), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.draft;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      this.label(`Ø ${fmt(radius * 2)}`, c.x, c.y - this.vp.px(radius) - 14, COLORS.draft, true);
      return;
    }

    const pts = overlay.draft.map((p) => this.vp.toScreen(p));
    const preview = overlay.cursor ? this.vp.toScreen(overlay.cursor) : null;

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (preview) ctx.lineTo(preview.x, preview.y);
    ctx.strokeStyle = overlay.mode === 'measure' ? COLORS.measure : COLORS.draft;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = COLORS.draft;
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Longueur du segment en cours, pour tracer a la bonne dimension.
    if (preview && overlay.cursor) {
      const last = overlay.draft[overlay.draft.length - 1];
      const d = dist(last, overlay.cursor);
      if (d > 0.5) {
        this.label(fmt(d), (pts[pts.length - 1].x + preview.x) / 2, (pts[pts.length - 1].y + preview.y) / 2 - 14, COLORS.draft, true);
      }
    }
  }

  private drawScaleBar(width: number, height: number): void {
    const ctx = this.ctx;
    const candidates = [10, 20, 50, 100, 200, 500, 1000];
    const target = 140;
    const cm = candidates.find((c) => this.vp.px(c) >= 80) ?? 1000;
    const px = Math.min(this.vp.px(cm), target * 2);
    const x = width - px - 24;
    const y = height - 28;

    ctx.strokeStyle = COLORS.text;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + px, y);
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x, y + 5);
    ctx.moveTo(x + px, y - 5);
    ctx.lineTo(x + px, y + 5);
    ctx.stroke();
    this.label(fmt(cm), x + px / 2, y - 14, COLORS.text, true);
  }

  private label(text: string, x: number, y: number, color: string, boxed = false): void {
    const ctx = this.ctx;
    ctx.font = '600 11px ui-sans-serif, system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (boxed) {
      const w = ctx.measureText(text).width + 10;
      ctx.fillStyle = 'rgba(18, 20, 26, 0.78)';
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - 9, w, 18, 4);
      ctx.fill();
    }
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  /** Cadre englobant tout le contenu de la scene, pour le zoom "tout voir". */
  static contentBbox(scene: Scene) {
    const pts: Pt[] = [];
    if (scene.background) {
      const bg = scene.background;
      pts.push({ x: 0, y: 0 });
      pts.push({ x: bg.widthPx * bg.cmPerPx, y: bg.heightPx * bg.cmPerPx });
    }
    if (scene.room) pts.push(...scene.room.points);
    for (const o of scene.obstacles) pts.push(...o.points);
    for (const m of scene.movables) pts.push(...movablePolygon(m));
    if (pts.length === 0) return { minX: 0, minY: 0, maxX: 400, maxY: 300 };
    return bboxOf(pts);
  }
}
