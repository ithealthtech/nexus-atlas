import type { LayoutField } from '@atlas/shared';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui';
import { formatDate } from '@/lib/format';

/** Displays an asset field value the way its type suggests. */
export function FieldValue({ field, value }: { field: LayoutField; value: unknown }) {
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length))
    return <span className="text-muted">—</span>;
  switch (field.type) {
    case 'url':
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-primary hover:underline"
        >
          {String(value)}
        </a>
      );
    case 'email':
      return (
        <a href={`mailto:${value}`} className="text-primary hover:underline">
          {String(value)}
        </a>
      );
    case 'phone':
      return (
        <a href={`tel:${String(value).replace(/[^\d+]/g, '')}`} className="text-primary hover:underline">
          {String(value)}
        </a>
      );
    case 'date':
      return <span>{formatDate(`${value}T12:00:00`)}</span>;
    case 'checkbox':
      return <span>{value ? 'Yes' : 'No'}</span>;
    case 'multiselect':
      return <span>{(value as string[]).join(', ')}</span>;
    case 'ip':
      return <code className="font-mono text-[13px]">{String(value)}</code>;
    case 'textarea':
      return <span className="whitespace-pre-wrap">{String(value)}</span>;
    default:
      return <span className="break-words">{String(value)}</span>;
  }
}

/** Form control for one layout field. Values are controlled by the parent form. */
export function FieldInput({
  field,
  value,
  onChange,
  error,
}: {
  field: LayoutField;
  value: unknown;
  onChange: (value: unknown) => void;
  error?: string;
}) {
  const label = (
    <>
      {field.label}
      {field.required && <span className="text-danger"> *</span>}
    </>
  );
  if (field.type === 'checkbox')
    return (
      <Checkbox
        label={field.label}
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
        description={field.help || undefined}
      />
    );
  if (field.type === 'multiselect')
    return (
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-[13px] font-semibold">{label}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {field.options.map((option) => {
            const selected = Array.isArray(value) && value.includes(option);
            return (
              <Checkbox
                key={option}
                label={option}
                checked={selected}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...((value as string[]) ?? []), option]
                      : ((value as string[]) ?? []).filter((v) => v !== option),
                  )
                }
              />
            );
          })}
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
      </fieldset>
    );
  const str = value === undefined || value === null ? '' : String(value);
  return (
    <Field label={label} help={field.help || undefined} error={error}>
      {(p) =>
        field.type === 'textarea' ? (
          <Textarea {...p} value={str} onChange={(e) => onChange(e.target.value)} rows={3} />
        ) : field.type === 'select' ? (
          <Select {...p} value={str} onChange={(e) => onChange(e.target.value)}>
            <option value="">—</option>
            {field.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            {...p}
            value={str}
            onChange={(e) =>
              onChange(field.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)
            }
            type={
              field.type === 'number'
                ? 'number'
                : field.type === 'date'
                  ? 'date'
                  : field.type === 'url'
                    ? 'url'
                    : field.type === 'email'
                      ? 'email'
                      : field.type === 'phone'
                        ? 'tel'
                        : 'text'
            }
            inputMode={field.type === 'ip' ? 'decimal' : undefined}
            className={field.type === 'ip' ? 'font-mono' : undefined}
            placeholder={
              field.type === 'ip' ? '10.0.0.1 or 10.0.0.0/24' : field.type === 'url' ? 'https://' : undefined
            }
          />
        )
      }
    </Field>
  );
}
