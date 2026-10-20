import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MENU_STYLES, MENU_STYLE_INFO, type MenuStyle, type WorkspacePrefs } from '@atlas/shared';
import { Card, CardHeader, Skeleton, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useWorkspacePrefs } from '@/lib/queries';

/** A small drawing of where each menu style puts things, so the choice can be made by eye. */
function Sketch({ style }: { style: MenuStyle }) {
  const line = 'h-1 rounded-full bg-border-strong';
  const item = (active?: boolean) => cn('h-1 rounded-full', active ? 'bg-primary' : 'bg-border-strong opacity-70');
  const page = (
    <div className="flex-1 space-y-1.5 p-2">
      <div className={cn(line, 'w-1/3')} />
      <div className={cn(line, 'w-full opacity-60')} />
      <div className={cn(line, 'w-full opacity-60')} />
      <div className={cn(line, 'w-2/3 opacity-60')} />
    </div>
  );
  return (
    <div
      aria-hidden
      className={cn('flex h-16 overflow-hidden rounded border border-border bg-bg', style === 'top' && 'flex-col')}
    >
      {style === 'rail' && (
        <>
          <div className="flex w-3.5 flex-col items-center gap-1 border-r border-border bg-surface pt-1.5">
            {[true, false, false, false].map((active, i) => (
              <div key={i} className={cn('size-1.5 rounded-sm', active ? 'bg-primary' : 'bg-border-strong')} />
            ))}
          </div>
          <div className="w-8 space-y-1 border-r border-border bg-surface p-1.5">
            <div className={item(true)} />
            <div className={item()} />
            <div className={item()} />
          </div>
        </>
      )}
      {style === 'sidebar' && (
        <div className="w-11 space-y-1 border-r border-border bg-surface p-1.5">
          <div className={item(true)} />
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className={item()} />
          ))}
        </div>
      )}
      {style === 'top' && (
        <>
          <div className="flex h-3.5 shrink-0 items-center gap-1 border-b border-border bg-surface px-1.5">
            <div className="h-1 w-3 rounded-full bg-primary" />
            <div className="h-1 w-3 rounded-full bg-border-strong" />
            <div className="h-1 w-3 rounded-full bg-border-strong" />
          </div>
          <div className="flex h-2.5 shrink-0 items-center gap-1 border-b border-border bg-surface px-1.5">
            <div className="h-0.5 w-2.5 rounded-full bg-primary" />
            <div className="h-0.5 w-2.5 rounded-full bg-border-strong" />
          </div>
        </>
      )}
      {page}
    </div>
  );
}

/** Each person's choice of main menu. It is saved to their account, so it follows them to any browser. */
export function MenuStylePicker() {
  const prefs = useWorkspacePrefs();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState<MenuStyle | null>(null);
  const choose = async (menu: MenuStyle) => {
    if (!prefs.data || prefs.data.menu === menu) return;
    setSaving(menu);
    try {
      const saved = await api<WorkspacePrefs>('/account/workspace', {
        method: 'PUT',
        body: { ...prefs.data, menu },
      });
      queryClient.setQueryData(['workspace'], saved);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(null);
    }
  };
  return (
    <Card>
      <CardHeader
        title="Menu"
        description="How the main menu is laid out on a computer. Only you see this choice, and it follows you to any browser. Phones always use a slide-out menu."
      />
      {!prefs.data ? (
        <Skeleton className="m-5 h-28" />
      ) : (
        <div role="radiogroup" aria-label="Menu style" className="grid gap-3 p-5 sm:grid-cols-3">
          {MENU_STYLES.map((style) => {
            const chosen = (saving ?? prefs.data.menu) === style;
            return (
              <button
                key={style}
                type="button"
                role="radio"
                aria-checked={chosen}
                onClick={() => void choose(style)}
                className={cn(
                  'rounded-md border p-3 text-left transition-colors',
                  chosen ? 'border-primary bg-primary-soft' : 'border-border hover:border-border-strong',
                )}
              >
                <Sketch style={style} />
                <span className="mt-2.5 block text-sm font-semibold text-text">{MENU_STYLE_INFO[style].label}</span>
                <span className="mt-0.5 block text-xs text-text-2">{MENU_STYLE_INFO[style].description}</span>
              </button>
            );
          })}
        </div>
      )}
    </Card>
  );
}
