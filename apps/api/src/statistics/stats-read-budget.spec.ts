import { StatsReadBudget } from './stats-read-budget';

describe('analytics monotonic read budget', () => {
  it('shares cancellation and the original deadline across reserved phases', () => {
    let now = 1000;
    const controller = new AbortController();
    const budget = new StatsReadBudget(6000, controller.signal, () => now);
    const snapshot = budget.reserve(650);
    expect(snapshot.remainingMs()).toBe(4350);
    now = 5300;
    expect(snapshot.remainingMs()).toBe(50);
    expect(budget.remainingMs()).toBe(700);
    controller.abort();
    expect(() => snapshot.check()).toThrow();
    expect(() => budget.check()).toThrow();
  });
  it('never renews a shortened admission or exhausted response budget', () => {
    let now = 1000;
    const budget = new StatsReadBudget(1200, new AbortController().signal, () => now);
    const admission = budget.within(500);
    expect(admission.deadline).toBe(1200);
    now = 1200;
    expect(() => admission.check()).toThrow();
    expect(() => budget.reserve(50)).toThrow();
  });
});
