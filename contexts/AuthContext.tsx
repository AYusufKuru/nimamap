import type { Session, User } from '@supabase/supabase-js';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../supabase';

export type UserRole = 'field' | 'admin';

export type Profile = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: UserRole;
};

type AuthContextValue = {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function normalizeRole(raw: unknown): UserRole {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  return s === 'admin' ? 'admin' : 'field';
}

async function loadProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, role')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    if (__DEV__) {
      console.warn('[Auth] profiles okuma:', error.message);
    }
    return null;
  }
  if (!data) return null;
  return {
    ...data,
    role: normalizeRole(data.role),
  } as Profile;
}

const SESSION_INIT_MS = 14_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      if (__DEV__) {
        console.warn(`[Auth] ${label} zaman aşımı (${ms}ms)`);
      }
      resolve(null);
    }, ms);
    promise
      .then((v) => {
        clearTimeout(t);
        resolve(v);
      })
      .catch(() => {
        clearTimeout(t);
        resolve(null);
      });
  });
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  /** Giriş formu işlerken sekme görünür olunca loading sıfırlanmasın */
  const signInInFlightRef = useRef(false);
  /** Profil isteği sürerken visibility ile loading=false yapılmasın (Yetkisiz ekranı flaşı) */
  const profileFetchDepthRef = useRef(0);

  const refreshProfile = useCallback(async () => {
    const { data: { session: s } } = await supabase.auth.getSession();
    if (!s?.user) {
      setProfile(null);
      return;
    }
    const p = await loadProfile(s.user.id);
    setProfile(p);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const sessionResult = await withTimeout(
          supabase.auth.getSession(),
          SESSION_INIT_MS,
          'getSession (ilk yükleme)'
        );
        if (cancelled) return;
        const initial = sessionResult?.data?.session ?? null;
        if (initial?.user) {
          profileFetchDepthRef.current += 1;
          try {
            const p = await loadProfile(initial.user.id);
            if (cancelled) return;
            setSession(initial);
            setProfile(p);
          } finally {
            profileFetchDepthRef.current -= 1;
          }
        } else {
          setSession(initial);
          setProfile(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, newSession) => {
        if (cancelled) return;
        if (!newSession?.user) {
          setSession(null);
          setProfile(null);
          setLoading(false);
          return;
        }
        /**
         * Sekme geri dönüşünde sık sık gelir; JWT yenilenir. Profili baştan çekmek + setProfile
         * tüm ekranı/haritayı yeniden bağlıyordu (sayfa yenilendi hissiyatı).
         */
        if (event === 'TOKEN_REFRESHED') {
          setSession(newSession);
          setLoading(false);
          return;
        }
        if (event === 'SIGNED_IN') {
          setLoading(true);
        }
        profileFetchDepthRef.current += 1;
        try {
          const p = await loadProfile(newSession.user.id);
          if (cancelled) return;
          setSession(newSession);
          setProfile(p);
        } catch (e) {
          if (__DEV__) console.warn('[Auth] onAuthStateChange profil:', e);
        } finally {
          profileFetchDepthRef.current -= 1;
          setLoading(false);
        }
      }
    );

    /**
     * Sekmeye dönünce takılı kalan spinner’ı kapat. Profil isteği sürerken tetiklenirse
     * loading’i düşürme — ara durumda session varken profile=null kalıp Yetkisiz flaşı oluşuyordu.
     */
    const onVisibility = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
      if (signInInFlightRef.current) return;
      if (profileFetchDepthRef.current > 0) return;
      if (!cancelled) setLoading(false);
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      cancelled = true;
      subscription.unsubscribe();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    signInInFlightRef.current = true;
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) {
        return { error: error as Error | null };
      }
      // Giriş sonrası profil burada yüklensin; bazı ortamlarda onAuthStateChange gecikiyor veya farklı event geliyor
      const { data: { session: s } } = await supabase.auth.getSession();
      if (s?.user) {
        profileFetchDepthRef.current += 1;
        try {
          const p = await loadProfile(s.user.id);
          setSession(s);
          setProfile(p);
        } finally {
          profileFetchDepthRef.current -= 1;
        }
      } else {
        setSession(s);
        setProfile(null);
      }
      return { error: null };
    } finally {
      setLoading(false);
      signInInFlightRef.current = false;
    }
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      loading,
      signIn,
      signOut,
      refreshProfile,
    }),
    [session, profile, loading, signIn, signOut, refreshProfile]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth yalnızca AuthProvider içinde kullanılabilir.');
  return ctx;
}
