/**
 * Ouverture d'une session WebXR sur le casque et extraction des surfaces.
 *
 * Le module s'arrete a la frontiere du materiel : il rend des polygones en
 * metres dans le repere du monde, que `model/scan.ts` convertit en plan.
 */

import type { ScanPlane, Vec3 } from '../model/scan.ts';
import { normalizeLabel } from '../model/scan.ts';
import type { ScanTally } from './overlay.ts';
import { createScanOverlay } from './overlay.ts';

/** Les plans ne sont pas peuples des la premiere frame. */
const SETTLE_MS = 2500;
/** Duree sans changement au-dela de laquelle le releve est considere complet. */
const STABLE_MS = 1500;
/** Garde-fou : on ne retient jamais l'utilisateur dans le casque plus longtemps. */
const MAX_MS = 12000;

export interface ScanOutcome {
  planes: ScanPlane[];
  /** Ou se tenait le porteur, pour departager les pieces du releve. */
  viewer: Vec3 | null;
  /** Fonctionnalites reellement accordees : dit si le panneau a pu s'afficher. */
  features: string[];
  cancelled: boolean;
}

export async function isScanSupported(): Promise<boolean> {
  if (!navigator.xr) return false;
  try {
    return await navigator.xr.isSessionSupported('immersive-ar');
  } catch {
    return false;
  }
}

/**
 * Deroule un relevé complet : permission, session immersive, collecte, sortie.
 * La promesse ne se resout qu'une fois la session refermee.
 */
export async function runRoomScan(): Promise<ScanOutcome> {
  const xr = navigator.xr;
  if (!xr) throw new Error("Ce navigateur n'expose pas WebXR.");

  const overlay = createScanOverlay();
  document.body.appendChild(overlay.root);

  let session: XRSession;
  try {
    session = await xr.requestSession('immersive-ar', {
      requiredFeatures: ['plane-detection'],
      optionalFeatures: ['local-floor', 'dom-overlay'],
      domOverlay: { root: overlay.root },
    });
  } catch (err) {
    overlay.destroy();
    throw new Error(describeSessionError(err));
  }

  // Certaines implementations n'emettent aucune frame sans couche de rendu.
  // On n'affiche rien : le passthrough suffit pendant le relevé.
  const gl = createXrContext();
  if (gl) {
    await gl.makeXRCompatible().catch(() => {});
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  }

  const refSpace = await requestFloorSpace(session);
  const features = session.enabledFeatures ? Array.from(session.enabledFeatures) : [];

  return new Promise<ScanOutcome>((resolve) => {
    const started = performance.now();
    let planes: ScanPlane[] = [];
    let viewer: Vec3 | null = null;
    let signature = '';
    let lastChange = started;
    let done = false;

    const finish = (cancelled: boolean, endSession: boolean): void => {
      if (done) return;
      done = true;
      overlay.destroy();
      if (endSession) void session.end().catch(() => {});
      resolve({ planes, viewer, features, cancelled });
    };

    overlay.onAccept = () => finish(false, true);
    overlay.onCancel = () => finish(true, true);
    // Jamais automatiquement : relancer la configuration efface le travail de
    // delimitation deja fait. C'est une decision, pas un rattrapage.
    overlay.onRecapture = () => {
      void recapture(session).catch((err) => overlay.warn(String(err)));
    };
    // Sortie par le menu systeme, ou casque retire.
    session.addEventListener('end', () => finish(planes.length === 0, false));

    const onFrame = (_time: number, frame: XRFrame): void => {
      if (done) return;
      session.requestAnimationFrame(onFrame);

      const detected = frame.detectedPlanes;
      if (detected) planes = collect(detected, frame, refSpace);

      const pose = frame.getViewerPose(refSpace);
      if (pose) {
        const m = pose.transform.matrix;
        viewer = { x: m[12], y: m[13], z: m[14] };
      }

      const now = performance.now();
      const next = `${planes.length}:${planes.reduce((n, p) => n + p.polygon.length, 0)}`;
      if (next !== signature) {
        signature = next;
        lastChange = now;
      }
      overlay.update(tally(planes));

      // La session se referme d'elle-meme : le panneau peut ne pas s'afficher
      // selon le casque, et rien ne doit dependre de son apparition. Les boutons
      // ne sont qu'un raccourci quand ils sont visibles.
      const elapsed = now - started;
      const settled = elapsed > SETTLE_MS && planes.length > 0 && now - lastChange > STABLE_MS;
      if (settled || elapsed > MAX_MS) finish(false, true);
    };

    session.requestAnimationFrame(onFrame);
  });
}

function collect(
  detected: ReadonlySet<XRPlane>,
  frame: XRFrame,
  refSpace: XRReferenceSpace,
): ScanPlane[] {
  const out: ScanPlane[] = [];
  for (const plane of detected) {
    const pose = frame.getPose(plane.planeSpace, refSpace);
    if (!pose || plane.polygon.length < 3) continue;
    const m = pose.transform.matrix;
    out.push({
      label: plane.semanticLabel ?? plane.orientation ?? 'other',
      polygon: plane.polygon.map((p) => transform(m, p)),
    });
  }
  return out;
}

/** Applique une matrice 4x4 en colonnes majeures a un point homogene. */
function transform(m: Float32Array, p: DOMPointReadOnly): Vec3 {
  return {
    x: m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12] * p.w,
    y: m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13] * p.w,
    z: m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14] * p.w,
  };
}

export function tally(planes: ScanPlane[]): ScanTally {
  const t: ScanTally = { walls: 0, floors: 0, doors: 0, furniture: 0, total: planes.length };
  for (const plane of planes) {
    const label = normalizeLabel(plane.label);
    if (label === 'wall' || label === 'wall face') t.walls++;
    else if (label === 'floor') t.floors++;
    else if (label === 'door' || label === 'door frame') t.doors++;
    else if (label !== 'ceiling') t.furniture++;
  }
  return t;
}

async function recapture(session: XRSession): Promise<void> {
  if (!session.initiateRoomCapture) {
    throw new Error('Ce casque ne sait pas lancer la configuration depuis la page.');
  }
  await session.initiateRoomCapture();
}

/**
 * Ouvre une session dans le seul but de relancer la configuration de la piece.
 * Utile quand le releve melange plusieurs pieces, ou quand la salle de bain n'a
 * jamais ete delimitee : c'est le casque qui refait son modele, pas nous.
 */
export async function runRoomCapture(): Promise<void> {
  const xr = navigator.xr;
  if (!xr) throw new Error("Ce navigateur n'expose pas WebXR.");

  let session: XRSession;
  try {
    session = await xr.requestSession('immersive-ar', { requiredFeatures: ['plane-detection'] });
  } catch (err) {
    throw new Error(describeSessionError(err));
  }

  const gl = createXrContext();
  if (gl) {
    await gl.makeXRCompatible().catch(() => {});
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  }

  try {
    await recapture(session);
  } finally {
    await session.end().catch(() => {});
  }
}

/** `local-floor` place l'origine au sol, ce qui evite d'avoir a estimer sa hauteur. */
async function requestFloorSpace(session: XRSession): Promise<XRReferenceSpace> {
  try {
    return await session.requestReferenceSpace('local-floor');
  } catch {
    return await session.requestReferenceSpace('local');
  }
}

function createXrContext(): WebGL2RenderingContext | WebGLRenderingContext | null {
  const canvas = document.createElement('canvas');
  return (
    canvas.getContext('webgl2', { xrCompatible: true }) ??
    canvas.getContext('webgl', { xrCompatible: true })
  );
}

function describeSessionError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof DOMException && err.name === 'NotSupportedError') {
    return "Ce casque n'expose pas la détection de surfaces (plane-detection).";
  }
  if (err instanceof DOMException && err.name === 'SecurityError') {
    return 'WebXR exige une page servie en HTTPS.';
  }
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return "Accès à l'espace refusé.";
  }
  return `Session refusée : ${message}`;
}
