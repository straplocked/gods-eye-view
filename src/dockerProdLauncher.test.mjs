import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { admitKeySetupRequest } from './keySetupCore.mjs';
import {
  DATA_SUBDIRS,
  inspectKeysFile,
  prepareDataDir,
  resolveProductionTrustPolicy,
} from '../scripts/docker-prod-start.mjs';

const read = (relative) =>
  readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

/** A reverse proxy on the LAN, and a visitor's Host as the proxy forwards it. */
const PROXY_PEER = '192.168.1.12';
const PUBLIC_HOST = 'godseye.pluginsynthesis.com';

test('the production launcher trusts no key-setup peer, whatever the environment says', () => {
  assert.deepEqual(resolveProductionTrustPolicy({ env: {} }), {
    trustedPeers: '',
    warning: null,
  });
  assert.deepEqual(
    resolveProductionTrustPolicy({
      env: { GEV_KEY_SETUP_TRUSTED_PEERS: 'none' },
    }),
    {
      trustedPeers: '',
      warning: null,
    },
  );
  assert.equal(
    resolveProductionTrustPolicy({ env: { GEV_KEY_SETUP_TRUSTED_PEERS: '  ' } })
      .warning,
    null,
  );
  const ignored = resolveProductionTrustPolicy({
    env: { GEV_KEY_SETUP_TRUSTED_PEERS: PROXY_PEER },
  });
  assert.equal(
    ignored.trustedPeers,
    '',
    'an operator-supplied proxy address is NOT honored',
  );
  assert.match(
    ignored.warning,
    /Ignoring GEV_KEY_SETUP_TRUSTED_PEERS=192\.168\.1\.12/,
  );
  assert.match(ignored.warning, /proxy/);
});

test('with the production policy a proxy peer is refused by the real key-setup gate', () => {
  const { trustedPeers } = resolveProductionTrustPolicy({
    env: { GEV_KEY_SETUP_TRUSTED_PEERS: PROXY_PEER },
  });
  const request = {
    method: 'GET',
    remoteAddress: PROXY_PEER,
    hostHeader: PUBLIC_HOST,
    proxyHeaders: {},
    env: { GEV_KEY_SETUP_TRUSTED_PEERS: trustedPeers },
  };
  assert.equal(
    admitKeySetupRequest(request).ok,
    false,
    'the proxy address is not loopback and not trusted',
  );
  assert.equal(admitKeySetupRequest(request).code, 'not-loopback');
  // The control: the same request IS admitted when that address is trusted, so
  // the refusal above comes from the policy and not from some other check.
  const admitted = admitKeySetupRequest({
    ...request,
    hostHeader: 'localhost:4173',
    env: { GEV_KEY_SETUP_TRUSTED_PEERS: PROXY_PEER },
  });
  assert.equal(
    admitted.ok,
    true,
    'trusting the proxy peer would expose key setup',
  );
  // Loopback from inside the container stays the only way in.
  assert.equal(
    admitKeySetupRequest({
      ...request,
      remoteAddress: '127.0.0.1',
      hostHeader: 'localhost:4173',
    }).ok,
    true,
  );
});

test('the keys file is described without being read, and a broken one is not silently skipped', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-prod-keys-'));
  try {
    assert.equal(inspectKeysFile(dir).state, 'absent');
    assert.match(inspectKeysFile(dir).message, /keyless feeds only/);
    const file = path.join(dir, '.env');
    writeFileSync(file, 'FIRMS_MAP_KEY=sentinel-value\n', { mode: 0o600 });
    const ok = inspectKeysFile(dir);
    assert.equal(ok.state, 'ok');
    assert.doesNotMatch(ok.message, /sentinel-value/, 'never echoes a value');
    if (process.getuid?.() !== 0) {
      chmodSync(file, 0o000);
      const unreadable = inspectKeysFile(dir);
      assert.equal(unreadable.state, 'unreadable');
      assert.match(unreadable.message, /chown 99:100/);
      chmodSync(file, 0o600);
    }
    rmSync(file);
    mkdirSync(file);
    assert.equal(
      inspectKeysFile(dir).state,
      'not-a-file',
      'a directory named .env is not a keys file',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the data volume gets its cache and log directories, and an unwritable one is reported', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-prod-data-'));
  try {
    assert.deepEqual(prepareDataDir(dir), { ok: true, message: null });
    for (const name of ['.gev-cache', '.gev-logs']) {
      assert.ok(DATA_SUBDIRS.includes(name));
      writeFileSync(path.join(dir, name, 'probe'), 'x');
    }
    const blocked = path.join(dir, 'a-file');
    writeFileSync(blocked, '');
    const result = prepareDataDir(blocked);
    assert.equal(result.ok, false);
    assert.match(result.message, /not writable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the production image is self-contained, secret-free and keeps state in one volume', () => {
  const dockerfile = read('deploy/Dockerfile');
  assert.match(
    dockerfile,
    /^CMD \["node", "scripts\/docker-prod-start\.mjs"\]$/m,
  );
  assert.match(
    dockerfile,
    /^RUN [^\n]*\\\n\s+npm run build$/m,
    'the image serves a built bundle',
  );
  assert.match(dockerfile, /^VOLUME \["\/data"\]$/m);
  for (const name of ['.env', '.gev-cache', '.gev-logs']) {
    assert.match(
      dockerfile,
      new RegExp(
        `ln -sf?n? /data/${name.replace('.', '\\.')} /app/${name.replace('.', '\\.')}`,
      ),
      `${name} is linked into the data volume`,
    );
  }
  assert.match(
    dockerfile,
    /^ENV GEV_KEY_SETUP_TRUSTED_PEERS=none$/m,
    'no peer is trusted by default',
  );
  assert.match(dockerfile, /^USER node$/m, 'never runs as root');
  assert.doesNotMatch(
    dockerfile,
    /^ARG /m,
    'build args are recorded in image history',
  );
  assert.doesNotMatch(
    dockerfile,
    /COPY[^\n]*\.env/,
    'no key file is copied in',
  );
  assert.doesNotMatch(
    dockerfile,
    /^ENV (?!GEV_KEY_SETUP_TRUSTED_PEERS)[A-Z_]*(KEY|TOKEN|SECRET)[A-Z_]*=\S/m,
    'no credential in ENV',
  );
  assert.match(
    dockerfile,
    /--mount=type=secret,id=dotenv,target=\/app\/\.env,required=false,uid=1000,mode=0400/,
  );
  assert.doesNotMatch(
    dockerfile,
    /^(ENV|ARG) GEV_ALLOWED_HOSTS/m,
    'the allowed host is deployment config, not baked in',
  );
});

test('the development image and compose file keep their own contract', () => {
  assert.match(
    read('Dockerfile'),
    /^CMD \["node", "scripts\/docker-start\.mjs"\]$/m,
  );
  assert.doesNotMatch(read('compose.yaml'), /deploy\/Dockerfile/);
});

test('the Unraid template runs the published image without secrets', () => {
  const xml = read('deploy/unraid/gods-eye-view.xml');
  assert.match(
    xml,
    /<Repository>ghcr\.io\/straplocked\/gods-eye-view:latest<\/Repository>/,
  );
  assert.match(xml, /<Network>bridge<\/Network>/);
  assert.match(xml, /<WebUI>http:\/\/\[IP\]:\[PORT:4173\]\/<\/WebUI>/);
  assert.match(
    xml,
    /Target="4173" Default="3650" Mode="tcp"[^>]*Type="Port"[^>]*>3650</,
  );
  assert.match(
    xml,
    /Target="\/data" Default="\/mnt\/user\/appdata\/gods-eye-view" Mode="rw"[^>]*Type="Path"[^>]*>\/mnt\/user\/appdata\/gods-eye-view</,
  );
  assert.match(
    xml,
    /Target="GEV_ALLOWED_HOSTS" Default="godseye\.pluginsynthesis\.com"[^>]*Type="Variable"/,
  );
  assert.match(xml, /<ExtraParams>--user 99:100 /);
  const configs = [...xml.matchAll(/<Config\b([^>]*)>([^<]*)<\/Config>/g)];
  assert.equal(configs.length, 3, 'port, appdata and allowed hosts only');
  for (const [, attributes] of configs) {
    assert.doesNotMatch(
      attributes,
      /Target="[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)/,
      'no credential variable',
    );
    assert.doesNotMatch(
      attributes,
      /Mask="true"/,
      'nothing secret is collected here',
    );
  }
  assert.doesNotMatch(
    xml,
    /GEV_KEY_SETUP_TRUSTED_PEERS/,
    'the template cannot trust a proxy peer',
  );
});

test('the publish workflow pushes to GHCR with pinned actions and least privilege', () => {
  const workflow = read('.github/workflows/publish.yml');
  assert.match(
    workflow,
    /^on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:$/m,
  );
  assert.match(
    workflow,
    /^permissions:\n {2}contents: read$/m,
    'read-only by default',
  );
  assert.match(
    workflow,
    /^ {4}permissions:\n {6}contents: read\n {6}packages: write$/m,
    'only the job can write packages',
  );
  assert.match(workflow, /password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.doesNotMatch(
    workflow,
    /secrets\.(?!GITHUB_TOKEN)/,
    'no other secret is referenced',
  );
  assert.match(workflow, /ghcr\.io\/straplocked\/gods-eye-view/);
  assert.match(workflow, /\$\{\{ env\.IMAGE \}\}:latest/);
  assert.match(
    workflow,
    /\$\{\{ env\.IMAGE \}\}:sha-\$\{\{ steps\.tags\.outputs\.short \}\}/,
  );
  assert.match(workflow, /platforms: linux\/amd64/);
  assert.match(workflow, /file: deploy\/Dockerfile/);
  assert.match(workflow, /cache-from: type=gha/);
  assert.match(workflow, /cache-to: type=gha/);
  assert.doesNotMatch(
    workflow,
    /build-args/,
    'nothing is baked into the published image',
  );
  const uses = [...workflow.matchAll(/^\s+uses: (\S+)/gm)].map(
    (match) => match[1],
  );
  assert.ok(uses.length >= 4);
  for (const reference of uses) {
    assert.match(
      reference,
      /@[0-9a-f]{40}$/,
      `${reference} is pinned to a full commit SHA`,
    );
  }
  assert.doesNotMatch(
    read('.github/workflows/ci.yml'),
    /ghcr\.io|packages: write/,
    'CI never publishes',
  );
});

test('the deploy guide states the proxy trust trap and the access-list gate', () => {
  const guide = read('docs/DEPLOY-UNRAID.md');
  assert.match(guide, /GEV_KEY_SETUP_TRUSTED_PEERS/);
  assert.match(guide, /Access List/);
  assert.match(guide, /GEV_ALLOWED_HOSTS/);
  assert.match(guide, /\/mnt\/user\/appdata\/gods-eye-view/);
  assert.doesNotMatch(
    guide,
    /(?:api[_-]?key|token|secret)\s*[:=]\s*[A-Za-z0-9]{16,}/i,
    'no credential in the guide',
  );
});
