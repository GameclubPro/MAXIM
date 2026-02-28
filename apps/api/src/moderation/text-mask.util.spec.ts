import { maskText } from './text-mask.util';

describe('maskText', () => {
  it('masks short text fully', () => {
    expect(maskText('тест')).toBe('****');
  });

  it('masks middle section for longer text', () => {
    expect(maskText('нарушение')).toBe('на*****ие');
  });
});
