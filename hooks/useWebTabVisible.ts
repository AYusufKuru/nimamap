import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

/**
 * Web: başka sekmeye gidip dönünce tetiklenir (yenileme / tekrar yükleme için).
 */
export function useWebTabVisible(onVisible: () => void, enabled = true) {
  const cb = useRef(onVisible);
  cb.current = onVisible;


  useEffect(() => {
    if (!enabled || Platform.OS !== 'web' || typeof document === 'undefined') return;

    const handler = () => {
      if (document.visibilityState === 'visible') {
        cb.current();
      }
    };

    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [enabled]);
}
