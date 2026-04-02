export const AUTH_UPDATED_EVENT = 'vistral:auth-updated';

export const emitAuthUpdated = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent(AUTH_UPDATED_EVENT));
};
