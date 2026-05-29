export const COMMERCIAL_HARD_NEGATIVE_REASON_PREFIXES = [
  'private:',
  'private-single:',
  'private-goods:',
  'search:',
  'context:',
  'job-seeking:',
] as const;

export type CommercialHardNegativeClass =
  | 'PRIVATE_ONE_OFF_GOODS'
  | 'PRIVATE_REAL_ESTATE'
  | 'REQUEST_OR_RECOMMENDATION'
  | 'JOB_SEEKING'
  | 'QUESTION_CONTEXT';

export function classifyCommercialHardNegativeSignals(
  negativeSignals: readonly string[],
): CommercialHardNegativeClass[] {
  const classes = new Set<CommercialHardNegativeClass>();

  for (const signal of negativeSignals) {
    if (signal.startsWith('private-goods:') || signal.startsWith('private-single:')) {
      classes.add('PRIVATE_ONE_OFF_GOODS');
    } else if (signal === 'private:property-sale') {
      classes.add('PRIVATE_REAL_ESTATE');
    } else if (signal.startsWith('search:') || signal.startsWith('search-pattern:')) {
      classes.add('REQUEST_OR_RECOMMENDATION');
    } else if (signal.startsWith('job-seeking:')) {
      classes.add('JOB_SEEKING');
    } else if (signal.startsWith('context:')) {
      classes.add('QUESTION_CONTEXT');
    }
  }

  return [...classes];
}
