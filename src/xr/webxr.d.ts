/**
 * Declarations WebXR minimales.
 *
 * La lib DOM de TypeScript ne couvre pas WebXR, et le module de detection de
 * plans n'est pas dans @types/webxr non plus. On declare donc ici le strict
 * necessaire, plutot que d'ajouter une dependance au projet.
 * Reference : https://immersive-web.github.io/plane-detection/
 */

interface XRRigidTransform {
  /** Matrice 4x4 en colonnes majeures. */
  readonly matrix: Float32Array;
}

interface XRPose {
  readonly transform: XRRigidTransform;
}

interface XRSpace {}
interface XRReferenceSpace extends XRSpace {}

interface XRPlane {
  readonly planeSpace: XRSpace;
  /** Contour ferme, exprime dans `planeSpace`. */
  readonly polygon: ReadonlyArray<DOMPointReadOnly>;
  readonly orientation?: 'horizontal' | 'vertical';
  /** Etiquette du registre semantique ('floor', 'wall', 'door', 'table'…). */
  readonly semanticLabel?: string;
}

interface XRFrame {
  readonly session: XRSession;
  /** Absent tant que la permission n'est pas accordee ou que rien n'est detecte. */
  readonly detectedPlanes?: ReadonlySet<XRPlane>;
  getPose(space: XRSpace, baseSpace: XRSpace): XRPose | null | undefined;
  /** Position et orientation du casque : indique dans quelle piece on se tient. */
  getViewerPose(referenceSpace: XRReferenceSpace): XRPose | null | undefined;
}

declare class XRWebGLLayer {
  constructor(session: XRSession, context: WebGLRenderingContext | WebGL2RenderingContext);
}

interface XRSession extends EventTarget {
  readonly enabledFeatures?: ReadonlyArray<string>;
  requestReferenceSpace(type: string): Promise<XRReferenceSpace>;
  requestAnimationFrame(callback: (time: number, frame: XRFrame) => void): number;
  updateRenderState(state: { baseLayer?: XRWebGLLayer }): void;
  end(): Promise<void>;
  /** Lance la configuration de la piece depuis la page (Meta Quest). */
  initiateRoomCapture?(): Promise<void>;
}

interface XRSessionInit {
  requiredFeatures?: string[];
  optionalFeatures?: string[];
  domOverlay?: { root: Element };
}

interface XRSystem {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(mode: string, init?: XRSessionInit): Promise<XRSession>;
}

interface Navigator {
  readonly xr?: XRSystem;
}

interface WebGLContextAttributes {
  xrCompatible?: boolean;
}

interface WebGLRenderingContext {
  makeXRCompatible(): Promise<void>;
}

interface WebGL2RenderingContext {
  makeXRCompatible(): Promise<void>;
}
