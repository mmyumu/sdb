import { dist, polygonArea } from '../core/geometry.ts';
import { collisionReport } from '../model/collision.ts';
import type { Store } from '../model/store.ts';
import { rescaleScene } from '../model/store.ts';
import { alignSceneToGrid } from '../model/align.ts';
import { obstacleSize, resizeObstacleTo, resizeRoundObstacle } from '../model/room.ts';
import type { Movable, MovableKind, Obstacle, Scene } from '../model/types.ts';
import { APPLIANCE_PRESETS, FURNITURE_COLORS, emptyScene, uid } from '../model/types.ts';
import { openCalibration } from './calibrate.ts';
import { LibrarySection, ScanSection } from './plans.ts';
import type { CanvasController } from './tools.ts';
import type { Mode } from './render.ts';

const TOOL_IDS = [
  '#tool-room',
  '#tool-door',
  '#tool-obstacle',
  '#tool-circle',
  '#tool-select',
  '#tool-measure',
];

const PANEL_HTML = `
  <header class="panel-head">
    <h1>Plan &amp; passage</h1>
    <div class="row">
      <button id="undo" class="ghost" title="Annuler (Ctrl+Z)">↶</button>
      <button id="redo" class="ghost" title="Rétablir (Ctrl+Y)">↷</button>
      <button id="fit" class="ghost" title="Tout afficher">⤢</button>
    </div>
  </header>

  <section id="scan-section"></section>

  <section>
    <h2>1 · Photo</h2>
    <p class="hint">
      Redresse une photo du sol en vue de dessus pour tracer par-dessus. Tu peux aussi
      tracer directement à la souris sans photo.
    </p>
    <div class="row">
      <button id="load-photo" class="primary">Charger une photo</button>
      <button id="drop-photo" class="ghost" hidden>Retirer</button>
    </div>
    <label class="field" id="opacity-field" hidden>
      Opacité du fond
      <input type="range" id="opacity" min="0" max="1" step="0.05">
    </label>
    <input type="file" id="photo-input" accept="image/*" hidden>
  </section>

  <section>
    <h2>2 · Plan</h2>
    <div class="row wrap">
      <button id="tool-room" data-mode="room">Tracer la pièce</button>
      <button id="tool-door" data-mode="door">Portes</button>
      <button id="tool-obstacle" data-mode="obstacle">Meuble</button>
      <button id="tool-circle" data-mode="circle">Meuble rond</button>
      <button id="tool-select" data-mode="select">Sélection</button>
    </div>
    <p class="hint" id="draw-hint"></p>
    <div class="row wrap">
      <button id="align" class="ghost" title="Rendre le mur dominant horizontal">Aligner sur la grille</button>
      <label class="field checkbox inline-check">
        <input type="checkbox" id="align-square" checked> équerrer les murs
      </label>
    </div>
    <div id="obstacle-list" class="list"></div>
    <p class="stat" id="room-stat"></p>
  </section>

  <section>
    <h2>3 · Échelle</h2>
    <p class="hint">
      Mesure une longueur connue sur le plan, saisis sa valeur réelle : tout le plan
      se recale.
    </p>
    <div class="row">
      <button id="tool-measure" data-mode="measure">Mesurer</button>
      <button id="clear-measures" class="ghost">Effacer</button>
    </div>
    <div id="measure-list" class="list"></div>
  </section>

  <section>
    <h2>4 · Simulation</h2>
    <div class="row">
      <select id="preset"></select>
      <button id="add-movable" class="primary">Ajouter</button>
    </div>
    <label class="field">
      Jeu de sécurité autour de l'objet
      <span class="inline"><input type="number" id="clearance" min="0" step="0.5"> cm</span>
    </label>
    <label class="field checkbox">
      <input type="checkbox" id="collision"> Blocage par collision
    </label>
    <div id="movable-list" class="list"></div>
    <p class="hint">
      Glisse l'objet à la souris : il bute sur les murs et les meubles et glisse le long.
      <b>R</b> tourne de 90°, la poignée ronde tourne librement (<b>Maj</b> = pas de 15°),
      les flèches déplacent de 1 cm (<b>Maj</b> = 10 cm).
      Marque une arête comme <b>porte</b> pour autoriser le passage à travers.
    </p>
  </section>

  <section id="library-section"></section>

  <footer class="panel-foot">
    <button id="export" class="ghost">Exporter</button>
    <button id="import" class="ghost">Importer</button>
    <button id="reset" class="ghost danger">Réinitialiser</button>
    <input type="file" id="import-input" accept="application/json" hidden>
  </footer>
`;

const DRAW_HINTS: Record<Mode, string> = {
  select:
    'Clique un objet pour le sélectionner. Tire un coin pour le déplacer, double-clique une arête pour ajouter un coin, ' +
    'un coin pour le retirer. Espace ou clic droit pour déplacer la vue.',
  room: 'Clique chaque coin de la pièce. Entrée ou double-clic pour fermer, Échap pour annuler. Maj contraint les angles.',
  door: 'Clique une arête du contour pour la marquer comme porte (traversable). Re-clique pour annuler.',
  obstacle: "Clique les coins de l'emprise au sol du meuble. Entrée ou double-clic pour fermer.",
  circle: 'Glisse du centre vers le bord : le diamètre suit le curseur. Pour un lavabo, une colonne, un pied de table.',
  measure: 'Trace un segment sur une longueur que tu as mesurée en vrai.',
};

/** Elements d'une ligne de meuble, conserves pour une mise a jour sans reconstruction. */
interface ObstacleRow {
  root: HTMLElement;
  name: HTMLInputElement;
  swatch: HTMLElement;
  /** Present seulement pour une emprise ronde. */
  diameter: HTMLInputElement;
  diameterField: HTMLElement;
  /** Encombrement, pour les emprises quelconques. */
  width: HTMLInputElement;
  depth: HTMLInputElement;
  sizeField: HTMLElement;
}

interface MovableRow {
  root: HTMLElement;
  name: HTMLInputElement;
  badge: HTMLElement;
  kind: HTMLSelectElement;
  w: HTMLInputElement;
  h: HTMLInputElement;
  angle: HTMLInputElement;
  depthLabel: HTMLElement;
}

interface MeasureRow {
  root: HTMLElement;
  reading: HTMLElement;
}

export class Panel {
  private root: HTMLElement;
  private scheduled = false;

  private obstacleRows = new Map<string, ObstacleRow>();
  private movableRows = new Map<string, MovableRow>();
  private measureRows = new Map<string, MeasureRow>();
  private obstacleSignature = '';
  private movableSignature = '';
  private measureSignature = '';
  private library: LibrarySection;
  private scan: ScanSection;

  constructor(
    container: HTMLElement,
    private store: Store,
    private controller: CanvasController,
    private onFit: () => void,
  ) {
    this.root = container;
    this.root.innerHTML = PANEL_HTML;
    this.bindStatic();
    this.library = new LibrarySection(this.$('#library-section'), store, onFit);
    this.scan = new ScanSection(this.$('#scan-section'), store, onFit, () => void this.library.refresh());
    // Les mises à jour sont groupées par frame : pendant un glisser-déposer le store
    // émet à chaque mouvement, et reconstruire le DOM à ce rythme casserait le focus.
    this.store.subscribe(() => this.schedule());
    this.render();
  }

  schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.render();
    });
  }

  private $<T extends HTMLElement>(sel: string): T {
    const el = this.root.querySelector<T>(sel);
    if (!el) throw new Error(`Élément introuvable : ${sel}`);
    return el;
  }

  private bindStatic(): void {
    const presetSelect = this.$<HTMLSelectElement>('#preset');
    presetSelect.innerHTML =
      APPLIANCE_PRESETS.map((p, i) => `<option value="${i}">${p.label} — ${p.w}×${p.h} cm</option>`).join('') +
      '<option value="custom">Sur mesure…</option>';

    this.$('#undo').addEventListener('click', () => this.store.undo());
    this.$('#redo').addEventListener('click', () => this.store.redo());
    this.$('#fit').addEventListener('click', () => this.onFit());

    for (const id of TOOL_IDS) {
      const btn = this.$<HTMLButtonElement>(id);
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode as Mode;
        this.controller.setMode(this.controller.mode === mode && mode !== 'select' ? 'select' : mode);
        // Sans cela le bouton garde le focus et Espace / Entrée le re-déclenchent
        // au lieu de piloter le canvas.
        btn.blur();
      });
    }

    const photoInput = this.$<HTMLInputElement>('#photo-input');
    this.$('#load-photo').addEventListener('click', () => photoInput.click());
    photoInput.addEventListener('change', () => {
      const file = photoInput.files?.[0];
      photoInput.value = '';
      if (!file) return;
      void openCalibration(file).then((bg) => {
        if (!bg) return;
        this.store.commit((s) => {
          s.background = bg;
        });
        this.onFit();
      });
    });

    this.$('#drop-photo').addEventListener('click', () => {
      this.store.commit((s) => {
        s.background = null;
      });
    });

    this.$<HTMLInputElement>('#opacity').addEventListener('input', (e) => {
      const value = Number((e.target as HTMLInputElement).value);
      this.store.update((s) => {
        if (s.background) s.background.opacity = value;
      });
    });

    this.$<HTMLInputElement>('#clearance').addEventListener('change', (e) => {
      const value = Math.max(0, Number((e.target as HTMLInputElement).value) || 0);
      this.store.commit((s) => {
        s.clearance = value;
      });
    });

    this.$<HTMLInputElement>('#collision').addEventListener('change', (e) => {
      const value = (e.target as HTMLInputElement).checked;
      this.store.commit((s) => {
        s.collisionEnabled = value;
      });
    });

    this.$('#add-movable').addEventListener('click', () => this.addMovable());

    this.$('#align').addEventListener('click', () => this.alignToGrid());

    this.$('#clear-measures').addEventListener('click', () => {
      this.store.commit((s) => {
        s.measurements = [];
      });
    });

    this.$('#export').addEventListener('click', () => this.exportScene());
    const importInput = this.$<HTMLInputElement>('#import-input');
    this.$('#import').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', () => {
      const file = importInput.files?.[0];
      importInput.value = '';
      if (file) void this.importScene(file);
    });

    this.$('#reset').addEventListener('click', () => {
      if (!confirm('Effacer le plan et repartir de zéro ?')) return;
      this.store.replace(emptyScene());
      this.onFit();
    });
  }

  /**
   * Redresse le plan. La rotation ne touche a aucune mesure ; l'equerrage, lui,
   * deplace des sommets, d'ou la case a cocher plutot qu'un comportement impose.
   */
  private alignToGrid(): void {
    const scene = this.store.state;
    if (!scene.room || scene.room.points.length < 3) return;
    if (scene.background && !confirm("La photo de fond ne tournera pas avec le plan et ne sera plus alignée. Continuer ?")) {
      return;
    }
    const square = this.$<HTMLInputElement>('#align-square').checked;
    this.store.commit((s) => {
      alignSceneToGrid(s, { square });
    });
    this.onFit();
  }

  private addMovable(): void {
    const select = this.$<HTMLSelectElement>('#preset');
    let label: string;
    let w: number;
    let h: number;

    if (select.value === 'custom') {
      const raw = prompt('Nom, largeur cm, profondeur cm', 'Objet, 60, 60');
      if (!raw) return;
      const parts = raw.split(',').map((s) => s.trim());
      label = parts[0] || 'Objet';
      w = Number(parts[1]);
      h = Number(parts[2]);
      if (!(w > 0) || !(h > 0)) {
        alert('Dimensions invalides.');
        return;
      }
    } else {
      const preset = APPLIANCE_PRESETS[Number(select.value)];
      label = preset.label;
      w = preset.w;
      h = preset.h;
    }

    this.store.commit((s) => {
      const m: Movable = {
        id: uid('mov'),
        label,
        kind: 'rect',
        w,
        h,
        pos: sceneCenter(s, w, h),
        angle: 0,
        color: FURNITURE_COLORS[(s.movables.length + 2) % FURNITURE_COLORS.length],
      };
      s.movables.push(m);
      s.selectedId = m.id;
    });
    this.controller.setMode('select');
  }

  private exportScene(): void {
    const blob = new Blob([this.store.toJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.store.state.name.replace(/\s+/g, '-').toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private async importScene(file: File): Promise<void> {
    try {
      const scene = JSON.parse(await file.text()) as Scene;
      if (typeof scene !== 'object' || !scene || !Array.isArray(scene.movables)) {
        throw new Error('format');
      }
      // Le plan importe est une copie : il ne pointe pas vers l'entree du depot
      // dont il provient, sinon un « Envoyer » l'ecraserait.
      this.store.replace({ ...emptyScene(), ...scene, remoteId: null });
      this.onFit();
    } catch {
      alert("Ce fichier n'est pas un plan valide.");
    }
  }

  /** Recale toute la scène pour que la mesure `id` vale `realCm`. */
  private applyScale(id: string, realCm: number): void {
    const mes = this.store.state.measurements.find((m) => m.id === id);
    if (!mes) return;
    const current = dist(mes.a, mes.b);
    if (!(current > 0) || !(realCm > 0)) return;
    const factor = realCm / current;
    if (Math.abs(factor - 1) < 1e-9) return;
    this.store.commit((s) => rescaleScene(s, factor));
    this.onFit();
  }

  private mutateMovable(id: string, fn: (m: Movable) => void): void {
    this.store.commit((s) => {
      const t = s.movables.find((x) => x.id === id);
      if (t) fn(t);
    });
  }

  // --- rendu -------------------------------------------------------------

  render(): void {
    const scene = this.store.state;

    this.$<HTMLButtonElement>('#undo').disabled = !this.store.canUndo();
    this.$<HTMLButtonElement>('#redo').disabled = !this.store.canRedo();

    for (const id of TOOL_IDS) {
      const btn = this.$<HTMLButtonElement>(id);
      btn.classList.toggle('active', btn.dataset.mode === this.controller.mode);
    }
    this.$<HTMLButtonElement>('#tool-door').disabled = !scene.room;
    this.$<HTMLButtonElement>('#align').disabled = !scene.room || scene.room.points.length < 3;
    this.$('#draw-hint').textContent = DRAW_HINTS[this.controller.mode];

    const hasBg = Boolean(scene.background);
    this.$('#drop-photo').hidden = !hasBg;
    this.$('#opacity-field').hidden = !hasBg;
    if (scene.background) {
      this.setValue(this.$<HTMLInputElement>('#opacity'), String(scene.background.opacity));
    }
    this.$('#load-photo').textContent = hasBg ? 'Remplacer la photo' : 'Charger une photo';

    this.setValue(this.$<HTMLInputElement>('#clearance'), String(scene.clearance));
    this.$<HTMLInputElement>('#collision').checked = scene.collisionEnabled;

    this.library.render();
    this.scan.render();
    this.renderRoomStat(scene);
    this.renderObstacles(scene);
    this.renderMeasurements(scene);
    this.renderMovables(scene);
  }

  /** N'écrit pas dans un champ que l'utilisateur est en train d'éditer. */
  private setValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
    if (document.activeElement === input) return;
    if (input.value !== value) input.value = value;
  }

  private renderRoomStat(scene: Scene): void {
    const el = this.$('#room-stat');
    if (!scene.room || scene.room.points.length < 3) {
      el.textContent = '';
      return;
    }
    const area = polygonArea(scene.room.points) / 10000;
    const doors = scene.room.doors.length;
    el.textContent = `Surface ${area.toFixed(2)} m² · ${scene.room.points.length} coins · ${doors} ouverture${doors > 1 ? 's' : ''}`;
  }

  private renderObstacles(scene: Scene): void {
    const list = this.$('#obstacle-list');
    const signature = scene.obstacles.map((o) => o.id).join('|');
    if (signature !== this.obstacleSignature) {
      this.obstacleSignature = signature;
      this.obstacleRows.clear();
      list.innerHTML = '';
      for (const o of scene.obstacles) list.appendChild(this.buildObstacleRow(o));
    }
    for (const o of scene.obstacles) {
      const row = this.obstacleRows.get(o.id);
      if (!row) continue;
      row.root.classList.toggle('selected', o.id === scene.selectedId);
      row.swatch.style.background = o.color;
      this.setValue(row.name, o.label);
      const isRound = o.round !== undefined;
      row.diameterField.hidden = !isRound;
      row.sizeField.hidden = isRound;
      if (isRound) {
        this.setValue(row.diameter, String(round(o.round as number)));
      } else {
        const size = obstacleSize(o);
        this.setValue(row.width, String(round(size.width)));
        this.setValue(row.depth, String(round(size.depth)));
      }
    }
  }

  private buildObstacleRow(o: Obstacle): HTMLElement {
    const root = document.createElement('div');
    root.className = 'item';
    root.innerHTML = `
      <span class="swatch"></span>
      <input class="name">
      <label class="round-field" hidden>Ø <input class="diameter" type="number" min="1" step="0.5"></label>
      <span class="size-field" hidden>
        <input class="width" type="number" min="1" step="0.5" title="Largeur : la profondeur suit dans le même rapport">
        <span class="times">×</span>
        <input class="depth" type="number" min="1" step="0.5" title="Profondeur : la largeur suit dans le même rapport">
      </span>
      <button class="ghost small" title="Supprimer">✕</button>
    `;
    const name = root.querySelector<HTMLInputElement>('.name')!;
    const swatch = root.querySelector<HTMLElement>('.swatch')!;
    const diameter = root.querySelector<HTMLInputElement>('.diameter')!;
    const diameterField = root.querySelector<HTMLElement>('.round-field')!;
    const width = root.querySelector<HTMLInputElement>('.width')!;
    const depth = root.querySelector<HTMLInputElement>('.depth')!;
    const sizeField = root.querySelector<HTMLElement>('.size-field')!;

    // Saisir une dimension redimensionne l'emprise entiere dans le meme rapport :
    // on donne la mesure qu'on connait, la forme est preservee.
    const applySize = (input: HTMLInputElement, axis: 'width' | 'depth') => () => {
      const value = Number(input.value);
      if (!(value > 0)) return;
      this.store.commit((s) => {
        const t = s.obstacles.find((x) => x.id === o.id);
        if (t) resizeObstacleTo(t, axis, value);
      });
    };
    for (const [input, axis] of [[width, 'width'], [depth, 'depth']] as const) {
      const apply = applySize(input, axis);
      input.addEventListener('change', apply);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') apply();
      });
    }

    const applyDiameter = (): void => {
      const value = Number(diameter.value);
      if (!(value > 0)) return;
      this.store.commit((s) => {
        const t = s.obstacles.find((x) => x.id === o.id);
        if (t) resizeRoundObstacle(t, value);
      });
    };
    diameter.addEventListener('change', applyDiameter);
    diameter.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyDiameter();
    });

    name.addEventListener('change', () => {
      const value = name.value;
      this.store.commit((s) => {
        const t = s.obstacles.find((x) => x.id === o.id);
        if (t) t.label = value;
      });
    });
    root.querySelector('button')!.addEventListener('click', () => {
      this.store.commit((s) => {
        s.obstacles = s.obstacles.filter((x) => x.id !== o.id);
        if (s.selectedId === o.id) s.selectedId = null;
      });
    });
    swatch.addEventListener('click', () => {
      this.store.update((s) => {
        s.selectedId = o.id;
      });
    });

    this.obstacleRows.set(o.id, { root, name, swatch, diameter, diameterField, width, depth, sizeField });
    return root;
  }

  private renderMeasurements(scene: Scene): void {
    const list = this.$('#measure-list');
    const signature = scene.measurements.map((m) => m.id).join('|');
    if (signature !== this.measureSignature) {
      this.measureSignature = signature;
      this.measureRows.clear();
      list.innerHTML = '';
      for (const m of scene.measurements) list.appendChild(this.buildMeasureRow(m.id));
    }
    for (const m of scene.measurements) {
      const row = this.measureRows.get(m.id);
      if (row) row.reading.textContent = `${dist(m.a, m.b).toFixed(1)} cm`;
    }
  }

  private buildMeasureRow(id: string): HTMLElement {
    const current = dist(
      this.store.state.measurements.find((m) => m.id === id)!.a,
      this.store.state.measurements.find((m) => m.id === id)!.b,
    );
    const root = document.createElement('div');
    root.className = 'item';
    root.innerHTML = `
      <span class="reading"></span>
      <span class="arrow">=</span>
      <input class="value" type="number" step="0.1" min="0.1" value="${current.toFixed(1)}">
      <button class="apply small" title="Recaler tout le plan">↺</button>
      <button class="ghost small" title="Supprimer">✕</button>
    `;
    const reading = root.querySelector<HTMLElement>('.reading')!;
    const input = root.querySelector<HTMLInputElement>('.value')!;
    const apply = () => this.applyScale(id, Number(input.value));

    root.querySelector('.apply')!.addEventListener('click', apply);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') apply();
    });
    root.querySelectorAll('button')[1].addEventListener('click', () => {
      this.store.commit((s) => {
        s.measurements = s.measurements.filter((x) => x.id !== id);
      });
    });

    this.measureRows.set(id, { root, reading });
    return root;
  }

  private renderMovables(scene: Scene): void {
    const list = this.$('#movable-list');
    const signature = scene.movables.map((m) => m.id).join('|');
    if (signature !== this.movableSignature) {
      this.movableSignature = signature;
      this.movableRows.clear();
      list.innerHTML = '';
      for (const m of scene.movables) list.appendChild(this.buildMovableRow(m));
    }
    for (const m of scene.movables) {
      const row = this.movableRows.get(m.id);
      if (!row) continue;
      const report = collisionReport(scene, m);
      const reason = report.walls.length
        ? report.obstacles.length
          ? 'mur + meuble'
          : 'mur'
        : 'meuble';
      row.root.classList.toggle('selected', m.id === scene.selectedId);
      row.badge.textContent = report.hit ? `bloqué · ${reason}` : 'libre';
      row.badge.className = `badge ${report.hit ? 'bad' : 'good'}`;
      this.setValue(row.name, m.label);
      this.setValue(row.kind, m.kind);
      this.setValue(row.w, String(round(m.w)));
      this.setValue(row.h, String(round(m.h)));
      this.setValue(row.angle, String(Math.round((m.angle * 180) / Math.PI)));
      row.h.disabled = m.kind === 'circle';
      row.depthLabel.textContent = m.kind === 'circle' ? 'Ø' : 'P';
    }
  }

  private buildMovableRow(m: Movable): HTMLElement {
    const root = document.createElement('div');
    root.className = 'item column';
    root.innerHTML = `
      <div class="item-line">
        <span class="swatch" style="background:${m.color}"></span>
        <input class="name">
        <span class="badge"></span>
        <button class="ghost small remove" title="Supprimer">✕</button>
      </div>
      <div class="item-line dims">
        <select class="kind">
          <option value="rect">Rectangle</option>
          <option value="circle">Rond</option>
        </select>
        <label>L <input class="w" type="number" min="1" step="0.5"></label>
        <label><span class="depth-label">P</span> <input class="h" type="number" min="1" step="0.5"></label>
        <label>∠ <input class="a" type="number" step="1">°</label>
      </div>
    `;

    const name = root.querySelector<HTMLInputElement>('.name')!;
    const badge = root.querySelector<HTMLElement>('.badge')!;
    const kind = root.querySelector<HTMLSelectElement>('.kind')!;
    const w = root.querySelector<HTMLInputElement>('.w')!;
    const h = root.querySelector<HTMLInputElement>('.h')!;
    const angle = root.querySelector<HTMLInputElement>('.a')!;
    const depthLabel = root.querySelector<HTMLElement>('.depth-label')!;

    // Sélection au clic sur la ligne, sans voler le clic aux champs.
    root.addEventListener('pointerdown', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, select, button')) return;
      this.store.update((s) => {
        s.selectedId = m.id;
      });
    });

    name.addEventListener('change', () => {
      const value = name.value;
      this.mutateMovable(m.id, (t) => {
        t.label = value;
      });
    });
    kind.addEventListener('change', () => {
      const value = kind.value as MovableKind;
      this.mutateMovable(m.id, (t) => {
        t.kind = value;
      });
    });
    w.addEventListener('change', () => {
      const value = Number(w.value);
      if (value > 0) {
        this.mutateMovable(m.id, (t) => {
          t.w = value;
        });
      }
    });
    h.addEventListener('change', () => {
      const value = Number(h.value);
      if (value > 0) {
        this.mutateMovable(m.id, (t) => {
          t.h = value;
        });
      }
    });
    angle.addEventListener('change', () => {
      const value = Number(angle.value);
      if (Number.isFinite(value)) {
        this.mutateMovable(m.id, (t) => {
          t.angle = (value * Math.PI) / 180;
        });
      }
    });
    root.querySelector<HTMLButtonElement>('.remove')!.addEventListener('click', () => {
      this.store.commit((s) => {
        s.movables = s.movables.filter((x) => x.id !== m.id);
        if (s.selectedId === m.id) s.selectedId = null;
      });
    });

    this.movableRows.set(m.id, { root, name, badge, kind, w, h, angle, depthLabel });
    return root;
  }
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Point de départ d'un nouvel objet : centre de la pièce, sinon du fond, sinon proche de l'origine. */
function sceneCenter(s: Scene, w: number, h: number): { x: number; y: number } {
  if (s.room && s.room.points.length >= 3) {
    const xs = s.room.points.map((p) => p.x);
    const ys = s.room.points.map((p) => p.y);
    return {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
  }
  if (s.background) {
    return {
      x: (s.background.widthPx * s.background.cmPerPx) / 2,
      y: (s.background.heightPx * s.background.cmPerPx) / 2,
    };
  }
  return { x: w, y: h };
}
