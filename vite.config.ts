import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { scenesApi } from './server/scenes.ts';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * WebXR n'est accessible qu'en contexte sécurisé : depuis le casque, l'app doit
 * être servie en HTTPS. Le certificat est optionnel — `npm run cert` le crée,
 * et sans lui le serveur reste en HTTP pour le développement sur PC.
 */
function devCertificate(): { key: Buffer; cert: Buffer } | undefined {
  const key = path.join(root, 'certs', 'dev-key.pem');
  const cert = path.join(root, 'certs', 'dev-cert.pem');
  if (!existsSync(key) || !existsSync(cert)) return undefined;
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

// La configuration locale — port, domaines autorises — vit dans `.env`, absent du
// depot. Voir `.env.example`.
const env = { ...loadEnv('development', root, 'SDB_'), ...process.env };
const port = Number(env.SDB_PORT) || 5173;
const https = devCertificate();

/**
 * Vite refuse les requetes dont l'en-tete Host lui est inconnu. Un tunnel expose
 * l'app sous un nom de domaine tire au hasard : il faut donc l'autoriser, sinon
 * le casque ne recoit qu'une page d'erreur.
 */
const allowedHosts = [
  '.trycloudflare.com',
  '.ngrok-free.app',
  '.ngrok.io',
  '.loca.lt',
  ...(env.SDB_ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean) ?? []),
];

export default defineConfig({
  plugins: [scenesApi(path.join(root, 'data'))],
  server: { port, host: true, https, allowedHosts },
  preview: { port: port + 1, host: true, https, allowedHosts },
  build: { target: 'es2022' },
});
