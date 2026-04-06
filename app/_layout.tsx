import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { AuthProvider } from '@/contexts/AuthContext';
import { MunicipalitiesProvider } from '@/contexts/MunicipalitiesContext';
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

  /** Web: başka sekmeye gidip geri gelince tam yenileme — tutarlı veri için en güvenilir yol */
  useEffect(() => {
    if (!appReady || Platform.OS !== 'web' || typeof document === 'undefined') return;
    let wasHidden = false;
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        wasHidden = true;
        return;
      }
      if (document.visibilityState === 'visible' && wasHidden) {
        wasHidden = false;
        window.location.reload();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [appReady]);

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
