export class DiffSentinelError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
export class NotAGitRepositoryError extends DiffSentinelError {}
export class GitCommandError extends DiffSentinelError {}
export class UnsafePathError extends DiffSentinelError {}
export class ConfigError extends DiffSentinelError {}
export class ModelRequestError extends DiffSentinelError {}
export class ModelRateLimitError extends ModelRequestError {}
export class InvalidModelResponseError extends DiffSentinelError {}
export class AgentLimitExceededError extends DiffSentinelError {}
