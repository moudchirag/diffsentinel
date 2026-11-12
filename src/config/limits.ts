export interface ReviewLimits {
  maxChangedFiles: number;
  maxFileBytes: number;
  maxDiffCharacters: number;
  maxContextCharacters: number;
  maxRelatedTestFiles: number;
  maxToolCalls: number;
  maxToolsPerIteration: number;
  maxAgentIterations: number;
}

export const DEFAULT_LIMITS: ReviewLimits = {
  maxChangedFiles: 20,
  maxFileBytes: 20 * 1024,
  maxDiffCharacters: 40_000,
  maxContextCharacters: 60_000,
  maxRelatedTestFiles: 5,
  // Parallel calls per turn keep API usage low: one model turn can gather several pieces of context.
  maxToolCalls: 10,
  maxToolsPerIteration: 4,
  // tool turns + the final submit_review turn + spare for one nudge/repair. Lowered further by --max-calls.
  maxAgentIterations: 6,
};
