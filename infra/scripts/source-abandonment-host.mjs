import { pathToFileURL } from 'node:url';
import { parseLegacyColdHostRequest, runLegacyColdHost } from './legacy-cold-host.mjs';

export const SOURCE_ABANDONMENT_PROTOCOL = 'source-abandonment-v1';

// FLAG: Source abandonment has its own bounded request domain. Legacy entrypoints
// never accept this selection; both domains retain the same exclusive cold journal.
export function parseSourceAbandonmentHostRequest(text, now = Date.now()) {
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error('host_request_budget');
  const input = JSON.parse(text);
  if (!['preflight', 'prepare'].includes(input?.operation)) return parseLegacyColdHostRequest(text);
  const selection = input.selection;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection))
    throw new Error('source_selection_required');
  const { protocol, abandonBefore, ...legacySelection } = selection;
  if (
    protocol !== SOURCE_ABANDONMENT_PROTOCOL ||
    typeof abandonBefore !== 'string' ||
    !Number.isFinite(Date.parse(abandonBefore)) ||
    new Date(abandonBefore).toISOString() !== abandonBefore ||
    Date.parse(abandonBefore) > now
  )
    throw new Error('source_cutoff_required');
  const result = parseLegacyColdHostRequest(
    JSON.stringify({ ...input, selection: legacySelection }),
  );
  if (result.selection.ownerWebhookEventIds.length > 8) throw new Error('source_selection_budget');
  return { ...result, selection: { ...result.selection, protocol, abandonBefore } };
}

export async function runSourceAbandonmentHost(request) {
  request = parseSourceAbandonmentHostRequest(JSON.stringify(request));
  return runLegacyColdHost(request, { protocol: SOURCE_ABANDONMENT_PROTOCOL });
}

async function main() {
  let text = '';
  const timer = setTimeout(() => process.stdin.destroy(new Error('stdin_deadline')), 5_000);
  try {
    if (process.argv.length !== 2) throw new Error('stdin_only');
    for await (const part of process.stdin) {
      text += part;
      if (Buffer.byteLength(text) > 64 * 1024) throw new Error('stdin_budget');
    }
    clearTimeout(timer);
    const result = await runSourceAbandonmentHost(parseSourceAbandonmentHostRequest(text));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.decision === 'DENY') process.exitCode = 1;
  } catch {
    process.stderr.write(
      'Exact-source abandonment refused; inspect its private evidence and durable journal.\n',
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
