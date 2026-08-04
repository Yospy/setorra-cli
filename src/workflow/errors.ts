export type RepositoryAgentConfigErrorCode = "invalid_template_input";

export class RepositoryAgentConfigError extends Error {
  readonly code: RepositoryAgentConfigErrorCode;
  readonly detail: string | undefined;

  constructor(
    code: RepositoryAgentConfigErrorCode,
    detail?: string,
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "RepositoryAgentConfigError";
    this.code = code;
    this.detail = detail;
  }
}
