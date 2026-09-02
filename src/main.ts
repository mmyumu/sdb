import './style.css';
import { Renderer } from './app/render.ts';
import { CanvasController } from './app/tools.ts';
import { Panel } from './app/ui.ts';
import { Viewport } from './app/viewport.ts';
import { Store } from './model/store.ts';

const app = document.getElementById('app');
if (!app) throw new Error('#app introuvable');

app.innerHTML = `
  <aside id="panel" class="panel"></aside>
  <main class="stage">
    <canvas id="board"></canvas>
    <button id="panel-toggle" class="panel-toggle" aria-label="Afficher les outils">☰</button>
  </main>
`;

const canvas = document.getElementById('board') as HTMLCanvasElement;
const store = new Store();
const viewport = new Viewport();
const renderer = new Renderer(canvas, viewport);

let frame = 0;
function requestRedraw(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    renderer.draw(store.state, controller.overlay, requestRedraw);
  });
}

const controller = new CanvasController(canvas, store, viewport, renderer, requestRedraw);

function fitView(): void {
  viewport.fit(
    Renderer.contentBbox(store.state),
    canvas.clientWidth || 800,
    canvas.clientHeight || 600,
  );
  requestRedraw();
}

const panel = new Panel(
  document.getElementById('panel') as HTMLElement,
  store,
  controller,
  fitView,
);
controller.onModeChange = () => panel.render();

store.subscribe(requestRedraw);
window.addEventListener('resize', requestRedraw);

document.getElementById('panel-toggle')!.addEventListener('click', () => {
  document.body.classList.toggle('panel-open');
  requestRedraw();
});

void store.load().then(() => {
  fitView();
  panel.render();
});

// Vue par defaut : une piece de 3 x 2,5 m visible a l'ecran.
viewport.fit({ minX: -20, minY: -20, maxX: 320, maxY: 270 }, canvas.clientWidth || 800, canvas.clientHeight || 600);
requestRedraw();
