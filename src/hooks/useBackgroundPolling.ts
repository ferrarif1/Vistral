import { useEffect, useRef } from 'react';

interface UseBackgroundPollingOptions {
  intervalMs: number;
  enabled?: boolean;
  pauseWhenHidden?: boolean;
  runOnVisible?: boolean;
  allowConcurrent?: boolean;
}

export default function useBackgroundPolling(
  callback: () => void | Promise<void>,
  {
    intervalMs,
    enabled = true,
    pauseWhenHidden = true,
    runOnVisible = true,
    allowConcurrent = false
  }: UseBackgroundPollingOptions
) {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled || intervalMs <= 0) {
      return;
    }

    let timer: number | null = null;
    let inFlight = false;

    const clearTimer = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const runCallback = () => {
      if (!allowConcurrent && inFlight) {
        return;
      }

      inFlight = true;
      Promise.resolve(callbackRef.current())
        .catch(() => {
          // Individual callers own error presentation.
        })
        .finally(() => {
          inFlight = false;
        });
    };

    const startTimer = () => {
      clearTimer();

      if (pauseWhenHidden && typeof document !== 'undefined' && document.hidden) {
        return;
      }

      timer = window.setInterval(() => {
        runCallback();
      }, intervalMs);
    };

    startTimer();

    if (!pauseWhenHidden || typeof document === 'undefined') {
      return clearTimer;
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearTimer();
        return;
      }

      if (runOnVisible) {
        runCallback();
      }
      startTimer();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      clearTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [allowConcurrent, enabled, intervalMs, pauseWhenHidden, runOnVisible]);
}
