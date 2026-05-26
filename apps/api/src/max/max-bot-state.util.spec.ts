import {
  canDiscoverChatsForBotState,
  canExecuteActionsForBotState,
  createBotLifecycleStats,
  isAdminVisibleByDefaultForBotState,
  isOperationalBotState,
} from './max-bot-state.util';

describe('max bot lifecycle policy', () => {
  it('keeps route capabilities aligned with lifecycle states', () => {
    expect(isOperationalBotState('active')).toBe(true);
    expect(isOperationalBotState('draining')).toBe(true);
    expect(isOperationalBotState('dormant')).toBe(false);
    expect(isOperationalBotState('disabled')).toBe(false);

    expect(canExecuteActionsForBotState('active')).toBe(true);
    expect(canExecuteActionsForBotState('draining')).toBe(false);
    expect(canDiscoverChatsForBotState('draining')).toBe(true);
    expect(canDiscoverChatsForBotState('dormant')).toBe(false);
  });

  it('builds lifecycle stats from the same visibility policy used by config parsing', () => {
    expect(isAdminVisibleByDefaultForBotState('dormant')).toBe(true);
    expect(isAdminVisibleByDefaultForBotState('disabled')).toBe(false);

    expect(
      createBotLifecycleStats([
        { state: 'active' },
        { state: 'dormant' },
        { state: 'draining', visibleInAdmin: false },
        { state: 'disabled' },
        { state: 'disabled', visibleInAdmin: true },
      ]),
    ).toEqual({
      configured: 5,
      adminVisible: 3,
      active: 1,
      dormant: 1,
      draining: 1,
      disabled: 2,
    });
  });
});
