import { Search, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/shared/utils';
import { workApi } from '@/modules/work/api';
import type * as EmojiDataModule from '@/modules/work/slackEmoji.data';

/**
 * Kevin's "Frequently used" in Slack (the API does not expose it), in his
 * order. Reactions picked here move up as they get used.
 */
export const FREQUENT_EMOJI: Array<[string, string]> = [
  ['+1', '👍'], ['white_check_mark', '✅'], ['handshake', '🤝'], ['fire', '🔥'], ['100', '💯'], ['heart', '❤️'],
  ['ok_hand', '👌'], ['joy', '😂'], ['pray', '🙏'], ['rolling_on_the_floor_laughing', '🤣'], ['melting_face', '🫠'],
  ['heart_eyes', '😍'], ['eyes', '👀'], ['heart_hands', '🫶'], ['saluting_face', '🫡'], ['laughing', '😆'], ['tada', '🎉'],
  ['sweat_smile', '😅'], ['raised_hands', '🙌'], ['neutral_face', '😐'], ['crossed_fingers', '🤞'], ['expressionless', '😑'],
  ['sunglasses', '😎'], ['wink', '😉'], ['face_holding_back_tears', '🥹'], ['heavy_check_mark', '✔️'], ['open_mouth', '😮'],
  ['partying_face', '🥳'], ['upside_down_face', '🙃'], ['x', '❌'], ['rocket', '🚀'], ['confetti_ball', '🎊'],
  ['arrows_counterclockwise', '🔄'], ['boom', '💥'], ['face_with_peeking_eye', '🫣'],
];

const USAGE_KEY = 'kvn-work-emoji-usage';
type Usage = Record<string, { n: number; char: string | null; at: number }>;

function readUsage(): Usage {
  try {
    return JSON.parse(localStorage.getItem(USAGE_KEY) ?? '{}') as Usage;
  } catch {
    return {};
  }
}

export function recordEmojiUse(name: string, char: string | null) {
  try {
    const usage = readUsage();
    usage[name] = { n: (usage[name]?.n ?? 0) + 1, char, at: Date.now() };
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
  } catch {
    // Usage only reorders the list; fine to lose.
  }
}

/** Frequently used: Slack's list, with the ones picked here most often first. */
export function frequentEmoji(): Array<{ name: string; char: string | null }> {
  const usage = readUsage();
  const base = new Map<string, string | null>(FREQUENT_EMOJI.map(([name, char]) => [name, char]));
  for (const [name, entry] of Object.entries(usage)) if (!base.has(name)) base.set(name, entry.char);
  const order = [...base.keys()];
  return order
    .map((name, index) => ({ name, char: base.get(name) ?? null, score: usage[name]?.n ?? 0, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 36)
    .map(({ name, char }) => ({ name, char }));
}

type EmojiData = typeof EmojiDataModule;
let dataPromise: Promise<EmojiData> | null = null;
let customPromise: Promise<Record<string, string> | null> | null = null;

function EmojiGlyph({ char, name, custom }: { char: string | null; name: string; custom: Record<string, string> | null }) {
  const url = custom?.[name];
  if (!char && url) return <img src={url} alt={name} className="h-6 w-6 object-contain" />;
  return <span className="text-[22px] leading-none">{char ?? '❔'}</span>;
}

/**
 * Slack-style reaction picker: Frequently used first, then every emoji by
 * category, with a search on Slack names. Floats next to its anchor (a bottom
 * sheet on phones) so the column's scroll does not clip it.
 */
export default function EmojiPicker({
  anchor,
  onPick,
  onClose,
}: {
  anchor: HTMLElement | null;
  onPick: (name: string, char: string | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [data, setData] = useState<EmojiData | null>(null);
  const [custom, setCustom] = useState<Record<string, string> | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const isPhone = typeof window !== 'undefined' && window.innerWidth < 640;
  const frequent = useMemo(() => frequentEmoji(), []);

  useEffect(() => {
    dataPromise ??= import('@/modules/work/slackEmoji.data');
    customPromise ??= workApi.slackCustomEmoji().then((r) => r.custom).catch(() => null);
    let alive = true;
    void dataPromise.then((d) => alive && setData(d));
    void customPromise.then((c) => alive && setCustom(c));
    return () => {
      alive = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (isPhone || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = 340;
    const height = 380;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below;
    setPosition({ top, left });
  }, [anchor, isPhone]);

  useEffect(() => {
    const onDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (boxRef.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('touchstart', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  const needle = query.trim().toLowerCase().replace(/^:|:$/g, '');
  const results = useMemo(() => {
    if (!needle) return null;
    const found: Array<{ name: string; char: string | null }> = [];
    for (const [char, name, aliases] of data?.SLACK_EMOJI ?? []) {
      if (name.includes(needle) || aliases.includes(needle)) found.push({ name, char });
    }
    for (const name of Object.keys(custom ?? {})) if (name.includes(needle)) found.push({ name, char: null });
    // Names that start with the query first ("eye" → eyes before heart_eyes).
    return found
      .sort((a, b) => Number(!a.name.startsWith(needle)) - Number(!b.name.startsWith(needle)))
      .slice(0, 160);
  }, [custom, data, needle]);

  const grid = (items: Array<{ name: string; char: string | null }>) => (
    <div className="grid grid-cols-8 gap-0.5 sm:grid-cols-9">
      {items.map((item) => (
        <button
          key={item.name}
          type="button"
          title={`:${item.name}:`}
          onClick={() => onPick(item.name, item.char)}
          className="flex h-9 w-9 items-center justify-center rounded-md transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
        >
          <EmojiGlyph char={item.char} name={item.name} custom={custom} />
        </button>
      ))}
    </div>
  );

  const sections = useMemo(() => {
    if (!data) return [];
    return data.SLACK_EMOJI_CATEGORIES.map((title, index) => ({
      title,
      items: data.SLACK_EMOJI.filter((e) => e[3] === index).map(([char, name]) => ({ name, char })),
    }));
  }, [data]);
  const customItems = Object.keys(custom ?? {}).sort().map((name) => ({ name, char: null }));

  const body = (
    <div
      ref={boxRef}
      role="dialog"
      aria-label="Add a reaction"
      style={isPhone ? undefined : { top: position?.top ?? -9999, left: position?.left ?? -9999 }}
      className={cn(
        'fixed z-[60] flex flex-col overflow-hidden border border-border bg-popover text-popover-foreground shadow-xl',
        isPhone ? 'inset-x-0 bottom-0 h-[60vh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]' : 'h-[380px] w-[340px] rounded-xl',
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/70 px-2.5 py-2">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          autoFocus={!isPhone}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const first = results?.[0];
              if (first) onPick(first.name, first.char);
            }
          }}
          placeholder="Search emoji (fire, 100, thumbs…)"
          className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
        />
        <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {results ? (
          results.length ? <div className="pt-2">{grid(results)}</div> : <p className="px-1 py-3 text-xs text-muted-foreground">No emoji named “{needle}”.</p>
        ) : (
          <>
            <h4 className="sticky top-0 z-10 bg-popover px-1 pb-1 pt-2 text-[11px] font-semibold text-muted-foreground">Frequently used</h4>
            {grid(frequent)}
            {customItems.length > 0 && (
              <>
                <h4 className="sticky top-0 z-10 bg-popover px-1 pb-1 pt-3 text-[11px] font-semibold text-muted-foreground">Custom</h4>
                {grid(customItems)}
              </>
            )}
            {!data && <p className="px-1 py-3 text-xs text-muted-foreground">Loading emoji…</p>}
            {sections.map((section) => (
              <div key={section.title}>
                <h4 className="sticky top-0 z-10 bg-popover px-1 pb-1 pt-3 text-[11px] font-semibold text-muted-foreground">{section.title}</h4>
                {grid(section.items)}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );

  return createPortal(
    <>
      {isPhone && <div className="fixed inset-0 z-[59] bg-black/30" aria-hidden />}
      {body}
    </>,
    document.body,
  );
}
