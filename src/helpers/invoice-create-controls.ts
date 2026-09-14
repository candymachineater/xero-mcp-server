import { z } from "zod";

// Validate calendar components without parsing a timezone-dependent instant.
const calendarDate = z
  .string()
  .length(10)
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    if (year < 1 || month < 1 || month > 12 || day < 1) return false;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= days[month - 1];
  }, "Expected a real YYYY-MM-DD calendar date");

export const invoiceCreateControlsSchema = z
  .object({
    status: z
      .literal("DRAFT")
      .describe(
        "Only DRAFT is supported. Omit to keep DRAFT; this tool cannot authorise or send an invoice.",
      )
      .optional(),
    dueDate: calendarDate
      .describe(
        "Explicit due date (YYYY-MM-DD), overriding the legacy UTC-date(now + 30 days) default. Choose payment terms and resolve the calendar date before calling; no working-day or holiday calculation is performed.",
      )
      .optional(),
  })
  .strict();

export type InvoiceCreateControls = z.infer<typeof invoiceCreateControlsSchema>;
