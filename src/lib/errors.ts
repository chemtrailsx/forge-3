/**
 * A small error vocabulary. Every route handler funnels through
 * `toErrorResponse`, so an unexpected exception can never leak a stack trace,
 * a connection string or a provider key into an HTTP body.
 */

export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'You must be signed in.') {
    super(message, 401, 'unauthorized');
  }
}

export class NotFoundError extends AppError {
  constructor(what = 'Resource') {
    super(`${what} not found.`, 404, 'not_found');
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'invalid_request', details);
  }
}

/** A provider (Rime / LLM / STT) failed or is not configured. */
export class ProviderError extends AppError {
  constructor(
    readonly provider: string,
    message: string,
    status = 502,
  ) {
    super(message, status, `${provider}_error`);
  }
}

export function toErrorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return Response.json(
      { error: { code: error.code, message: error.message, details: error.details ?? null } },
      { status: error.status },
    );
  }
  console.error('[unhandled]', error);
  return Response.json(
    { error: { code: 'internal_error', message: 'Something went wrong.' } },
    { status: 500 },
  );
}

/** True when a failure is the caller going away (barge-in, navigation, reload). */
export function isAbort(error: unknown): boolean {
  return (
    error instanceof DOMException
      ? error.name === 'AbortError'
      : error instanceof Error && (error.name === 'AbortError' || error.message === 'aborted')
  );
}
