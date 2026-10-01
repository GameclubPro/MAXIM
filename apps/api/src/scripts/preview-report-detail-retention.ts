import { ConfigService } from '@nestjs/config';
import { createPrismaClient } from '../prisma/prisma-client';
import { ReportStateService } from '../moderation/reports/report-state.service';
import { ReportViewService } from '../moderation/reports/report-view.service';
import { ReportRetentionService } from '../moderation/reports/report-retention.service';
import { ReportTelemetryService } from '../moderation/reports/report-telemetry.service';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--days'))
    throw new Error('Usage: reports:retention-preview [--days 30|90|180]');
  const days = args.length ? Number(args[1]) : 30;
  if (![30, 90, 180].includes(days)) throw new Error('Retention days must be 30, 90 or 180');
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('A disposable local DATABASE_URL is required');
  const parsed = new URL(url);
  // FLAG: This diagnostic cannot select a production or arbitrary remote database.
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    !parsed.pathname.includes('race_test')
  )
    throw new Error('Preview requires a disposable local race_test database');
  const prisma = createPrismaClient(url, {
    max: 1,
    statement_timeout: 2000,
    connectionTimeoutMillis: 2000,
    options: '-c lock_timeout=1000',
  });
  try {
    const config = new ConfigService({
      PARTICIPANT_REPORTS_DETAIL_RETENTION_ENABLED: false,
      PARTICIPANT_REPORTS_DETAIL_RETENTION_DAYS: days,
      PARTICIPANT_REPORTS_MODE: 'off',
    });
    const state = new ReportStateService(prisma as never, {} as never, {} as never, config);
    const view = new ReportViewService(prisma as never, state);
    const retention = new ReportRetentionService(
      prisma as never,
      state,
      view,
      config,
      new ReportTelemetryService(),
    );
    const previewRemovableDetails = await retention.previewPage();
    process.stdout.write(
      JSON.stringify({
        dryRun: true,
        days,
        maximumCases: 5,
        maximumDetails: 200,
        previewRemovableDetails,
      }) + '\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch(() => {
  process.stderr.write(
    'Report retention preview failed; verify local database configuration and migration state.\n',
  );
  process.exitCode = 1;
});
