import { runtime as photoRuntime, image } from './photo-native-fixtures.mjs';
import { LEGACY_COLD_API_SERVICES } from '../multibot-legacy-cold-recovery.mjs';
const source = 'b'.repeat(40);
export function legacyColdFleet(stopped = false) {
  const roles = LEGACY_COLD_API_SERVICES.map((service, index) => ({
    Id: (index + 1).toString(16).padStart(64, '0'),
    Image: image,
    Name: `/infra-${service}-1`,
    State: {
      Running: !stopped,
      Status: stopped ? 'exited' : 'running',
      Paused: false,
      Restarting: false,
      Dead: false,
    },
    Config: {
      Image: `maxim-api:${source}`,
      Labels: {
        'com.docker.compose.project': 'infra',
        'com.docker.compose.service': service,
        'com.maxim.release-protected': 'true',
        'org.opencontainers.image.revision': source,
      },
      Env: [
        `APP_SERVICE_NAME=${service}`,
        `APP_ROLE=${service.startsWith('api-moderation') || service === 'api-media-analysis' ? 'moderation' : service.slice(4)}`,
        'DATABASE_URL=postgresql://do-not-log',
        'REDIS_URL=redis://do-not-log',
      ],
    },
  }));
  const ocrEnv = {
    NODE_ENV: 'production',
    COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: '/run/maxim-ocr/native-ocr.sock',
    PHOTO_DUPLICATE_MAX_BYTES: '16777216',
    COMMERCIAL_OCR_MAX_INPUT_PIXELS: '40000000',
    COMMERCIAL_OCR_MAX_OUTPUT_PIXELS: '3000000',
    COMMERCIAL_OCR_MAX_SIDE: '2000',
    COMMERCIAL_OCR_TESSERACT_BINARY: 'tesseract',
    COMMERCIAL_OCR_TESSERACT_CONCURRENCY: '1',
    COMMERCIAL_OCR_TESSERACT_MAX_QUEUE: '4',
    COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: '10000',
    COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS: '250',
    COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES: '16777216',
    COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES: '4194304',
    OMP_THREAD_LIMIT: '1',
  };
  const ocr = {
    Id: 'e'.repeat(64),
    Image: image,
    Name: '/infra-ocr-native-sandbox-1',
    State: { Running: true, Status: 'running', Health: { Status: 'healthy' } },
    Mounts: [
      {
        Type: 'volume',
        Name: 'infra_ocr_native_ipc',
        Destination: '/run/maxim-ocr',
        RW: true,
        Mode: 'rw',
      },
    ],
    Config: {
      User: '1000:1000',
      Cmd: [
        'node',
        'apps/api/dist/apps/api/src/moderation/commercial-ocr/native-ocr-sandbox.entrypoint.js',
      ],
      Env: Object.entries(ocrEnv).map(([key, value]) => `${key}=${value}`),
      Labels: {
        'com.docker.compose.project': 'infra',
        'com.docker.compose.service': 'ocr-native-sandbox',
        'com.maxim.release-protected': 'true',
        'com.maxim.ocr-native-sandbox': 'true',
        'com.maxim.ocr-native-sandbox-capable': 'true',
      },
    },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Init: true,
      Memory: 1024 ** 3,
      NanoCpus: 1_000_000_000,
      PidsLimit: 128,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Tmpfs: { '/tmp': 'rw,size=64m,mode=1777,uid=1000,gid=1000' },
    },
  };
  const containers = [...roles, ocr, { ...photoRuntime(), Id: 'f'.repeat(64) }];
  for (const row of containers) {
    row.Config.Image = `maxim-api:${source}`;
    row.Config.Labels['org.opencontainers.image.revision'] = source;
    row.HostConfig = { ...row.HostConfig, RestartPolicy: { Name: 'unless-stopped' } };
    Object.assign(row.State, {
      Running: !stopped,
      Status: stopped ? 'exited' : 'running',
      Paused: false,
      Restarting: false,
      Dead: false,
    });
  }
  return containers;
}
