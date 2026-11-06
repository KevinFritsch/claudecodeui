import { beforeEach, describe, expect, it } from 'vitest';

import { consumePendingWorkLink, setPendingWorkLink } from '@/modules/work/pendingWorkLink';

const base = {
  projectPath: '/home/kvn/golfn',
  itemType: 'jira' as const,
  itemKey: 'GOL-1',
  sessionName: 'jira: GOL-1 Fix it',
  matchPrefix: 'jira: GOL-1 Fix',
};

describe('pending Work link', () => {
  beforeEach(() => sessionStorage.clear());

  it('links the session whose first message starts with the prefilled prompt', () => {
    setPendingWorkLink(base);
    expect(consumePendingWorkLink('/home/kvn/golfn', 'jira: GOL-1 Fix it please')?.itemKey).toBe('GOL-1');
    // consumed once
    expect(consumePendingWorkLink('/home/kvn/golfn', 'jira: GOL-1 Fix it please')).toBeNull();
  });

  it('ignores an unrelated chat started meanwhile, and keeps the link pending', () => {
    setPendingWorkLink(base);
    expect(consumePendingWorkLink('/home/kvn/golfn', 'something else')).toBeNull();
    expect(consumePendingWorkLink('/home/kvn', 'jira: GOL-1 Fix it')).toBeNull();
    expect(consumePendingWorkLink('/home/kvn/golfn', 'jira:   GOL-1\nFix it')?.itemKey).toBe('GOL-1');
  });
});
