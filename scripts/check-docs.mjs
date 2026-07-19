import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const shellFencePattern = /```(?:bash|sh|shell)\s*\n([\s\S]*?)```/gu;
const bannedExecutablePattern = /(?:app2\.major-maksimov\.ru|s3:\/\/|\byc\s+storage\b|object[ -]?storage|cdn-cache)/iu;

function walkMarkdown(directory) {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) {
      return entry === 'archive' && path.includes(`${resolve(directory, 'operations')}`)
        ? []
        : walkMarkdown(path);
    }
    return path.endsWith('.md') ? [path] : [];
  });
}

export function findDocumentationViolations(root) {
  const violations = [];
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const scripts = new Set(Object.keys(packageJson.scripts ?? {}));
  const workspacePackages = new Map();

  for (const workspaceRoot of ['apps', 'packages']) {
    const directory = resolve(root, workspaceRoot);
    if (!existsSync(directory)) {
      continue;
    }
    for (const entry of readdirSync(directory)) {
      const workspacePackagePath = resolve(directory, entry, 'package.json');
      if (!existsSync(workspacePackagePath)) {
        continue;
      }
      const workspacePackage = JSON.parse(readFileSync(workspacePackagePath, 'utf8'));
      workspacePackages.set(workspacePackage.name, workspacePackage);
    }
  }

  const archiveRoot = `${resolve(root, 'docs/operations/archive')}/`;
  const markdownFiles = [resolve(root, 'README.md'), ...walkMarkdown(resolve(root, 'docs'))].filter(
    (path) => existsSync(path) && !`${path}/`.startsWith(archiveRoot),
  );
  for (const filePath of markdownFiles) {
    const repoPath = relative(root, filePath).split('\\').join('/');
    const contents = readFileSync(filePath, 'utf8');
    for (const match of contents.matchAll(shellFencePattern)) {
      const block = match[1];
      const startLine = contents.slice(0, match.index).split('\n').length + 1;
      const commands = block
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));

      for (const [offset, command] of commands.entries()) {
        const location = `${repoPath}:${startLine + offset}`;
        if (bannedExecutablePattern.test(command)) {
          violations.push(`${location} contains a dormant CDN/Object Storage command.`);
        }
        if (/(?:^|\s)docker-compose(?:\s|$)/u.test(command)) {
          violations.push(`${location} uses docker-compose; use docker compose.`);
        }
        if (/<[a-z][^>]*>/iu.test(command)) {
          violations.push(`${location} contains a non-executable angle-bracket placeholder.`);
        }

        for (const npmMatch of command.matchAll(/\bnpm\s+run\s+([a-z0-9:_-]+)/giu)) {
          const script = npmMatch[1];
          const workspaceMatch = command.match(/--workspace\s+([^\s'";]+)/u);
          if (workspaceMatch) {
            const workspace = workspacePackages.get(workspaceMatch[1]);
            if (!workspace) {
              violations.push(`${location} references unknown workspace ${workspaceMatch[1]}.`);
            } else if (typeof workspace.scripts?.[script] !== 'string') {
              violations.push(`${location} references missing ${workspaceMatch[1]} script ${script}.`);
            }
          } else if (!scripts.has(script)) {
            violations.push(`${location} references missing root npm script ${script}.`);
          }
        }

        const executableMatch = command.match(/(?:^|\s)(\.\/[a-zA-Z0-9_./-]+)/u);
        if (executableMatch && !existsSync(resolve(root, executableMatch[1]))) {
          violations.push(`${location} references missing executable ${executableMatch[1]}.`);
        }
      }
    }
  }

  const composeServices = new Set(
    execFileSync(
      'docker',
      ['compose', '-f', 'infra/docker-compose.yml', 'config', '--services'],
      { cwd: root, encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean),
  );
  for (const filePath of markdownFiles) {
    const repoPath = relative(root, filePath).split('\\').join('/');
    const contents = readFileSync(filePath, 'utf8');
    for (const match of contents.matchAll(/docker\s+compose[^\n]*(?:exec|run|logs|restart)\s+(?:--?\S+\s+)*([a-z0-9][a-z0-9-]*)/giu)) {
      if (!composeServices.has(match[1])) {
        const line = contents.slice(0, match.index).split('\n').length;
        violations.push(`${repoPath}:${line} references unknown Compose service ${match[1]}.`);
      }
    }
  }

  return [...new Set(violations)].sort();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(import.meta.dirname, '..');
  const violations = findDocumentationViolations(root);
  for (const violation of violations) {
    console.error(violation);
  }
  if (violations.length > 0) {
    process.exitCode = 1;
  }
}
