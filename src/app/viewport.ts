import type { Bbox, Pt } from '../core/geometry.ts';

/** Transformation monde (cm) <-> ecran (px CSS). Pas de rotation. */
export class Viewport {
  /** Pixels ecran par centimetre. */
  scale = 2;
  /** Translation, en pixels ecran. */
  tx = 0;
  ty = 0;

  toScreen(p: Pt): Pt {
    return { x: p.x * this.scale + this.tx, y: p.y * this.scale + this.ty };
  }

  toWorld(p: Pt): Pt {
    return { x: (p.x - this.tx) / this.scale, y: (p.y - this.ty) / this.scale };
  }

  /** Longueur en cm convertie en pixels. */
  px(cm: number): number {
    return cm * this.scale;
  }

  /** Zoome autour d'un point ecran fixe (curseur, centre de pincement). */
  zoomAt(screen: Pt, factor: number, min = 0.05, max = 40): void {
    const next = Math.max(min, Math.min(max, this.scale * factor));
    const applied = next / this.scale;
    this.tx = screen.x - (screen.x - this.tx) * applied;
    this.ty = screen.y - (screen.y - this.ty) * applied;
    this.scale = next;
  }

  panBy(dx: number, dy: number): void {
    this.tx += dx;
    this.ty += dy;
  }

  fit(box: Bbox, widthPx: number, heightPx: number, padding = 40): void {
    const w = box.maxX - box.minX;
    const h = box.maxY - box.minY;
    if (!(w > 0) || !(h > 0)) return;
    const s = Math.min((widthPx - padding * 2) / w, (heightPx - padding * 2) / h);
    this.scale = Math.max(0.05, Math.min(40, s));
    this.tx = widthPx / 2 - ((box.minX + box.maxX) / 2) * this.scale;
    this.ty = heightPx / 2 - ((box.minY + box.maxY) / 2) * this.scale;
  }
}
