import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MENU_STYLES, MENU_STYLE_INFO, type MenuStyle, type WorkspacePrefs } from '@atlas/shared';
import { Card, CardHeader, Skeleton, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useWorkspacePrefs } from '@/lib/queries';

/** A small drawing of where each menu style puts things, so the choice can be made by eye. */
function Sketch({ style }: { style: MenuStyle }) {
  const menu = 'bg-sidebar';
  const line = 'h-1 rounded-full bg-border-strong';
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
          <div className={cn(menu, 'w-3 brightness-75')} />
          <div className={cn(menu, 'w-8')} />
        </>
      )}
      {style === 'sidebar' && <div className={cn(menu, 'w-9')} />}
      {style === 'top' && (
        <>
          <div className={cn(menu, 'h-3')} />
          <div className="h-2 border-b border-border bg-surface" />
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
        description="How the main menu is laid out on a computer. Only you see this choice; phones always use a slide-out menu."
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
