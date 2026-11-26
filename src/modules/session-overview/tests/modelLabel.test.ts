import { describe, expect, it } from 'vitest';

import { modelLabel } from '@/modules/session-overview/api';

describe('modelLabel', () => {
  it('shows family and version', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 1M');
    expect(modelLabel('claude-fable-5-2')).toBe('Fable 5.2');
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelLabel('claude-opus-5')).toBe('Opus 5');
  });
  it('keeps unknown ids and drops empty ones', () => {
    expect(modelLabel('gpt-5')).toBe('gpt-5');
    expect(modelLabel(null)).toBeNull();
  });
});
