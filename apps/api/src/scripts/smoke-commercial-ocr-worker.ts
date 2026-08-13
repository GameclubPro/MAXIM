import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';

import { NativeTesseractOcrAdapter } from '../moderation/commercial-ocr/native-tesseract-ocr.adapter';

const STARTUP_TIMEOUT_MS = 6_000;
const RECOGNITION_TIMEOUT_MS = 8_000;
const CYRILLIC_SERVICE_TEXT = 'РЕМОНТ КВАРТИР';
const LATIN_SERVICE_TEXT = 'REPAIR SERVICE';
const CYRILLIC_CALL_TO_ACTION = 'ЗВОНИТЕ';
const EXPECTED_PHONE_DIGITS = '79991234567';

export async function runCommercialOcrWorkerSmoke(): Promise<void> {
  const adapter = new NativeTesseractOcrAdapter(
    new ConfigService({
      ...process.env,
      COMMERCIAL_OCR_TESSERACT_CONCURRENCY: 1,
      COMMERCIAL_OCR_TESSERACT_MAX_QUEUE: 1,
      COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS: 2,
      COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: RECOGNITION_TIMEOUT_MS,
      COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES: 2 * 1024 * 1024,
      COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES: 512 * 1024,
      OMP_THREAD_LIMIT: 1,
    }),
  );
  adapter.onModuleInit();
  try {
    await waitForReady(adapter, STARTUP_TIMEOUT_MS);
    const result = await adapter.recognize(await buildSmokeRaster(), {
      psm: 6,
      passLabel: 'deploy-smoke',
      deadlineAtMs: Date.now() + RECOGNITION_TIMEOUT_MS,
    });
    if (!result.ok) {
      throw new Error(`Commercial OCR worker smoke failed open: ${result.reason}`);
    }
    assertCommercialOcrWorkerSmokeText(result.text);
  } finally {
    await adapter.onModuleDestroy();
  }
}

export function assertCommercialOcrWorkerSmokeText(text: string): void {
  const normalized = text.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const digits = text.replace(/\D+/gu, '');
  if (
    !normalized.includes(CYRILLIC_SERVICE_TEXT) ||
    !normalized.includes(LATIN_SERVICE_TEXT) ||
    !normalized.includes(CYRILLIC_CALL_TO_ACTION) ||
    !digits.includes(EXPECTED_PHONE_DIGITS)
  ) {
    throw new Error('Commercial OCR worker smoke did not recognize the expected opaque fixture');
  }
}

async function waitForReady(adapter: NativeTesseractOcrAdapter, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (adapter.getRuntimeStatus().ready) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Commercial OCR worker did not become ready: ${adapter.getRuntimeStatus().state}`);
}

async function buildSmokeRaster(): Promise<Buffer> {
  const svg = Buffer.from(
    [
      '<svg width="1400" height="390" xmlns="http://www.w3.org/2000/svg">',
      '<rect width="1400" height="390" fill="white"/>',
      '<text x="60" y="100" font-family="DejaVu Sans" font-size="64" font-weight="700">',
      CYRILLIC_SERVICE_TEXT,
      '</text>',
      '<text x="60" y="215" font-family="DejaVu Sans" font-size="64" font-weight="700">',
      LATIN_SERVICE_TEXT,
      '</text>',
      '<text x="60" y="330" font-family="DejaVu Sans" font-size="64" font-weight="700">',
      `${CYRILLIC_CALL_TO_ACTION} +7 999 123 45 67`,
      '</text>',
      '</svg>',
    ].join(''),
    'utf8',
  );
  return sharp(svg).png({ compressionLevel: 1, adaptiveFiltering: false }).toBuffer();
}

if (require.main === module) {
  void runCommercialOcrWorkerSmoke()
    .then(() => process.stdout.write('Commercial OCR worker smoke passed.\n'))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
