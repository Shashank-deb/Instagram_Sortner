/** Base class for errors that are safe to show to the user verbatim. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'bad_request',
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotConfiguredError extends AppError {
  constructor(message: string) {
    super(message, 409, 'not_configured');
  }
}

export class AuthExpiredError extends AppError {
  constructor(message = 'Instagram rejected the stored session. Log in again.') {
    super(message, 401, 'auth_expired');
  }
}

/**
 * Instagram asked for a checkpoint / challenge, or rate-limited us. This is the
 * signal to stop everything immediately: retrying is what turns a soft warning
 * into an action block.
 */
export class ThrottledError extends AppError {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
    readonly hard = false,
  ) {
    super(message, 429, hard ? 'checkpoint' : 'rate_limited');
  }
}

export class ProviderUnsupportedError extends AppError {
  constructor(operation: string, provider: string) {
    super(`The "${provider}" provider cannot ${operation}.`, 501, 'unsupported');
  }
}
