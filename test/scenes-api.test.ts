import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scenesMiddleware } from '../server/scenes.ts';

/** Depot isole, servi par un vrai serveur HTTP le temps du test. */
async function withApi(fn: (base: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sdb-scenes-'));
  const middleware = scenesMiddleware(dir);
  const server = createServer((req, res) => {
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end('non gere');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/api/scenes`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

const post = (base: string, body: unknown, init: RequestInit = {}) =>
  fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });

test('un plan envoye est relu a l’identique', async () => {
  await withApi(async (base) => {
    const scene = { version: 1, name: 'Salle de bain', room: { points: [{ x: 1, y: 2 }], doors: [0] } };
    const created = (await (await post(base, { name: 'Relevé', scene })).json()) as { id: string };
    assert.match(created.id, /^\d{4}-\d{2}-\d{2}-\d{4}-[0-9a-f]{4}$/);

    const read = (await (await fetch(`${base}/${created.id}`)).json()) as { name: string; scene: unknown };
    assert.equal(read.name, 'Relevé');
    assert.deepEqual(read.scene, scene);
  });
});

test('la liste est triee du plus recent au plus ancien', async () => {
  await withApi(async (base) => {
    await post(base, { name: 'A', scene: {} });
    await post(base, { name: 'B', scene: {} });
    const list = (await (await fetch(base)).json()) as { name: string; savedAt: string; bytes: number }[];
    assert.equal(list.length, 2);
    assert.ok(list[0].savedAt >= list[1].savedAt);
    assert.ok(list.every((s) => s.bytes > 0));
  });
});

test('PUT remplace le plan sans en creer un second', async () => {
  await withApi(async (base) => {
    const created = (await (await post(base, { name: 'A', scene: { v: 1 } })).json()) as { id: string };
    await fetch(`${base}/${created.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A bis', scene: { v: 2 } }),
    });
    const list = (await (await fetch(base)).json()) as unknown[];
    assert.equal(list.length, 1);
    const read = (await (await fetch(`${base}/${created.id}`)).json()) as { name: string; scene: { v: number } };
    assert.equal(read.name, 'A bis');
    assert.equal(read.scene.v, 2);
  });
});

test('le releve du casque est marque comme venant du Quest', async () => {
  await withApi(async (base) => {
    const res = await post(base, { name: 'Relevé', scene: {} }, {
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) OculusBrowser/34.0 Quest 3',
      },
    });
    const record = (await res.json()) as { origin: string };
    assert.equal(record.origin, 'quest');
  });
});

test('DELETE retire le plan, et le relire echoue', async () => {
  await withApi(async (base) => {
    const created = (await (await post(base, { name: 'A', scene: {} })).json()) as { id: string };
    assert.equal((await fetch(`${base}/${created.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${base}/${created.id}`)).status, 404);
    assert.equal((await fetch(`${base}/${created.id}`, { method: 'DELETE' })).status, 404);
  });
});

test('les entrees invalides sont refusees', async () => {
  await withApi(async (base) => {
    // Champ `scene` absent.
    assert.equal((await post(base, { name: 'A' })).status, 400);
    // Corps illisible.
    assert.equal(
      (await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })).status,
      400,
    );
    // Identifiant hors motif : aucune remontee de chemin possible.
    assert.equal((await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`)).status, 400);
    assert.equal((await fetch(`${base}/Majuscules`)).status, 400);
  });
});
