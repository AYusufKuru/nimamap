import { useAuth } from '@/contexts/AuthContext';
import { useSelectableMunicipalities } from '@/hooks/useSelectableMunicipalities';
import { asHref } from '@/utils/asHref';
import { OPERATOR_DATA } from '@/utils/reportOperators';
import { MaterialIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system/legacy';
import * as Location from 'expo-location';
import * as MediaLibrary from 'expo-media-library';
import * as Print from 'expo-print';
import { Redirect, router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, KeyboardAvoidingView, Linking, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import ViewShot from 'react-native-view-shot';
import { supabase } from '../supabase';
import { generatePdfHtml } from '../utils/pdfTemplates';
import { openExternalUrl } from '../utils/openExternalUrl';

const LOCATION_FETCH_MS = 28000;
const GEOCODE_FETCH_MS = 15000;
/** Son bilinen konum bu kadar “taze” ise tam GPS beklemeden kullan (hızlı yol). */
const LAST_KNOWN_MAX_AGE_MS = 120000;

/** Galeriye kayıt: önce writeOnly+foto, olmazsa tam foto okuma (Android OEM / sürüm farkları). */
async function ensureMediaLibrarySavePermission(): Promise<boolean> {
  const g: MediaLibrary.GranularPermission[] = ['photo'];
  let r = await MediaLibrary.getPermissionsAsync(true, g);
  if (r.granted) return true;
  r = await MediaLibrary.requestPermissionsAsync(true, g);
  if (r.granted) return true;
  r = await MediaLibrary.getPermissionsAsync(false, g);
  if (r.granted) return true;
  r = await MediaLibrary.requestPermissionsAsync(false, g);
  return r.granted;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export default function App() {
  const { session, loading: authLoading, profile, signOut } = useAuth();
  const {
    municipalities,
    selectableMunicipalities,
    loading: municipalitiesLoading,
    error: municipalitiesError,
    refreshAssignments,
    canUseMunicipality,
  } = useSelectableMunicipalities();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [locationPermission, setLocationPermission] = useState<boolean | null>(null);

  const cameraRef = useRef<CameraView | null>(null);
  const viewShotRef = useRef<ViewShot | null>(null);
  /** Artık geçerli olmayan konum isteklerinin state güncellemesini engellemek için (İptal / ardışık çekim). */
  const locationOpIdRef = useRef(0);

  // States
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [locationData, setLocationData] = useState<{ latitude: number, longitude: number } | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [timestamp, setTimestamp] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [locationFailed, setLocationFailed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const insets = useSafeAreaInsets();

  // Form States
  const [isFormVisible, setIsFormVisible] = useState(false);
  const [operator, setOperator] = useState<string | null>(null);
  const [fiber, setFiber] = useState<string | null>(null);
  const [type, setType] = useState<string | null>(null);
  const types = ['Menhol', 'Kabin', 'Baz İstasyonu', 'Aydınlatma Direği', 'Elektrik Panosu', 'Doğalgaz', 'Trafo'];

  // Settings States
  const [isSettingsVisible, setIsSettingsVisible] = useState(false);
  const [isTypeSelectionVisible, setIsTypeSelectionVisible] = useState(false);
  const [flash, setFlash] = useState<'off' | 'on' | 'auto'>('off');
  const [municipalityId, setMunicipalityId] = useState<string | null>(null);
  const [municipalityPickerVisible, setMunicipalityPickerVisible] = useState(false);

  const selectedMunicipality = useMemo(
    () => (municipalityId ? municipalities.find((m) => m.id === municipalityId) : undefined),
    [municipalities, municipalityId]
  );

  useEffect(() => {
    if (municipalityPickerVisible) {
      void refreshAssignments();
    }
  }, [municipalityPickerVisible, refreshAssignments]);

  const [settingsIlce, setSettingsIlce] = useState<string>('');
  const [settingsMahalle, setSettingsMahalle] = useState<string>('');
  const [settingsSokak, setSettingsSokak] = useState<string>('');
  const [settingsSokakTuru, setSettingsSokakTuru] = useState<'Sokak' | 'Cadde' | 'Bulvar'>('Sokak');
  const [settingsBazIstasyonuOlcu, setSettingsBazIstasyonuOlcu] = useState<string>('');
  const [settingsTrafoOlcu, setSettingsTrafoOlcu] = useState<string>('');
  const [isReportsVisible, setIsReportsVisible] = useState(false);
  const [reports, setReports] = useState<any[]>([]);
  const [isLoadingReports, setIsLoadingReports] = useState(false);

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      setLocationPermission(status === 'granted');
      
      // Load saved settings
      try {
        const savedMunicipalityId = await AsyncStorage.getItem('municipalityId');
        if (savedMunicipalityId) setMunicipalityId(savedMunicipalityId);

        const savedOperator = await AsyncStorage.getItem('operator');
        if (savedOperator) setOperator(savedOperator);
        
        const savedFiber = await AsyncStorage.getItem('fiber');
        if (savedFiber) setFiber(savedFiber);
        
        const savedType = await AsyncStorage.getItem('type');
        if (savedType) {
          setType(savedType);
          const group = getGroupName(savedType);
          if (group) {
            const savedGroupOp = await AsyncStorage.getItem(`operator_${group}`);
            setOperator(savedGroupOp || null);
          }
        }

        const savedIlce = await AsyncStorage.getItem('settingsIlce');
        if (savedIlce) setSettingsIlce(savedIlce);

        const savedMahalle = await AsyncStorage.getItem('settingsMahalle');
        if (savedMahalle) setSettingsMahalle(savedMahalle);

        const savedSokak = await AsyncStorage.getItem('settingsSokak');
        if (savedSokak) setSettingsSokak(savedSokak);

        const savedSokakTuru = await AsyncStorage.getItem('settingsSokakTuru');
        if (savedSokakTuru === 'Cadde' || savedSokakTuru === 'Sokak' || savedSokakTuru === 'Bulvar') setSettingsSokakTuru(savedSokakTuru);

        const savedBazOlcu = await AsyncStorage.getItem('settingsBazIstasyonuOlcu');
        if (savedBazOlcu) setSettingsBazIstasyonuOlcu(savedBazOlcu);

        const savedTrafoOlcu = await AsyncStorage.getItem('settingsTrafoOlcu');
        if (savedTrafoOlcu) setSettingsTrafoOlcu(savedTrafoOlcu);
      } catch (e) {
        console.warn("Error loading settings:", e);
      }
    })();
  }, []);

  const getGroupName = (t: string | null) => {
    if (!t) return null;
    if (t === 'Menhol' || t === 'Kabin') return 'MenholKabin';
    if (t === 'Baz İstasyonu') return 'BazIstasyonu';
    if (t === 'Doğalgaz') return 'Dogalgaz';
    return 'ElektrikGrubu'; // Aydınlatma Direği, Elektrik Panosu, Trafo
  };

  const saveSettings = async () => {
    try {
      if (municipalityId) {
        await AsyncStorage.setItem('municipalityId', municipalityId);
      } else {
        await AsyncStorage.removeItem('municipalityId');
      }
      await AsyncStorage.setItem('settingsIlce', settingsIlce);
      await AsyncStorage.setItem('settingsMahalle', settingsMahalle);
      await AsyncStorage.setItem('settingsSokak', settingsSokak);
      await AsyncStorage.setItem('settingsSokakTuru', settingsSokakTuru);
      await AsyncStorage.setItem('settingsBazIstasyonuOlcu', settingsBazIstasyonuOlcu);
      await AsyncStorage.setItem('settingsTrafoOlcu', settingsTrafoOlcu);

      const group = getGroupName(type);
      if (group && operator) {
        await AsyncStorage.setItem(`operator_${group}`, operator);
      }

      if (fiber) await AsyncStorage.setItem('fiber', fiber);
      if (type) await AsyncStorage.setItem('type', type);
      setIsSettingsVisible(false);
      Alert.alert("Başarılı", "Ayarlar kaydedildi.");
    } catch (e) {
      console.error("Error saving settings:", e);
      Alert.alert("Hata", "Ayarlar kaydedilemedi.");
    }
  };

  const quickSaveType = async (newType: string) => {
    try {
      setType(newType);
      await AsyncStorage.setItem('type', newType);
      
      // Grup bazlı operatörü yükle
      const group = getGroupName(newType);
      if (group) {
        const savedGroupOp = await AsyncStorage.getItem(`operator_${group}`);
        setOperator(savedGroupOp || null);
      }

      setIsTypeSelectionVisible(false);
    } catch (e) {
      console.error("Error quick saving type:", e);
    }
  };

  const toggleFlash = () => {
    setFlash(current => {
      if (current === 'off') return 'on';
      if (current === 'on') return 'auto';
      return 'off';
    });
  };

  const fetchReports = async () => {
    setIsLoadingReports(true);
    const { data, error } = await supabase
      .from('report_logs')
      .select('*, profiles(full_name, email)')
      .order('created_at', { ascending: false });
    
    if (!error && data) {
      console.log("Fetched reports count:", data.length);
      setReports(data);
    } else if (error) {
      console.error("Fetch reports error:", error);
      Alert.alert("Hata", "Raporlar alınamadı: " + error.message);
    }
    setIsLoadingReports(false);
  };

  useEffect(() => {
    if (isReportsVisible) {
      fetchReports();
    }
  }, [isReportsVisible]);

  if (authLoading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#0000ff" />
        <Text>Oturum kontrol ediliyor...</Text>
      </View>
    );
  }

  if (!session) {
    return <Redirect href={asHref('/login')} />;
  }

  // Web: yalnızca yönetim paneli; saha (kamera / yükleme) mobilde
  if (Platform.OS === 'web') {
    if (profile?.role === 'admin') {
      return <Redirect href={asHref('/admin')} />;
    }
    return (
      <SafeAreaView style={styles.centerContainer}>
        <Text style={{ textAlign: 'center', marginBottom: 20, paddingHorizontal: 24, color: '#333' }}>
          Saha raporu ve fotoğraf yükleme yalnızca mobil uygulamada kullanılır. Yönetici iseniz yönetici
          hesabıyla giriş yapın.
        </Text>
        <TouchableOpacity
          style={styles.button}
          onPress={async () => {
            await signOut();
            router.replace(asHref('/login'));
          }}
        >
          <Text style={styles.buttonText}>Çıkış Yap</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  if (!cameraPermission || locationPermission === null) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#0000ff" />
        <Text>İzinler kontrol ediliyor...</Text>
      </View>
    );
  }

  if (!cameraPermission.granted) {
    return (
      <View style={styles.centerContainer}>
        <Text style={{ textAlign: 'center', marginBottom: 20 }}>
          Kamerayı ve konumu kullanabilmek için izinlere ihtiyacımız var.
        </Text>
        <TouchableOpacity style={styles.button} onPress={requestCameraPermission}>
          <Text style={styles.buttonText}>Kamera İzni Ver</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!locationPermission) {
    return (
      <View style={styles.centerContainer}>
        <Text style={{ textAlign: 'center', marginBottom: 20 }}>
          Konum erişim izni reddedildi. Lütfen ayarlardan konum iznini verin.
        </Text>
        <TouchableOpacity style={styles.button} onPress={() => void Linking.openSettings()}>
          <Text style={styles.buttonText}>Ayarlara git</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const takePicture = async () => {
    if (!cameraRef.current) return;
    const myOpId = ++locationOpIdRef.current;
    setIsProcessing(true);
    setLocationFailed(false);
    setLocationData(null);
    setAddress(null);
    try {
      const photo = await cameraRef.current.takePictureAsync();
      if (myOpId !== locationOpIdRef.current) return;

      setPhotoUri(photo.uri);

      const now = new Date();
      const dateString = now.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
      const timeString = now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      setTimestamp(`${dateString} - ${timeString}`);

      // Önce cache’teki son konum (Expo: çoğu zaman anında). Yoksa düşük doğruluk — GPS’e göre daha hızlı.
      let loc = await Location.getLastKnownPositionAsync({
        maxAge: LAST_KNOWN_MAX_AGE_MS,
      });
      if (myOpId !== locationOpIdRef.current) return;
      if (!loc) {
        loc = await withTimeout(
          Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Low,
          }),
          LOCATION_FETCH_MS,
          'LOCATION_TIMEOUT'
        );
        if (myOpId !== locationOpIdRef.current) return;
      }

      setLocationData({
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
      });

      try {
        const geocode = await withTimeout(
          Location.reverseGeocodeAsync({
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
          }),
          GEOCODE_FETCH_MS,
          'GEOCODE_TIMEOUT'
        );
        if (myOpId !== locationOpIdRef.current) return;

        if (geocode && geocode.length > 0) {
          const place = geocode[0];
          const addressText = `${place.street || ''} ${place.name || ''}, ${place.city || place.subregion || ''}, ${place.region || ''} ${place.country || ''} ${place.postalCode || ''}`;
          setAddress(addressText.trim().replace(/^,\s*/, "").replace(/\s+/g, ' '));
        } else {
          setAddress('Adres bulunamadı');
        }
      } catch (geoErr) {
        if (myOpId !== locationOpIdRef.current) return;
        console.warn('Geocode:', geoErr);
        setAddress('Adres bulunamadı');
      }
    } catch (error) {
      if (myOpId !== locationOpIdRef.current) return;
      console.error('Hata:', error);
      setLocationFailed(true);
      Alert.alert(
        'Konum alınamadı',
        'GPS sinyali gecikti veya alınamadı. Açık alanda deneyin, konumun açık olduğundan emin olun ve yeniden fotoğraf çekin.'
      );
    } finally {
      if (myOpId === locationOpIdRef.current) {
        setIsProcessing(false);
      }
    }
  };

  const resetPhoto = () => {
    locationOpIdRef.current += 1;
    setIsProcessing(false);
    setPhotoUri(null);
    setLocationData(null);
    setAddress(null);
    setTimestamp(null);
    setLocationFailed(false);
  };

  const processAndSave = async () => {
    if (!locationData || locationFailed || isProcessing) {
      Alert.alert('Kayıt', 'Önce konumun tamamlanmasını bekleyin veya yeniden fotoğraf çekin.');
      return;
    }
    if (!municipalityId) {
      Alert.alert('Belediye', 'Ayarlar üzerinden kayıtlı bir belediye seçin.');
      return;
    }
    const muniForSave = municipalities.find((m) => m.id === municipalityId);
    if (!muniForSave) {
      Alert.alert('Belediye', 'Seçili belediye bulunamadı. Ayarları açıp tekrar seçin.');
      return;
    }
    if (!canUseMunicipality(municipalityId)) {
      Alert.alert(
        'Yetki',
        'Bu belediyeye rapor yükleme yetkiniz yok. Yöneticiniz size bu belediyeyi atamalıdır.'
      );
      return;
    }
    setIsSaving(true);
    try {
      const { data: { session: authSession } } = await supabase.auth.getSession();
      if (!authSession?.user) {
        Alert.alert('Oturum', 'Lütfen tekrar giriş yapın.');
        setIsSaving(false);
        return;
      }

      console.log('[SAVE] Başladı');

      let saveUri: string | null = null;

      console.log('[SAVE] ViewShot capture başlıyor...');
      if (viewShotRef.current) {
        saveUri = await (viewShotRef.current as any).capture();
      } else if (photoUri) {
        saveUri = photoUri;
      }
      console.log('[SAVE] ViewShot capture bitti:', saveUri ? 'ok' : 'null');

      if (saveUri) {
        const localUri = saveUri.startsWith('file://') ? saveUri : `file://${saveUri}`;
        console.log('[SAVE] Galeriye kayıt başlıyor...');
        const galleryOk = await ensureMediaLibrarySavePermission();
        if (!galleryOk) {
          Alert.alert(
            'Galeri izni',
            'Fotoğrafı galeriye kaydetmek için izin gerekli. Tekrar deneyin veya Ayarlar üzerinden uygulamaya fotoğraf erişimi verin.',
            [
              { text: 'İptal', style: 'cancel', onPress: () => setIsSaving(false) },
              { text: 'Ayarlara git', onPress: () => void Linking.openSettings() },
            ]
          );
          setIsSaving(false);
          return;
        }
        await MediaLibrary.saveToLibraryAsync(localUri);
        console.log('[SAVE] Galeriye kayıt bitti!');
      }

      const _saveUri = saveUri;
      const _photoUriForPdf = photoUri;
      const _locationData = locationData;
      const _address = address;
      const _timestamp = timestamp;
      const _operator = operator;
      const _fiber = fiber;
      const _type = type;
      const _municipalityName = muniForSave.name;
      const _settingsIlce = settingsIlce;
      const _settingsMahalle = settingsMahalle;
      const _settingsSokak = settingsSokak;
      const _settingsSokakTuru = settingsSokakTuru;
      const _settingsBazIstasyonuOlcu = settingsBazIstasyonuOlcu;
      const _settingsTrafoOlcu = settingsTrafoOlcu;

      const parts = _address?.split(',') || [];
      const neighborhood = parts.find(p => p.toLowerCase().includes('mah'))?.trim() || '-';
      const sokak = parts.find(p => p.toLowerCase().includes('sok'))?.trim() || '-';

      let base64Image = '';
      const imageToEmbed = _saveUri || _photoUriForPdf;
      if (imageToEmbed) {
        try {
          const localPath = imageToEmbed.startsWith('file://') ? imageToEmbed : `file://${imageToEmbed}`;
          const base64Str = await (FileSystem as any).readAsStringAsync(localPath, {
            encoding: (FileSystem as any).EncodingType.Base64,
          });
          base64Image = `data:image/jpeg;base64,${base64Str}`;
        } catch (e) {
          console.warn('Base64 error: ', e);
          base64Image = imageToEmbed;
        }
      }

      let logoBase64: string | null = null;
      if (muniForSave.logo_url) {
        try {
          const dest = `${(FileSystem as any).cacheDirectory}muni_logo_${Date.now()}.img`;
          const dl = await (FileSystem as any).downloadAsync(muniForSave.logo_url, dest);
          const base64Str = await (FileSystem as any).readAsStringAsync(dl.uri, {
            encoding: (FileSystem as any).EncodingType.Base64,
          });
          const lower = muniForSave.logo_url.toLowerCase();
          const mime = lower.includes('.png') ? 'png' : lower.includes('.webp') ? 'webp' : 'jpeg';
          logoBase64 = `data:image/${mime};base64,${base64Str}`;
        } catch (e) {
          console.warn('Belediye logosu indirilemedi', e);
        }
      }

      const finalMahalle = _settingsMahalle.trim() || neighborhood;
      const finalSokak = _settingsSokak.trim() || sokak;

      let fullOperatorName = _operator || '-';
      if (_type === 'Menhol' || _type === 'Kabin') {
        const match = OPERATOR_DATA.MenholKabin.find(o => o.short === _operator);
        if (match) fullOperatorName = match.full;
      } else if (_type === 'Baz İstasyonu') {
        const match = OPERATOR_DATA.BazIstasyonu.find(o => o.short === _operator);
        if (match) fullOperatorName = match.full;
      }

      const htmlContent = generatePdfHtml(
        base64Image,
        _locationData,
        _address,
        _timestamp,
        fullOperatorName,
        _fiber,
        _type,
        _municipalityName,
        logoBase64,
        finalMahalle,
        finalSokak,
        _settingsSokakTuru,
        _settingsIlce.trim(),
        _settingsBazIstasyonuOlcu.trim(),
        _settingsTrafoOlcu.trim()
      );

      const { uri: pdfUri } = await Print.printToFileAsync({ html: htmlContent });
      const fileName = `report_${Date.now()}.pdf`;
      const response = await fetch(pdfUri);
      const blob = await response.blob();
      const arrayBuffer = await new Response(blob).arrayBuffer();

      const { error: uploadError } = await supabase.storage
        .from('reports')
        .upload(fileName, arrayBuffer, { contentType: 'application/pdf' });

      if (uploadError) {
        throw new Error(uploadError.message || 'PDF depolamaya yüklenemedi');
      }

      const { data: publicUrlData } = supabase.storage.from('reports').getPublicUrl(fileName);

      const insertPayload = {
        pdf_url: publicUrlData.publicUrl,
        latitude: _locationData?.latitude,
        longitude: _locationData?.longitude,
        address: _address,
        timestamp_text: _timestamp,
        operator: fullOperatorName,
        fiber: _fiber,
        type: _type,
        municipality_id: municipalityId,
        municipality_name: _municipalityName,
        neighborhood: finalMahalle || neighborhood,
        sokak: finalSokak || sokak,
        ilce: _settingsIlce.trim() || null,
        user_id: authSession.user.id,
      };

      const insertWithoutIlce = () => {
        const { ilce: _drop, ...rest } = insertPayload;
        return rest;
      };

      let { error: insertError } = await supabase.from('report_logs').insert([insertPayload]);

      const errMsg = (insertError?.message || '').toLowerCase();
      if (insertError && errMsg.includes('ilce')) {
        console.warn('[PDF] ilce kolonu yok veya şema; ilce olmadan tekrar deneniyor.');
        const retryNoIlce = await supabase.from('report_logs').insert([insertWithoutIlce()]);
        insertError = retryNoIlce.error;
      }

      if (insertError?.code === 'PGRST204') {
        console.warn('[PDF] Schema cache, tekrar deneniyor...');
        await new Promise((r) => setTimeout(r, 1500));
        let retry = await supabase.from('report_logs').insert([insertPayload]);
        insertError = retry.error;
        if (insertError) {
          const m = (insertError.message || '').toLowerCase();
          if (m.includes('ilce')) {
            retry = await supabase.from('report_logs').insert([insertWithoutIlce()]);
            insertError = retry.error;
          }
        }
      }

      if (insertError) {
        console.error('[PDF] Tablo kayıt hatası:', insertError);
        throw new Error(insertError.message || 'Rapor veritabanına kaydedilemedi');
      }

      console.log('[PDF] Kayıt tamamlandı.');
      setIsSaving(false);
      resetPhoto();
    } catch (e: any) {
      console.error('Kaydetme Hatası:', e);
      Alert.alert('Kayıt', e?.message || String(e));
      setIsSaving(false);
    }
  };


  // If a photo was taken, display it with info
  if (photoUri) {

    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.previewContainer}>
          <ViewShot ref={viewShotRef} options={{ format: "jpg", quality: 0.9 }} style={styles.viewShotContainer}>
            <Image source={{ uri: photoUri }} style={styles.fullImage} resizeMode="contain" />

            <View style={styles.overlayInfoBox}>
              <View style={styles.mapContainer}>
                {locationFailed ? (
                  <View style={[styles.mapImage, styles.mapPlaceholder]}>
                    <MaterialIcons name="location-off" size={36} color="#f5d742" />
                  </View>
                ) : locationData ? (
                  <Image
                    source={{
                      uri: `https://static-maps.yandex.ru/1.x/?lang=tr_TR&ll=${locationData.longitude},${locationData.latitude}&z=15&l=sat,skl&size=300,300&pt=${locationData.longitude},${locationData.latitude},pm2rdl`
                    }}
                    style={styles.mapImage}
                  />
                ) : (
                  <View style={[styles.mapImage, styles.mapPlaceholder]}>
                    <ActivityIndicator size="small" color="#f5d742" />
                  </View>
                )}
              </View>

              <View style={styles.detailsContainer}>
                <View style={styles.detailsHeaderRow}>
                  <Text style={styles.addressTitle} numberOfLines={2}>
                    {locationFailed
                      ? 'Konum alınamadı'
                      : !locationData
                        ? 'Konum alınıyor…'
                        : !address
                          ? 'Adres çözümleniyor…'
                          : address.split(',').slice(-3).join(',').trim()}
                  </Text>
                </View>

                <Text style={styles.addressSub} numberOfLines={2}>
                  {locationFailed
                    ? 'GPS zaman aşımı veya hata. Yeniden çekin.'
                    : !locationData
                      ? 'Lütfen bekleyin…'
                      : address || '—'}
                </Text>

                {locationData && !locationFailed && (
                  <Text style={styles.coordinateText}>
                    Enlem: {locationData.latitude.toFixed(6)}° Boylam: {locationData.longitude.toFixed(6)}°
                  </Text>
                )}
                <Text style={styles.dateText}>{timestamp}</Text>
              </View>
            </View>
          </ViewShot>
        </View>


        <View style={[styles.actionButtons, { paddingBottom: Math.max(insets.bottom + 10, 15) }]}>
          <TouchableOpacity style={[styles.button, styles.secondaryButton]} onPress={resetPhoto} disabled={isSaving}>
            <Text style={[styles.buttonText, {color: '#333'}]}>İptal</Text>
          </TouchableOpacity>
          {locationFailed ? (
            <TouchableOpacity
              style={[styles.button, { minWidth: 160 }]}
              onPress={resetPhoto}
              disabled={isSaving}
            >
              <Text style={styles.buttonText}>Yeniden Çek</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[
                styles.button,
                { minWidth: 160 },
                (isSaving || isProcessing || !locationData) && { opacity: 0.45 },
              ]}
              onPress={processAndSave}
              disabled={isSaving || isProcessing || !locationData}
            >
              {isSaving ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : isProcessing || !locationData ? (
                <Text style={styles.buttonText}>Konum bekleniyor…</Text>
              ) : (
                <Text style={styles.buttonText}>Galeriye Kaydet</Text>
              )}
            </TouchableOpacity>
          )}
        </View>

        <Modal visible={isSaving} transparent animationType="fade" statusBarTranslucent>
          <View style={styles.savingOverlay}>
            <ActivityIndicator size="large" color="#fff" />
            <Text style={styles.savingOverlayText}>Kaydediliyor…</Text>
            <Text style={styles.savingOverlaySub}>PDF oluşturuluyor ve sunucuya yükleniyor</Text>
          </View>
        </Modal>
      </SafeAreaView>
    );
  }

  // Camera View
  return (
    <SafeAreaView style={styles.container}>
      {/* Üst ortada tür badge'i - Tıklanabilir */}
      <TouchableOpacity 
        style={styles.typeBadge} 
        onPress={() => setIsTypeSelectionVisible(true)}
        activeOpacity={0.7}
      >
        <Text style={styles.typeBadgeText}>{type || 'Tür Seçin'}</Text>
      </TouchableOpacity>
      <View style={styles.topBarLeft}>
        <TouchableOpacity style={styles.flashButton} onPress={toggleFlash}>
          <MaterialIcons 
            name={flash === 'on' ? 'flash-on' : flash === 'auto' ? 'flash-auto' : 'flash-off'} 
            size={28} 
            color="white" 
          />
        </TouchableOpacity>
      </View>
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.settingsButton} onPress={() => setIsSettingsVisible(true)}>
          <MaterialIcons name="settings" size={28} color="white" />
        </TouchableOpacity>
      </View>
      <View style={styles.cameraSection}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          flash={flash}
          ref={cameraRef}
        />
        <View
          style={[
            styles.cameraUI,
            { paddingBottom: Math.max(insets.bottom + 20, 40), pointerEvents: 'box-none' },
          ]}
        >
          {isProcessing ? (
            <ActivityIndicator size="large" color="#ffffff" />
          ) : (
            <View style={styles.captureContainer}>
              <TouchableOpacity style={styles.captureButton} onPress={takePicture}>
                <View style={styles.captureInner} />
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>

      {/* HIZLI TÜR SEÇİM MODALI */}
      <Modal visible={isTypeSelectionVisible} animationType="fade" transparent={true} onRequestClose={() => setIsTypeSelectionVisible(false)}>
        <TouchableOpacity 
          style={styles.modalOverlay} 
          activeOpacity={1} 
          onPress={() => setIsTypeSelectionVisible(false)}
        >
          <View style={[styles.modalContent, { maxHeight: '60%' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Hızlı Tür Seçimi</Text>
              <TouchableOpacity onPress={() => setIsTypeSelectionVisible(false)}>
                <MaterialIcons name="close" size={24} color="#333" />
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={styles.quickTypeGrid}>
                {types.map(t => (
                  <TouchableOpacity 
                    key={t} 
                    style={[styles.quickTypeItem, type === t && styles.quickTypeItemSelected]} 
                    onPress={() => quickSaveType(t)}
                  >
                    <MaterialIcons 
                      name={t === 'Menhol' ? 'settings-input-component' : 
                            t === 'Kabin' ? 'storage' : 
                            t === 'Baz İstasyonu' ? 'cell-tower' : 
                            t === 'Elektrik Panosu' ? 'bolt' : 
                            t === 'Doğalgaz' ? 'local-fire-department' : 
                            t === 'Trafo' ? 'ev-station' : 'lightbulb'} 
                      size={28} 
                      color={type === t ? '#fff' : '#444'} 
                    />
                    <Text style={[styles.quickTypeLabel, type === t && styles.quickTypeLabelSelected]}>{t}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* SETTINGS MODAL */}
      <Modal visible={isSettingsVisible} animationType="fade" transparent={true} onRequestClose={() => setIsSettingsVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Ayarlar</Text>
            
            <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
              <Text style={styles.sectionTitle}>Hesap</Text>
              <Text style={{ marginBottom: 6, color: '#444' }}>{session.user.email}</Text>
              {profile?.full_name ? (
                <Text style={{ marginBottom: 10, color: '#666' }}>{profile.full_name}</Text>
              ) : null}
              <TouchableOpacity
                style={[styles.button, styles.secondaryButton, { marginBottom: 10 }]}
                onPress={() => {
                  setIsSettingsVisible(false);
                  setIsReportsVisible(true);
                }}
              >
                <Text style={[styles.buttonText, { color: '#333' }]}>Rapor Arşivim</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, { backgroundColor: '#c62828', marginBottom: 16 }]}
                onPress={async () => {
                  setIsSettingsVisible(false);
                  await signOut();
                  router.replace(asHref('/login'));
                }}
              >
                <Text style={styles.buttonText}>Çıkış Yap</Text>
              </TouchableOpacity>

              <Text style={styles.sectionTitle}>Belediye</Text>
              {municipalitiesError ? (
                <Text style={{ color: '#c62828', marginBottom: 8, fontSize: 13 }}>{municipalitiesError}</Text>
              ) : null}
              {municipalitiesLoading ? (
                <ActivityIndicator style={{ marginVertical: 12 }} />
              ) : (
                <>
                  <TouchableOpacity
                    style={styles.input}
                    onPress={() => setMunicipalityPickerVisible(true)}
                  >
                    <Text style={{ color: selectedMunicipality ? '#111' : '#999' }}>
                      {selectedMunicipality
                        ? (() => {
                            const { name: n, district: d, province: p } = selectedMunicipality;
                            if (d?.trim()) return `${n} · ${d.trim()}, ${p}`;
                            return p ? `${n} (${p})` : n;
                          })()
                        : 'Belediye seçin'}
                    </Text>
                  </TouchableOpacity>
                </>
              )}

              <Text style={styles.sectionTitle}>İlçe Adı</Text>
              <TextInput
                style={styles.input}
                value={settingsIlce}
                onChangeText={setSettingsIlce}
                placeholder="Örn: İlkadım (boş bırakılabilir)"
                placeholderTextColor="#999"
              />

              <Text style={styles.sectionTitle}>Mahalle Adı</Text>
              <TextInput
                style={styles.input}
                value={settingsMahalle}
                onChangeText={setSettingsMahalle}
                placeholder="Örn: Cumhuriyet Mahallesi"
                placeholderTextColor="#999"
              />

              <Text style={styles.sectionTitle}>Sokak mı / Cadde mi / Bulvar mı?</Text>
              <View style={styles.chipContainer}>
                {(['Sokak', 'Cadde', 'Bulvar'] as const).map(t => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.chip, settingsSokakTuru === t && styles.chipSelected]}
                    onPress={() => setSettingsSokakTuru(t)}
                  >
                    <Text style={[styles.chipText, settingsSokakTuru === t && styles.chipTextSelected]}>{t}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.sectionTitle}>Adı ({settingsSokakTuru})</Text>
              <TextInput
                style={styles.input}
                value={settingsSokak}
                onChangeText={setSettingsSokak}
                placeholder={
                  settingsSokakTuru === 'Cadde' ? 'Örn: Atatürk Caddesi' : 
                  settingsSokakTuru === 'Bulvar' ? 'Örn: Cumhuriyet Bulvarı' : 
                  'Örn: Gül Sokağı'
                }
                placeholderTextColor="#999"
              />

              {/* Tür seçimi buradan kaldırıldı, sadece üst badge üzerinden yapılabilecek */}

              {/* DİNAMİK OPERATÖR / FİRMA SEÇİMİ */}
              {(type === 'Menhol' || type === 'Kabin') ? (
                <>
                  <Text style={styles.sectionTitle}>Operatör / Firma</Text>
                  <View style={styles.chipContainer}>
                    {OPERATOR_DATA.MenholKabin.map(op => (
                      <TouchableOpacity 
                        key={op.short} 
                        style={[styles.chip, operator === op.short && styles.chipSelected]} 
                        onPress={() => setOperator(op.short)}
                      >
                        <Text style={[styles.chipText, operator === op.short && styles.chipTextSelected]}>{op.short}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              ) : type === 'Baz İstasyonu' ? (
                <>
                  <Text style={styles.sectionTitle}>GSM Operatörü</Text>
                  <View style={styles.chipContainer}>
                    {OPERATOR_DATA.BazIstasyonu.map(op => (
                      <TouchableOpacity 
                        key={op.short} 
                        style={[styles.chip, operator === op.short && styles.chipSelected]} 
                        onPress={() => setOperator(op.short)}
                      >
                        <Text style={[styles.chipText, operator === op.short && styles.chipTextSelected]}>{op.short}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={styles.sectionTitle}>Baz İstasyonu Ölçüleri (cm)</Text>
                  <TextInput
                    style={styles.input}
                    value={settingsBazIstasyonuOlcu}
                    onChangeText={setSettingsBazIstasyonuOlcu}
                    placeholder="Örn: 200 x 150 x 300 (PDF için elle girilir)"
                    placeholderTextColor="#999"
                  />
                </>
              ) : type === 'Trafo' ? (
                <>
                  <Text style={styles.sectionTitle}>Firma İsmi (Manuel)</Text>
                  <TextInput
                    style={styles.input}
                    value={operator || ''}
                    onChangeText={setOperator}
                    placeholder="Firma ismini giriniz"
                    placeholderTextColor="#999"
                  />
                  <Text style={styles.sectionTitle}>Elektrik Aydınlatma Trafosu Ölçüleri (cm)</Text>
                  <TextInput
                    style={styles.input}
                    value={settingsTrafoOlcu}
                    onChangeText={setSettingsTrafoOlcu}
                    placeholder="Örn: 80 x 60 x 120 (PDF için elle girilir)"
                    placeholderTextColor="#999"
                  />
                </>
              ) : type ? (
                <>
                  <Text style={styles.sectionTitle}>Firma İsmi (Manuel)</Text>
                  <TextInput
                    style={styles.input}
                    value={operator || ''}
                    onChangeText={setOperator}
                    placeholder="Firma ismini giriniz"
                    placeholderTextColor="#999"
                  />
                </>
              ) : null}
            </ScrollView>

            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.button, styles.secondaryButton, { flex: 1, marginRight: 10 }]} onPress={() => setIsSettingsVisible(false)}>
                <Text style={[styles.buttonText, {color: '#333'}]}>İptal</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.button, { flex: 1 }]} onPress={saveSettings}>
                <Text style={styles.buttonText}>Kaydet</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={municipalityPickerVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setMunicipalityPickerVisible(false)}
      >
        <View style={styles.modalOverlay}>
          {/*
            modalContent alignItems:center + FlatList = satır genişliği ikon kadar kalıyor, metin görünmüyor.
            alignItems: stretch ile tam genişlik.
          */}
          <View style={[styles.modalContent, styles.municipalityPickerCard]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                Belediye seç
                {selectableMunicipalities.length > 0 ? ` (${selectableMunicipalities.length})` : ''}
              </Text>
              <TouchableOpacity onPress={() => setMunicipalityPickerVisible(false)} style={{ padding: 5 }}>
                <MaterialIcons name="close" size={24} color="#333" />
              </TouchableOpacity>
            </View>
            <FlatList
              data={selectableMunicipalities}
              keyExtractor={(item, index) => (item.id != null ? String(item.id) : `m-${index}`)}
              style={styles.municipalityPickerList}
              contentContainerStyle={styles.municipalityPickerListContent}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                municipalitiesLoading ? (
                  <ActivityIndicator style={{ marginVertical: 24 }} />
                ) : municipalitiesError ? (
                  <Text style={{ textAlign: 'center', padding: 24, color: '#c62828' }}>
                    Belediyeler yüklenemedi: {municipalitiesError}
                  </Text>
                ) : (
                  <Text style={{ textAlign: 'center', padding: 24, color: '#999' }}>
                    {profile?.role === 'field'
                      ? 'Size atanmış belediye yok. Yönetici panelinden (Kullanıcılar) size belediye atanmalıdır.'
                      : 'Kayıtlı belediye yok. Yönetici panelinden ekleyin.'}
                  </Text>
                )
              }
              renderItem={({ item }) => (
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={styles.municipalityPickerRow}
                  onPress={() => {
                    setMunicipalityId(item.id);
                    setMunicipalityPickerVisible(false);
                  }}
                >
                  <View style={styles.municipalityPickerIconWrap}>
                    <MaterialIcons name="location-city" size={26} color="#64748b" />
                  </View>
                  <View style={styles.municipalityPickerTextCol}>
                    <Text style={styles.municipalityPickerName} numberOfLines={2}>
                      {item.name}
                    </Text>
                    {item.province ? (
                      <Text style={styles.municipalityPickerSub} numberOfLines={2}>
                        {item.district?.trim()
                          ? `${item.district.trim()} · ${item.province}`
                          : item.province}
                      </Text>
                    ) : null}
                  </View>
                  {municipalityId === item.id ? (
                    <MaterialIcons name="check" size={22} color="#2196F3" style={{ flexShrink: 0 }} />
                  ) : null}
                </TouchableOpacity>
              )}
            />
          </View>
        </View>
      </Modal>

      <Modal visible={isReportsVisible} animationType="slide" transparent={true} onRequestClose={() => setIsReportsVisible(false)}>
        <KeyboardAvoidingView 
          behavior={Platform.OS === 'ios' ? 'padding' : undefined} 
          style={{flex: 1}}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Rapor Arşiv</Text>
                <TouchableOpacity onPress={() => setIsReportsVisible(false)} style={{padding: 5}}>
                  <MaterialIcons name="close" size={24} color="#333" />
                </TouchableOpacity>
              </View>

              {isLoadingReports ? (
                <ActivityIndicator size="large" color="#2196F3" style={{marginTop: 20}} />
              ) : (
                <FlatList
                  data={reports}
                  keyExtractor={(item) => String(item.id)}
                  style={styles.reportsList}
                  keyboardShouldPersistTaps="always"
                  contentContainerStyle={{ paddingBottom: 20 }}
                  ListEmptyComponent={<Text style={{ textAlign: 'center', marginTop: 30, color: '#999' }}>Rapor bulunamadı.</Text>}
                  renderItem={({ item: report }) => (
                    <View style={styles.reportItem}>
                      <View style={styles.reportInfo}>
                        <Text style={styles.reportType}>{report.type || 'Bilinmiyor'} - {report.operator || ''}</Text>
                        <Text style={styles.reportAddress} numberOfLines={1}>{report.municipality_name || ''} {report.neighborhood || ''}</Text>
                        <Text style={styles.reportDate}>{report.timestamp_text}</Text>
                        {report.profiles?.full_name || report.profiles?.email ? (
                          <Text style={{ fontSize: 12, color: '#1565c0', marginTop: 4 }}>
                            {report.profiles?.full_name || report.profiles?.email}
                          </Text>
                        ) : null}
                      </View>
                      <TouchableOpacity 
                        onPress={() => {
                          if (!report.pdf_url) return;
                          if (Platform.OS === 'web') {
                            void openExternalUrl(report.pdf_url);
                            return;
                          }
                          void Sharing.shareAsync(report.pdf_url);
                        }} 
                        style={{padding: 12, backgroundColor: '#f0f0f0', borderRadius: 20}}
                      >
                        <MaterialIcons name="picture-as-pdf" size={24} color="#f44336" />
                      </TouchableOpacity>
                    </View>
                  )}
                />
              )}

              <View style={styles.modalActions}>
                <TouchableOpacity style={[styles.button, { flex: 1 }]} onPress={() => setIsReportsVisible(false)}>
                  <Text style={styles.buttonText}>Kapat</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  cameraSection: {
    flex: 1,
  },
  cameraUI: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
    justifyContent: 'flex-end',
    paddingBottom: 40,
  },
  captureContainer: {
    alignItems: 'center',
  },
  captureButton: {
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  captureInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'white',
  },
  previewContainer: {
    flex: 1,
    backgroundColor: '#fff',
  },
  viewShotContainer: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#fff',
  },
  fullImage: {
    flex: 1,
    width: '100%',
  },
  overlayInfoBox: {
    position: 'absolute',
    bottom: 20,
    left: 15,
    right: 15,
    flexDirection: 'row',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  mapContainer: {
    width: 90,
    height: 110,
    marginRight: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#ffffff55',
    overflow: 'hidden',
    backgroundColor: '#333',
  },
  mapImage: {
    width: '100%',
    height: '100%',
  },
  mapPlaceholder: {
    backgroundColor: '#333',
    justifyContent: 'center',
    alignItems: 'center',
  },
  detailsContainer: {
    flex: 1,
    justifyContent: 'center',
  },
  detailsHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 4,
  },
  addressTitle: {
    flex: 1,
    fontSize: 16,
    color: '#FFD700',
    fontWeight: 'bold',
    marginRight: 8,
    ...Platform.select({
      web: { textShadow: '1px 1px 3px rgba(0,0,0,0.8)' },
      default: {
        textShadowColor: 'rgba(0,0,0,0.8)',
        textShadowOffset: { width: 1, height: 1 },
        textShadowRadius: 3,
      },
    }),
  },
  addressSub: {
    fontSize: 12,
    color: '#fff',
    marginBottom: 6,
    ...Platform.select({
      web: { textShadow: '1px 1px 3px rgba(0,0,0,0.8)' },
      default: {
        textShadowColor: 'rgba(0,0,0,0.8)',
        textShadowOffset: { width: 1, height: 1 },
        textShadowRadius: 3,
      },
    }),
  },
  coordinateText: {
    fontSize: 12,
    color: '#fff',
    marginBottom: 6,
    ...Platform.select({
      web: { textShadow: '1px 1px 3px rgba(0,0,0,0.8)' },
      default: {
        textShadowColor: 'rgba(0,0,0,0.8)',
        textShadowOffset: { width: 1, height: 1 },
        textShadowRadius: 3,
      },
    }),
  },
  dateText: {
    fontSize: 12,
    color: '#fff',
    ...Platform.select({
      web: { textShadow: '1px 1px 3px rgba(0,0,0,0.8)' },
      default: {
        textShadowColor: 'rgba(0,0,0,0.8)',
        textShadowOffset: { width: 1, height: 1 },
        textShadowRadius: 3,
      },
    }),
  },
  savingOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  savingOverlayText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    marginTop: 20,
    textAlign: 'center',
  },
  savingOverlaySub: {
    color: 'rgba(255,255,255,0.88)',
    fontSize: 14,
    marginTop: 10,
    textAlign: 'center',
    paddingHorizontal: 16,
  },
  actionButtons: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    padding: 15,
    backgroundColor: '#1e1e1e',
  },
  button: {
    backgroundColor: '#2196F3',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    width: '100%',
    maxHeight: '80%',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
  },
  /** Belediye seçici: üst modalContent alignItems:center satırları boğuyordu */
  municipalityPickerCard: {
    maxHeight: '72%',
    alignItems: 'stretch',
    alignSelf: 'stretch',
  },
  municipalityPickerList: {
    width: '100%',
    flexGrow: 1,
    minHeight: 120,
  },
  municipalityPickerListContent: {
    paddingBottom: 12,
    flexGrow: 1,
  },
  municipalityPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  municipalityPickerIconWrap: {
    width: 44,
    height: 44,
    marginRight: 12,
    borderRadius: 6,
    backgroundColor: '#eef2f6',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  municipalityPickerTextCol: {
    flex: 1,
    minWidth: 0,
    marginRight: 8,
  },
  municipalityPickerName: {
    fontSize: 16,
    color: '#111',
    fontWeight: '600',
  },
  municipalityPickerSub: {
    fontSize: 13,
    color: '#666',
    marginTop: 2,
  },
  scrollContent: {
    width: '100%',
    flexGrow: 0,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 10,
    color: '#333',
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginTop: 15,
    marginBottom: 8,
    color: '#555',
    alignSelf: 'flex-start',
  },
  chipContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    width: '100%',
  },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
    backgroundColor: '#f0f0f0',
    borderWidth: 1,
    borderColor: '#ddd',
  },
  chipSelected: {
    backgroundColor: '#2196F3',
    borderColor: '#2196F3',
  },
  chipText: {
    color: '#333',
    fontSize: 14,
  },
  chipTextSelected: {
    color: '#fff',
    fontWeight: 'bold',
  },
  modalActions: {
    flexDirection: 'row',
    width: '100%',
    marginTop: 20,
    justifyContent: 'space-between',
  },
  secondaryButton: {
    backgroundColor: '#e0e0e0',
  },
  buttonText: {
    color: 'white',
    fontWeight: 'bold',
    fontSize: 16,
  },
  typeBadge: {
    position: 'absolute',
    top: 60,
    alignSelf: 'center', // Sadece içerik (badge) genişliğinde olması için
    zIndex: 1000, 
  },
  typeBadgeText: {
    backgroundColor: 'rgba(0,0,0,0.8)',
    color: '#FFD700',
    fontSize: 22, // Daha da büyük
    fontWeight: '900',
    paddingHorizontal: 30,
    paddingVertical: 12,
    borderRadius: 30,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: '#FFD700',
    ...Platform.select({
      web: {
        boxShadow: '0 6px 8px rgba(0,0,0,0.6)',
      },
      default: {
        elevation: 10,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.6,
        shadowRadius: 8,
      },
    }),
  },
  topBar: {
    position: 'absolute',
    top: 50,
    right: 20,
    zIndex: 10,
    flexDirection: 'row',
  },
  topBarLeft: {
    position: 'absolute',
    top: 50,
    left: 20,
    zIndex: 10,
    flexDirection: 'row',
  },
  settingsButton: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 10,
    borderRadius: 20,
  },
  flashButton: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 10,
    borderRadius: 20,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    alignItems: 'center',
    marginBottom: 15,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd',
    marginBottom: 15,
    width: '100%',
  },
  searchInput: {
    flex: 1,
    padding: 12,
    fontSize: 16,
    color: '#333',
  },
  reportsList: {
    width: '100%',
    flex: 1,
  },
  reportItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    borderRadius: 8,
    marginBottom: 5,
  },
  reportItemSelected: {
    backgroundColor: '#e3f2fd',
  },
  reportCheck: {
    marginRight: 10,
  },
  reportInfo: {
    flex: 1,
  },
  reportType: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#333',
  },
  reportAddress: {
    fontSize: 12,
    color: '#666',
  },
  reportDate: {
    fontSize: 10,
    color: '#999',
    marginTop: 2,
  },
  quickTypeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    paddingTop: 10,
  },
  quickTypeItem: {
    width: '48%',
    backgroundColor: '#f5f5f5',
    padding: 15,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 15,
    borderWidth: 1,
    borderColor: '#eee',
  },
  quickTypeItemSelected: {
    backgroundColor: '#2196F3',
    borderColor: '#2196F3',
  },
  quickTypeLabel: {
    marginTop: 8,
    fontSize: 14,
    fontWeight: '600',
    color: '#444',
    textAlign: 'center',
  },
  quickTypeLabelSelected: {
    color: '#fff',
  },
  input: {
    width: '100%',
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: '#333',
    backgroundColor: '#fafafa',
  },
});
