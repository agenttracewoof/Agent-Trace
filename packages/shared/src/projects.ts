import { z } from 'zod'

/**
 * The dashboard boundary for projects (FR-015, T078): the operator creates a
 * project and receives the ingest key the SDK authenticates with. Same rule as
 * `ingest.ts` — requests are strict, responses may grow.
 */

/** Trimmed before the length check: a name of spaces is no name. */
export const createProjectRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
})

export const memberRoleSchema = z.enum(['owner', 'operator'])

export const projectSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  role: memberRoleSchema,
  /** Decisions a day this project may record before ingest answers 429 (FR-030). */
  dailyQuota: z.number().int(),
  createdAt: z.iso.datetime(),
})

export const listProjectsResponseSchema = z.object({
  projects: z.array(projectSummarySchema),
  /** How many projects one account may own; the screen disables "create" at it. */
  maxOwnedProjects: z.number().int(),
})

/**
 * The only response that carries the key in the clear. It is not stored and
 * cannot be shown again — a lost key can only be replaced.
 */
export const createProjectResponseSchema = z.object({
  project: projectSummarySchema,
  ingestKey: z.string(),
})

export const reissueIngestKeyResponseSchema = z.object({ ingestKey: z.string() })

export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>
export type ProjectSummary = z.infer<typeof projectSummarySchema>
export type ListProjectsResponse = z.infer<typeof listProjectsResponseSchema>
export type CreateProjectResponse = z.infer<typeof createProjectResponseSchema>
export type ReissueIngestKeyResponse = z.infer<typeof reissueIngestKeyResponseSchema>
