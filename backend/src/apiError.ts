export interface NormalizedApiError {
  status: number;
  code: string;
  message: string;
}

const authMessages = new Set<string>([
  'Authentication required.',
  'Current user not found in mock store.',
  'Invalid username or password.'
]);

const internalErrorMessages = new Set<string>(['Failed to read verification reports directory.']);

const normalizeMessage = (input: string): string => input.trim().toLowerCase();

const startsWithAny = (target: string, prefixes: string[]): boolean =>
  prefixes.some((prefix) => target.startsWith(prefix));

const includesAny = (target: string, fragments: string[]): boolean =>
  fragments.some((fragment) => target.includes(fragment));

const isPermissionMessage = (message: string): boolean => {
  const normalized = normalizeMessage(message);
  return startsWithAny(normalized, ['no permission to ', 'only admin can ']);
};

const isNotFoundMessage = (message: string): boolean => {
  const normalized = normalizeMessage(message);
  return (
    includesAny(normalized, [' not found']) ||
    includesAny(normalized, ['bootstrap session not found']) ||
    includesAny(normalized, ['does not belong to this dataset'])
  );
};

const isInvalidStateMessage = (message: string): boolean => {
  const normalized = normalizeMessage(message);
  if (normalized.startsWith('new annotation must start from')) {
    return true;
  }

  if (normalized.startsWith('invalid annotation transition:')) {
    return true;
  }

  if (normalized.startsWith('only admin can ')) {
    return false;
  }

  return (
    normalized.startsWith('only ') && normalized.includes(' can ')
  ) || normalized.includes('cannot be deleted while');
};

const isValidationMessage = (message: string): boolean => {
  const normalized = normalizeMessage(message);
  return includesAny(normalized, [
    'must be at least',
    'must include',
    'cannot include',
    'conversation title must be',
    'does not match',
    'must match',
    'invalid review_reason_code',
    'upload at least one ready model file',
    'llm api key is missing',
    'returned empty content',
    'already exists',
    'current password is incorrect',
    'status must be active or disabled',
    'disable reason is required when disabling an account',
    'cannot disable your own account',
    'cannot disable the last active admin account',
    'invalid json body',
    'invalid framework query',
    'worker name is required',
    'worker name cannot be empty',
    'cannot remove worker with in-flight training jobs',
    'training worker endpoint already exists',
    'control plane base url is required',
    'control plane base url must be a full http(s) url',
    'control plane base url must use http or https',
    'pairing token is required',
    'pairing token is invalid or expired',
    'protected foundation models cannot be deleted'
  ]);
};

const isRuntimePublicAuthMissingMessage = (message: string): boolean =>
  normalizeMessage(message) === 'bearer runtime api key is required.';

const isRuntimePublicAuthDeniedMessage = (message: string): boolean => {
  const normalized = normalizeMessage(message);
  return (
    normalized === 'invalid runtime api key for requested model version.' ||
    normalized.startsWith('runtime api key expired for ') ||
    normalized.startsWith('runtime api key quota exceeded for ')
  );
};

export const normalizeApiError = (error: unknown): NormalizedApiError => {
  if (!(error instanceof Error)) {
    return {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Unexpected server error.'
    };
  }

  const message = error.message || 'Unexpected server error.';

  if (message === 'Account is disabled. Ask an administrator to reactivate it.') {
    return {
      status: 403,
      code: 'ACCOUNT_DISABLED',
      message
    };
  }

  if (message === 'Public registration is disabled.') {
    return {
      status: 403,
      code: 'PUBLIC_REGISTRATION_DISABLED',
      message
    };
  }

  if (message === 'CSRF token mismatch.') {
    return {
      status: 403,
      code: 'CSRF_VALIDATION_FAILED',
      message
    };
  }

  if (
    message === 'Training worker token is invalid.' ||
    message === 'Training worker token is not configured.'
  ) {
    return {
      status: 403,
      code: 'INSUFFICIENT_PERMISSIONS',
      message
    };
  }

  if (normalizeMessage(message).startsWith('upload payload exceeds ')) {
    return {
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message
    };
  }

  if (authMessages.has(message)) {
    return {
      status: 401,
      code: 'AUTHENTICATION_REQUIRED',
      message
    };
  }

  if (isRuntimePublicAuthMissingMessage(message)) {
    return {
      status: 401,
      code: 'AUTHENTICATION_REQUIRED',
      message
    };
  }

  if (isRuntimePublicAuthDeniedMessage(message)) {
    return {
      status: 403,
      code: 'INSUFFICIENT_PERMISSIONS',
      message
    };
  }

  if (isPermissionMessage(message)) {
    return {
      status: 403,
      code: 'INSUFFICIENT_PERMISSIONS',
      message
    };
  }

  if (isNotFoundMessage(message)) {
    return {
      status: 404,
      code: 'RESOURCE_NOT_FOUND',
      message
    };
  }

  if (isInvalidStateMessage(message)) {
    return {
      status: 409,
      code: 'INVALID_STATE_TRANSITION',
      message
    };
  }

  if (isValidationMessage(message)) {
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message
    };
  }

  if (internalErrorMessages.has(message)) {
    return {
      status: 500,
      code: 'INTERNAL_ERROR',
      message
    };
  }

  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    message
  };
};
