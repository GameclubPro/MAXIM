import { readCliOptions } from './audit-commercial-filter';

describe('audit-commercial-filter CLI options', () => {
  it('keeps --limit all as an unlimited audit', () => {
    expect(readCliOptions(['--limit', 'all']).limit).toBeNull();
    expect(readCliOptions(['--limit=all']).limit).toBeNull();
  });

  it('uses the default limit only when --limit is omitted', () => {
    expect(readCliOptions([]).limit).toBe(1500);
  });
});
