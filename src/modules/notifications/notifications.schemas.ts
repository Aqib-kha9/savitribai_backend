import { z } from 'zod';

/**
 * Notifications schemas (docs/backend-master-spec.md §18).
 *
 * The notification subsystem is a delivery OUTBOX: business modules enqueue
 * notification_outbox rows (through this module or directly), a worker drains
 * the queue through the configured gateway channels, and every delivery attempt
 * is recorded in notification_delivery_log. This module exposes the two admin
 * surfaces the spec requires:
 *   - template administration (notification_template) — list / create / update,
 *     with is_mandatory enforced (transaction-balance + approval messages can
 *     never be disabled, §18.1);
 *   - outbox & delivery history (notification_outbox / notification_delivery_log)
 *     — filtered list, detail, retry of failed/skipped items, cancel of queued
 *     items, and the 30-day delivery history (spec §18.1).
 *
 * Vocabulary mirrors the 001_schema.sql CHECK constraints:
 *   - channel: sms | whatsapp | email | app_notification | voice_call |
 *     printed_receipt
 *   - status: queued | sending | sent | failed | skipped
 *
 * event_type is a TEXT column (no CHECK), but the template CRUD surface only
 * accepts the events the business has defined — the seeded NOTIFICATION_TEMPLATES
 * plus the spec §18 pre-maturity reminder and M.D. security alert.
 */

export const uuidSchema = z.string().uuid('Invalid id format');

/** Delivery channels — mirrors notification_template.channel CHECK. */
export const notificationChannelSchema = z.enum([
  'sms',
  'whatsapp',
  'email',
  'app_notification',
  'voice_call',
  'printed_receipt',
]);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

/**
 * Business events that trigger notifications. Covers every seeded template
 * (seed.ts NOTIFICATION_TEMPLATES) plus the spec §18 FD pre-maturity reminder
 * and M.D. security alert events.
 */
export const notificationEventTypeSchema = z.enum([
  'collection.recorded',
  'withdrawal.paid',
  'loan.instalment_due',
  'rd.instalment_due',
  'fd.matured',
  'fd.maturity_reminder',
  'account.opened',
  'security.alert',
]);
export type NotificationEventType = z.infer<typeof notificationEventTypeSchema>;

/** Outbox lifecycle — mirrors notification_outbox.status CHECK. */
export const notificationStatusSchema = z.enum([
  'queued',
  'sending',
  'sent',
  'failed',
  'skipped',
]);
export type NotificationStatus = z.infer<typeof notificationStatusSchema>;

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

// ---------------------------------------------------------------------------
// Template administration
// ---------------------------------------------------------------------------

/** GET /templates query — filter by event, channel, language, active flag. */
export const listTemplatesQuerySchema = z.object({
  eventType: notificationEventTypeSchema.optional(),
  channel: notificationChannelSchema.optional(),
  language: z.string().trim().min(2).max(10).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListTemplatesQuery = z.infer<typeof listTemplatesQuerySchema>;

/** POST /templates body — unique on (event_type, channel, language). */
export const createTemplateSchema = z.object({
  eventType: notificationEventTypeSchema,
  channel: notificationChannelSchema,
  language: z.string().trim().min(2).max(10).default('en'),
  templateBody: z.string().trim().min(1).max(2000),
  isMandatory: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

/** PATCH /templates/:id body — partial update; mandatory templates stay active. */
export const updateTemplateSchema = z
  .object({
    templateBody: z.string().trim().min(1).max(2000).optional(),
    isActive: z.boolean().optional(),
    isMandatory: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

export const templateIdParamSchema = z.object({ id: uuidSchema });
export type TemplateIdParam = z.infer<typeof templateIdParamSchema>;

// ---------------------------------------------------------------------------
// Outbox & delivery history
// ---------------------------------------------------------------------------

/** GET /outbox query — filter by status/event/channel/actor and IST day range. */
export const listOutboxQuerySchema = z
  .object({
    status: notificationStatusSchema.optional(),
    eventType: notificationEventTypeSchema.optional(),
    channel: notificationChannelSchema.optional(),
    customerId: uuidSchema.optional(),
    staffId: uuidSchema.optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .superRefine((value, ctx) => {
    if (value.from !== undefined && value.to !== undefined && value.from > value.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: 'from must not be after to',
      });
    }
  });
export type ListOutboxQuery = z.infer<typeof listOutboxQuerySchema>;

export const outboxIdParamSchema = z.object({ id: uuidSchema });
export type OutboxIdParam = z.infer<typeof outboxIdParamSchema>;
