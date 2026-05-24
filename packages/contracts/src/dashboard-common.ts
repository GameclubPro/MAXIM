import { z } from 'zod';

export const logsDashboardRangeSchema = z.enum(['24h', '7d', '30d']);
export type LogsDashboardRange = z.infer<typeof logsDashboardRangeSchema>;

export const booleanQueryFlagSchema = z.preprocess((input) => {
  if (input === true || input === false) {
    return input;
  }
  if (input === '1' || input === 'true') {
    return true;
  }
  if (input === '0' || input === 'false') {
    return false;
  }
  return input;
}, z.boolean());
