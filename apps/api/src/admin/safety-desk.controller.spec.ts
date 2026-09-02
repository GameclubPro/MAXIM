import { SafetyDeskController } from './safety-desk.controller';

describe('SafetyDeskController night-mode runtime pagination', () => {
  it.each([undefined, '0', '50', '1000'])(
    'passes the raw offset query value %p to the bounded service read',
    (offset) => {
      const response = { offset: offset === undefined ? 0 : Number(offset), items: [] };
      const safetyDeskService = {
        getNightModeTransitionRuntime: jest.fn().mockReturnValue(response),
      };
      const controller = new SafetyDeskController(safetyDeskService as never);

      expect(controller.getNightModeTransitionRuntime(offset)).toBe(response);
      expect(safetyDeskService.getNightModeTransitionRuntime).toHaveBeenCalledWith(offset);
    },
  );
});
