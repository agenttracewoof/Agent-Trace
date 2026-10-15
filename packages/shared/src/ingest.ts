import { hexDigest, signedManifestSchema } from '@agenttrace/manifest'
import { z } from 'zod'

/**
 * Межа приймання: рівно те, що SDK шле, і рівно те, що API відповідає. Схеми
 * спільні, тож клієнт і сервер не можуть розійтися в контракті мовчки.
 *
 * Запити — `strictObject`: зайве поле у тілі означає, що хтось шле не те, що
 * думає. Відповіді — звичайний `object`: сервер може додати поле, і старий
 * клієнт від цього падати не має.
 */

export const registerAgentRequestSchema = z.strictObject({
  /** Ідентифікатор агента у системі клієнта — його, не наш. */
  externalId: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  publicKey: hexDigest(32),
})

export const registerAgentResponseSchema = z.object({ agentId: z.uuid() })

/**
 * `proof` is the current key's signature over the rotation statement
 * (`keyRotationDigest`), and `effectiveAt` is part of what it signs.
 */
export const rotateAgentKeyRequestSchema = z.strictObject({
  newPublicKey: hexDigest(32),
  effectiveAt: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  proof: hexDigest(64),
})

export const rotateAgentKeyResponseSchema = z.object({
  agentId: z.uuid(),
  publicKey: hexDigest(32),
  effectiveAt: z.int(),
})

/**
 * Тіло — підписаний конверт як є. Підпис покриває дайджест манифесту, тож
 * будь-яке поле поза ним непідписане; плаский набір полів змусив би API
 * збирати манифест назад, і кожна розбіжність складання робила б чесне
 * рішення схожим на підроблене. `agentId` тут теж не потрібен: агента
 * визначає `manifest.agentPubkey`, який у підпис входить.
 */
export const submitDecisionRequestSchema = signedManifestSchema

/** Ті самі значення, що в `decision_status` бази. */
export const decisionStatusSchema = z.enum(['pending', 'anchored', 'failed'])

export const submitDecisionResponseSchema = z.object({
  status: decisionStatusSchema,
  publicUrl: z.url(),
})

export type RegisterAgentRequest = z.infer<typeof registerAgentRequestSchema>
export type RegisterAgentResponse = z.infer<typeof registerAgentResponseSchema>
export type RotateAgentKeyRequest = z.infer<typeof rotateAgentKeyRequestSchema>
export type RotateAgentKeyResponse = z.infer<typeof rotateAgentKeyResponseSchema>
export type SubmitDecisionRequest = z.infer<typeof submitDecisionRequestSchema>
export type SubmitDecisionResponse = z.infer<typeof submitDecisionResponseSchema>
export type DecisionStatus = z.infer<typeof decisionStatusSchema>
