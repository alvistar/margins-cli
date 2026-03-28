// ─── Base ─────────────────────────────────────────────────────────────────────

export class MarginsError extends Error {
  constructor(
    message: string,
    public readonly userMessage: string,
    public readonly exitCode: number = 1,
  ) {
    super(message)
    this.name = this.constructor.name
  }
}

// ─── Auth errors ──────────────────────────────────────────────────────────────

export class AuthMissing extends MarginsError {
  constructor() {
    super('No API key configured', 'Not authenticated. Run: margins auth login', 1)
  }
}

export class AuthExpired extends MarginsError {
  constructor() {
    super('API key expired or invalid', 'API key expired or invalid. Run: margins auth login', 1)
  }
}

export class AuthInvalid extends MarginsError {
  constructor() {
    super('API key invalid', 'API key invalid. Run: margins auth login', 1)
  }
}

// ─── Network/API errors ───────────────────────────────────────────────────────

export class NetworkError extends MarginsError {
  constructor(serverUrl: string) {
    super(`Network error reaching ${serverUrl}`, `Cannot reach ${serverUrl}. Check your connection.`, 1)
  }
}

export class TimeoutError extends MarginsError {
  constructor() {
    super('Request timed out', 'Request timed out. Try again.', 1)
  }
}

export class ServerError extends MarginsError {
  constructor(status: number) {
    super(`Server error ${status}`, `Server error (${status}). Try again later.`, 1)
  }
}

export class ForbiddenError extends MarginsError {
  constructor(resource = 'this resource') {
    super(`Access denied to ${resource}`, `Access denied to ${resource}.`, 1)
  }
}

export class NotFoundError extends MarginsError {
  constructor(resource: string) {
    super(`Not found: ${resource}`, `Not found: ${resource}.`, 1)
  }
}

export class ResponseParseError extends MarginsError {
  constructor() {
    super('Unexpected server response', 'Unexpected server response. Use --verbose for details.', 1)
  }
}

// ─── Config errors ────────────────────────────────────────────────────────────

export class ConfigParseError extends MarginsError {
  constructor(detail: string) {
    super(`Config parse error: ${detail}`, `${detail}. Delete and re-run: margins auth login`, 1)
  }
}

export class ConflictError extends MarginsError {
  constructor(message: string) {
    super(`Conflict: ${message}`, message, 1)
  }
}

export class WorkspaceNotFoundError extends MarginsError {
  constructor(slug: string) {
    super(`Workspace not found: ${slug}`, `Workspace '${slug}' not found.`, 1)
  }
}

export class DiscussionNotFoundError extends MarginsError {
  constructor(id: string) {
    super(`Discussion not found: ${id}`, `Discussion '${id}' not found.`, 1)
  }
}

// ─── Validation errors ────────────────────────────────────────────────────────

export class ValidationError extends MarginsError {
  constructor(message: string) {
    super(`Validation error: ${message}`, message, 1)
  }
}

// ─── Auth flow errors ─────────────────────────────────────────────────────────

export class LoginTimeout extends MarginsError {
  constructor() {
    super('Login timed out', 'Login timed out (2 min). Try again.', 1)
  }
}

export class OAuthError extends MarginsError {
  constructor(reason: string) {
    super(`OAuth error: ${reason}`, `Authentication failed: ${reason}`, 1)
  }
}
