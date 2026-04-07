import { useEffect, useState } from 'react';

const readCompactViewport = (maxWidth: number): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.matchMedia(`(max-width: ${maxWidth}px)`).matches;
};

export default function useCompactViewport(maxWidth = 960): boolean {
  const [isCompactViewport, setIsCompactViewport] = useState<boolean>(() =>
    readCompactViewport(maxWidth)
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const onChange = (event: MediaQueryListEvent) => {
      setIsCompactViewport(event.matches);
    };

    setIsCompactViewport(mediaQuery.matches);

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', onChange);
      return () => {
        mediaQuery.removeEventListener('change', onChange);
      };
    }

    mediaQuery.addListener(onChange);
    return () => {
      mediaQuery.removeListener(onChange);
    };
  }, [maxWidth]);

  return isCompactViewport;
}
