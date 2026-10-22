import { advanceNetworkViewObservation } from './network-view-observation';

describe('observed network view intervals', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 22, 0, minutes));
  it('uses first observation as baseline and records unchanged successful coverage', () => {
    const first = advanceNetworkViewObservation(null, { observedAt: at(0), views: 500 })!;
    expect(first.interval).toBeNull();
    const next = advanceNetworkViewObservation(first.state, { observedAt: at(60), views: 500 })!;
    expect(next.interval).toEqual({ fromAt: at(0), toAt: at(60), delta: 0, quality: 'ready' });
    expect(
      advanceNetworkViewObservation(next.state, { observedAt: at(60), views: 900 }),
    ).toBeNull();
    expect(
      advanceNetworkViewObservation(next.state, { observedAt: at(59), views: 900 }),
    ).toBeNull();
  });
  it('does not inflate a regression and rebound and retains uncertain interval provenance', () => {
    let state = advanceNetworkViewObservation(null, { observedAt: at(0), views: 100 })!.state;
    for (const [minutes, views, delta] of [
      [1, 80, 0],
      [2, 100, 0],
      [3, 110, 10],
    ]) {
      const transition = advanceNetworkViewObservation(state, { observedAt: at(minutes), views })!;
      expect(transition.interval?.delta).toBe(delta);
      state = transition.state;
    }
    expect(
      advanceNetworkViewObservation(state, { observedAt: at(190), views: 130 })?.interval,
    ).toMatchObject({ delta: 20, quality: 'gap' });
    expect(advanceNetworkViewObservation(state, { observedAt: at(5), views: -1 })).toBeNull();
    expect(advanceNetworkViewObservation(state, { observedAt: at(5), views: 1.5 })).toBeNull();
  });
});
