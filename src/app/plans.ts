/**
 * Deux sections du panneau : le relevé au casque, et le depot de plans partage
 * entre les appareils.
 */

import type { Store } from '../model/store.ts';
import type { ScanPlan, ScanRoom } from '../model/scan.ts';
import { planFromRawScan, sceneFromRoom, sceneFromScan } from '../model/scan.ts';
import type { RawScan } from '../model/types.ts';
import type { SceneSummary } from '../model/remote.ts';
import { deleteScene, fetchScene, listScenes, pushScene } from '../model/remote.ts';
import { isScanSupported, runRoomCapture, runRoomScan } from '../xr/session.ts';

const SCAN_HTML = `
  <h2>Relevé Quest 3</h2>
  <p class="hint">
    Le casque connaît déjà la géométrie de la pièce. Un relevé remplace la photo
    <i>et</i> le recalage d'échelle : les murs arrivent en centimètres réels.
    Place-toi dans la pièce à relever : c'est ainsi qu'elle est reconnue parmi
    celles que le casque connaît.
  </p>
  <div class="row wrap">
    <button id="scan" class="primary">Scanner la pièce</button>
    <button id="recapture" class="ghost" title="Relancer la configuration d'espace du casque">Reconfigurer l'espace</button>
  </div>
  <p class="stat" id="scan-status"></p>
  <label class="field" id="room-field" hidden>
    Pièce retenue
    <select id="room-select"></select>
  </label>
  <div class="row" id="replan-row" hidden>
    <button id="replan" class="ghost">Recalculer le plan</button>
  </div>
  <div class="notes" id="scan-warnings"></div>
`;

const LIBRARY_HTML = `
  <h2>Plans enregistrés</h2>
  <p class="hint">
    Les plans sont gardés sur le serveur, donc accessibles depuis n'importe quel
    appareil — c'est ainsi qu'un relevé fait dans le casque se reprend sur le PC.
    <b>Enregistrer sous</b> crée une copie : de quoi garder le relevé intact avant
    de retoucher les mesures.
  </p>
  <label class="field">
    Nom du plan
    <input type="text" id="plan-name" maxlength="120" placeholder="Salle de bain">
  </label>
  <div class="row wrap">
    <button id="push" class="primary">Enregistrer</button>
    <button id="save-as" class="ghost">Enregistrer sous…</button>
    <button id="refresh" class="ghost" title="Rafraîchir la liste">⟳</button>
  </div>
  <p class="stat" id="library-status"></p>
  <div class="list" id="library-list"></div>
`;

export class ScanSection {
  private status: HTMLElement;
  private warnings: HTMLElement;
  private button: HTMLButtonElement;
  private recapture: HTMLButtonElement;
  private roomField: HTMLElement;
  private roomSelect: HTMLSelectElement;
  private replanRow: HTMLElement;
  private busy = false;
  /** Relevé dont découle `plan`, pour ne pas le recalculer à chaque rendu. */
  private planFor: RawScan | null = null;
  private plan: ScanPlan | null = null;
  /** Piece du releve sur laquelle la scene courante est batie. */
  private usedRoom: number | null = null;

  constructor(
    root: HTMLElement,
    private store: Store,
    private onFit: () => void,
    private onSaved: () => void,
  ) {
    root.innerHTML = SCAN_HTML;
    this.status = root.querySelector<HTMLElement>('#scan-status')!;
    this.warnings = root.querySelector<HTMLElement>('#scan-warnings')!;
    this.button = root.querySelector<HTMLButtonElement>('#scan')!;
    this.recapture = root.querySelector<HTMLButtonElement>('#recapture')!;
    this.roomField = root.querySelector<HTMLElement>('#room-field')!;
    this.roomSelect = root.querySelector<HTMLSelectElement>('#room-select')!;
    this.replanRow = root.querySelector<HTMLElement>('#replan-row')!;

    this.button.addEventListener('click', () => void this.scan());
    this.recapture.addEventListener('click', () => void this.reconfigure());
    this.roomSelect.addEventListener('change', () => this.useRoom(this.roomSelect.value));
    root.querySelector('#replan')!.addEventListener('click', () => {
      this.warnings.innerHTML = '';
      this.planFor = null;
      this.render();
      this.note('Plan recalculé depuis le relevé conservé.', 'good');
      this.useRoom(this.roomSelect.value);
    });
    void this.probe();
  }

  /** Etat du support avant toute tentative : c'est la que se voient les vrais blocages. */
  private async probe(): Promise<void> {
    if (!window.isSecureContext) {
      this.disableXr("WebXR exige HTTPS. Lance `npm run cert`, puis rouvre l'app en https://");
      return;
    }
    if (await isScanSupported()) {
      this.say('Casque détecté.', 'good');
      return;
    }
    this.disableXr('Aucun casque ici — ouvre cette page dans le navigateur du Quest 3.');
  }

  private disableXr(message: string): void {
    this.button.disabled = true;
    this.recapture.disabled = true;
    this.say(message, 'dim');
  }

  /**
   * Le relevé conservé permet de rejouer la conversion sur le PC : changer de
   * pièce ou profiter d'un algorithme amélioré ne demande pas de remettre le casque.
   */
  render(): void {
    const scan = this.store.state.scan;
    this.roomField.hidden = true;
    this.replanRow.hidden = !scan;
    if (!scan) {
      this.plan = null;
      this.planFor = null;
      return;
    }
    if (this.planFor !== scan) {
      this.planFor = scan;
      this.plan = planFromRawScan(scan);
      const auto = this.plan.rooms[this.plan.selected];
      const automatic = auto?.containsViewer
        ? 'Automatique — celle où je me tenais'
        : 'Automatique — la plus grande';
      this.roomSelect.innerHTML =
        `<option value="auto">${automatic}</option>` +
        this.plan.rooms.map((r, i) => `<option value="${i}">${roomLabel(r, i)}</option>`).join('');
      this.roomSelect.value = 'auto';
    }
    // Toujours visible des qu'un releve existe : le critere de choix est une
    // option, pas un comportement cache.
    this.roomField.hidden = (this.plan?.rooms.length ?? 0) < 1;
  }

  /**
   * Rebatit la scene sur une piece du releve.
   *
   * Tant qu'on reste sur la meme piece, les emprises ajoutees a la main sont
   * conservees : elles sont dans le meme repere, et recalculer ne doit pas punir
   * celui qui a complete le releve. Changer de piece, en revanche, change de
   * repere — les garder les placerait n'importe ou.
   */
  private useRoom(choice: string): void {
    if (!this.plan) return;
    const index = choice === 'auto' ? this.plan.selected : Number(choice);
    const room = this.plan.rooms[index];
    if (!room) return;

    const scene = this.store.state;
    const sameRoom = this.usedRoom === null || this.usedRoom === index;
    // Un plan enregistre avant l'introduction du marquage n'a que des emprises
    // non marquees, toutes issues du releve : les conserver les dupliquerait.
    const legacy = scene.obstacles.length > 0 && !scene.obstacles.some((o) => o.fromScan);
    const kept = sameRoom && !legacy ? scene.obstacles.filter((o) => !o.fromScan) : [];
    const next = sceneFromRoom(room, scene.name, scene.scan);
    next.obstacles = [...next.obstacles, ...kept];
    next.remoteId = scene.remoteId;

    this.usedRoom = index;
    this.store.replace(next);
    this.onFit();
    if (kept.length) {
      this.note(`${kept.length} emprise(s) ajoutée(s) à la main ont été conservées.`, 'good');
    } else if (legacy) {
      this.note('Plan antérieur au marquage des emprises : toutes ont été reconstruites depuis le relevé.');
    } else if (!sameRoom) {
      this.note('Changement de pièce : les emprises ajoutées à la main ont été retirées.');
    }
  }

  private say(message: string, tone: 'good' | 'warn' | 'bad' | 'dim'): void {
    this.status.textContent = message;
    this.status.className = `stat tone-${tone}`;
  }

  /** Relance la configuration d'espace du casque, hors de tout relevé. */
  private async reconfigure(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.recapture.disabled = true;
    this.warnings.innerHTML = '';
    this.say("Configuration de l'espace en cours dans le casque…", 'dim');
    try {
      await runRoomCapture();
      this.say("Espace reconfiguré. Relance « Scanner la pièce ».", 'good');
    } catch (err) {
      this.say(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      this.busy = false;
      this.recapture.disabled = false;
    }
  }

  private async scan(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.button.disabled = true;
    this.warnings.innerHTML = '';
    this.say('Relevé en cours dans le casque…', 'dim');

    try {
      const outcome = await runRoomScan();
      if (outcome.cancelled) {
        this.say('Relevé annulé.', 'dim');
        return;
      }
      const raw: RawScan = {
        capturedAt: new Date().toISOString(),
        planes: outcome.planes,
        viewer: outcome.viewer,
      };
      const name = `Relevé du ${new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}`;
      const { scene, plan } = sceneFromScan(raw, name);

      // Un panneau absent n'est plus bloquant, mais autant le dire : c'est ce qui
      // explique qu'on n'ait rien eu a cliquer dans le casque.
      if (outcome.features.length && !outcome.features.includes('dom-overlay')) {
        this.note("Le panneau dans le casque n'était pas disponible ; le relevé s'est terminé tout seul.");
      }
      for (const warning of plan.warnings) this.note(warning);
      if (!plan.room) {
        this.say('Aucun contour exploitable.', 'bad');
        return;
      }

      this.usedRoom = plan.selected;
      this.store.replace(scene);
      this.onFit();
      this.render();
      const chosen = plan.rooms[plan.selected];
      this.say(
        `${chosen.points.length} coins (d'après les ${chosen.source === 'walls' ? 'murs' : 'sol'}), ` +
          `${chosen.doors.length} ouverture(s), ${chosen.obstacles.length} meuble(s).`,
        'good',
      );
      await this.upload(name);
    } catch (err) {
      this.say(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      this.busy = false;
      this.button.disabled = false;
    }
  }

  /** Envoi immediat : sans PC a portee de main, l'utilisateur ne peut rien cliquer d'autre. */
  private async upload(name: string): Promise<void> {
    try {
      const record = await pushScene(this.store.state, name);
      this.store.update((s) => {
        s.remoteId = record.id;
      });
      this.note(`Enregistré sous « ${record.name} » — disponible sur le PC.`, 'good');
      this.onSaved();
    } catch (err) {
      this.note(`Plan gardé en local, enregistrement impossible : ${err instanceof Error ? err.message : err}`);
    }
  }

  private note(text: string, tone: 'warn' | 'good' = 'warn'): void {
    const p = document.createElement('p');
    p.className = `note tone-${tone}`;
    p.textContent = text;
    this.warnings.appendChild(p);
  }
}

function roomLabel(room: ScanRoom, index: number): string {
  const area = (room.area / 10000).toFixed(1);
  const here = room.containsViewer ? ' · tu y étais' : '';
  return `Pièce ${index + 1} — ${area} m², ${room.points.length} coins${here}`;
}

export class LibrarySection {
  private status: HTMLElement;
  private list: HTMLElement;
  private push: HTMLButtonElement;
  private saveAs: HTMLButtonElement;
  private nameInput: HTMLInputElement;
  private available = true;

  constructor(
    private root: HTMLElement,
    private store: Store,
    private onFit: () => void,
  ) {
    root.innerHTML = LIBRARY_HTML;
    this.status = root.querySelector<HTMLElement>('#library-status')!;
    this.list = root.querySelector<HTMLElement>('#library-list')!;
    this.push = root.querySelector<HTMLButtonElement>('#push')!;
    this.saveAs = root.querySelector<HTMLButtonElement>('#save-as')!;
    this.nameInput = root.querySelector<HTMLInputElement>('#plan-name')!;

    this.push.addEventListener('click', () => void this.save(false));
    this.saveAs.addEventListener('click', () => void this.save(true));
    this.nameInput.addEventListener('change', () => {
      const value = this.nameInput.value.trim();
      if (value) {
        this.store.commit((s) => {
          s.name = value;
        });
      }
    });
    root.querySelector('#refresh')!.addEventListener('click', () => void this.refresh());
    void this.refresh();
  }

  /** Le libelle depend du plan courant : deja enregistre, ou non. */
  render(): void {
    if (!this.available) return;
    const scene = this.store.state;
    this.push.textContent = scene.remoteId ? 'Enregistrer' : 'Enregistrer';
    this.push.title = scene.remoteId
      ? 'Remplace le plan enregistré portant ce nom'
      : "Crée l'entrée dans le dépôt";
    if (document.activeElement !== this.nameInput && this.nameInput.value !== scene.name) {
      this.nameInput.value = scene.name;
    }
  }

  async refresh(): Promise<void> {
    try {
      const scenes = await listScenes();
      this.available = true;
      this.root.hidden = false;
      this.renderList(scenes);
      this.status.textContent = scenes.length ? '' : 'Aucun plan enregistré pour l’instant.';
      this.status.className = 'stat';
      this.render();
    } catch (err) {
      // Build statique servi sans le serveur : la section n'a plus de sens.
      this.available = false;
      this.list.innerHTML = '';
      this.status.textContent = err instanceof Error ? err.message : String(err);
      this.status.className = 'stat tone-warn';
    }
  }

  /**
   * `asNew` force la creation d'une entree : c'est l'« enregistrer sous » qui
   * permet de figer un etat — le releve brut avant retouches — et d'y revenir.
   */
  private async save(asNew: boolean): Promise<void> {
    const scene = this.store.state;
    let name = scene.name;
    if (asNew) {
      const proposed = prompt('Nom de la copie', `${scene.name} (copie)`);
      if (proposed === null) return;
      name = proposed.trim() || `${scene.name} (copie)`;
    }

    this.push.disabled = true;
    this.saveAs.disabled = true;
    try {
      const record = await pushScene(scene, name, asNew ? null : scene.remoteId);
      this.store.update((s) => {
        s.remoteId = record.id;
        s.name = record.name;
      });
      await this.refresh();
      this.say(asNew ? `Copie créée : « ${record.name} ».` : `« ${record.name} » enregistré.`, 'good');
    } catch (err) {
      this.say(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      this.push.disabled = false;
      this.saveAs.disabled = false;
    }
  }

  /** Copie une entree du depot sans toucher au plan ouvert. */
  private async duplicate(id: string, name: string): Promise<void> {
    try {
      const record = await fetchScene(id);
      const copy = await pushScene({ ...record.scene, remoteId: null }, `${name} (copie)`);
      await this.refresh();
      this.say(`Copie créée : « ${copy.name} ».`, 'good');
    } catch (err) {
      this.say(err instanceof Error ? err.message : String(err), 'bad');
    }
  }

  private say(message: string, tone: 'good' | 'bad'): void {
    this.status.textContent = message;
    this.status.className = `stat tone-${tone}`;
  }

  private async open(id: string): Promise<void> {
    try {
      const record = await fetchScene(id);
      this.store.replace(record.scene);
      this.onFit();
      this.render();
    } catch (err) {
      this.say(err instanceof Error ? err.message : String(err), 'bad');
    }
  }

  private renderList(scenes: SceneSummary[]): void {
    this.list.innerHTML = '';
    for (const s of scenes) {
      const row = document.createElement('div');
      row.className = 'item column';
      row.classList.toggle('selected', s.id === this.store.state.remoteId);
      row.innerHTML = `
        <div class="item-line">
          <span class="plan-name"></span>
          <button class="small open" title="Ouvrir ce plan">Ouvrir</button>
          <button class="ghost small duplicate" title="Créer une copie de ce plan">⧉</button>
          <button class="ghost small remove" title="Supprimer">✕</button>
        </div>
        <span class="plan-meta"></span>
      `;
      row.querySelector<HTMLElement>('.plan-name')!.textContent = s.name;
      row.querySelector<HTMLElement>('.plan-meta')!.textContent =
        `${originLabel(s.origin)} · ${new Date(s.savedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}`;
      row.querySelector('.open')!.addEventListener('click', () => void this.open(s.id));
      row.querySelector('.duplicate')!.addEventListener('click', () => void this.duplicate(s.id, s.name));
      row.querySelector('.remove')!.addEventListener('click', () => {
        if (!confirm(`Supprimer « ${s.name} » du dépôt ?`)) return;
        void deleteScene(s.id).then(() => this.refresh());
      });
      this.list.appendChild(row);
    }
  }
}

function originLabel(origin: string): string {
  if (origin === 'quest') return 'Quest';
  if (origin === 'mobile') return 'Téléphone';
  return 'PC';
}
