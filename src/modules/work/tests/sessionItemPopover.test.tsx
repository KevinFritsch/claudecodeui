import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SessionItemPopover from '@/modules/work/SessionItemPopover';
import type * as ApiModule from '@/modules/work/api';
import type { SessionLinkView, SlackMention } from '@/modules/work/api';

const transition = vi.fn();
const slackDone = vi.fn();
vi.mock('@/modules/work/api', async (original) => ({
  ...(await original<typeof ApiModule>()),
  workApi: {
    transition: (...args: unknown[]) => transition(...args),
    slackDone: (...args: unknown[]) => slackDone(...args),
    slackCustomEmoji: async () => ({ custom: null }),
  },
}));

afterEach(() => {
  cleanup();
  transition.mockReset();
  slackDone.mockReset();
});

const ACTIONS = ['In Progress', 'Pull Request', 'QA', 'QA App', 'Done', 'Canceled'];
const anchor = () => document.body.appendChild(document.createElement('span'));

const jiraLink: SessionLinkView = {
  itemType: 'jira', itemKey: 'GOL-3590', label: 'GOL-3590', title: 'Create Offer endpoint', url: 'https://jira.test/browse/GOL-3590',
  status: 'In Progress', derived: false,
  jira: {
    key: 'GOL-3590', summary: 'Create Offer endpoint', status: 'In Progress', statusCategory: 'indeterminate', issueType: 'Story',
    priority: 'Medium', updated: '2026-11-20T10:00:00Z', url: 'https://jira.test/browse/GOL-3590',
    sprint: { name: 'GOL Sprint 88', state: 'active' }, carriedOverSprints: 0,
  },
};

describe('SessionItemPopover', () => {
  it('offers the Jira moves, puts the usual next step first, and can undo', async () => {
    transition.mockResolvedValueOnce({ key: 'GOL-3590', from: 'In Progress', to: 'QA' });
    const onChanged = vi.fn();
    render(<SessionItemPopover link={jiraLink} anchor={anchor()} projectPath="/p" jiraActions={ACTIONS} onChanged={onChanged} onDetach={() => undefined} onClose={() => undefined} />);

    // The current status is not offered; the step after it is the highlighted one.
    expect(screen.queryByRole('button', { name: 'In Progress' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Pull Request' }).getAttribute('title')).toBe('The usual next step');

    fireEvent.click(screen.getByRole('button', { name: 'QA' }));
    await waitFor(() => expect(screen.getByText('GOL-3590 moved to QA')).toBeTruthy());
    expect(transition).toHaveBeenCalledWith('/p', 'GOL-3590', 'QA');
    expect(onChanged).toHaveBeenCalled();
    // Now on QA: QA is gone from the choices, QA App is next.
    expect(screen.queryByRole('button', { name: 'QA' })).toBeNull();
    expect(screen.getByRole('button', { name: 'QA App' }).getAttribute('title')).toBe('The usual next step');

    transition.mockResolvedValueOnce({ key: 'GOL-3590', from: 'QA', to: 'In Progress' });
    fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
    await waitFor(() => expect(transition).toHaveBeenLastCalledWith('/p', 'GOL-3590', 'In Progress'));
  });

  it('shows the Slack conversation with its actions, and Done closes the whole group', async () => {
    const base = Math.floor(Date.now() / 1000) - 600;
    const message = (n: number, author: string, text: string): SlackMention => ({
      id: `D1:${base + n}.000100`, channelId: 'D1', channelName: 'DM · jade', channelKind: 'dm', ts: `${base + n}.000100`, threadTs: `${base + n}.000100`,
      author, authorId: author, authorAvatar: null, text, permalink: 'https://slack.test/x', myReactions: [], replyCount: 0,
    });
    const first = message(0, 'Jade', 'Does the cash radar doc make sense?');
    const second = message(60, 'Jade', 'Also the gift guide');
    slackDone.mockResolvedValueOnce({ id: second.id, done: true, emoji: 'white_check_mark' });
    const link: SessionLinkView = {
      itemType: 'slack', itemKey: first.id, label: '@Jade', title: first.text, url: first.permalink, status: 'waiting', derived: false,
      slack: { messages: [first, second], waiting: true },
    };
    render(<SessionItemPopover link={link} anchor={anchor()} projectPath="/p" jiraActions={[]} onChanged={() => undefined} onDetach={() => undefined} onClose={() => undefined} />);

    expect(screen.getByText('Does the cash radar doc make sense?')).toBeTruthy();
    expect(screen.getByText('Also the gift guide')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Reply$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /AI reply/ })).toBeTruthy();
    expect(screen.queryByText(/Start session/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Done/ }));
    // ✅ goes on the newest message; the older one is closed with it.
    await waitFor(() => expect(slackDone).toHaveBeenCalledWith('/p', second.id, true, 'white_check_mark', [first.id]));
    await waitFor(() => expect(screen.getByText(/added in Slack/)).toBeTruthy());
  });
});
