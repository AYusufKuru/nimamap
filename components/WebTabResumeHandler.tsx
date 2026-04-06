import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/supabase';
import { WEB_APP_RESUME_EVENT } from '@/utils/webAppResume';
import { useEffect } from 'react';
import { Platform } from 'react-native';

/**
 * Web: başka sekmeye veya masaüstüne gidip geri gelince JWT + profil yenilenir,
 * ardından `WEB_APP_RESUME_EVENT` ile listeler/raporlar tekrar yüklenir (tam sayfa yenilemesi yok).
 */
export function WebTabResumeHandler() {
  const { refreshProfile } = useAuth();

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;

    let wasHidden = false;
    const onVis = async () => {
      if (document.visibilityState === 'hidden') {
        wasHidden = true;
        return;
      }
      if (document.visibilityState !== 'visible' || !wasHidden) return;
      wasHidden = false;

      try {
        const { error } = await supabase.auth.refreshSession();
        if (error) await supabase.auth.getSession();
      } catch {
        await supabase.auth.getSession();
      }

      await refreshProfile();

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(WEB_APP_RESUME_EVENT));
      }
    };

    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refreshProfile]);

  return null;
}
