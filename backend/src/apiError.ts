export interface NormalizedApiError {
  status: number;
  code: string;
  message: string;
}

const authMessages = new Set<string>([
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
    includesAny(normalized, ['does not belong to this dataset'])
  );
};

const isInvalidStateMessage = (message: string): boolean => {
  const normalized = normalizeMessage(message);
  if (normalized.startsWith('new annotation must start from')) {
    return true;
  }

  if (normalized.startsWith('only admin can ')) {
    return false;
  }

  return normalized.startsWith('only ') && normalized.includes(' can ');
};

const isValidationMessage = (message: string): boolean => {
  const normalized = normalizeMessage(message);
  return includesAny(normalized, [
    'must be at least',
    'conversation title must be',
    'does not match',
    'upload at least one ready model file',
    'llm api key is missing',
    'returned empty content',
    'already exists',
    'invalid json body',
    'invalid framework query'
  ]);
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

  if (message === 'CSRF token mismatch.') {
    return {
      status: 403,
      code: 'CSRF_VALIDATION_FAILED',
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
