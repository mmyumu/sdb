/**
 * Homographie plane : redresse la photo d'un sol en vue de dessus orthographique.
 *
 * L'utilisateur designe 4 points de l'image formant un rectangle reel au sol
 * (dalle de carrelage, contour de piece...) et donne ses dimensions en cm.
 * Cela fixe a la fois la perspective, le rapport d'aspect et l'echelle absolue.
 */

import type { Pt } from './geometry.ts';

/** Matrice 3x3, ligne par ligne. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Elimination de Gauss avec pivot partiel. */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];

    const p = m[col][col];
    for (let c = col; c <= n; c++) m[col][c] /= p;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row) => row[n]);
}

/** Homographie envoyant les 4 points `src` sur les 4 points `dst` (DLT). */
export function homographyFromQuads(src: Pt[], dst: Pt[]): Mat3 | null {
  if (src.length !== 4 || dst.length !== 4) return null;

  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    a.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }

  const h = solveLinear(a, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Applique H a un point. Renvoie null derriere la ligne d'horizon (w ~ 0). */
export function applyH(h: Mat3, p: Pt): Pt | null {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  if (Math.abs(w) < 1e-9) return null;
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  };
}

/** Denominateur homogene : son signe dit de quel cote de l'horizon on se trouve. */
export function homogeneousW(h: Mat3, p: Pt): number {
  return h[6] * p.x + h[7] * p.y + h[8];
}

export function invertH(h: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, i, j] = h;
  const det = a * (e * j - f * i) - b * (d * j - f * g) + c * (d * i - e * g);
  if (Math.abs(det) < 1e-14) return null;
  const inv: Mat3 = [
    (e * j - f * i) / det,
    (c * i - b * j) / det,
    (b * f - c * e) / det,
    (f * g - d * j) / det,
    (a * j - c * g) / det,
    (c * d - a * f) / det,
    (d * i - e * g) / det,
    (b * g - a * i) / det,
    (a * e - b * d) / det,
  ];
  return inv;
}

export function composeH(m: Mat3, n: Mat3): Mat3 {
  const out = new Array(9).fill(0) as number[];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += m[r * 3 + k] * n[k * 3 + c];
      out[r * 3 + c] = s;
    }
  }
  return out as Mat3;
}

export interface WarpResult {
  /** Image redressee : chaque pixel represente `1 / pxPerCm` cm au sol. */
  canvas: HTMLCanvasElement;
  /** Resolution de l'image redressee, en pixels par centimetre. */
  pxPerCm: number;
  /**
   * Coin haut-gauche de l'image redressee, exprime dans le repere du rectangle
   * de reference (origine = premier point clique, en cm).
   */
  originCm: Pt;
}

export interface WarpOptions {
  /** Cote maximal de l'image de sortie, en pixels. */
  maxSizePx?: number;
  /** Etendue maximale du sol reconstruit autour du rectangle de reference, en cm. */
  maxExtentCm?: number;
  onProgress?: (ratio: number) => void;
}

/**
 * Redresse `image` en vue de dessus.
 *
 * `srcQuad` : 4 points image, dans l'ordre, decrivant le rectangle reel au sol.
 * `realW` / `realH` : dimensions reelles de ce rectangle, en cm, dans le meme ordre
 * (realW = cote entre srcQuad[0] et srcQuad[1]).
 */
export async function warpToTopDown(
  image: CanvasImageSource & { width: number; height: number },
  srcQuad: Pt[],
  realW: number,
  realH: number,
  opts: WarpOptions = {},
): Promise<WarpResult | null> {
  const maxSizePx = opts.maxSizePx ?? 1800;
  const maxExtentCm = opts.maxExtentCm ?? 1200;

  // Etape 1 : homographie vers un repere en centimetres (1 unite = 1 cm).
  const dstCm: Pt[] = [
    { x: 0, y: 0 },
    { x: realW, y: 0 },
    { x: realW, y: realH },
    { x: 0, y: realH },
  ];
  const hCm = homographyFromQuads(srcQuad, dstCm);
  if (!hCm) return null;

  // Etape 2 : etendue du sol visible. On echantillonne l'image et on ne garde
  // que les points du bon cote de l'horizon et a distance raisonnable.
  const refCenter: Pt = {
    x: srcQuad.reduce((s, p) => s + p.x, 0) / 4,
    y: srcQuad.reduce((s, p) => s + p.y, 0) / 4,
  };
  const refSign = Math.sign(homogeneousW(hCm, refCenter)) || 1;

  const limitMinX = -maxExtentCm;
  const limitMaxX = realW + maxExtentCm;
  const limitMinY = -maxExtentCm;
  const limitMaxY = realH + maxExtentCm;

  let minX = 0;
  let minY = 0;
  let maxX = realW;
  let maxY = realH;

  const steps = 80;
  for (let iy = 0; iy <= steps; iy++) {
    for (let ix = 0; ix <= steps; ix++) {
      const p = { x: (ix / steps) * image.width, y: (iy / steps) * image.height };
      const w = homogeneousW(hCm, p);
      if (Math.sign(w) !== refSign || Math.abs(w) < 1e-9) continue;
      const q = applyH(hCm, p);
      if (!q) continue;
      if (q.x < limitMinX || q.x > limitMaxX || q.y < limitMinY || q.y > limitMaxY) continue;
      if (q.x < minX) minX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.x > maxX) maxX = q.x;
      if (q.y > maxY) maxY = q.y;
    }
  }

  const widthCm = maxX - minX;
  const heightCm = maxY - minY;
  if (!(widthCm > 0) || !(heightCm > 0)) return null;

  // Etape 3 : resolution de sortie. Inutile de depasser la finesse de la photo.
  const refPxSide = Math.max(
    Math.hypot(srcQuad[1].x - srcQuad[0].x, srcQuad[1].y - srcQuad[0].y),
    Math.hypot(srcQuad[2].x - srcQuad[1].x, srcQuad[2].y - srcQuad[1].y),
  );
  const nativePxPerCm = refPxSide / Math.max(realW, realH, 1);
  let pxPerCm = Math.min(nativePxPerCm, maxSizePx / Math.max(widthCm, heightCm));
  pxPerCm = Math.max(0.2, Math.min(pxPerCm, 12));

  const outW = Math.max(1, Math.round(widthCm * pxPerCm));
  const outH = Math.max(1, Math.round(heightCm * pxPerCm));

  // Etape 4 : homographie finale image -> pixels de sortie, puis son inverse
  // pour echantillonner la source depuis chaque pixel destination.
  const toOut: Mat3 = composeH(
    [pxPerCm, 0, -minX * pxPerCm, 0, pxPerCm, -minY * pxPerCm, 0, 0, 1],
    hCm,
  );
  const inv = invertH(toOut);
  if (!inv) return null;

  // Source en ImageData pour l'echantillonnage bilineaire.
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = image.width;
  srcCanvas.height = image.height;
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  if (!srcCtx) return null;
  srcCtx.drawImage(image, 0, 0);
  const src = srcCtx.getImageData(0, 0, image.width, image.height);
  const sd = src.data;
  const sw = src.width;
  const sh = src.height;

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const outCtx = out.getContext('2d');
  if (!outCtx) return null;
  const dst = outCtx.createImageData(outW, outH);
  const dd = dst.data;

  const rowsPerChunk = Math.max(16, Math.ceil(200000 / outW));
  for (let y0 = 0; y0 < outH; y0 += rowsPerChunk) {
    const y1 = Math.min(outH, y0 + rowsPerChunk);
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < outW; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w = inv[6] * px + inv[7] * py + inv[8];
        if (Math.abs(w) < 1e-9) continue;
        const sx = (inv[0] * px + inv[1] * py + inv[2]) / w;
        const sy = (inv[3] * px + inv[4] * py + inv[5]) / w;
        if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) continue;

        const x0 = sx | 0;
        const yy0 = sy | 0;
        const fx = sx - x0;
        const fy = sy - yy0;
        const i00 = (yy0 * sw + x0) * 4;
        const i10 = i00 + 4;
        const i01 = i00 + sw * 4;
        const i11 = i01 + 4;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        const o = (y * outW + x) * 4;
        dd[o] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
        dd[o + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
        dd[o + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
        dd[o + 3] = 255;
      }
    }
    opts.onProgress?.(y1 / outH);
    // Laisse respirer le thread principal entre deux blocs de lignes.
    await new Promise((r) => setTimeout(r, 0));
  }

  outCtx.putImageData(dst, 0, 0);
  return { canvas: out, pxPerCm, originCm: { x: minX, y: minY } };
}
