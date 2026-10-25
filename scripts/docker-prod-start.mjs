#!/usr/bin/env node
/**
 * Production container launcher (deploy/Dockerfile entry point).
 *
 * Serves the BUILT application with `vite preview`. Every API provider mounts
 * in `configurePreviewServer` as well as `configureServer`, so the preview
 * server is the whole app minus the development-only surfaces:
 *
 *   - Provider Settings (`/api/setup/*`) is never mounted under preview, so the
 *     keys are read from the `.env` in the data volume, not written by a browser.
 *   - There is no HMR or other websocket path, so a reverse proxy needs no
 *     "Websockets Support".
 *   - `/mcp` is loopback-only and refuses any proxied request.
 *
 * Persistent state lives in ONE directory, `/data` (see the symlinks in
 * deploy/Dockerfile): `.env`, `.gev-cache/` and `.gev-logs/`.
 *
 * Unlike scripts/docker-start.mjs this launcher NEVER trusts a peer for key
 * setup. Behind a reverse proxy every public request arrives from the proxy's
 * address, so trusting that address would hand Provider Settings to the whole
 * internet. Trust is pinned to none here, whatever the environment says.
 */
import {
  accessSync,
  constants,
  mkdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectInvocation } from './pinokio-install.mjs';
import { loadViteFromCanonicalRoot } from './pinokio-start.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const ROOT = realpathSync(path.resolve(path.dirname(MODULE_PATH), '..'));

/** Where deploy/Dockerfile links `.env`, `.gev-cache` and `.gev-logs` to. */
export const DATA_DIR = '/data';

/** Directories the app writes under the data volume. */
export const DATA_SUBDIRS = Object.freeze(['.gev-cache', '.gev-logs']);

/**
 * Decide the key-setup trust policy for a production launch. The answer is
 * always "no additional peers"; the only variable is whether to warn that an
 * operator-supplied list was ignored.
 * @param {{env?: NodeJS.ProcessEnv}} input
 * @returns {{trustedPeers: '', warning: string|null}} Value for
 *   GEV_KEY_SETUP_TRUSTED_PEERS (always '') and an optional warning.
 */
export function resolveProductionTrustPolicy({ env = process.env } = {}) {
  const requested = String(env.GEV_KEY_SETUP_TRUSTED_PEERS ?? '').trim();
  if (!requested || requested.toLowerCase() === 'none') {
    return { trustedPeers: '', warning: null };
  }
  return {
    trustedPeers: '',
    warning:
      `[Docker] Ignoring GEV_KEY_SETUP_TRUSTED_PEERS=${requested}: the production ` +
      'image trusts no key-setup peer, because behind a reverse proxy every ' +
      "visitor arrives from the proxy's address. Edit the .env in the data " +
      'volume to configure keys.',
  };
}

/**
 * Describe the keys file in the data volume without reading its contents.
 * `unreadable` and `not-a-file` are fatal at start: a keys file that exists but
 * cannot be loaded must not silently start the app keyless.
 * @param {string} dataDir
 * @returns {{state: 'absent'|'ok'|'unreadable'|'not-a-file', message: string}}
 */
export function inspectKeysFile(dataDir = DATA_DIR) {
  const file = path.join(dataDir, '.env');
  let info;
  try {
    info = statSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        state: 'absent',
        message:
          `[Docker] No ${file}: running with the keyless feeds only. Create it ` +
          'to add optional provider keys (see docs/DEPLOY-UNRAID.md).',
      };
    }
    return {
      state: 'unreadable',
      message: `${file} cannot be inspected (${error?.code || 'error'}).`,
    };
  }
  if (!info.isFile()) {
    return {
      state: 'not-a-file',
      message: `${file} is not a regular file.`,
    };
  }
  try {
    accessSync(file, constants.R_OK);
  } catch {
    return {
      state: 'unreadable',
      message:
        `${file} is owned by ${info.uid}:${info.gid} and the container user cannot ` +
        'read it. chown it to the container user (Unraid: chown 99:100) and keep mode 600.',
    };
  }
  return {
    state: 'ok',
    message: `[Docker] Loading provider keys from ${file}.`,
  };
}

/**
 * Create the writable runtime directories under the data volume. A volume the
 * container user cannot write is reported, not fatal: every cache is
 * best-effort, and a read-only volume with a readable `.env` still serves.
 * @param {string} dataDir
 * @returns {{ok: boolean, message: string|null}}
 */
export function prepareDataDir(dataDir = DATA_DIR) {
  try {
    for (const name of DATA_SUBDIRS) {
      mkdirSync(path.join(dataDir, name), { recursive: true });
    }
    accessSync(dataDir, constants.W_OK);
    return { ok: true, message: null };
  } catch (error) {
    const uid = process.getuid?.() ?? -1;
    const gid = process.getgid?.() ?? -1;
    return {
      ok: false,
      message:
        `[Docker] ${dataDir} is not writable by ${uid}:${gid} (${error?.code || 'error'}), ` +
        'so caches and logs will not persist. chown the mapped appdata folder to that user.',
    };
  }
}

async function start() {
  const policy = resolveProductionTrustPolicy();
  // Pinned before Vite loads: the config copies .env values only into UNSET
  // variables, so an empty string here cannot be overridden from the data volume.
  process.env.GEV_KEY_SETUP_TRUSTED_PEERS = policy.trustedPeers;
  if (policy.warning) console.warn(policy.warning);
  console.log(
    '[Docker] Key setup trusts no peer; Provider Settings is not served.',
  );

  const data = prepareDataDir();
  if (data.message) console.warn(data.message);
  const keys = inspectKeysFile();
  // Vite would crash on an unreadable .env anyway; refuse first, with the fix.
  if (keys.state === 'unreadable' || keys.state === 'not-a-file') {
    throw new Error(keys.message);
  }
  console.log(keys.message);

  try {
    statSync(path.join(ROOT, 'dist', 'index.html'));
  } catch {
    throw new Error(
      'dist/index.html is missing: this image was built without `npm run build`',
    );
  }

  const port = Number.parseInt(process.env.PORT, 10) || 4173;
  const { preview } = await loadViteFromCanonicalRoot(ROOT);
  const server = await preview({
    root: ROOT,
    // Load the config natively rather than bundling it to node_modules/.vite-temp,
    // so a non-root container user needs no writable application directory.
    configLoader: 'native',
    preview: { host: '0.0.0.0', port, strictPort: true },
  });
  server.printUrls();
  console.log(`[Docker] Ready on port ${port}.`);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.httpServer.close(() => process.exit(0));
      server.httpServer.closeAllConnections?.();
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

if (isDirectInvocation(process.argv[1], MODULE_PATH)) {
  start().catch((error) => {
    console.error(`[Docker] Start refused: ${error.message}`);
    process.exitCode = 1;
  });
}
