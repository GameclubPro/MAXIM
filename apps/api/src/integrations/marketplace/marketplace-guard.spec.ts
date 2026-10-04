import { ConfigService } from '@nestjs/config';
import {
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { MarketplaceIntegrationGuard } from './marketplace-integration.guard';
import { readMarketplaceResponse } from './marketplace-profile.service';
const context = (authorization?: string) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }),
  }) as ExecutionContext;
describe('marketplace integration authentication', () => {
  it('stays unavailable when the dedicated credential is absent', () => {
    expect(() =>
      new MarketplaceIntegrationGuard(new ConfigService()).canActivate(context('Bearer anything')),
    ).toThrow(ServiceUnavailableException);
  });
  it('requires the exact dedicated bearer credential', () => {
    const guard = new MarketplaceIntegrationGuard(
      new ConfigService({ SVYAZKA_ANALYTICS_TOKEN: 'a'.repeat(64) }),
    );
    expect(() => guard.canActivate(context('Major ' + 'a'.repeat(64)))).toThrow(
      UnauthorizedException,
    );
    expect(() => guard.canActivate(context('Bearer ' + 'b'.repeat(64)))).toThrow(
      UnauthorizedException,
    );
    expect(guard.canActivate(context('Bearer ' + 'a'.repeat(64)))).toBe(true);
  });
  it('bounds external responses and rejects malformed JSON without leaking payloads', async () => {
    await expect(readMarketplaceResponse(new Response('x'.repeat(128 * 1024 + 1)))).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(readMarketplaceResponse(new Response('private-source-body'))).rejects.toThrow(
      'Некорректный ответ Связки',
    );
  });
});
