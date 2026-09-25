import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ImagePlus, Palette, RotateCcw, Save, X } from 'lucide-react';
import {
  DEFAULT_BRANDING,
  THEME_DENSITIES,
  THEME_FONT_SCALES,
  THEME_NAV_STYLES,
  THEME_RADII,
  THEME_SIDEBAR_WIDTHS,
  type Branding,
} from '@atlas/shared';
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  Field,
  FormError,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  useToast,
} from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { contrast, readableOn, setThemePreview, useBranding } from '@/lib/branding';

const LABELS = {
  fontScale: { small: 'Small', default: 'Default', large: 'Large' },
  radius: { square: 'Square', default: 'Soft (default)', round: 'Round' },
  sidebarWidth: { narrow: 'Narrow', default: 'Default', wide: 'Wide' },
  density: { comfortable: 'Comfortable', compact: 'Compact' },
  navStyle: { filled: 'Filled highlight', bar: 'Accent bar', subtle: 'Coloured text' },
} as const;
// Atlas's own colours, used when a colour is left on default (for previews and contrast checks).
const ATLAS = { accent: '#205843', accentDark: '#6fb68f', sidebar: '#132b24', sidebarDark: '#0b1411' };

const same = (a: Branding, b: Branding) => JSON.stringify(a) === JSON.stringify(b);
const pick = (b: Branding): Branding =>
  Object.fromEntries(Object.keys(DEFAULT_BRANDING).map((k) => [k, b[k as keyof Branding]])) as Branding;

/** Administration → Theme: branding, colours, layout, and the sign-in page, previewed live across Atlas. */
export function Theme() {
  const saved = useBranding().data;
  const [draft, setDraft] = useState<Branding | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const client = useQueryClient();
  const base = useMemo(() => (saved ? pick(saved) : null), [saved]);
  const theme = draft ?? base;
  const dirty = !!(draft && base && !same(draft, base));

  // Every screen shows the draft while it's being edited; leaving the page puts the saved theme back.
  useEffect(() => setThemePreview(dirty ? draft : null), [draft, dirty]);
  useEffect(() => () => setThemePreview(null), []);

  if (!theme || !base)
    return (
      <>
        <PageHeader eyebrow="Administration" title="Theme" />
        <Skeleton className="h-96" />
      </>
    );
  const set = <K extends keyof Branding>(key: K, value: Branding[K]) => setDraft({ ...theme, [key]: value });
  const fieldError = (key: keyof Branding) => error?.fields?.[key];

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/branding', { method: 'PUT', body: theme });
      await client.invalidateQueries({ queryKey: ['branding'] });
      setDraft(null);
      toast('Theme saved. Everyone sees it the next time a page loads.');
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Theme"
        description="Your brand, colours, and layout for your team, the client portal, and the sign-in page. Changes show across Atlas as you edit; nobody else sees them until you save."
      />
      <div className="space-y-6 pb-28">
        <Card>
          <CardHeader title="Brand" description="Shown in the sidebar, the sign-in page, and the browser tab." />
          <div className="grid gap-5 p-5 sm:grid-cols-2">
            <Field
              label="Brand name"
              help={`Defaults to your organization's name (${saved?.name}).`}
              error={fieldError('brandName')}
            >
              {(p) => (
                <Input
                  {...p}
                  value={theme.brandName}
                  maxLength={60}
                  onChange={(e) => set('brandName', e.target.value)}
                />
              )}
            </Field>
            <Field label="Tagline" help="Under the name when there's no logo." error={fieldError('tagline')}>
              {(p) => (
                <Input {...p} value={theme.tagline} maxLength={80} onChange={(e) => set('tagline', e.target.value)} />
              )}
            </Field>
            <Field label="Browser tab title" help="Defaults to the brand name." error={fieldError('browserTitle')}>
              {(p) => (
                <Input
                  {...p}
                  value={theme.browserTitle}
                  maxLength={60}
                  onChange={(e) => set('browserTitle', e.target.value)}
                />
              )}
            </Field>
            <ImageField
              label="Favicon"
              help="Square PNG, SVG, or ICO, under 50 KB."
              accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon"
              maxKb={50}
              value={theme.favicon}
              onChange={(v) => set('favicon', v)}
              error={fieldError('favicon')}
              small
            />
            <ImageField
              label="Logo"
              help="PNG, JPEG, or SVG, under 150 KB. Wide logos work best."
              accept="image/png,image/jpeg,image/svg+xml"
              maxKb={150}
              value={theme.logo}
              onChange={(v) => set('logo', v)}
              error={fieldError('logo')}
              background="var(--sidebar)"
            />
            <ImageField
              label="Logo for dark mode"
              help="Optional. Used in dark mode instead of the logo above."
              accept="image/png,image/jpeg,image/svg+xml"
              maxKb={150}
              value={theme.logoDark}
              onChange={(v) => set('logoDark', v)}
              error={fieldError('logoDark')}
              background="#0b1411"
            />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Colours"
            description="Text on each colour is chosen automatically. Checks below warn when something would be hard to read."
          />
          <div className="grid gap-5 p-5 sm:grid-cols-2">
            <ColorField
              label="Accent"
              help="Buttons, links, and highlights."
              value={theme.accent}
              fallback={ATLAS.accent}
              onChange={(v) => set('accent', v)}
            />
            <ColorField
              label="Accent in dark mode"
              help="Optional. Otherwise the accent is lightened for dark mode."
              value={theme.accentDark}
              fallback={ATLAS.accentDark}
              onChange={(v) => set('accentDark', v)}
            />
            <ColorField
              label="Sidebar"
              help="The navigation panel and the sign-in page's brand panel."
              value={theme.sidebar}
              fallback={ATLAS.sidebar}
              onChange={(v) => set('sidebar', v)}
            />
            <ColorField
              label="Sidebar in dark mode"
              help="Optional. Otherwise the sidebar colour above is used."
              value={theme.sidebarDark}
              fallback={ATLAS.sidebarDark}
              onChange={(v) => set('sidebarDark', v)}
            />
          </div>
          <ContrastChecks theme={theme} />
        </Card>

        <Card>
          <CardHeader title="Layout" description="Sizing and feel for everyone, on every screen." />
          <div className="grid gap-5 p-5 sm:grid-cols-2 lg:grid-cols-3">
            <Choice
              label="Text size"
              value={theme.fontScale}
              options={THEME_FONT_SCALES}
              labels={LABELS.fontScale}
              onChange={(v) => set('fontScale', v)}
            />
            <Choice
              label="Density"
              value={theme.density}
              options={THEME_DENSITIES}
              labels={LABELS.density}
              onChange={(v) => set('density', v)}
            />
            <Choice
              label="Corners"
              value={theme.radius}
              options={THEME_RADII}
              labels={LABELS.radius}
              onChange={(v) => set('radius', v)}
            />
            <Choice
              label="Sidebar width"
              value={theme.sidebarWidth}
              options={THEME_SIDEBAR_WIDTHS}
              labels={LABELS.sidebarWidth}
              onChange={(v) => set('sidebarWidth', v)}
            />
            <Choice
              label="Current page in navigation"
              value={theme.navStyle}
              options={THEME_NAV_STYLES}
              labels={LABELS.navStyle}
              onChange={(v) => set('navStyle', v)}
            />
            <div className="flex items-end">
              <Checkbox
                checked={theme.motion}
                onChange={(e) => set('motion', e.target.checked)}
                label="Animations"
                description="Dialogs and notifications slide in. People who ask their system for less motion never see it."
              />
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Sign-in page" description="The brand panel beside the sign-in form (on wider screens)." />
          <div className="grid gap-5 p-5 sm:grid-cols-2">
            <div className="space-y-5">
              <Field
                label="Headline"
                help="Replaces “A clearer picture. For every client.”"
                error={fieldError('loginHeadline')}
              >
                {(p) => (
                  <Input
                    {...p}
                    value={theme.loginHeadline}
                    maxLength={80}
                    onChange={(e) => set('loginHeadline', e.target.value)}
                  />
                )}
              </Field>
              <Field label="Text" error={fieldError('loginText')}>
                {(p) => (
                  <Textarea
                    {...p}
                    rows={3}
                    value={theme.loginText}
                    maxLength={300}
                    onChange={(e) => set('loginText', e.target.value)}
                  />
                )}
              </Field>
            </div>
            <ImageField
              label="Background image"
              help="JPEG, PNG, or WebP, under 400 KB. It's darkened with the sidebar colour so the text stays readable."
              accept="image/jpeg,image/png,image/webp"
              maxKb={400}
              value={theme.loginBackground}
              onChange={(v) => set('loginBackground', v)}
              error={fieldError('loginBackground')}
              tall
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="Client portal" />
          <div className="p-5">
            <Field
              label="Welcome message"
              help="Shown to client contacts at the top of their dashboard."
              error={fieldError('portalWelcome')}
            >
              {(p) => (
                <Textarea
                  {...p}
                  value={theme.portalWelcome}
                  maxLength={500}
                  onChange={(e) => set('portalWelcome', e.target.value)}
                  placeholder="Welcome! Here's the documentation we keep for you. Call us at (919) 555-0100 for help."
                />
              )}
            </Field>
          </div>
        </Card>
      </div>

      <div className="fixed right-0 bottom-0 left-0 z-20 border-t border-border bg-surface/95 px-5 py-3 backdrop-blur lg:left-(--sidebar-width)">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
          <p className="mr-auto text-sm text-text-2" role="status">
            {dirty ? 'Unsaved changes. You see them everywhere; nobody else does yet.' : 'The theme is saved.'}
          </p>
          <FormError
            message={error && !error.fields ? error.message : error ? 'Check the highlighted fields.' : null}
          />
          <Button
            variant="ghost"
            onClick={() => setDraft({ ...DEFAULT_BRANDING })}
            disabled={same(theme, DEFAULT_BRANDING)}
          >
            <RotateCcw /> Atlas defaults
          </Button>
          <Button variant="secondary" onClick={() => setDraft(null)} disabled={!dirty}>
            <X /> Discard
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={!dirty}>
            <Save /> Save theme
          </Button>
        </div>
      </div>
    </>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  labels,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <Field label={label}>
      {(p) => (
        <Select {...p} value={value} onChange={(e) => onChange(e.target.value as T)}>
          {options.map((o) => (
            <option key={o} value={o}>
              {labels[o]}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

function ColorField({
  label,
  help,
  value,
  fallback,
  onChange,
}: {
  label: string;
  help: string;
  value: string | null;
  fallback: string;
  onChange: (value: string | null) => void;
}) {
  return (
    <Field label={label} help={help}>
      {(p) => (
        <div className="flex items-center gap-2">
          <input
            {...p}
            type="color"
            value={value ?? fallback}
            onChange={(e) => onChange(e.target.value)}
            className="h-10 w-14 cursor-pointer rounded-lg border border-border-strong bg-surface"
          />
          <code className="font-mono text-sm">{value ?? 'Atlas default'}</code>
          {value && (
            <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
              Use default
            </Button>
          )}
        </div>
      )}
    </Field>
  );
}

function ImageField({
  label,
  help,
  accept,
  maxKb,
  value,
  onChange,
  error,
  background,
  small,
  tall,
}: {
  label: string;
  help: string;
  accept: string;
  maxKb: number;
  value: string | null;
  onChange: (value: string | null) => void;
  error?: string;
  background?: string;
  small?: boolean;
  tall?: boolean;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const pickFile = (file: File | undefined) => {
    setProblem(null);
    if (!file) return;
    if (!accept.split(',').includes(file.type)) return setProblem(`That file type isn't supported here.`);
    if (file.size > maxKb * 1024)
      return setProblem(`Use a file under ${maxKb} KB (this one is ${Math.ceil(file.size / 1024)} KB).`);
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result));
    reader.readAsDataURL(file);
  };
  return (
    <Field label={label} help={help} error={problem ?? error}>
      {(p) => (
        <div className="space-y-2">
          <div
            className={
              'grid place-items-center overflow-hidden rounded-lg border border-dashed border-border-strong bg-surface-2 ' +
              (tall ? 'h-32' : 'h-16')
            }
            style={value && background ? { background } : undefined}
          >
            {value ? (
              <img
                src={value}
                alt={`${label} preview`}
                className={
                  small ? 'size-8 object-contain' : tall ? 'size-full object-cover' : 'max-h-12 max-w-48 object-contain'
                }
              />
            ) : (
              <span className="flex items-center gap-1.5 text-xs text-muted">
                <ImagePlus className="size-4" aria-hidden /> Using the Atlas default
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              {...p}
              type="file"
              accept={accept}
              className="pt-1.5"
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
            {value && (
              <Button variant="ghost" onClick={() => onChange(null)}>
                Remove
              </Button>
            )}
          </div>
        </div>
      )}
    </Field>
  );
}

/** Warns before saving colours that would make text hard to read (WCAG AA: 4.5:1 for normal text). */
function ContrastChecks({ theme }: { theme: Branding }) {
  const accent = theme.accent ?? ATLAS.accent;
  const sidebar = theme.sidebar ?? ATLAS.sidebar;
  const checks: { ok: boolean; text: ReactNode }[] = [
    {
      ok: contrast(accent, readableOn(accent)) >= 4.5,
      text: `Button text on the accent: ${contrast(accent, readableOn(accent)).toFixed(1)}:1`,
    },
    {
      ok: contrast(accent, '#ffffff') >= 4.5,
      text: `Accent-coloured links on white: ${contrast(accent, '#ffffff').toFixed(1)}:1${
        contrast(accent, '#ffffff') < 4.5 ? ' (pick a darker accent)' : ''
      }`,
    },
    {
      ok: contrast(sidebar, readableOn(sidebar)) >= 7,
      text: `Sidebar text: ${contrast(sidebar, readableOn(sidebar)).toFixed(1)}:1${
        contrast(sidebar, readableOn(sidebar)) < 7 ? ' (mid-tone sidebars leave less room; pick lighter or darker)' : ''
      }`,
    },
  ];
  return (
    <ul className="space-y-1.5 border-t border-border px-5 py-4 text-sm" aria-label="Readability checks">
      {checks.map((c, i) => (
        <li key={i} className="flex items-center gap-2">
          {c.ok ? (
            <CheckCircle2 className="size-4 text-success" aria-label="Passes" />
          ) : (
            <AlertTriangle className="size-4 text-warning" aria-label="Hard to read" />
          )}
          {c.text}
        </li>
      ))}
      <li className="flex items-center gap-2 text-xs text-muted">
        <Palette className="size-3.5" aria-hidden /> Checked against WCAG 2.2 AA. Switch to dark mode to review the
        dark-mode colours.
      </li>
    </ul>
  );
}
