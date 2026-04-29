import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import 'react-native-reanimated';

import { AuthProvider } from '@/contexts/AuthContext';
import { MunicipalitiesProvider } from '@/contexts/MunicipalitiesContext';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { supabase } from '@/supabase';
import { SafeAreaProvider } from 'react-native-safe-area-context';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [appReady, setAppReady] = useState(false);

  useEffect(() => {
    async function prepare() {
      try {
        // Logo belirgin şekilde görünsün diye 3 saniye bekle
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch (e) {
        console.warn(e);
      } finally {
        setAppReady(true);
      }
    }
    prepare();
  }, []);

  useEffect(() => {
    if (appReady) {
      SplashScreen.hideAsync();
    }
  }, [appReady]);

  /**
   * Web’de tarayıcı arka plandaki sekmeyi donduruyor; Supabase’in token auto-refresh
   * `setInterval` zamanlayıcısı askıya alınınca dönüşte takılı auth-lock yüzünden tüm sorgular
   * (raporlar, belediyeler vs.) sonsuza kadar yükleniyor durumunda kalıyordu. Sekme görünür
   * olunca refresh’i baştan başlat + session’ı yenile, gizliyken durdur.
   */
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        try {
          supabase.auth.startAutoRefresh();
        } catch {
          /* ignore */
        }
        void supabase.auth.getSession().then(({ data }) => {
          const session = data.session;
          if (!session) return;
          const expiresAt = (session.expires_at ?? 0) * 1000;
          const skewMs = 60_000;
          if (!expiresAt || expiresAt - Date.now() < skewMs) {
            void supabase.auth.refreshSession().catch(() => {});
          }
        });
      } else {
        try {
          supabase.auth.stopAutoRefresh();
        } catch {
          /* ignore */
        }
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  if (!appReady) {
    return null;
  }

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <MunicipalitiesProvider>
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="login" />
            <Stack.Screen name="admin" />
          </Stack>
          <StatusBar style="auto" />
        </ThemeProvider>
        </MunicipalitiesProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
