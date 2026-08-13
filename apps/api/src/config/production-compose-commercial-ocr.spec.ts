import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const COMPOSE_FILES = [
  ['main', '../../../../infra/docker-compose.yml'],
  ['scale', '../../../../infra/docker-compose.scale.yml'],
] as const;

describe('production Compose commercial OCR isolation', () => {
  describe.each(COMPOSE_FILES)('%s compose', (name, composePath) => {
    const compose = readFileSync(resolve(__dirname, composePath), 'utf8');
    const mediaAnalysis = readServiceBlock(compose, 'api-media-analysis');

    it('uses one fail-safe rollout, canary allowlist, and OCR version across API roles', () => {
      expect(mediaAnalysis).toContain('${MAXIM_COMPOSE_SERVICE_ENV_FILE:-../.env}');
      expect(mediaAnalysis).not.toMatch(/^\s+COMMERCIAL_OCR_ROLLOUT_MODE:/mu);
      expect(mediaAnalysis).not.toMatch(/^\s+COMMERCIAL_OCR_CANARY_CHAT_IDS:/mu);
      expect(mediaAnalysis).not.toMatch(/^\s+COMMERCIAL_OCR_VERSION:/mu);
      expect(compose).toMatch(
        /^ {2}COMMERCIAL_OCR_ROLLOUT_MODE: \$\{COMMERCIAL_OCR_ROLLOUT_MODE:-shadow\}$/mu,
      );
      expect(compose).toMatch(
        /^ {2}COMMERCIAL_OCR_CANARY_CHAT_IDS: \$\{COMMERCIAL_OCR_CANARY_CHAT_IDS:-\}$/mu,
      );
      expect(compose).toMatch(
        /^ {2}COMMERCIAL_OCR_VERSION: \$\{COMMERCIAL_OCR_VERSION:-tesseract-rus-eng-v1\}$/mu,
      );
    });

    it('keeps the native OCR process single-threaded and resource isolated', () => {
      expect(readEnvNumber(mediaAnalysis, 'COMMERCIAL_OCR_TESSERACT_CONCURRENCY')).toBe(1);
      expect(readEnvNumber(mediaAnalysis, 'OMP_THREAD_LIMIT')).toBe(1);
      expect(mediaAnalysis).not.toMatch(/^\s+COMMERCIAL_OCR_PROCESSOR_CONCURRENCY:/mu);
      expect(mediaAnalysis).toMatch(/^\s+init:\s+true\s*$/mu);
      expect(mediaAnalysis).toMatch(/^\s+deploy:\n\s+replicas:\s+1\s*$/mu);
      expect(mediaAnalysis).toMatch(/^\s+cpus:\s+0\.75\s*$/mu);
      expect(mediaAnalysis).toMatch(/^\s+mem_limit:\s+1g\s*$/mu);
    });

    it('sandboxes native image parsing behind a read-only least-privilege container', () => {
      expect(mediaAnalysis).toMatch(/^\s+read_only:\s+true\s*$/mu);
      expect(mediaAnalysis).toMatch(/^\s+cap_drop:\n\s+- ALL\s*$/mu);
      expect(mediaAnalysis).toMatch(
        new RegExp(
          `^\\s+security_opt:${name === 'scale' ? ' !override' : ''}\\n\\s+- no-new-privileges:true\\s*$`,
          'mu',
        ),
      );
      expect(mediaAnalysis).toMatch(
        /^\s+tmpfs:\n\s+- \/tmp:size=64m,mode=1777,uid=1000,gid=1000\s*$/mu,
      );
    });
  });
});

function readServiceBlock(compose: string, service: string): string {
  const match = compose.match(
    new RegExp(
      `\\n  ${escapeRegExp(service)}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:|\\nvolumes:|$)`,
      'u',
    ),
  );

  if (!match?.[1]) {
    throw new Error(`Missing compose service ${service}`);
  }
  return match[1];
}

function readEnvNumber(serviceBlock: string, key: string): number {
  const match = serviceBlock.match(
    new RegExp(`^\\s{6}${escapeRegExp(key)}:\\s*'?([0-9]+)'?\\s*$`, 'mu'),
  );

  if (!match?.[1]) {
    throw new Error(`Missing compose env ${key}`);
  }
  return Number(match[1]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
