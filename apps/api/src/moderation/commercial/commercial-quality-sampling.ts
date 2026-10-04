import { createHash, createHmac } from 'node:crypto';
import {
  normalizeCommercialCampaignPhone,
  normalizeCommercialCampaignUrl,
} from '../commercial-campaign.util';
import { parseCommercialPhones } from './commercial-phone';
import { extractUrlsFromText } from '../../common/url-text.util';

export const COMMERCIAL_QUALITY_SAMPLING_VERSION = 'commercial-quality-sampling-v1';
const NO_HIT_THRESHOLD = Math.ceil(0.1 * 2 ** 32);
export const COMMERCIAL_QUALITY_EVALUATION_PROBABILITY = NO_HIT_THRESHOLD / 2 ** 32;

export type CommercialQualitySample = {
  samplingProbability: number;
  samplingStratum: 'HIT' | 'REVIEW' | 'NO_HIT' | 'TECHNICAL';
  pseudonymizationKeyId: string;
  randomEvaluationIncluded: boolean;
  evaluationSamplingProbability: number;
  campaignGroupingComplete: boolean;
  logicalMessageKey: string;
  authorGroupId: string;
  campaignGroupId: string;
  campaignGroupIds: string[];
  sourceSnapshotSha256: string;
  messageCreatedAt: string;
};

// FLAG: Sampling and pseudonyms are observational only. A mirror, edit, source type or
// changed decision cannot change the random inclusion of the same logical message.
// Never derive campaign identity from masked contacts or persist raw contact material.
export function buildCommercialQualitySample(input: {
  secret: string | null | undefined;
  chatId: string;
  userId: string;
  messageId: string;
  text: string;
  messageCreatedAt: string | null;
  source: 'TEXT' | 'OCR';
  hasDetection: boolean;
  reviewRecommended?: boolean;
  technicalIncomplete?: boolean;
  sourceIdentity?: string;
}): CommercialQualitySample | null {
  if (
    !input.secret ||
    input.secret.length < 16 ||
    !input.chatId ||
    !input.userId ||
    !input.messageId ||
    !input.messageCreatedAt ||
    !Number.isFinite(Date.parse(input.messageCreatedAt))
  )
    return null;
  const token = (domain: string, values: readonly string[]) =>
    createHmac('sha256', input.secret!)
      .update(JSON.stringify([COMMERCIAL_QUALITY_SAMPLING_VERSION, domain, ...values]))
      .digest('hex');
  const logicalMessageKey = token('message', [input.chatId, input.messageId]);
  const randomEvaluationIncluded =
    Number.parseInt(token('sample', [logicalMessageKey]).slice(0, 8), 16) < NO_HIT_THRESHOLD;
  const samplingStratum = input.technicalIncomplete
    ? 'TECHNICAL'
    : input.reviewRecommended
      ? 'REVIEW'
      : input.hasDetection
        ? 'HIT'
        : 'NO_HIT';
  if (samplingStratum === 'NO_HIT' && !randomEvaluationIncluded) return null;
  const campaignText = input.text.slice(0, 32_000);
  const phones = parseCommercialPhones(campaignText)
    .map((contact) => normalizeCommercialCampaignPhone(contact.normalizedNumber))
    .filter((value): value is string => value !== null);
  const links = extractUrlsFromText(campaignText)
    .map(normalizeCommercialCampaignUrl)
    .filter((value): value is string => value !== null);
  const handles = [
    ...campaignText.matchAll(/(?:^|[^\p{L}\p{N}_])@([a-z0-9_]{4,32})(?=$|[^\p{L}\p{N}_])/giu),
  ].map((match) => match[1]!.toLowerCase());
  const contactGroups = [
    ...phones.map((value) => token('campaign-phone', [value])),
    ...links.map((value) => token('campaign-link', [value])),
    ...handles.map((value) => token('campaign-handle', [value])),
  ];
  // FLAG: Shared templates without a shared original contact are not proof of one
  // campaign. The author key groups such repeats conservatively; independent image
  // clustering must be supplied by the private image corpus, never inferred from OCR.
  const allCampaignGroupIds = [...new Set(contactGroups)].sort();
  const campaignGroupIds = allCampaignGroupIds.slice(0, 32);
  const authorGroupId = token('author', [input.userId]);
  const campaignGroupId = campaignGroupIds[0] ?? token('author-campaign', [authorGroupId]);
  const messageCreatedAt = new Date(input.messageCreatedAt).toISOString();
  return {
    samplingProbability:
      samplingStratum === 'NO_HIT' ? COMMERCIAL_QUALITY_EVALUATION_PROBABILITY : 1,
    samplingStratum,
    pseudonymizationKeyId: token('key-identity', []),
    randomEvaluationIncluded,
    evaluationSamplingProbability: COMMERCIAL_QUALITY_EVALUATION_PROBABILITY,
    campaignGroupingComplete: input.text.length <= 32_000 && allCampaignGroupIds.length <= 32,
    logicalMessageKey,
    authorGroupId,
    campaignGroupId,
    campaignGroupIds: campaignGroupIds.length ? campaignGroupIds : [campaignGroupId],
    sourceSnapshotSha256: createHash('sha256')
      .update(
        JSON.stringify([
          logicalMessageKey,
          messageCreatedAt,
          input.source,
          input.text,
          input.sourceIdentity ?? null,
        ]),
      )
      .digest('hex'),
    messageCreatedAt,
  };
}
