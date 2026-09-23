import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

const control =
  'w-full rounded-lg border border-border-strong bg-surface px-3 text-sm text-text placeholder:text-muted transition-colors focus:border-primary focus:outline-none focus:ring-3 focus:ring-primary/15 disabled:opacity-60 aria-[invalid=true]:border-danger';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(control, 'h-10', className)} {...props} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cn(control, 'min-h-24 py-2.5 leading-relaxed', className)} {...props} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...props },
  ref,
) {
  return <select ref={ref} className={cn(control, 'h-10 pr-8', className)} {...props} />;
});

/** Label + control + help/error text with the accessibility wiring done. */
export function Field({
  label,
  help,
  error,
  children,
  className,
}: {
  label: ReactNode;
  help?: ReactNode;
  error?: string;
  className?: string;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
}) {
  const id = useId();
  const described = error ? `${id}-error` : help ? `${id}-help` : undefined;
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-[13px] font-semibold text-text">
        {label}
      </label>
      {children({ id, 'aria-describedby': described, 'aria-invalid': error ? true : undefined })}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      ) : help ? (
        <p id={`${id}-help`} className="text-xs text-muted">
          {help}
        </p>
      ) : null}
    </div>
  );
}

export function Checkbox({
  label,
  description,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; description?: ReactNode }) {
  return (
    <label className={cn('flex cursor-pointer items-start gap-3 text-sm', className)}>
      <input type="checkbox" className="mt-0.5 size-4 shrink-0 rounded accent-(--primary)" {...props} />
      <span>
        <span className="font-medium text-text">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
      </span>
    </label>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </div>
  );
}
