import { AsyncLocalStorage } from 'node:async_hooks';
import type { WebhookEffectOrigin } from '../webhook-effect-origin-context';
import {
  commercialLlmSourceCurrent,
  COMMERCIAL_LLM_DELETE_RULE_CODE,
  type CommercialLlmSource,
} from './commercial-llm-enforcement.protocol';

const sources = new AsyncLocalStorage<{ active: boolean; source: CommercialLlmSource }>();

// FLAG: This is a new, proof-bound child handoff, not renewed canonical handler authority.
// The source is captured while the original owner is active; only its fresh Redis proof may
// attribute this one AI DELETE. Historical SHADOW data and other rule families cannot use it.
export async function withCommercialLlmEffectOrigin<T>(
  source: CommercialLlmSource,
  hasProof: () => Promise<boolean>,
  callback: () => Promise<T>,
): Promise<T> {
  if (!commercialLlmSourceCurrent(source) || !(await hasProof()))
    throw new Error('Commercial AI origin unavailable');
  const scope = { active: true, source: structuredClone(source) };
  return sources.run(scope, async () => {
    try {
      return await callback();
    } finally {
      scope.active = false;
    }
  });
}

export function readCommercialLlmEffectOrigin(
  chatId: string,
  messageId: string,
  ruleCode: string,
): WebhookEffectOrigin | null {
  const scope = sources.getStore();
  if (
    !scope?.active ||
    ruleCode !== COMMERCIAL_LLM_DELETE_RULE_CODE ||
    scope.source.chatId !== chatId ||
    scope.source.messageId !== messageId ||
    !commercialLlmSourceCurrent(scope.source)
  )
    return null;
  const { sourceEventAtMs, ...origin } = scope.source.origin;
  return { ...origin, sourceEventAt: new Date(sourceEventAtMs) };
}
