import { AdminDateInput } from '@/components/admin/AdminDateInput';
import { AdminTopBar } from '@/components/admin/AdminTopBar';
import { adminTheme } from '@/constants/adminTheme';
import { useAuth } from '@/contexts/AuthContext';
import { useAdminToast } from '@/contexts/AdminToastContext';
import { useMunicipalities } from '@/contexts/MunicipalitiesContext';
import { asHref } from '@/utils/asHref';
import {
    isManualOperatorType,
    presetOperatorPairs,
} from '@/utils/reportOperators';
import { MaterialIcons } from '@expo/vector-icons';
import { Link, Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ViewStyle } from 'react-native';
import {
    ActivityIndicator,
    FlatList,
    Linking,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../../supabase';
import { downloadReportsZip } from '@/utils/bulkDownloadReportsZip';
import { extractReportsStoragePath } from '@/utils/reportsStoragePath';

const REPORT_TYPES = [
  'Menhol',
  'Kabin',
  'Baz İstasyonu',
  'Aydınlatma Direği',
  'Elektrik Panosu',
  'Doğalgaz',
  'Trafo',
] as const;

type ReportRow = {
  id: string;
  pdf_url: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  timestamp_text: string | null;
  operator: string | null;
  fiber: string | null;
  type: string | null;
  municipality_name: string | null;
  neighborhood: string | null;
  sokak: string | null;
  ilce: string | null;
  municipality_id: string | null;
  user_id: string | null;
  created_at: string | null;
  profiles: { full_name: string | null; email: string | null } | null;
};

type ProfileOption = { id: string; email: string | null; full_name: string | null };

/** API’den gelen satır (PostgREST embed FK olmadan ilişki kuramıyor; profiles ayrı birleştirilir) */
type RawReportRow = Omit<ReportRow, 'profiles'>;

function escapeIlike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** Web: tarayıcı indirmesi; native: URL aç */
const listScrollHideWeb: ViewStyle | undefined =
  Platform.OS === 'web'
    ? ({ scrollbarWidth: 'none', msOverflowStyle: 'none' } as ViewStyle)
    : undefined;

const ADMIN_PROVINCE_KEY = 'admin_selected_province_v1';

export default function AdminScreen() {
  const { session, profile, loading: authLoading } = useAuth();
  const showToast = useAdminToast();
  const { municipalities } = useMunicipalities();
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [users, setUsers] = useState<ProfileOption[]>([]);
  const [rawRows, setRawRows] = useState<RawReportRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [usersLoading, setUsersLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [reportDeleteTarget, setReportDeleteTarget] = useState<ReportRow | null>(null);
  const [reportDeleteBusy, setReportDeleteBusy] = useState(false);

  const [searchText, setSearchText] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [userFilter, setUserFilter] = useState<string>('');
  const [municipalityFilter, setMunicipalityFilter] = useState('');
  const [neighborhoodFilter, setNeighborhoodFilter] = useState('');
  const [sokakFilter, setSokakFilter] = useState('');
  const [ilceFilter, setIlceFilter] = useState('');
  const [operatorFilter, setOperatorFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [typeModalOpen, setTypeModalOpen] = useState(false);
  const [operatorModalOpen, setOperatorModalOpen] = useState(false);
  const [dynamicOperators, setDynamicOperators] = useState<string[]>([]);
  const [dynamicOpsLoading, setDynamicOpsLoading] = useState(false);

  const [selectedProvince, setSelectedProvince] = useState('');
  const [provinceModalOpen, setProvinceModalOpen] = useState(false);

  /** PDF’li satırların toplu ZIP indirmesi için seçim */
  const [selectedReportIds, setSelectedReportIds] = useState<string[]>([]);
  const [bulkDownloading, setBulkDownloading] = useState(false);

  const isAdmin = profile?.role === 'admin';

  const provinceOptions = useMemo(() => {
    const s = new Set<string>();
    for (const m of municipalities) {
      const p = (m.province || '').trim();
      if (p) s.add(p);
    }
    return [...s].sort((a, b) => a.localeCompare(b, 'tr'));
  }, [municipalities]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof sessionStorage === 'undefined') return;
    const saved = sessionStorage.getItem(ADMIN_PROVINCE_KEY);
    if (saved) setSelectedProvince(saved);
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof sessionStorage === 'undefined') return;
    if (selectedProvince) sessionStorage.setItem(ADMIN_PROVINCE_KEY, selectedProvince);
    else sessionStorage.removeItem(ADMIN_PROVINCE_KEY);
  }, [selectedProvince]);


  const rows = useMemo((): ReportRow[] => {
    const profileMap = new Map(
      users.map((u) => [u.id, { full_name: u.full_name, email: u.email }])
    );
    let list: ReportRow[] = rawRows.map((r) => ({
      ...r,
      /** PostgREST bazen uuid’yi nesne/sayı döndürebilir; liste + seçim için string */
      id: String(r.id),
      profiles: r.user_id ? profileMap.get(r.user_id) ?? null : null,
    }));
    if (searchText.trim()) {
      const t = searchText.trim().toLowerCase();
      list = list.filter((r) => {
        const blob = [
          r.address,
          r.municipality_name,
          r.neighborhood,
          r.operator,
          r.sokak,
          r.ilce,
          r.type,
          r.fiber,
          r.timestamp_text,
          r.profiles?.full_name,
          r.profiles?.email,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return blob.includes(t);
      });
    }
    return list;
  }, [rawRows, users, searchText]);

  const rowIdSet = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);

  useEffect(() => {
    setSelectedReportIds((prev) => prev.filter((id) => rowIdSet.has(id)));
  }, [rowIdSet]);

  const pdfRows = useMemo(() => rows.filter((r) => r.pdf_url), [rows]);
  const selectedPdfCount = useMemo(
    () =>
      selectedReportIds.filter((id) => {
        const r = rows.find((x) => x.id === id);
        return !!r?.pdf_url;
      }).length,
    [selectedReportIds, rows]
  );

  const toggleReportSelect = useCallback((id: string) => {
    setSelectedReportIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const selectAllPdfInList = useCallback(() => {
    setSelectedReportIds(pdfRows.map((r) => r.id));
  }, [pdfRows]);

  const clearReportSelection = useCallback(() => setSelectedReportIds([]), []);

  const runBulkZipDownload = useCallback(async () => {
    const items = rows.filter((r) => selectedReportIds.includes(r.id) && r.pdf_url);
    if (items.length === 0) {
      showToast({ message: 'Önce PDF’li kayıtları işaretleyin.', variant: 'error', duration: 4000 });
      return;
    }
    setBulkDownloading(true);
    try {
      const prov = selectedProvince.trim().replace(/\s+/g, '_') || 'il';
      const base = `raporlar_${prov}_${new Date().toISOString().slice(0, 10)}`;
      await downloadReportsZip(
        items.map((r) => ({
          id: r.id,
          pdf_url: r.pdf_url!,
          type: r.type,
          operator: r.operator,
        })),
        base
      );
      showToast({ message: `${items.length} PDF tek ZIP dosyasında indirildi.` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast({ message: msg, variant: 'error', duration: 8000 });
    } finally {
      setBulkDownloading(false);
    }
  }, [rows, selectedReportIds, selectedProvince, showToast]);

  useEffect(() => {
    if (!session || !isAdmin) {
      setUsersLoading(false);
      return;
    }
    (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, email, full_name')
        .order('email');
      if (!error && data) setUsers(data as ProfileOption[]);
      setUsersLoading(false);
    })();
  }, [session, isAdmin]);

  useEffect(() => {
    setOperatorFilter('');
  }, [typeFilter]);

  useEffect(() => {
    if (!session || !isAdmin || !typeFilter || !isManualOperatorType(typeFilter)) {
      setDynamicOperators([]);
      setDynamicOpsLoading(false);
      return;
    }
    if (!selectedProvince.trim()) {
      setDynamicOperators([]);
      setDynamicOpsLoading(false);
      return;
    }
    const spNorm = selectedProvince.trim().toLowerCase();
    const provinceIds = municipalities
      .filter((m) => (m.province || '').trim().toLowerCase() === spNorm)
      .map((m) => m.id);
    if (provinceIds.length === 0) {
      setDynamicOperators([]);
      setDynamicOpsLoading(false);
      return;
    }
    let cancelled = false;
    setDynamicOpsLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from('report_logs')
        .select('operator')
        .eq('type', typeFilter)
        .in('municipality_id', provinceIds)
        .limit(8000);
      if (cancelled) return;
      if (error) {
        console.error(error);
        setDynamicOperators([]);
      } else {
        const u = [...new Set((data ?? []).map((r) => r.operator).filter(Boolean))] as string[];
        u.sort((a, b) => a.localeCompare(b, 'tr'));
        setDynamicOperators(u);
      }
      setDynamicOpsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [typeFilter, session, isAdmin, municipalities, selectedProvince]);

  const operatorPickerLabel = useMemo(() => {
    if (!operatorFilter.trim()) return 'Tümü';
    const preset = presetOperatorPairs(typeFilter);
    const hit = preset.find((p) => p.full === operatorFilter.trim());
    if (hit) return hit.short;
    const s = operatorFilter.trim();
    return s.length > 30 ? `${s.slice(0, 30)}…` : s;
  }, [operatorFilter, typeFilter]);

  const QUERY_TIMEOUT_MS = 45_000;

  const selectProvince = useCallback((p: string) => {
    setMunicipalityFilter('');
    setNeighborhoodFilter('');
    setSokakFilter('');
    setIlceFilter('');
    setOperatorFilter('');
    setSearchText('');
    setSelectedProvince(p);
    setProvinceModalOpen(false);
  }, []);

  const runQuery = useCallback(async () => {
    if (!selectedProvince.trim()) {
      setRawRows([]);
      return;
    }
    const spNorm = selectedProvince.trim().toLowerCase();
    const inProvince = municipalities.filter(
      (m) => (m.province || '').trim().toLowerCase() === spNorm
    );
    const provinceMuniIds = inProvince.map((m) => m.id);
    const provinceMuniNames = [...new Set(inProvince.map((m) => m.name.trim()).filter(Boolean))];

    if (provinceMuniIds.length === 0 && provinceMuniNames.length === 0) {
      setRawRows([]);
      return;
    }

    const applyDetailFilters = (q: any) => {
      if (dateFrom.trim()) q = q.gte('created_at', `${dateFrom.trim()}T00:00:00.000Z`);
      if (dateTo.trim()) q = q.lte('created_at', `${dateTo.trim()}T23:59:59.999Z`);
      if (typeFilter) q = q.eq('type', typeFilter);
      if (userFilter) q = q.eq('user_id', userFilter);
      if (municipalityFilter.trim()) {
        q = q.ilike('municipality_name', `%${escapeIlike(municipalityFilter.trim())}%`);
      }
      if (neighborhoodFilter.trim()) {
        q = q.ilike('neighborhood', `%${escapeIlike(neighborhoodFilter.trim())}%`);
      }
      if (sokakFilter.trim()) {
        q = q.ilike('sokak', `%${escapeIlike(sokakFilter.trim())}%`);
      }
      if (ilceFilter.trim()) {
        q = q.ilike('ilce', `%${escapeIlike(ilceFilter.trim())}%`);
      }
      if (operatorFilter.trim()) {
        q = q.eq('operator', operatorFilter.trim());
      }
      return q;
    };

    const race = <T,>(p: Promise<{ data: T | null; error: unknown }>) =>
      Promise.race([
        p,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Sunucu yanıt vermedi. Ağı kontrol edip tekrar deneyin.')),
            QUERY_TIMEOUT_MS
          )
        ),
      ]);

    setLoading(true);
    try {
      const promises: Promise<{ data: unknown; error: unknown }>[] = [];
      if (provinceMuniIds.length > 0) {
        let qById = applyDetailFilters(
          supabase.from('report_logs').select('*').in('municipality_id', provinceMuniIds)
        );
        qById = qById.order('created_at', { ascending: false }).limit(800);
        promises.push(race(qById));
      }
      if (provinceMuniNames.length > 0) {
        let qLegacy = applyDetailFilters(
          supabase.from('report_logs').select('*').is('municipality_id', null).in('municipality_name', provinceMuniNames)
        );
        qLegacy = qLegacy.order('created_at', { ascending: false }).limit(800);
        promises.push(race(qLegacy));
      }
      if (promises.length === 0) {
        setRawRows([]);
        return;
      }

      const results = await Promise.all(promises);
      for (const res of results) {
        if (res.error) {
          console.error(res.error);
          setRawRows([]);
          showToast({
            message: String((res.error as { message?: string }).message ?? res.error),
            variant: 'error',
            duration: 7000,
          });
          return;
        }
      }

      const byId = new Map<string, RawReportRow>();
      for (const res of results) {
        const rows = (res.data || []) as RawReportRow[];
        for (const row of rows) {
          byId.set(row.id, row);
        }
      }
      const merged = [...byId.values()].sort((a, b) => {
        const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
        const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
        return tb - ta;
      });
      setRawRows(merged.slice(0, 500));
    } catch (e) {
      console.error('[admin] runQuery', e);
      setRawRows([]);
      const msg = e instanceof Error ? e.message : String(e);
      showToast({ message: msg, variant: 'error', duration: 7000 });
    } finally {
      setLoading(false);
    }
  }, [
    selectedProvince,
    municipalities,
    typeFilter,
    userFilter,
    municipalityFilter,
    neighborhoodFilter,
    sokakFilter,
    ilceFilter,
    operatorFilter,
    dateFrom,
    dateTo,
    showToast,
  ]);

  useEffect(() => {
    if (session && isAdmin && selectedProvince.trim()) {
      void runQuery();
    }
    if (session && isAdmin && !selectedProvince.trim()) {
      setRawRows([]);
    }
  }, [session, isAdmin, selectedProvince, runQuery]);

  useFocusEffect(
    useCallback(() => {
      if (session && isAdmin && selectedProvince.trim()) void runQuery();
    }, [session, isAdmin, selectedProvince, runQuery])
  );

  const clearFilters = () => {
    setSearchText('');
    setTypeFilter('');
    setUserFilter('');
    setMunicipalityFilter('');
    setNeighborhoodFilter('');
    setSokakFilter('');
    setIlceFilter('');
    setOperatorFilter('');
    setDateFrom('');
    setDateTo('');
  };

  const performDeleteReport = useCallback(
    async (row: ReportRow): Promise<boolean> => {
      setDeletingId(row.id);
      try {
        const { error } = await supabase.from('report_logs').delete().eq('id', row.id);
        if (error) {
          showToast({ message: `Hata: ${error.message}`, variant: 'error', duration: 7000 });
          return false;
        }
        if (row.pdf_url) {
          const path = extractReportsStoragePath(row.pdf_url);
          if (path) {
            const { error: stErr } = await supabase.storage.from('reports').remove([path]);
            if (stErr && __DEV__) {
              console.warn('[admin] Depo dosyası silinemedi (RLS veya yol):', stErr.message);
            }
          }
        }
        setRawRows((prev) => prev.filter((r) => r.id !== row.id));
        showToast({ message: 'Kayıt silindi' });
        return true;
      } finally {
        setDeletingId(null);
      }
    },
    [showToast]
  );

  const dismissReportDelete = () => {
    if (!reportDeleteBusy) setReportDeleteTarget(null);
  };

  const executeReportDelete = async () => {
    if (!reportDeleteTarget) return;
    setReportDeleteBusy(true);
    try {
      const ok = await performDeleteReport(reportDeleteTarget);
      if (ok) setReportDeleteTarget(null);
    } finally {
      setReportDeleteBusy(false);
    }
  };

  const confirmDeleteReport = useCallback((row: ReportRow) => {
    setReportDeleteTarget(row);
  }, []);

  const userLabel = useMemo(
    () => (u: ProfileOption) => u.full_name || u.email || u.id.slice(0, 8),
    []
  );

  if (authLoading && !session) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={adminTheme.accent} />
      </View>
    );
  }

  if (!session) {
    return <Redirect href={asHref('/login?redirect=/admin')} />;
  }

  if (Platform.OS !== 'web') {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.deniedWrap}>
          <View style={styles.deniedCard}>
            <View style={styles.deniedIconCircle}>
              <MaterialIcons name="computer" size={36} color={adminTheme.accent} />
            </View>
            <Text style={styles.deniedTitle}>Web tarayıcı gerekli</Text>
            <Text style={styles.deniedText}>
              Yönetim paneli yalnızca bilgisayar tarayıcısında kullanılır. Saha uygulaması için bu cihazdaki
              ana ekranı kullanın.
            </Text>
            <TouchableOpacity style={styles.primaryBtnSolid} onPress={() => router.replace(asHref('/'))}>
              <Text style={styles.primaryBtnSolidText}>Saha uygulamasına dön</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (!isAdmin) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.deniedWrap}>
          <View style={styles.deniedCard}>
            <View style={[styles.deniedIconCircle, { backgroundColor: adminTheme.dangerBg }]}>
              <MaterialIcons name="lock-outline" size={36} color={adminTheme.danger} />
            </View>
            <Text style={styles.deniedTitle}>Yetkisiz</Text>
            <Text style={styles.deniedText}>Bu sayfa yalnızca yönetici hesapları içindir.</Text>
            <Text style={[styles.deniedText, { marginBottom: 4 }]}>
              Saha uygulaması mobilde; yönetici işlemleri web üzerinden yapılır.
            </Text>
            <Link href={asHref('/login')} asChild>
              <TouchableOpacity style={styles.outlineBtn}>
                <Text style={styles.outlineBtnText}>Başka hesapla giriş</Text>
              </TouchableOpacity>
            </Link>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.adminShell}>
      <AdminTopBar title="Raporlar" />

      <View style={styles.mainRow}>
        <View style={styles.filterColumn}>
          <View style={styles.filterCard}>
            <View style={styles.filterCardHeader}>
              <MaterialIcons name="tune" size={18} color={adminTheme.accent} />
              <Text style={styles.filterHeading}>Filtreler</Text>
            </View>

            <Text style={styles.filterBlockTitle}>İl (zorunlu)</Text>
            <TouchableOpacity
              style={styles.userPickerBtn}
              onPress={() => setProvinceModalOpen(true)}
              activeOpacity={0.7}
            >
              <MaterialIcons name="place" size={18} color={adminTheme.accent} />
              <Text
                style={[styles.userPickerText, !selectedProvince.trim() && { color: adminTheme.textMuted }]}
                numberOfLines={1}
              >
                {selectedProvince.trim() ? selectedProvince : 'İl seçin…'}
              </Text>
              <MaterialIcons name="arrow-drop-down" size={22} color={adminTheme.textMuted} />
            </TouchableOpacity>

            <View style={styles.filterSectionSpacer} />
            <Text style={styles.filterBlockTitle}>Liste ve tarih</Text>
            <Text style={styles.labelCompact}>Genel arama</Text>
            <TextInput
              style={styles.inputCompact}
              value={searchText}
              onChangeText={setSearchText}
              placeholder="Liste üzerinde ara…"
              placeholderTextColor={adminTheme.textMuted}
            />

            <View style={styles.row2Compact}>
              <View style={styles.row2Item}>
                <AdminDateInput label="Başlangıç" value={dateFrom} onChange={setDateFrom} />
              </View>
              <View style={styles.row2Item}>
                <AdminDateInput label="Bitiş" value={dateTo} onChange={setDateTo} />
              </View>
            </View>

            <View style={styles.filterSectionSpacer} />
            <Text style={styles.filterBlockTitle}>Detay filtre</Text>

            <Text style={styles.labelCompact}>Tür</Text>
            <TouchableOpacity
              style={styles.userPickerBtn}
              onPress={() => setTypeModalOpen(true)}
              activeOpacity={0.7}
            >
              <Text style={styles.userPickerText} numberOfLines={2}>
                {typeFilter || 'Tümü'}
              </Text>
              <MaterialIcons name="arrow-drop-down" size={22} color={adminTheme.textMuted} />
            </TouchableOpacity>

            {typeFilter ? (
              <>
                <Text style={styles.labelCompact}>Operatör / firma</Text>
                {isManualOperatorType(typeFilter) && dynamicOpsLoading ? (
                  <ActivityIndicator color={adminTheme.accent} size="small" style={{ marginVertical: 6 }} />
                ) : (
                  <TouchableOpacity
                    style={styles.userPickerBtn}
                    onPress={() => setOperatorModalOpen(true)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.userPickerText} numberOfLines={2}>
                      {operatorPickerLabel}
                    </Text>
                    <MaterialIcons name="arrow-drop-down" size={22} color={adminTheme.textMuted} />
                  </TouchableOpacity>
                )}
              </>
            ) : null}

            <Text style={styles.labelCompact}>Belediye</Text>
            <TextInput
              style={styles.inputCompact}
              value={municipalityFilter}
              onChangeText={setMunicipalityFilter}
              placeholder="…"
              placeholderTextColor={adminTheme.textMuted}
            />

            <Text style={styles.labelCompact}>İlçe</Text>
            <TextInput
              style={styles.inputCompact}
              value={ilceFilter}
              onChangeText={setIlceFilter}
              placeholder="…"
              placeholderTextColor={adminTheme.textMuted}
            />

            <Text style={styles.labelCompact}>Mahalle</Text>
            <TextInput
              style={styles.inputCompact}
              value={neighborhoodFilter}
              onChangeText={setNeighborhoodFilter}
              placeholder="…"
              placeholderTextColor={adminTheme.textMuted}
            />

            <Text style={styles.labelCompact}>Sokak / cadde / bulvar</Text>
            <TextInput
              style={styles.inputCompact}
              value={sokakFilter}
              onChangeText={setSokakFilter}
              placeholder="Cadde, sokak veya bulvar adı"
              placeholderTextColor={adminTheme.textMuted}
            />

            <Text style={styles.labelCompact}>Kullanıcı</Text>
            {usersLoading ? (
              <ActivityIndicator color={adminTheme.accent} size="small" />
            ) : (
              <TouchableOpacity
                style={styles.userPickerBtn}
                onPress={() => setUserModalOpen(true)}
                activeOpacity={0.7}
              >
                <Text style={styles.userPickerText} numberOfLines={1}>
                  {userFilter
                    ? (() => {
                        const u = users.find((x) => x.id === userFilter);
                        return u ? userLabel(u) : userFilter.slice(0, 10);
                      })()
                    : 'Tümü'}
                </Text>
                <MaterialIcons name="arrow-drop-down" size={22} color={adminTheme.textMuted} />
              </TouchableOpacity>
            )}

            <View style={styles.filterButtonsCompact}>
              <Pressable
                style={({ pressed }) => [
                  styles.primaryBtnCompact,
                  Platform.OS === 'web' && styles.primaryBtnCompactWeb,
                  pressed && !loading && styles.primaryBtnCompactPressed,
                  loading && styles.primaryBtnCompactLoading,
                ]}
                onPress={() => void runQuery()}
                disabled={loading}
              >
                {loading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.primaryBtnTextCompact}>Filtrele</Text>
                )}
              </Pressable>
              <TouchableOpacity style={styles.secondaryBtnCompact} onPress={clearFilters}>
                <Text style={styles.secondaryBtnTextCompact}>Temizle</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        <View style={styles.listColumn}>
          <View style={styles.listHeader}>
            <View style={styles.listHeaderTop}>
              <View style={styles.resultPill}>
                <Text style={styles.resultCount}>
                  {!selectedProvince.trim() ? 'İl seçilmedi' : `${rows.length} kayıt`}
                </Text>
              </View>
              {pdfRows.length > 0 ? (
                <Text style={styles.pdfHint}>{pdfRows.length} kayıtta PDF var</Text>
              ) : null}
            </View>
            {selectedProvince.trim() && pdfRows.length > 0 ? (
              <View style={styles.bulkBar}>
                <TouchableOpacity
                  style={styles.bulkChip}
                  onPress={selectAllPdfInList}
                  disabled={bulkDownloading}
                  accessibilityLabel="PDF olan tüm kayıtları seç"
                >
                  <MaterialIcons name="select-all" size={16} color={adminTheme.accentDark} />
                  <Text style={styles.bulkChipText}>Tümünü seç</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.bulkChip}
                  onPress={clearReportSelection}
                  disabled={bulkDownloading || selectedPdfCount === 0}
                  accessibilityLabel="Seçimi temizle"
                >
                  <MaterialIcons name="clear-all" size={16} color={adminTheme.textSecondary} />
                  <Text style={styles.bulkChipTextMuted}>Seçimi temizle</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.bulkPrimary,
                    (selectedPdfCount === 0 || bulkDownloading) && styles.bulkPrimaryDisabled,
                  ]}
                  onPress={() => void runBulkZipDownload()}
                  disabled={selectedPdfCount === 0 || bulkDownloading}
                  accessibilityLabel="Seçilen PDFleri ZIP olarak indir"
                >
                  {bulkDownloading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <>
                      <MaterialIcons name="archive" size={18} color="#fff" />
                      <Text style={styles.bulkPrimaryText}>
                        ZIP indir{selectedPdfCount > 0 ? ` (${selectedPdfCount})` : ''}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            ) : null}
          </View>

          <FlatList
            data={rows}
            keyExtractor={(item) => String(item.id)}
            style={[styles.listFlat, listScrollHideWeb]}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.cardStripe} />
            <View style={styles.cardInner}>
            <View style={styles.cardTop}>
              {item.pdf_url ? (
                <TouchableOpacity
                  style={styles.cardCheckHit}
                  onPress={() => toggleReportSelect(item.id)}
                  disabled={bulkDownloading}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: selectedReportIds.includes(item.id) }}
                  accessibilityLabel="Bu kaydı ZIP indirmeye dahil et"
                >
                  <MaterialIcons
                    name={selectedReportIds.includes(item.id) ? 'check-box' : 'check-box-outline-blank'}
                    size={26}
                    color={selectedReportIds.includes(item.id) ? adminTheme.accent : adminTheme.textMuted}
                  />
                </TouchableOpacity>
              ) : (
                <View style={styles.cardCheckSpacer} />
              )}
              <View style={{ flex: 1 }}>
                <View style={styles.cardTitleRow}>
                  <Text style={styles.cardTypePill}>{item.type || 'Tür yok'}</Text>
                </View>
                <Text style={styles.cardTitle}>{item.operator || '—'}</Text>
                <Text style={styles.cardSub} numberOfLines={2}>
                  {[item.municipality_name, item.ilce, item.neighborhood, item.sokak]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
                <Text style={styles.cardMeta}>
                  {item.timestamp_text || '—'}
                  {item.created_at
                    ? ` · ${new Date(item.created_at).toLocaleString('tr-TR')}`
                    : ''}
                </Text>
                <View style={styles.userRow}>
                  <MaterialIcons name="person-outline" size={14} color={adminTheme.accent} />
                  <Text style={styles.cardUser}>
                    {item.profiles?.full_name || item.profiles?.email || item.user_id?.slice(0, 8) || '—'}
                  </Text>
                </View>
              </View>
              {item.pdf_url ? (
                <View style={styles.pdfActions}>
                  <TouchableOpacity
                    style={styles.cardIconBtn}
                    onPress={() => Linking.openURL(item.pdf_url!)}
                    accessibilityLabel="PDF aç"
                  >
                    <MaterialIcons name="picture-as-pdf" size={24} color={adminTheme.danger} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.cardIconBtn}
                    onPress={() => confirmDeleteReport(item)}
                    disabled={deletingId === item.id}
                    accessibilityLabel="Kaydı sil"
                  >
                    {deletingId === item.id ? (
                      <View style={styles.cardIconSpinner}>
                        <ActivityIndicator size="small" color={adminTheme.danger} />
                      </View>
                    ) : (
                      <MaterialIcons name="delete-outline" size={24} color={adminTheme.danger} />
                    )}
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
            {item.address ? (
              <Text style={styles.cardAddr} numberOfLines={3}>
                {item.address}
              </Text>
            ) : null}
            </View>
          </View>
        )}
            ListEmptyComponent={
              loading ? null : (
                <Text style={styles.empty}>
                  {!selectedProvince.trim()
                    ? 'Listeyi görmek için soldaki filtrelerden il seçin.'
                    : 'Kayıt yok veya filtreye uyan sonuç yok.'}
                </Text>
              )
            }
          />
        </View>
      </View>

      <Modal
        visible={provinceModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setProvinceModalOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setProvinceModalOpen(false)} />
          <View style={[styles.modalCard, { maxHeight: '70%' }]}>
            <Text style={styles.modalTitle}>İl değiştir</Text>
            <Text style={styles.modalHint}>
              İl değişince liste ve detay filtreler bu ile göre yenilenir.
            </Text>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              {provinceOptions.map((p) => (
                <TouchableOpacity
                  key={p}
                  style={[styles.modalRow, selectedProvince === p && styles.modalRowOn]}
                  onPress={() => selectProvince(p)}
                >
                  <Text style={styles.modalRowText}>{p}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        visible={typeModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setTypeModalOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setTypeModalOpen(false)} />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Tür seç</Text>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <TouchableOpacity
                style={[styles.modalRow, !typeFilter && styles.modalRowOn]}
                onPress={() => {
                  setTypeFilter('');
                  setTypeModalOpen(false);
                }}
              >
                <Text style={styles.modalRowText}>Tümü</Text>
              </TouchableOpacity>
              {REPORT_TYPES.map((t) => (
                <TouchableOpacity
                  key={t}
                  style={[styles.modalRow, typeFilter === t && styles.modalRowOn]}
                  onPress={() => {
                    setTypeFilter(t);
                    setTypeModalOpen(false);
                  }}
                >
                  <Text style={styles.modalRowText} numberOfLines={2}>
                    {t}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        visible={operatorModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setOperatorModalOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOperatorModalOpen(false)} />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Operatör / firma seç</Text>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <TouchableOpacity
                style={[styles.modalRow, !operatorFilter.trim() && styles.modalRowOn]}
                onPress={() => {
                  setOperatorFilter('');
                  setOperatorModalOpen(false);
                }}
              >
                <Text style={styles.modalRowText}>Tümü</Text>
              </TouchableOpacity>
              {isManualOperatorType(typeFilter)
                ? dynamicOperators.map((op) => (
                    <TouchableOpacity
                      key={op}
                      style={[styles.modalRow, operatorFilter === op && styles.modalRowOn]}
                      onPress={() => {
                        setOperatorFilter(op);
                        setOperatorModalOpen(false);
                      }}
                    >
                      <Text style={styles.modalRowText} numberOfLines={3}>
                        {op}
                      </Text>
                    </TouchableOpacity>
                  ))
                : presetOperatorPairs(typeFilter).map((p) => (
                    <TouchableOpacity
                      key={p.short}
                      style={[styles.modalRow, operatorFilter === p.full && styles.modalRowOn]}
                      onPress={() => {
                        setOperatorFilter(p.full);
                        setOperatorModalOpen(false);
                      }}
                    >
                      <Text style={styles.modalRowText} numberOfLines={2}>
                        {p.short}
                      </Text>
                    </TouchableOpacity>
                  ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        visible={userModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setUserModalOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setUserModalOpen(false)} />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Kullanıcı seç</Text>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <TouchableOpacity
                style={styles.modalRow}
                onPress={() => {
                  setUserFilter('');
                  setUserModalOpen(false);
                }}
              >
                <Text style={styles.modalRowText}>Tümü</Text>
              </TouchableOpacity>
              {users.map((u) => (
                <TouchableOpacity
                  key={u.id}
                  style={[styles.modalRow, userFilter === u.id && styles.modalRowOn]}
                  onPress={() => {
                    setUserFilter(u.id);
                    setUserModalOpen(false);
                  }}
                >
                  <Text style={styles.modalRowText} numberOfLines={2}>
                    {userLabel(u)}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        visible={!!reportDeleteTarget}
        transparent
        animationType="fade"
        onRequestClose={dismissReportDelete}
      >
        <View style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={dismissReportDelete} />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Kaydı sil</Text>
            <Text style={styles.reportDeleteBody}>
              Bu rapor veritabanından silinecek; varsa PDF dosyası da depodan kaldırılır. Emin misiniz?
            </Text>
            <View style={styles.reportDeleteRow}>
              <TouchableOpacity
                style={styles.reportDeleteCancel}
                onPress={dismissReportDelete}
                disabled={reportDeleteBusy}
              >
                <Text style={styles.reportDeleteCancelText}>İptal</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.reportDeleteDanger, reportDeleteBusy && styles.opacityDisabled]}
                onPress={() => void executeReportDelete()}
                disabled={reportDeleteBusy}
              >
                {reportDeleteBusy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.reportDeleteDangerText}>Sil</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: adminTheme.bg },
  adminShell: {
    flex: 1,
    width: '100%',
    maxWidth: adminTheme.maxContent,
    alignSelf: 'center',
    minHeight: 0,
  },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: adminTheme.bg },
  deniedWrap: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: adminTheme.bg,
  },
  deniedCard: {
    backgroundColor: adminTheme.surface,
    borderRadius: adminTheme.radiusLg,
    padding: 28,
    maxWidth: 420,
    width: '100%',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: adminTheme.border,
    ...adminTheme.shadowCard,
  },
  deniedIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: adminTheme.accentLight,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  deniedTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: adminTheme.text,
    letterSpacing: -0.3,
    marginBottom: 8,
  },
  deniedText: {
    textAlign: 'center',
    color: adminTheme.textSecondary,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 20,
  },
  primaryBtnSolid: {
    backgroundColor: adminTheme.accent,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: adminTheme.radiusMd,
    width: '100%',
    alignItems: 'center',
  },
  primaryBtnSolidText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  outlineBtn: {
    borderWidth: 1,
    borderColor: adminTheme.accent,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: adminTheme.radiusMd,
    width: '100%',
    alignItems: 'center',
  },
  outlineBtnText: { color: adminTheme.accent, fontWeight: '600', fontSize: 16 },
  mainRow: {
    flex: 1,
    flexDirection: 'row',
    minHeight: 0,
    width: '100%',
  },
  filterColumn: {
    width: 272,
    flexShrink: 0,
    borderRightWidth: 1,
    borderRightColor: adminTheme.border,
    backgroundColor: adminTheme.bg,
    justifyContent: 'flex-start',
  },
  filterCard: {
    flex: 1,
    backgroundColor: adminTheme.surface,
    borderRadius: adminTheme.radiusMd,
    margin: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: adminTheme.border,
    ...adminTheme.shadowCard,
    justifyContent: 'space-between',
  },
  listColumn: {
    flex: 1,
    minWidth: 0,
    backgroundColor: adminTheme.bg,
  },
  listFlat: { flex: 1 },
  filterCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  filterHeading: { fontSize: 15, fontWeight: '700', color: adminTheme.text },
  filterBlockTitle: {
    fontSize: 10,
    fontWeight: '700',
    color: adminTheme.textSecondary,
    marginBottom: 2,
    marginTop: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  filterSectionSpacer: {
    marginTop: 10,
    marginBottom: 4,
    borderTopWidth: 1,
    borderTopColor: adminTheme.border,
  },
  labelCompact: {
    fontSize: 10,
    fontWeight: '700',
    color: adminTheme.textMuted,
    marginBottom: 3,
    marginTop: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  inputCompact: {
    borderWidth: 1,
    borderColor: adminTheme.border,
    borderRadius: adminTheme.radiusSm,
    paddingHorizontal: 8,
    paddingVertical: Platform.OS === 'ios' ? 7 : 5,
    backgroundColor: adminTheme.surfaceMuted,
    fontSize: 12,
    color: adminTheme.text,
  },
  row2Compact: { flexDirection: 'row', gap: 8 },
  row2Item: { flex: 1, minWidth: 0 },
  chipsWrapCompact: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  chipCompact: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: adminTheme.radiusFull,
    backgroundColor: adminTheme.chipInactive,
    borderWidth: 1,
    borderColor: adminTheme.border,
  },
  chipOn: {
    backgroundColor: adminTheme.accent,
    borderColor: adminTheme.accent,
  },
  chipTextCompact: { color: adminTheme.chipInactiveText, fontSize: 10, fontWeight: '500' },
  chipTextOn: { color: '#fff', fontWeight: '600' },
  userPickerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: adminTheme.border,
    borderRadius: adminTheme.radiusSm,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: adminTheme.surfaceMuted,
  },
  userPickerText: { flex: 1, fontSize: 12, color: adminTheme.text, marginRight: 4 },
  filterButtonsCompact: { flexDirection: 'column', gap: 6, marginTop: 8 },
  primaryBtnCompact: {
    width: '100%',
    backgroundColor: adminTheme.accent,
    paddingVertical: 10,
    borderRadius: adminTheme.radiusSm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnCompactWeb: { cursor: 'pointer' } as ViewStyle,
  primaryBtnCompactPressed: { opacity: 0.92 },
  primaryBtnCompactLoading: { opacity: 0.88 },
  primaryBtnTextCompact: { color: '#fff', fontWeight: '700', fontSize: 13 },
  secondaryBtnCompact: {
    width: '100%',
    paddingVertical: 8,
    borderRadius: adminTheme.radiusSm,
    borderWidth: 1,
    borderColor: adminTheme.border,
    backgroundColor: adminTheme.surface,
    alignItems: 'center',
  },
  secondaryBtnTextCompact: { color: adminTheme.textSecondary, fontWeight: '600', fontSize: 12 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 400,
    maxHeight: '70%',
    backgroundColor: adminTheme.surface,
    borderRadius: adminTheme.radiusLg,
    padding: 16,
    borderWidth: 1,
    borderColor: adminTheme.border,
    ...adminTheme.shadowCard,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: adminTheme.text,
    marginBottom: 8,
  },
  modalHint: {
    fontSize: 12,
    color: adminTheme.textSecondary,
    marginBottom: 8,
    lineHeight: 18,
  },
  modalScroll: { maxHeight: 360 },
  modalRow: {
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: adminTheme.radiusSm,
  },
  modalRowOn: { backgroundColor: adminTheme.accentLight },
  modalRowText: { fontSize: 14, color: adminTheme.text },
  reportDeleteBody: {
    fontSize: 14,
    lineHeight: 21,
    color: adminTheme.text,
    marginBottom: 18,
  },
  reportDeleteRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  reportDeleteCancel: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: adminTheme.radiusSm,
    borderWidth: 1,
    borderColor: adminTheme.border,
    backgroundColor: adminTheme.surfaceMuted,
  },
  reportDeleteCancelText: { fontSize: 15, fontWeight: '600', color: adminTheme.textSecondary },
  reportDeleteDanger: {
    minWidth: 100,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: adminTheme.radiusSm,
    backgroundColor: adminTheme.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reportDeleteDangerText: { fontSize: 15, fontWeight: '700', color: '#fff' },
  opacityDisabled: { opacity: 0.65 },
  listHeader: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: adminTheme.border,
    backgroundColor: adminTheme.surface,
    gap: 10,
  },
  listHeaderTop: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
  },
  pdfHint: { fontSize: 12, color: adminTheme.textMuted, fontWeight: '500' },
  bulkBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  bulkChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: adminTheme.radiusSm,
    borderWidth: 1,
    borderColor: adminTheme.border,
    backgroundColor: adminTheme.surfaceMuted,
  },
  bulkChipText: { fontSize: 13, fontWeight: '600', color: adminTheme.accentDark },
  bulkChipTextMuted: { fontSize: 13, fontWeight: '600', color: adminTheme.textSecondary },
  bulkPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: adminTheme.radiusSm,
    backgroundColor: adminTheme.accent,
    marginLeft: 'auto',
  },
  bulkPrimaryDisabled: { opacity: 0.45 },
  bulkPrimaryText: { fontSize: 14, fontWeight: '700', color: '#fff' },
  resultPill: {
    alignSelf: 'flex-start',
    backgroundColor: adminTheme.accentLight,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: adminTheme.radiusFull,
  },
  resultCount: { fontSize: 13, color: adminTheme.accentDark, fontWeight: '600' },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 32,
  },
  card: {
    flexDirection: 'row',
    backgroundColor: adminTheme.surface,
    borderRadius: adminTheme.radiusLg,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: adminTheme.border,
    overflow: 'hidden',
    ...adminTheme.shadowCard,
  },
  cardStripe: {
    width: 4,
    backgroundColor: adminTheme.accent,
  },
  cardInner: { flex: 1, paddingVertical: 18, paddingHorizontal: 20 },
  cardTop: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  cardCheckHit: {
    width: 36,
    minHeight: 40,
    justifyContent: 'flex-start',
    alignItems: 'flex-start',
    paddingTop: 2,
  },
  cardCheckSpacer: { width: 36 },
  cardTitleRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 6 },
  cardTypePill: {
    fontSize: 11,
    fontWeight: '700',
    color: adminTheme.accentDark,
    backgroundColor: adminTheme.accentLight,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: adminTheme.radiusFull,
    overflow: 'hidden',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  cardTitle: { fontSize: 17, fontWeight: '700', color: adminTheme.text, letterSpacing: -0.2 },
  cardSub: { fontSize: 14, color: adminTheme.textSecondary, marginTop: 6, lineHeight: 20 },
  cardMeta: { fontSize: 12, color: adminTheme.textMuted, marginTop: 8 },
  userRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  cardUser: { fontSize: 13, color: adminTheme.accent, fontWeight: '600' },
  cardAddr: {
    fontSize: 13,
    color: adminTheme.textSecondary,
    marginTop: 12,
    lineHeight: 19,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: adminTheme.border,
  },
  pdfActions: {
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 6,
  },
  /** PDF ve sil: aynı dokunma alanı ve ikon boyutu (24) */
  cardIconBtn: {
    width: 40,
    height: 40,
    borderRadius: adminTheme.radiusMd,
    backgroundColor: adminTheme.dangerBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardIconSpinner: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { textAlign: 'center', color: adminTheme.textMuted, marginTop: 32, fontSize: 15 },
});
