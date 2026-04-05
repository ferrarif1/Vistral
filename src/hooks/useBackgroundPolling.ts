import { useEffect, useRef } from 'react';

interface UseBackgroundPollingOptions {
  intervalMs: number;
  enabled?: boolean;
  pauseWhenHidden?: boolean;
  runOnVisible?: boolean;
}

export default function useBackgroundPolling(
  callback: () => void | Promise<void>,
  {
    intervalMs,
    enabled = true,
    pauseWhenHidden = true,
    runOnVisible = true
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

    const clearTimer = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const startTimer = () => {
      clearTimer();

      if (pauseWhenHidden && typeof document !== 'undefined' && document.hidden) {
        return;
      }

      timer = window.setInterval(() => {
        void callbackRef.current();
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
        void callbackRef.current();
      }
      startTimer();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      clearTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enabled, intervalMs, pauseWhenHidden, runOnVisible]);
}
