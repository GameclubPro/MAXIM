import {
  buildManagedBroadcastButtonState,
  buildManagedBroadcastLinkButtonRows,
  normalizeManagedBroadcastButtons,
} from './admin-managed-broadcast-buttons';

describe('admin managed broadcast button helpers', () => {
  it('normalizes explicit buttons before legacy button fields', () => {
    expect(
      normalizeManagedBroadcastButtons(
        [
          { text: 'Открыть выпуск', url: ' https://example.com/post ' },
          { text: '', url: 'max://user/123' },
        ],
        {
          buttonEnabled: true,
          buttonUrl: 'https://legacy.example.com',
          buttonText: 'Legacy',
        },
      ),
    ).toEqual([{ text: 'Открыть выпуск', url: 'https://example.com/post' }]);
  });

  it('uses legacy button fields only when explicit buttons are empty', () => {
    expect(
      buildManagedBroadcastButtonState([], {
        buttonEnabled: true,
        buttonUrl: 'https://example.com/legacy',
        buttonText: '  ',
      }),
    ).toEqual({
      buttons: [{ text: 'Открыть', url: 'https://example.com/legacy' }],
      buttonEnabled: true,
      buttonUrl: 'https://example.com/legacy',
      buttonText: 'Открыть',
    });
  });

  it('splits MAX link buttons into configured rows', () => {
    expect(
      buildManagedBroadcastLinkButtonRows([
        { text: '1', url: 'https://example.com/1' },
        { text: '2', url: 'https://example.com/2' },
        { text: '3', url: 'https://example.com/3' },
        { text: '4', url: 'https://example.com/4' },
      ]),
    ).toEqual([
      [
        { type: 'link', text: '1', url: 'https://example.com/1' },
        { type: 'link', text: '2', url: 'https://example.com/2' },
        { type: 'link', text: '3', url: 'https://example.com/3' },
      ],
      [{ type: 'link', text: '4', url: 'https://example.com/4' }],
    ]);
  });

  it('supports full-width rows for channel publication link buttons', () => {
    expect(
      buildManagedBroadcastLinkButtonRows(
        [
          { text: '1', url: 'https://example.com/1' },
          { text: '2', url: 'https://example.com/2' },
          { text: '3', url: 'https://example.com/3' },
          { text: '4', url: 'https://example.com/4' },
        ],
        { buttonsPerRow: 1 },
      ),
    ).toEqual([
      [{ type: 'link', text: '1', url: 'https://example.com/1' }],
      [{ type: 'link', text: '2', url: 'https://example.com/2' }],
      [{ type: 'link', text: '3', url: 'https://example.com/3' }],
      [{ type: 'link', text: '4', url: 'https://example.com/4' }],
    ]);
  });
});
