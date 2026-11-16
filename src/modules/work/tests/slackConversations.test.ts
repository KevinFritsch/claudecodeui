import { describe, expect, it } from 'vitest';

import { groupConversations } from '@/modules/work/SlackSection';
import type { SlackMention } from '@/modules/work/api';

const base = 1_763_000_000;
let n = 0;
function message(partial: Partial<SlackMention> & { channelId: string; at: number; author: string }): SlackMention {
  const ts = `${base + partial.at}.${String((n += 1)).padStart(6, '0')}`;
  return {
    id: `${partial.channelId}:${ts}`,
    channelName: 'Devs :fr:',
    channelKind: 'group',
    ts,
    threadTs: partial.threadTs ?? ts,
    authorId: partial.author,
    authorAvatar: null,
    text: 'hi',
    permalink: 'https://slack.test',
    myReactions: [],
    replyCount: 0,
    ...partial,
  } as SlackMention;
}

describe('groupConversations', () => {
  it('folds a burst of group-DM messages into one conversation, newest last', () => {
    const burst = [0, 30, 60, 90, 120, 150, 180, 240].map((at, i) =>
      message({ channelId: 'G1', at, author: i % 2 ? 'Walid' : 'Samy' }));
    const groups = groupConversations([...burst].reverse());
    expect(groups).toHaveLength(1);
    expect(groups[0].messages.map((m) => m.id)).toEqual(burst.map((m) => m.id));
    expect(groups[0].latest.id).toBe(burst[7].id);
    expect(groups[0].isThread).toBe(false);
  });

  it('starts a new conversation after a 2 hour gap, and keeps other channels apart', () => {
    const morning = message({ channelId: 'G1', at: 0, author: 'Samy' });
    const evening = message({ channelId: 'G1', at: 3 * 3600, author: 'Samy' });
    const dm = message({ channelId: 'D1', at: 60, author: 'Jade', channelKind: 'dm' });
    const groups = groupConversations([morning, evening, dm]);
    expect(groups.map((g) => g.messages.length)).toEqual([1, 1, 1]);
    expect(groups[0].latest.id).toBe(evening.id); // newest conversation first
  });

  it('groups a thread with the message that opened it', () => {
    const root = message({ channelId: 'C1', at: 0, author: 'James', channelKind: 'channel' });
    const reply1 = message({ channelId: 'C1', at: 100, author: 'Walid', channelKind: 'channel', threadTs: root.ts });
    const reply2 = message({ channelId: 'C1', at: 200, author: 'James', channelKind: 'channel', threadTs: root.ts });
    const unrelated = message({ channelId: 'C1', at: 150, author: 'Samy', channelKind: 'channel' });
    const groups = groupConversations([root, reply1, reply2, unrelated]);
    const thread = groups.find((g) => g.isThread)!;
    expect(thread.messages.map((m) => m.id)).toEqual([root.id, reply1.id, reply2.id]);
    expect(groups.filter((g) => !g.isThread).flatMap((g) => g.messages.map((m) => m.id))).toEqual([unrelated.id]);
  });
});
