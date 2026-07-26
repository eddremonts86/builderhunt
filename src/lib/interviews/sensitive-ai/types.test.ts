import { describe, expect, it } from 'vitest'
import type { SensitiveAICompletionRequest, SensitiveAIProvider } from './types'

interface FakeBriefInput {
  candidateName: string
}
interface FakeBriefOutput {
  candidateSummary: string
}

/** Proves `SensitiveAIProvider` is implementable with zero I/O and no Azure OpenAI SDK import. */
class FakeSensitiveAIProvider implements SensitiveAIProvider {
  async completeStructured<TInput, TOutput>(request: SensitiveAICompletionRequest<TInput>) {
    return {
      output: { candidateSummary: `Summary for ${(request.input as unknown as FakeBriefInput).candidateName}` } as unknown as TOutput,
      model: 'fake-model',
      promptVersion: request.promptVersion,
      usage: { inputTokens: 10, outputTokens: 20 },
    }
  }
}

describe('SensitiveAIProvider', () => {
  it('a fake adapter completes a structured request and echoes the promptVersion', async () => {
    const provider = new FakeSensitiveAIProvider()
    const result = await provider.completeStructured<FakeBriefInput, FakeBriefOutput>({
      taskId: 'interview-brief-generate',
      promptVersion: 'v1',
      input: { candidateName: 'Jamie' },
    })
    expect(result.output.candidateSummary).toBe('Summary for Jamie')
    expect(result.promptVersion).toBe('v1')
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
  })
})
