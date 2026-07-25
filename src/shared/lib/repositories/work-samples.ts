import { and, desc, eq } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { workSampleAnalyses } from '../db/schema'
import type { WorkSampleAnalysis } from '../work-sample'

export async function findWorkSampleAnalysis(
  transaction: TenantTransaction,
  userId: string,
  sampleUrl: string,
) {
  const [row] = await transaction.select().from(workSampleAnalyses)
    .where(and(eq(workSampleAnalyses.userId, userId), eq(workSampleAnalyses.sampleUrl, sampleUrl)))
    .limit(1)
  return row ?? null
}

export async function upsertWorkSampleAnalysis(
  transaction: TenantTransaction,
  input: {
    id: string
    userId: string
    builderIdentityId: string | null
    sampleUrl: string
    sampleType: 'repo' | 'pr' | 'file'
    analysis: WorkSampleAnalysis
  },
) {
  const [row] = await transaction.insert(workSampleAnalyses).values(input)
    .onConflictDoUpdate({
      target: [workSampleAnalyses.userId, workSampleAnalyses.sampleUrl],
      set: {
        builderIdentityId: input.builderIdentityId,
        sampleType: input.sampleType,
        analysis: input.analysis,
        updatedAt: new Date(),
      },
    })
    .returning()
  return row
}

export async function listWorkSampleAnalyses(
  transaction: TenantTransaction,
  userId: string,
  builderIdentityId?: string,
) {
  const conditions = builderIdentityId
    ? and(eq(workSampleAnalyses.userId, userId), eq(workSampleAnalyses.builderIdentityId, builderIdentityId))
    : eq(workSampleAnalyses.userId, userId)
  return transaction.select().from(workSampleAnalyses)
    .where(conditions)
    .orderBy(desc(workSampleAnalyses.createdAt))
    .limit(50)
}

export async function deleteWorkSampleAnalysis(
  transaction: TenantTransaction,
  userId: string,
  id: string,
) {
  const rows = await transaction.delete(workSampleAnalyses)
    .where(and(eq(workSampleAnalyses.userId, userId), eq(workSampleAnalyses.id, id)))
    .returning({ id: workSampleAnalyses.id })
  return rows.length > 0
}
