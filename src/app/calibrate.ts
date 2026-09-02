import type { Pt } from '../core/geometry.ts';
import { dist } from '../core/geometry.ts';
import { warpToTopDown } from '../core/homography.ts';
import type { Background } from '../model/types.ts';

/** Charge un fichier image en HTMLImageElement decodee. */
export function loadImageFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Image illisible"));
    };
    img.src = url;
  });
}

/**
 * Réduit une photo trop grande avant le redressement.
 * Au-delà de ~3000 px de côté, le gain de précision est nul et le redressement devient lent.
 */
function downscale(img: HTMLImageElement, maxSide = 2600): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
  }
  return c;
}

const HANDLE_LABELS = ['1', '2', '3', '4'];

/**
 * Ouvre l'ecran de calibration : l'utilisateur place 4 points sur un rectangle
 * réel du sol et saisit ses dimensions. Renvoie le calque de fond redressé,
 * ou null si l'utilisateur annule.
 */
export function openCalibration(file: File): Promise<Background | null> {
  return new Promise((resolve) => {
    void (async () => {
      let img: HTMLImageElement;
      try {
        img = await loadImageFile(file);
      } catch {
        alert("Impossible de lire cette image.");
        resolve(null);
        return;
      }
      const source = downscale(img);

      const overlay = document.createElement('div');
      overlay.className = 'calib';
      overlay.innerHTML = `
        <div class="calib-bar">
          <div class="calib-help">
            Place les <b>4 coins</b> d'un rectangle réel au sol (une dalle, un carré de
            carrelage, un pan de sol connu) dans l'ordre <b>1 → 2 → 3 → 4</b>, en tournant
            toujours dans le même sens. Puis donne ses dimensions réelles.
          </div>
          <label>1→2 <input type="number" id="calib-w" min="1" step="0.5" value="60"> cm</label>
          <label>2→3 <input type="number" id="calib-h" min="1" step="0.5" value="60"> cm</label>
          <button id="calib-cancel" class="ghost">Annuler</button>
          <button id="calib-ok" class="primary">Redresser</button>
        </div>
        <canvas id="calib-canvas"></canvas>
        <div class="calib-status" id="calib-status"></div>
      `;
      document.body.appendChild(overlay);

      const canvas = overlay.querySelector<HTMLCanvasElement>('#calib-canvas')!;
      const status = overlay.querySelector<HTMLDivElement>('#calib-status')!;
      const ctx = canvas.getContext('2d')!;

      // Quad initial : un carré centré, à repositionner par l'utilisateur.
      const cx = source.width / 2;
      const cy = source.height * 0.62;
      const r = Math.min(source.width, source.height) * 0.18;
      const quad: Pt[] = [
        { x: cx - r, y: cy - r * 0.5 },
        { x: cx + r, y: cy - r * 0.5 },
        { x: cx + r * 1.35, y: cy + r * 0.6 },
        { x: cx - r * 1.35, y: cy + r * 0.6 },
      ];

      let view = { scale: 1, tx: 0, ty: 0 };
      let dragIndex = -1;
      let pointer: Pt | null = null;
      let busy = false;

      const toScreen = (p: Pt): Pt => ({ x: p.x * view.scale + view.tx, y: p.y * view.scale + view.ty });
      const toImage = (p: Pt): Pt => ({ x: (p.x - view.tx) / view.scale, y: (p.y - view.ty) / view.scale });

      function fit(): void {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        view.scale = Math.min(w / source.width, h / source.height) * 0.92;
        view.tx = (w - source.width * view.scale) / 2;
        view.ty = (h - source.height * view.scale) / 2;
      }

      function drawMagnifier(at: Pt): void {
        const R = 68;
        const zoom = 5;
        const mx = at.x < canvas.clientWidth / 2 ? canvas.clientWidth - R - 24 : R + 24;
        const my = R + 24;
        const src = toImage(at);

        ctx.save();
        ctx.beginPath();
        ctx.arc(mx, my, R, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = '#000';
        ctx.fillRect(mx - R, my - R, R * 2, R * 2);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(
          source,
          src.x - R / zoom,
          src.y - R / zoom,
          (R * 2) / zoom,
          (R * 2) / zoom,
          mx - R,
          my - R,
          R * 2,
          R * 2,
        );
        ctx.restore();

        ctx.strokeStyle = '#7aa2f7';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(mx, my, R, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(mx - 10, my);
        ctx.lineTo(mx + 10, my);
        ctx.moveTo(mx, my - 10);
        ctx.lineTo(mx, my + 10);
        ctx.strokeStyle = '#f7768e';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      function draw(): void {
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
        ctx.fillStyle = '#0b0d12';
        ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
        ctx.drawImage(
          source,
          view.tx,
          view.ty,
          source.width * view.scale,
          source.height * view.scale,
        );

        const pts = quad.map(toScreen);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(122, 162, 247, 0.16)';
        ctx.fill();
        ctx.strokeStyle = '#7aa2f7';
        ctx.lineWidth = 2;
        ctx.stroke();

        pts.forEach((p, i) => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
          ctx.fillStyle = i === dragIndex ? '#f7768e' : '#7aa2f7';
          ctx.fill();
          ctx.fillStyle = '#0b0d12';
          ctx.font = '700 12px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(HANDLE_LABELS[i], p.x, p.y);
        });

        if (dragIndex >= 0 && pointer) drawMagnifier(pointer);
      }

      function localPoint(e: PointerEvent): Pt {
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
      }

      canvas.addEventListener('pointerdown', (e) => {
        const p = localPoint(e);
        const pts = quad.map(toScreen);
        let best = -1;
        let bestD = 28;
        pts.forEach((q, i) => {
          const d = dist(p, q);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        if (best >= 0) {
          dragIndex = best;
          pointer = p;
          canvas.setPointerCapture(e.pointerId);
          draw();
        }
      });

      canvas.addEventListener('pointermove', (e) => {
        if (dragIndex < 0) return;
        const p = localPoint(e);
        pointer = p;
        quad[dragIndex] = toImage(p);
        draw();
      });

      const endDrag = () => {
        dragIndex = -1;
        pointer = null;
        draw();
      };
      canvas.addEventListener('pointerup', endDrag);
      canvas.addEventListener('pointercancel', endDrag);

      const onResize = () => {
        fit();
        draw();
      };
      window.addEventListener('resize', onResize);

      function close(result: Background | null): void {
        window.removeEventListener('resize', onResize);
        overlay.remove();
        resolve(result);
      }

      overlay.querySelector('#calib-cancel')!.addEventListener('click', () => close(null));

      overlay.querySelector('#calib-ok')!.addEventListener('click', () => {
        if (busy) return;
        const realW = Number((overlay.querySelector('#calib-w') as HTMLInputElement).value);
        const realH = Number((overlay.querySelector('#calib-h') as HTMLInputElement).value);
        if (!(realW > 0) || !(realH > 0)) {
          status.textContent = 'Renseigne des dimensions valides.';
          return;
        }
        busy = true;
        status.textContent = 'Redressement…';
        void (async () => {
          const result = await warpToTopDown(source, quad, realW, realH, {
            onProgress: (r) => {
              status.textContent = `Redressement… ${Math.round(r * 100)} %`;
            },
          });
          if (!result) {
            busy = false;
            status.textContent =
              "Redressement impossible : les 4 points sont sans doute alignés ou croisés.";
            return;
          }
          close({
            dataUrl: result.canvas.toDataURL('image/jpeg', 0.86),
            widthPx: result.canvas.width,
            heightPx: result.canvas.height,
            cmPerPx: 1 / result.pxPerCm,
            opacity: 0.85,
          });
        })();
      });

      fit();
      draw();
    })();
  });
}
