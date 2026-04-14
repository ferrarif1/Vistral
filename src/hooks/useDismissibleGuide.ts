import { useCallback, useState } from 'react';

const readDismissedState = (storageKey: string): boolean => {
  try {
    return localStorage.getItem(storageKey) === 'true';
  } catch {
    return false;
  }
};

const writeDismissedState = (storageKey: string, dismissed: boolean): void => {
  try {
    localStorage.setItem(storageKey, dismissed ? 'true' : 'false');
  } catch {
    // Ignore storage failures in prototype mode.
  }
};

export default function useDismissibleGuide(storageKey: string) {
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissedState(storageKey));

  const dismiss = useCallback(() => {
    setDismissed(true);
    writeDismissedState(storageKey, true);
  }, [storageKey]);

  const reopen = useCallback(() => {
    setDismissed(false);
    writeDismissedState(storageKey, false);
  }, [storageKey]);

  return {
    dismissed,
    visible: !dismissed,
    dismiss,
    reopen
  };
}
