import { memo, useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Brain, ChevronDown } from 'lucide-react';

import type { ProviderModelOption } from '@/shared/types';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import { formatAnsweringModelLabel } from '@/modules/chat/utils/modelLabel';
import { ComposerMenuHeading, ComposerMenuItem, ComposerMenuSurface } from '@/modules/chat/composer/ComposerMenuPrimitives';

type EffortOption = NonNullable<ProviderModelOption['effort']>['values'][number];

type ComposerModelMenuProps = {
  effort: string;
  /** Effort values the active provider/model actually accepts; empty hides the effort picker. */
  effortOptions: EffortOption[];
  onSelectEffort: (effort: string) => void;
  model: string;
  /** Model catalog for the active provider; empty hides the model picker. */
  modelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  modelsLoading: boolean;
};

type PickerItem = { value: string; label: string; description?: string };

/** One-tap model switches, shown when the provider's catalog has them (Claude). */
const QUICK_MODELS = [
  { value: 'claude-opus-5-5', short: 'Opus' },
  { value: 'claude-fable-5-1', short: 'Fable' },
  { value: 'claude-sonnet-5-5', short: 'Sonnet' },
];

/** One trigger button and its popover list: one click opens it, one click picks. */
function ComposerPicker({
  ariaLabel,
  heading,
  triggerContent,
  items,
  selectedValue,
  onSelect,
  emptyText,
  itemClassName,
}: {
  ariaLabel: string;
  heading: string;
  triggerContent: ReactNode;
  items: PickerItem[];
  selectedValue: string;
  onSelect: (value: string) => void;
  emptyText?: string;
  itemClassName?: string;
}) {
  // Whether this picker's popover is showing.
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        className="flex h-8 max-w-24 shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-muted/40 px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted sm:max-w-44"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        {triggerContent}
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          <ComposerMenuHeading>{heading}</ComposerMenuHeading>
          {items.length === 0 && emptyText && (
            <p className="px-2.5 py-1.5 text-sm text-muted-foreground">{emptyText}</p>
          )}
          {items.map((item) => (
            <ComposerMenuItem
              key={item.value}
              label={item.label}
              description={item.description}
              isSelected={item.value === selectedValue}
              onSelect={() => {
                onSelect(item.value);
                setIsOpen(false);
              }}
              className={itemClassName}
            />
          ))}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}

/**
 * Rendered by chat's ChatComposer as two side-by-side pickers for the next
 * turn: the model, and the reasoning effort that model accepts.
 */
function ComposerModelMenu({
  effort,
  effortOptions,
  onSelectEffort,
  model,
  modelOptions,
  onSelectModel,
  modelsLoading,
}: ComposerModelMenuProps) {
  const { t } = useTranslation('chat');

  const defaultEffortLabel = t('composer.effortDefault', { defaultValue: 'Default' });
  const effortItems = useMemo<PickerItem[]>(
    () => (effortOptions.length > 0
      ? [{ value: DEFAULT_EFFORT_VALUE }, ...effortOptions].map((option) => ({
        value: option.value,
        label: option.value === DEFAULT_EFFORT_VALUE ? defaultEffortLabel : option.value,
        description: option.description,
      }))
      : []),
    [defaultEffortLabel, effortOptions],
  );
  const modelItems = useMemo<PickerItem[]>(
    () => modelOptions.map((option) => ({ value: option.value, label: option.label || option.value })),
    [modelOptions],
  );

  const selectedModelOption = modelOptions.find((option) => option.value === model) ?? null;
  // A model saved before the catalog listed exact versions (e.g. `opus`) still reads as its family.
  const modelLabel = selectedModelOption?.label || formatAnsweringModelLabel(model) || model;
  const effortLabel = effort === DEFAULT_EFFORT_VALUE ? defaultEffortLabel : effort;

  const hasModelPicker = modelOptions.length > 0 || modelsLoading;
  const quickModels = QUICK_MODELS.filter((quick) => modelOptions.some((option) => option.value === quick.value));
  const showQuickModels = quickModels.length >= 2;
  const isQuickModelSelected = showQuickModels && quickModels.some((quick) => quick.value === model);
  const hasEffortPicker = effortItems.length > 0;

  return (
    <>
      {showQuickModels && (
        <div
          role="radiogroup"
          aria-label={t('composer.quickModels', { defaultValue: 'Quick model switch' })}
          className="flex h-8 shrink-0 items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5"
        >
          {quickModels.map((quick) => {
            const option = modelOptions.find((candidate) => candidate.value === quick.value);
            const isActive = quick.value === model;
            return (
              <button
                key={quick.value}
                type="button"
                role="radio"
                aria-checked={isActive}
                title={option?.label || quick.short}
                onClick={() => {
                  if (!isActive) onSelectModel(quick.value);
                }}
                className={
                  isActive
                    ? 'h-7 rounded-md bg-background px-1.5 text-xs font-semibold sm:px-2 text-foreground shadow-sm ring-1 ring-border/60'
                    : 'h-7 rounded-md px-1.5 text-xs font-medium sm:px-2 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground'
                }
              >
                {quick.short}
              </button>
            );
          })}
        </div>
      )}
      {hasModelPicker && (
        <ComposerPicker
          ariaLabel={t('composer.modelPicker', { defaultValue: 'Select model' })}
          heading={t('composer.model', { defaultValue: 'Model' })}
          // With a quick switch active the dropdown is just the way to the other models.
          triggerContent={isQuickModelSelected
            ? <span className="sr-only">{t('composer.otherModels', { defaultValue: 'Other models' })}</span>
            : <span className="truncate">{modelLabel}</span>}
          items={modelItems}
          selectedValue={model}
          onSelect={onSelectModel}
          emptyText={modelsLoading ? t('composer.loadingModels', { defaultValue: 'Loading models…' }) : undefined}
        />
      )}
      {hasEffortPicker && (
        <ComposerPicker
          ariaLabel={t('composer.effortPicker', { defaultValue: 'Select reasoning effort' })}
          heading={t('composer.reasoning', { defaultValue: 'Reasoning' })}
          triggerContent={(
            <>
              <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate capitalize">{effortLabel}</span>
            </>
          )}
          items={effortItems}
          selectedValue={effort}
          onSelect={onSelectEffort}
          itemClassName="capitalize"
        />
      )}
    </>
  );
}

/** Memoized: the composer re-renders on every keystroke and none of these pickers' props change while typing. */
export default memo(ComposerModelMenu);
