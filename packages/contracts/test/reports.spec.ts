import { describe, expect, it } from 'vitest';
import {
  chatSettingsSchema,
  applySettingsSectionSchema,
  updateSettingsRequestSchema,
  chatSettingsScreenResponseSchema,
} from '../src/core.js';
import { reportSummarySchema } from '../src/reports.js';

describe('participant report settings', () => {
  it('defaults to disabled, three votes, one message and no mute', () => {
    expect(chatSettingsSchema.parse({})).toMatchObject({
      reportsEnabled: false,
      reportsThreshold: 3,
      reportsAliases: [],
      reportsDeleteMode: 'MESSAGE',
      reportsMuteEnabled: false,
      reportsMuteDurationHours: 1,
    });
    expect(applySettingsSectionSchema.parse('reports')).toBe('reports');
  });
  it.each([2, 6])('accepts threshold %i', (reportsThreshold) => {
    expect(chatSettingsSchema.safeParse({ reportsThreshold }).success).toBe(true);
  });
  it.each([
    { reportsThreshold: 1 },
    { reportsThreshold: 7 },
    { reportsThreshold: 2.5 },
    { reportsMuteDurationHours: 0 },
    { reportsMuteDurationHours: 25 },
    { reportsAliases: ['жалоба'] },
    { reportsAliases: ['мут'] },
    { reportsAliases: ['test'], adminBanCommandName: 'test' },
    { adminBanCommandName: 'report' },
    { reportsAliases: ['two words'] },
    { reportsAliases: ['a', 'b', 'c', 'd', 'e', 'f'] },
  ])('rejects unsafe input %j', (input) => {
    expect(updateSettingsRequestSchema.safeParse(input).success).toBe(false);
  });
  it('normalizes custom words without changing legacy mute defaults', () => {
    expect(
      chatSettingsSchema.parse({ reportsAliases: ['  СПАМ '], muteDurationHours: 6 }),
    ).toMatchObject({ reportsAliases: ['спам'], reportsMuteDurationHours: 1 });
  });
  it('defaults unknown server availability to unavailable', () => {
    expect(chatSettingsScreenResponseSchema.shape.reportsAvailable.parse(undefined)).toBe(false);
    expect(chatSettingsScreenResponseSchema.shape.reportsAvailable.parse(true)).toBe(true);
  });
  it('preserves compatibility for old reports and rejects negative absent counts', () => {
    expect(reportSummarySchema.shape.absent.parse(undefined)).toBe(0);
    expect(reportSummarySchema.shape.absent.safeParse(-1).success).toBe(false);
  });
});
