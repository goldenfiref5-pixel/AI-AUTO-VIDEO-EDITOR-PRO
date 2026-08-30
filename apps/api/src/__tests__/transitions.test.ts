import { describe, expect, it } from 'vitest';
import type { TransitionSettings } from '@aiedit/shared';
import { kenBurnsFilter, resolveTransition } from '../render/transitions';

const base: TransitionSettings = {
  enabled: true,
  types: [],
  intensity: 0.5,
  durationSec: 0.4,
};

const context = {
  index: 0,
  previousDurationSec: 4,
  nextDurationSec: 4,
  isBeatChange: false,
  requested: null,
};

describe('resolveTransition', () => {
  it('returns hard cuts when transitions are disabled', () => {
    const result = resolveTransition({ ...base, enabled: false }, context);
    expect(result.xfade).toBeNull();
    expect(result.durationSec).toBe(0);
  });

  it('honours an explicitly requested transition', () => {
    const result = resolveTransition(base, { ...context, requested: 'zoom' });
    expect(result.type).toBe('zoom');
    expect(result.xfade).toBe('zoomin');
  });

  it('maps match cuts to a hard cut, because that is what a match cut is', () => {
    const result = resolveTransition(base, { ...context, requested: 'match_cut' });
    expect(result.xfade).toBeNull();
  });

  it('never exceeds 40% of the shorter neighbouring clip', () => {
    const result = resolveTransition(
      { ...base, durationSec: 3 },
      { ...context, requested: 'fade', previousDurationSec: 1, nextDurationSec: 5 },
    );
    expect(result.durationSec).toBeLessThanOrEqual(0.4);
  });

  it('is deterministic for the same cut index', () => {
    const a = resolveTransition(base, { ...context, index: 7 });
    const b = resolveTransition(base, { ...context, index: 7 });
    expect(a).toEqual(b);
  });

  it('stylises beat changes at moderate intensity', () => {
    const result = resolveTransition(base, { ...context, isBeatChange: true });
    expect(result.xfade).not.toBeNull();
  });

  it('produces mostly hard cuts at zero intensity', () => {
    const stylised = Array.from({ length: 40 }, (_, i) =>
      resolveTransition({ ...base, intensity: 0 }, { ...context, index: i }),
    ).filter((t) => t.xfade !== null);
    expect(stylised).toHaveLength(0);
  });
});

describe('kenBurnsFilter', () => {
  const params = { durationSec: 4, fps: 30, width: 1080, height: 1920 };

  it('builds a zoompan chain with the right frame count', () => {
    const filter = kenBurnsFilter({ ...params, motion: 'push_in' });
    expect(filter).toContain('zoompan=');
    expect(filter).toContain('d=120');
    expect(filter).toContain('s=1080x1920');
  });

  it('holds zoom at 1 for a static shot', () => {
    const filter = kenBurnsFilter({ ...params, motion: 'static' });
    expect(filter).toContain("z='1'");
  });

  it('pans horizontally rather than zooming for pan moves', () => {
    const filter = kenBurnsFilter({ ...params, motion: 'pan_right' });
    expect(filter).toContain("x='(iw-iw/zoom)*(on/120)'");
  });

  it('falls back to a push-in for an unknown motion name', () => {
    const filter = kenBurnsFilter({ ...params, motion: 'nonsense' });
    expect(filter).toContain('zoompan=');
  });
});
