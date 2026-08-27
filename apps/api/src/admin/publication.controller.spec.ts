import { MINIAPP_PROFILES_METADATA } from '../auth/miniapp-profile';
import { PublicationDispatchProfile } from '../prisma/prisma-client';
import { PublicationController } from './publication.controller';

describe('PublicationController', () => {
  const user = {
    userId: 'admin-1',
    username: null,
    displayName: null,
  };

  it('allows new publication work only in Publik and keeps legacy reads in moderation', () => {
    expect(
      Reflect.getMetadata(MINIAPP_PROFILES_METADATA, PublicationController.prototype.create),
    ).toEqual(['publisher']);
    expect(
      Reflect.getMetadata(
        MINIAPP_PROFILES_METADATA,
        PublicationController.prototype.calendarAvailability,
      ),
    ).toEqual(['publisher']);
    expect(
      Reflect.getMetadata(MINIAPP_PROFILES_METADATA, PublicationController.prototype.listLegacy),
    ).toEqual(['moderation']);

    for (const handler of [
      PublicationController.prototype.list,
      PublicationController.prototype.get,
      PublicationController.prototype.update,
      PublicationController.prototype.pause,
      PublicationController.prototype.resume,
      PublicationController.prototype.cancel,
      PublicationController.prototype.remove,
      PublicationController.prototype.deliveries,
      PublicationController.prototype.retryOccurrence,
      PublicationController.prototype.resolveAmbiguous,
    ]) {
      expect(Reflect.getMetadata(MINIAPP_PROFILES_METADATA, handler)).toEqual([
        'moderation',
        'publisher',
      ]);
    }
  });

  it('maps every profile-scoped operation to its immutable dispatch profile', () => {
    const publicationService = {
      list: jest.fn(),
      create: jest.fn(),
      getCalendarAvailability: jest.fn(),
      get: jest.fn(),
      update: jest.fn(),
      pause: jest.fn(),
      resume: jest.fn(),
      cancel: jest.fn(),
      listDeliveries: jest.fn(),
      retryOccurrence: jest.fn(),
      resolveAmbiguousDelivery: jest.fn(),
      sendTest: jest.fn(),
    };
    const publicationLegacyService = { list: jest.fn() };
    const controller = new PublicationController(
      publicationService as never,
      publicationLegacyService as never,
    );
    const query = { view: 'plan' };
    const body = { requestId: 'request-1' };

    controller.list(user, query, 'publisher');
    controller.create(user, body, 'publisher');
    controller.calendarAvailability(user, body, 'publisher');
    controller.get('publication-1', user, 'moderation');
    controller.update('publication-1', user, body, 'publisher');
    controller.pause('publication-1', user, body, 'moderation');
    controller.resume('publication-1', user, body, 'publisher');
    controller.cancel('publication-1', user, body, 'moderation');
    controller.remove('publication-1', user, body, 'publisher');
    controller.deliveries('publication-1', user, query, 'moderation');
    controller.retryOccurrence('publication-1', 'occurrence-1', user, body, 'publisher');
    controller.resolveAmbiguous('publication-1', 'occurrence-1', user, body, 'moderation');

    expect(publicationService.list).toHaveBeenCalledWith(
      user,
      query,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(publicationService.create).toHaveBeenCalledWith(
      user,
      body,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(publicationService.getCalendarAvailability).toHaveBeenCalledWith(
      user,
      body,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(publicationService.get).toHaveBeenCalledWith(
      'publication-1',
      user,
      PublicationDispatchProfile.LEGACY_ROUTED,
    );
    expect(publicationService.update).toHaveBeenCalledWith(
      'publication-1',
      user,
      body,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(publicationService.pause).toHaveBeenCalledWith(
      'publication-1',
      user,
      body,
      PublicationDispatchProfile.LEGACY_ROUTED,
    );
    expect(publicationService.resume).toHaveBeenCalledWith(
      'publication-1',
      user,
      body,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(publicationService.cancel).toHaveBeenNthCalledWith(
      1,
      'publication-1',
      user,
      body,
      PublicationDispatchProfile.LEGACY_ROUTED,
    );
    expect(publicationService.cancel).toHaveBeenNthCalledWith(
      2,
      'publication-1',
      user,
      body,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(publicationService.listDeliveries).toHaveBeenCalledWith(
      'publication-1',
      user,
      query,
      PublicationDispatchProfile.LEGACY_ROUTED,
    );
    expect(publicationService.retryOccurrence).toHaveBeenCalledWith(
      'publication-1',
      'occurrence-1',
      user,
      body,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(publicationService.resolveAmbiguousDelivery).toHaveBeenCalledWith(
      'publication-1',
      'occurrence-1',
      user,
      body,
      PublicationDispatchProfile.LEGACY_ROUTED,
    );
  });

  it('does not expose the legacy test sender to the publisher profile', () => {
    const publicationService = { sendTest: jest.fn() };
    const controller = new PublicationController(publicationService as never, {} as never);

    expect(() => controller.test(user, {}, 'publisher')).toThrow();
    expect(publicationService.sendTest).not.toHaveBeenCalled();

    controller.test(user, {}, 'moderation');
    expect(publicationService.sendTest).toHaveBeenCalledWith(user, {});
  });
});
