import { BadRequestException } from '@nestjs/common';
import { extractPrivateControlUserErrorDetails } from './private-control-bad-request.util';

describe('extractPrivateControlUserErrorDetails', () => {
  it('keeps an intentional Russian validation message', () => {
    expect(
      extractPrivateControlUserErrorDetails(
        new BadRequestException('Сначала выберите чат или канал.'),
      ),
    ).toBe('Сначала выберите чат или канал.');
  });

  it.each([
    'Unknown channel section',
    'Input payload is invalid',
    'Request failed with status code 503',
    'MAX API timeout',
  ])('does not expose a technical BadRequest message: %s', (message) => {
    expect(extractPrivateControlUserErrorDetails(new BadRequestException(message))).toBeNull();
  });
});
