/**
 * Depot de plans partage entre les appareils.
 *
 * Le casque et le PC chargent deja la page depuis le meme serveur : il suffit de
 * lui ajouter quelques routes pour que le plan releve dans le casque soit
 * retrouve sur le PC. Un fichier JSON par plan, pas de base de donnees — la
 * volumetrie d'un usage personnel ne justifie rien de plus.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const PREFIX = '/api/scenes';
/** Une scene avec photo de fond embarquee en data URL pese quelques Mo. */
const MAX_BODY = 48 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface SceneRecord {
  id: string;
  name: string;
  savedAt: string;
  origin: string;
  scene: unknown;
}

export interface SceneSummary {
  id: string;
  name: string;
  savedAt: string;
  origin: string;
  bytes: number;
}

/** Middleware brut, expose pour pouvoir tester les routes sans lancer Vite. */
export function scenesMiddleware(dir: string) {
  return createMiddleware(new SceneStore(dir));
}

export function scenesApi(dir: string): Plugin {
  const middleware = scenesMiddleware(dir);
  return {
    name: 'sdb:scenes-api',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

function createMiddleware(store: SceneStore) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = req.url ?? '';
    if (!url.startsWith(PREFIX)) return next();
    void handle(store, req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error('[scenes]', err);
      send(res, status, { error: err instanceof Error ? err.message : 'Erreur serveur' });
    });
  };
}

async function handle(store: SceneStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const rest = url.pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, '');
  const method = req.method ?? 'GET';

  if (!rest) {
    if (method === 'GET') return send(res, 200, await store.list());
    if (method === 'POST') {
      const body = await readJson(req);
      return send(res, 201, await store.save(body, originOf(req)));
    }
    throw new HttpError(405, 'Méthode non gérée');
  }

  const id = decodeURIComponent(rest);
  if (!ID_PATTERN.test(id)) throw new HttpError(400, 'Identifiant invalide');

  if (method === 'GET') return send(res, 200, await store.read(id));
  if (method === 'PUT') {
    const body = await readJson(req);
    return send(res, 200, await store.save(body, originOf(req), id));
  }
  if (method === 'DELETE') {
    await store.remove(id);
    return send(res, 200, { id, deleted: true });
  }
  throw new HttpError(405, 'Méthode non gérée');
}

class SceneStore {
  // Champ explicite plutot qu'une propriete de constructeur : le mode
  // `--experimental-strip-types` de Node, utilise par les tests, ne la supporte pas.
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async list(): Promise<SceneSummary[]> {
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.json'));
    const out: SceneSummary[] = [];
    for (const file of files) {
      const full = path.join(this.dir, file);
      try {
        const [info, record] = await Promise.all([
          stat(full),
          readFile(full, 'utf8').then((raw) => JSON.parse(raw) as SceneRecord),
        ]);
        out.push({
          id: record.id,
          name: record.name,
          savedAt: record.savedAt,
          origin: record.origin,
          bytes: info.size,
        });
      } catch {
        // Fichier illisible ou a moitie ecrit : il ne doit pas casser la liste.
      }
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async read(id: string): Promise<SceneRecord> {
    try {
      return JSON.parse(await readFile(this.file(id), 'utf8')) as SceneRecord;
    } catch {
      throw new HttpError(404, 'Plan introuvable');
    }
  }

  async save(body: unknown, origin: string, forcedId?: string): Promise<SceneRecord> {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Corps de requête invalide');
    const input = body as { id?: unknown; name?: unknown; scene?: unknown };
    if (!input.scene || typeof input.scene !== 'object') {
      throw new HttpError(400, 'Champ `scene` manquant');
    }

    const requested = forcedId ?? (typeof input.id === 'string' ? input.id : undefined);
    const id = requested && ID_PATTERN.test(requested) ? requested : freshId();
    const record: SceneRecord = {
      id,
      name: typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 120) : 'Plan sans nom',
      savedAt: new Date().toISOString(),
      origin,
      scene: input.scene,
    };

    await mkdir(this.dir, { recursive: true });
    // Ecriture puis renommage : une lecture concurrente ne voit jamais un
    // fichier tronque.
    const tmp = `${this.file(id)}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(record), 'utf8');
    await rename(tmp, this.file(id));
    return record;
  }

  async remove(id: string): Promise<void> {
    try {
      await unlink(this.file(id));
    } catch {
      throw new HttpError(404, 'Plan introuvable');
    }
  }
}

/** Identifiant lisible et triable : `2026-09-02-1432-a1b2`. */
function freshId(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `${stamp}-${randomUUID().slice(0, 4)}`;
}

/** Distingue les envois du casque de ceux du PC, sans rien identifier de personnel. */
function originOf(req: IncomingMessage): string {
  const ua = String(req.headers['user-agent'] ?? '');
  if (/OculusBrowser|Quest/i.test(ua)) return 'quest';
  if (/Mobile|Android|iPhone/i.test(ua)) return 'mobile';
  if (!ua) return 'inconnu';
  return `pc-${createHash('sha1').update(ua).digest('hex').slice(0, 4)}`;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Plan trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'JSON illisible'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(payload);
}
