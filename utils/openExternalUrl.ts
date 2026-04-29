import { Linking, Platform } from 'react-native';

/**
 * Web: `Linking.openURL` → `window.open` bazı ortamlarda popup engeline takılır;
 * gerçek `<a target="_blank">` tıklaması genelde güvenilir şekilde yeni sekmede açar.
 */
export async function openExternalUrl(url: string): Promise<void> {
  const trimmed = url?.trim();
  if (!trimmed) return;

  if (Platform.OS === 'web') {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    let abs: string;
    try {
      abs = new URL(trimmed, window.location.href).href;
    } catch {
      throw new Error('Geçersiz adres');
    }
    const a = document.createElement('a');
    a.href = abs;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return;
  }

  await Linking.openURL(trimmed);
}
