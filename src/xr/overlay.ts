/**
 * Panneau affiche dans le casque pendant le relevé, via la fonctionnalite WebXR
 * `dom-overlay` : c'est du DOM ordinaire, compose par-dessus le passthrough.
 */

export interface ScanTally {
  walls: number;
  floors: number;
  doors: number;
  furniture: number;
  total: number;
}

export interface ScanOverlay {
  root: HTMLElement;
  /** Rafraichit le decompte affiche. */
  update(tally: ScanTally): void;
  /** Message d'erreur non bloquant. */
  warn(message: string): void;
  destroy(): void;
  onAccept: () => void;
  onCancel: () => void;
  onRecapture: () => void;
}

export function createScanOverlay(): ScanOverlay {
  const root = document.createElement('div');
  root.className = 'xr-overlay';
  root.innerHTML = `
    <div class="xr-card">
      <h2>Relevé de la pièce</h2>
      <p class="xr-tally">Recherche des surfaces…</p>
      <p class="xr-note">Le relevé se termine tout seul dès que plus rien ne bouge. Les boutons ne sont qu'un raccourci.</p>
      <p class="xr-warn" hidden></p>
      <div class="xr-actions">
        <button class="xr-accept" disabled>Terminer maintenant</button>
        <button class="xr-recapture">Reconfigurer la pièce (efface la délimitation)</button>
        <button class="xr-cancel">Annuler</button>
      </div>
    </div>
  `;

  const tallyEl = root.querySelector<HTMLElement>('.xr-tally')!;
  const warnEl = root.querySelector<HTMLElement>('.xr-warn')!;
  const accept = root.querySelector<HTMLButtonElement>('.xr-accept')!;

  const overlay: ScanOverlay = {
    root,
    onAccept: () => {},
    onCancel: () => {},
    onRecapture: () => {},
    update(tally) {
      accept.disabled = tally.total === 0;
      if (tally.total === 0) {
        tallyEl.textContent = 'Aucune surface connue par le casque.';
        return;
      }
      const parts = [
        plural(tally.walls, 'mur', 'murs'),
        tally.floors ? 'sol détecté' : 'sol manquant',
        plural(tally.doors, 'ouverture', 'ouvertures'),
        plural(tally.furniture, 'meuble', 'meubles'),
      ];
      tallyEl.textContent = parts.join(' · ');
    },
    warn(message) {
      warnEl.textContent = message;
      warnEl.hidden = false;
    },
    destroy() {
      root.remove();
    },
  };

  accept.addEventListener('click', () => overlay.onAccept());
  root.querySelector('.xr-cancel')!.addEventListener('click', () => overlay.onCancel());
  root.querySelector('.xr-recapture')!.addEventListener('click', () => overlay.onRecapture());
  return overlay;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}
