import { z } from 'zod'

export * from './ingest.js'

/** Єдиний формат помилки на всіх межах API — 02-CODE-RULES. */
export const errorCodeSchema = z.enum([
  'INVALID_INPUT',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'RATE_LIMITED',
  'INTERNAL',
])

export const apiErrorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
})

export type ErrorCode = z.infer<typeof errorCodeSchema>
export type ApiError = z.infer<typeof apiErrorSchema>
