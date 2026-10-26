#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_SITE_BYTES = 262144;
export const ERASER_UPSTREAM = `# BEGIN MAXIM LASTIK UPSTREAM v1
upstream major_eraser_webhook {
  server 127.0.0.1:3005;
  keepalive 16;
}
# END MAXIM LASTIK UPSTREAM v1

`;
export const ERASER_LOCATIONS = `  # BEGIN MAXIM LASTIK ROUTES v1
  # FLAG: Only the authenticated MAX webhook is public. Control APIs stay private.
  location = /eraser/webhook {
    limit_except POST { deny all; }
    client_max_body_size 2m;
    proxy_pass http://major_eraser_webhook/webhook;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_connect_timeout 3s;
    proxy_read_timeout 10s;
    proxy_send_timeout 10s;
  }
  location = /eraser { return 404; }
  location ^~ /eraser/ { return 404; }
  # END MAXIM LASTIK ROUTES v1

`;

function parse(raw) {
  const root = { children: [] },
    stack = [root];
  const nodes = [];
  let words = [];
  for (let at = 0; at < raw.length; ) {
    const ch = raw[at];
    if (/\s/u.test(ch)) {
      at++;
      continue;
    }
    if (ch === '#') {
      const end = raw.indexOf('\n', at);
      at = end < 0 ? raw.length : end + 1;
      continue;
    }
    if (ch === ';' || ch === '{') {
      if (!words.length) throw new Error('Malformed nginx directive.');
      const node = {
        words,
        start: words[0].start,
        end: at + 1,
        children: ch === '{' ? [] : null,
        parent: stack.at(-1),
      };
      stack.at(-1).children.push(node);
      nodes.push(node);
      words = [];
      if (ch === '{') {
        if (stack.length >= 64) throw new Error('Nginx nesting exceeds the patch budget.');
        stack.push(node);
      }
      at++;
      continue;
    }
    if (ch === '}') {
      if (words.length || stack.length === 1) throw new Error('Unbalanced nginx block.');
      stack.pop().end = ++at;
      continue;
    }
    const start = at;
    if (ch === '"' || ch === "'") {
      const quote = ch;
      at++;
      while (at < raw.length && raw[at] !== quote) {
        if (raw[at] === '\\') at++;
        at++;
      }
      if (at >= raw.length) throw new Error('Unterminated nginx quoted token.');
      at++;
    } else {
      while (at < raw.length && !/[\s;{}#]/u.test(raw[at])) {
        if (raw[at] === '\\') at++;
        at++;
      }
    }
    words.push({ value: raw.slice(start, at), start });
  }
  if (stack.length !== 1 || words.length) throw new Error('Incomplete nginx configuration.');
  return { root, nodes };
}
const values = (node) => node.words.map((word) => word.value);
const lineStart = (raw, node, indent) => {
  const start = raw.lastIndexOf('\n', node.start - 1) + 1;
  if (raw.slice(start, node.start) !== indent) throw new Error('Unknown nginx insertion anchor.');
  return start;
};
function insert(raw) {
  const { root, nodes } = parse(raw);
  for (const node of nodes) {
    const words = values(node);
    if (
      words.some((word) => word.includes('major_eraser_webhook')) ||
      (words[0] === 'location' && words.slice(1).some((word) => /eraser/iu.test(word)))
    )
      throw new Error('Conflicting or unowned Lastik nginx configuration.');
    if (node.children && words[0] === 'server' && node.parent !== root)
      throw new Error('Nested server blocks are not a supported site fragment.');
  }
  const upstreams = root.children.filter(
    (node) =>
      node.children && values(node).join(' ') === 'upstream major_maxim_api_webhook_ingress',
  );
  if (upstreams.length !== 1) throw new Error('Expected one existing webhook upstream anchor.');
  const candidates = [];
  for (const server of root.children.filter(
    (node) => node.children && values(node).join(' ') === 'server',
  )) {
    const names = server.children.filter(
      (node) => !node.children && values(node)[0] === 'server_name',
    );
    if (names.length !== 1) throw new Error('Missing or duplicate nginx server_name.');
    const hosts = values(names[0]).slice(1);
    if (!hosts.length || new Set(hosts).size !== hosts.length)
      throw new Error('Malformed or repeated nginx server names.');
    if (!hosts.includes('major-maksimov.ru')) continue;
    const listens = server.children
      .filter((node) => !node.children && values(node)[0] === 'listen')
      .map(values);
    const port443 = (words) => /^(?:443|[^\s]+:443)$/u.test(words[1] ?? '');
    if (listens.some((words) => port443(words) || words.includes('ssl'))) {
      if (
        hosts.length !== 1 ||
        !listens.length ||
        listens.some((words) => !port443(words) || !words.includes('ssl'))
      )
        throw new Error('Ambiguous canonical HTTPS server.');
      candidates.push(server);
    }
  }
  if (candidates.length !== 1) throw new Error('Expected one canonical HTTPS server.');
  const anchors = candidates[0].children.filter(
    (node) => node.children && values(node).join(' ') === 'location = /robots.txt',
  );
  if (anchors.length !== 1) throw new Error('Expected one canonical robots location anchor.');
  const insertions = [
    [lineStart(raw, upstreams[0], ''), ERASER_UPSTREAM],
    [lineStart(raw, anchors[0], '  '), ERASER_LOCATIONS],
  ].sort((a, b) => b[0] - a[0]);
  let output = raw;
  for (const [at, addition] of insertions)
    output = output.slice(0, at) + addition + output.slice(at);
  return output;
}
export function renderEraserNginx(raw) {
  if (
    typeof raw !== 'string' ||
    !raw ||
    raw.includes('\0') ||
    Buffer.byteLength(raw) > MAX_SITE_BYTES
  )
    throw new Error('Expected a bounded UTF-8 nginx site.');
  const count = (part) => raw.split(part).length - 1;
  const upstreams = count(ERASER_UPSTREAM),
    locations = count(ERASER_LOCATIONS);
  if (upstreams || locations || /MAXIM LASTIK (?:UPSTREAM|ROUTES)/u.test(raw)) {
    if (upstreams !== 1 || locations !== 1)
      throw new Error('Partial or modified Lastik nginx blocks.');
    const original = raw.replace(ERASER_UPSTREAM, '').replace(ERASER_LOCATIONS, '');
    if (insert(original) !== raw)
      throw new Error('Lastik nginx blocks are not at their exact owned anchors.');
    return raw;
  }
  return insert(raw);
}

function identity(stat) {
  return Object.fromEntries(
    ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map((key) => [
      key,
      String(stat[key]),
    ]),
  );
}
function readBounded(path, limit = MAX_SITE_BYTES) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(limit))
      throw new Error('Expected a bounded regular file with one hard link.');
    const bytes = Buffer.alloc(limit + 1);
    let size = 0,
      read;
    while (size < bytes.length && (read = readSync(fd, bytes, size, bytes.length - size, null)))
      size += read;
    const after = fstatSync(fd, { bigint: true });
    if (
      size > limit ||
      BigInt(size) !== before.size ||
      JSON.stringify(identity(before)) !== JSON.stringify(identity(after))
    )
      throw new Error('File changed while being read.');
    return { bytes: bytes.subarray(0, size), stat: before };
  } finally {
    closeSync(fd);
  }
}
export function snapshotSite(config, enabled) {
  if (resolve(config) !== config || realpathSync(config) !== config)
    throw new Error('Canonical nginx path must not traverse symlinks.');
  const link = lstatSync(enabled, { bigint: true });
  if (!link.isSymbolicLink() || realpathSync(enabled) !== config)
    throw new Error('Enabled nginx symlink does not select the canonical site.');
  const target = readlinkSync(enabled);
  const { bytes, stat } = readBounded(config);
  if ((Number(stat.mode) & 0o022) !== 0)
    throw new Error('Canonical nginx file is writable by other users.');
  const afterLink = lstatSync(enabled, { bigint: true });
  if (
    JSON.stringify(identity(link)) !== JSON.stringify(identity(afterLink)) ||
    readlinkSync(enabled) !== target ||
    JSON.stringify(identity(stat)) !== JSON.stringify(identity(lstatSync(config, { bigint: true })))
  )
    throw new Error('Canonical nginx file or enabled symlink changed while being read.');
  return {
    config: identity(stat),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    enabled: identity(link),
    target,
  };
}
function verify(config, enabled, expected) {
  const actual = snapshotSite(config, enabled);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Live nginx configuration or symlink changed; refusing replacement.');
  return actual;
}
function jsonFile(path) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readBounded(path).bytes));
}
function swap(config, enabled, expected, candidate) {
  const current = verify(config, enabled, expected);
  const { bytes } = readBounded(candidate);
  const temporary = `${config}.lastik-${randomUUID()}`;
  let renamed = false;
  try {
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      Number(current.config.mode) & 0o777,
    );
    try {
      writeFileSync(fd, bytes);
      fchownSync(fd, Number(current.config.uid), Number(current.config.gid));
      fchmodSync(fd, Number(current.config.mode) & 0o777);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // FLAG: The shared lock excludes supported writers; reject any observed external drift too.
    verify(config, enabled, expected);
    renameSync(temporary, config);
    renamed = true;
    const directory = openSync(dirname(config), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    return snapshotSite(config, enabled);
  } finally {
    if (!renamed) rmSync(temporary, { force: true });
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'snapshot' && args.length === 3) {
      writeFileSync(args[2], JSON.stringify(snapshotSite(args[0], args[1])), {
        flag: 'wx',
        mode: 0o600,
        flush: true,
      });
    } else if (command === 'render' && args.length === 2) {
      const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        readBounded(args[0]).bytes,
      );
      writeFileSync(args[1], renderEraserNginx(raw), { flag: 'wx', mode: 0o600, flush: true });
    } else if (command === 'verify' && args.length === 3) {
      verify(args[0], args[1], jsonFile(args[2]));
    } else if (command === 'swap' && args.length === 4) {
      process.stdout.write(
        `${JSON.stringify(swap(args[0], args[1], jsonFile(args[2]), args[3]))}\n`,
      );
    } else if (command === 'health' && args.length === 2) {
      const health = jsonFile(args[0]);
      const { validateCompleteReleaseManifest } = await import('./release-manifest.mjs');
      const manifest = validateCompleteReleaseManifest(jsonFile(args[1]));
      const componentSha = manifest.components?.eraser?.sourceSha;
      if (
        health.status !== 'ok' ||
        health.service !== 'eraser' ||
        health.enabled !== true ||
        health.schedulerHealthy !== true ||
        !/^[a-f0-9]{40}$/u.test(componentSha ?? '') ||
        health.commitSha !== componentSha
      )
        throw new Error('Active Lastik availability is not confirmed.');
    } else if (command === 'forbidden' && args.length === 1) {
      if (jsonFile(args[0]).code !== 'FORBIDDEN')
        throw new Error('Lastik secret rejection is not confirmed.');
    } else throw new Error('Invalid Lastik nginx helper operation.');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
