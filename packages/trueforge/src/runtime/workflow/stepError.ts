/** A step failed but still produced something worth exposing (e.g. a non-2xx response). */
export class WorkflowStepError extends Error {
  readonly output: unknown;

  constructor(message: string, options?: ErrorOptions & { output?: unknown }) {
    super(message, options);
    this.name = 'WorkflowStepError';
    this.output = options?.output ?? null;
  }
}
