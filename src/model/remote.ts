/**
 * Client du depot de plans (`server/scenes.ts`).
 *
 * IndexedDB reste le cache local de l'appareil ; ce depot est ce qui permet a un
 * plan relevé dans le casque d'etre repris sur le PC. Toutes les fonctions
 * echouent proprement quand l'app est servie sans son serveur.
 */

import type { Scene } from './types.ts';
import { emptyScene } from './types.ts';

const BASE = '/api/scenes';

export interface SceneSummary {
  id: string;
  name: string;
  savedAt: string;
  /** 'quest', 'mobile' ou 'pc-xxxx' : d'ou l'envoi a ete fait. */
  origin: string;
  bytes: number;
}

export interface SceneRecord extends Omit<SceneSummary, 'bytes'> {
  scene: Scene;
}

export class RemoteError extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  } catch {
    throw new RemoteError('Serveur injoignable. L’app est-elle bien servie par `npm run dev` ?');
  }
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new RemoteError(body?.error ?? `Erreur ${res.status}`);
  return body as T;
}

export function listScenes(): Promise<SceneSummary[]> {
  return call<SceneSummary[]>(BASE);
}

export async function fetchScene(id: string): Promise<SceneRecord> {
  const record = await call<SceneRecord>(`${BASE}/${encodeURIComponent(id)}`);
  // Une scene ancienne peut manquer de champs ajoutes depuis.
  return { ...record, scene: { ...emptyScene(), ...record.scene, remoteId: record.id } };
}

/** Cree le plan, ou remplace celui d'`id` s'il est fourni. */
export function pushScene(scene: Scene, name: string, id?: string | null): Promise<SceneRecord> {
  const payload = JSON.stringify({ name, scene });
  return id
    ? call<SceneRecord>(`${BASE}/${encodeURIComponent(id)}`, { method: 'PUT', body: payload })
    : call<SceneRecord>(BASE, { method: 'POST', body: payload });
}

export function deleteScene(id: string): Promise<unknown> {
  return call(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Le depot repond-il ? Sert a masquer la section quand l'app tourne sans serveur. */
export async function isRemoteAvailable(): Promise<boolean> {
  try {
    await listScenes();
    return true;
  } catch {
    return false;
  }
}
