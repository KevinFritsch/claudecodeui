import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, RotateCcw } from 'lucide-react';

import { cn } from '@/shared/utils';
import { colorFromText, isHexColor, withAlpha } from '@/modules/sidebar/utils/projectColor';

/** Hand-picked colours that sit well on the dark and light sidebar. */
const COLOR_SWATCHES = [
  '#f87171', '#fb923c', '#fbbf24', '#a3e635',
  '#4ade80', '#2dd4bf', '#38bdf8', '#60a5fa',
  '#818cf8', '#a78bfa', '#e879f9', '#f472b6',
];

const POPOVER_WIDTH = 232;

type ProjectColorPickerProps = {
  projectName: string;
  color: string;
  isCustom: boolean;
  onChange: (color: string | null) => void;
  size?: 'sm' | 'md';
};

/**
 * Used by the sidebar's project rows: the project's colour tile (its initial
 * on a tint of the colour), which opens a swatch popover to change it.
 */
export function ProjectColorPicker({ projectName, color, isCustom, onChange, size = 'sm' }: ProjectColorPickerProps) {
  // Whether the colour popover is showing.
  const [isOpen, setIsOpen] = useState(false);
  // Where the popover is drawn; measured from the tile because the sidebar scrolls and clips.
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  // What the hex field shows while being typed into; applied only once it is a valid colour.
  const [hexDraft, setHexDraft] = useState(color);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const autoColor = colorFromText(projectName);
  const initial = projectName.trim().charAt(0).toUpperCase() || '?';

  const close = useCallback(() => setIsOpen(false), []);

  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - POPOVER_WIDTH - 8);
    setPosition({ left, top: rect.bottom + 6 });
    setHexDraft(color);
  }, [color, isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popoverRef.current?.contains(target) && !triggerRef.current?.contains(target)) close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', close);
    };
  }, [close, isOpen]);

  const choose = (next: string | null) => {
    onChange(next);
    setIsOpen(false);
  };

  const tileSize = size === 'md' ? 'h-8 w-8 text-sm' : 'h-7 w-7 text-xs';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Change color of ${projectName}`}
        title="Change project color"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((current) => !current);
        }}
        className={cn(
          'flex flex-shrink-0 items-center justify-center rounded-lg font-semibold transition-transform duration-150 hover:scale-105 active:scale-95',
          tileSize,
        )}
        style={{
          backgroundColor: withAlpha(color, 0.16),
          color,
          boxShadow: `inset 0 0 0 1px ${withAlpha(color, 0.35)}`,
        }}
      >
        {initial}
      </button>

      {isOpen && position && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={`Color for ${projectName}`}
          className="fixed z-[100] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-2xl"
          style={{ left: position.left, top: position.top, width: POPOVER_WIDTH }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-xs font-medium text-foreground">Project color</span>
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: color }} aria-hidden />
          </div>

          <div className="grid grid-cols-6 gap-2">
            {COLOR_SWATCHES.map((swatch) => {
              const isSelected = isCustom && swatch === color;
              return (
                <button
                  key={swatch}
                  type="button"
                  aria-label={`Use ${swatch}`}
                  onClick={() => choose(swatch)}
                  className="relative flex h-7 w-7 items-center justify-center rounded-full transition-transform duration-150 hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  style={{
                    backgroundColor: swatch,
                    boxShadow: isSelected ? `0 0 0 2px hsl(var(--popover)), 0 0 0 4px ${swatch}` : undefined,
                  }}
                >
                  {isSelected && <Check className="h-3.5 w-3.5 text-black/70" strokeWidth={3} />}
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <label
              className="relative h-7 w-7 flex-shrink-0 cursor-pointer overflow-hidden rounded-full border border-border"
              style={{ background: 'conic-gradient(#f87171, #fbbf24, #4ade80, #38bdf8, #a78bfa, #f472b6, #f87171)' }}
              title="Pick any color"
            >
              <input
                type="color"
                value={color}
                onChange={(event) => {
                  setHexDraft(event.target.value);
                  onChange(event.target.value);
                }}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                aria-label="Pick any color"
              />
            </label>
            <input
              type="text"
              value={hexDraft}
              spellCheck={false}
              maxLength={7}
              onChange={(event) => {
                const next = event.target.value.startsWith('#') ? event.target.value : `#${event.target.value}`;
                setHexDraft(next);
                if (isHexColor(next)) onChange(next);
              }}
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-xs uppercase text-foreground focus:border-primary/60 focus:outline-none"
              aria-label="Hex color"
            />
          </div>

          <button
            type="button"
            onClick={() => choose(null)}
            disabled={!isCustom}
            className="mt-3 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <RotateCcw className="h-3 w-3" />
            <span className="flex-1 text-left">Auto from name</span>
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: autoColor }} aria-hidden />
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
