import { z } from 'zod';

// FLAG: Security updates must preserve accepted timestamp spelling and UTF-16 limits.
// Keep the original string: revisions, idempotency keys and saved schedules can bind its bytes.
export const utcTimestampSchema = z
  .string()
  .datetime()
  .or(z.string().datetime({ precision: -1 }));

export const offsetTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime({ offset: true, precision: -1 }));

export function utf16Max(schema: z.ZodString, maximum: number): z.ZodString {
  return schema.max(maximum).superRefine((value, ctx) => {
    if (
      value.length > maximum &&
      !ctx.issues.some(
        (issue) =>
          issue.code === 'too_big' && issue.origin === 'string' && issue.maximum === maximum,
      )
    ) {
      ctx.addIssue({ code: 'too_big', origin: 'string', maximum, inclusive: true });
    }
  });
}
