import { z } from 'zod';

// ---------- checklists (templates) and their runs ----------
const stepText = z.string().trim().min(1, 'A step needs some text.').max(500);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-31.')
  .nullable()
  .default(null);

export const checklistSchema = z.object({
  title: z.string().trim().min(1, 'Title is required.').max(200),
  description: z.string().trim().max(2000).default(''),
  steps: z
    .array(z.object({ id: z.string().max(40).optional(), text: stepText }))
    .min(1, 'Add at least one step.')
    .max(200),
  clientId: z.string().uuid().nullable().default(null),
});
export const updateChecklistSchema = checklistSchema.omit({ clientId: true }).partial();

export const startRunSchema = z
  .object({
    checklistId: z.string().uuid().optional(),
    // A one-off run without a template.
    title: z.string().trim().min(1).max(200).optional(),
    steps: z.array(stepText).min(1).max(200).optional(),
    assigneeId: z.string().uuid().nullable().default(null),
    dueDate: date,
  })
  .refine((v) => v.checklistId || (v.title && v.steps), 'Choose a checklist, or give a title and steps.');
export const updateRunSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  dueDate: date.optional(),
});
export const tickStepSchema = z.object({
  done: z.boolean(),
  note: z.string().trim().max(1000).optional(),
});

export interface ChecklistView {
  id: string;
  clientId: string | null;
  clientName: string | null;
  title: string;
  description: string;
  steps: { id: string; text: string }[];
  archived: boolean;
  updatedAt: string;
  canEdit: boolean;
}

export interface RunStep {
  id: string;
  text: string;
  doneAt: string | null;
  doneBy: string | null;
  doneByName: string | null;
  note: string;
}
export interface RunView {
  id: string;
  clientId: string;
  clientName: string;
  checklistId: string | null;
  title: string;
  steps: RunStep[];
  done: number;
  total: number;
  assigneeId: string | null;
  assigneeName: string | null;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
  createdByName: string | null;
  canEdit: boolean;
}
