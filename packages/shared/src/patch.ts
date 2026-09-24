import { z } from 'zod';

/**
 * Like `.partial()`, but drops field defaults. zod's `.partial()` keeps them, so a PATCH that sends one field
 * would silently reset every other defaulted field.
 */
export function patchOf<T extends z.ZodRawShape>(object: z.ZodObject<T>) {
  const shape = Object.fromEntries(
    Object.entries(object.shape).map(([key, field]) => {
      const inner = field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : (field as z.ZodType);
      return [key, inner.optional()];
    }),
  );
  return z.object(shape) as unknown as ReturnType<z.ZodObject<T>['partial']>;
}
