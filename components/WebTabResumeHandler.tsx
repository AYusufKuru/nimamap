import { useAuth } from '@/contexts/AuthContext';
import { WEB_APP_RESUME_EVENT } from '@/utils/webAppResume';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

const RESUME_DEBOUNCE_MS = 180;

function isAbortLike(e: unknown): boolean {
  const name = e && typeof e === 'object' && 'name' in e ? String((e as { name?: string }).name) : '';
  const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message?: string }).message) : '';
  return name === 'AbortError' || msg.includes('AbortError') || msg.includes('Lock broken');
}

/**
 * Web: sekme / pencere geri gelince profil + veri yenilenir.
 * `refreshSession()` kullanılmaz — tarayıcıda Supabase Auth Web Locks ile çakışıp
 * "Lock broken by another request with the steal option" üretir. Oturum yenilemesi
 * `autoRefreshToken` + `refreshProfile` içindeki `getSession` ile yürür.
 */
export function WebTabResumeHandler() {
  const { refreshProfile } = useAuth();
  const resumeBusyRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;

    let wasHidden = false;

    const runResume = async () => {
      if (resumeBusyRef.current) return;
      resumeBusyRef.current = true;
      try {
        try {
          await refreshProfile();
        } catch (e) {
          if (!isAbortLike(e) && __DEV__) {
            console.warn('[WebTabResume]', e);
          }
        }
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent(WEB_APP_RESUME_EVENT));
        }
      } finally {
        resumeBusyRef.current = false;
      }
    };

    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        wasHidden = true;
        return;
      }
      if (document.visibilityState !== 'visible' || !wasHidden) return;
      wasHidden = false;

      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        void runResume();
      }, RESUME_DEBOUNCE_MS);
    };

    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [refreshProfile]);

  return null;
}
