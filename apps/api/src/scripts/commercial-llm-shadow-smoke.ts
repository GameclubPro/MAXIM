import { CommercialLlmClient } from '../moderation/commercial/commercial-llm.client';
import {
  COMMERCIAL_LLM_MODEL_SHA256,
  COMMERCIAL_LLM_PROMPT_SHA256,
} from '../moderation/commercial/commercial-llm.protocol';
import {
  CommercialLlmShadowLease,
  createCommercialLlmRedis,
} from '../moderation/commercial/commercial-llm-shadow.lease';

// FLAG: Closed synthetic sources only. This executable has no MAX client, DB or effect authority.
export async function commercialLlmShadowSmoke() {
  if (
    process.argv.length !== 2 ||
    process.env.APP_SERVICE_NAME !== 'api-moderation-background' ||
    !process.env.REDIS_URL
  )
    throw new Error('Closed shadow smoke requires the background role');
  const redis = createCommercialLlmRedis(process.env.REDIS_URL);
  let token: string | null = null;
  const lease = new CommercialLlmShadowLease(redis);
  try {
    await redis.connect();
    token = await lease.acquire();
    if (!token)
      throw new Error('Closed shadow smoke not admitted; retry after current observation');
    const signal = AbortSignal.timeout(90_000);
    const client = new CommercialLlmClient({ endpoint: 'http://gemma-commercial-shadow:8080' });
    const cases = [];
    for (const sample of [
      {
        name: 'commercial-service',
        expected: 'COMMERCIAL',
        text: 'Наша компания ремонтирует стиральные машины. Мастера работают ежедневно, гарантия, принимаем заказы: [phone].',
      },
      {
        name: 'personal-used-item',
        expected: 'NOT_COMMERCIAL',
        text: 'Продам свой старый холодильник после переезда, один, б/у. Служил нашей семье десять лет.',
      },
    ] as const) {
      if (signal.aborted || !(await lease.owns(token)))
        throw new Error('Closed shadow smoke lease elapsed');
      const result = await client.classify(sample.text, signal);
      if (signal.aborted || !(await lease.owns(token)))
        throw new Error('Closed shadow smoke lease elapsed');
      const current = {
        name: sample.name,
        classification: result.classification,
        durationMs: result.durationMs,
      };
      cases.push(current);
      if (result.classification !== sample.expected) {
        throw new Error(
          `Closed shadow smoke unexpected classification: ${sample.name}/${result.classification}`,
        );
      }
    }
    return {
      ok: true,
      casesPassed: cases.length,
      casesTotal: 2,
      modelSha256: COMMERCIAL_LLM_MODEL_SHA256,
      promptSha256: COMMERCIAL_LLM_PROMPT_SHA256,
      cases,
    };
  } finally {
    if (token) await lease.release(token).catch(() => undefined);
    redis.disconnect();
  }
}

if (require.main === module) {
  commercialLlmShadowSmoke()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'Closed shadow smoke failed'}\n`,
      );
      process.exitCode = 1;
    });
}
