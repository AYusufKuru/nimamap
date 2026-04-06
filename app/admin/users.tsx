import { AdminTopBar } from '@/components/admin/AdminTopBar';
import { adminTheme } from '@/constants/adminTheme';
import { useAuth } from '@/contexts/AuthContext';
import { useAdminToast } from '@/contexts/AdminToastContext';
import { useMunicipalities } from '@/contexts/MunicipalitiesContext';
import { asHref } from '@/utils/asHref';
import { getFunctionInvokeErrorMessage } from '@/utils/parseSupabaseFunctionError';
import { WEB_APP_RESUME_EVENT } from '@/utils/webAppResume';
import { MaterialIcons } from '@expo/vector-icons';
import { Link, Redirect, router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
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

type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: string | null;
};

export default function AdminUsersScreen() {
  const { session, profile, loading: authLoading } = useAuth();
  const showToast = useAdminToast();
  const { municipalities, loading: municipalitiesLoading } = useMunicipalities();
  const [hasAdmin, setHasAdmin] = useState<boolean | null>(null);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [assignUser, setAssignUser] = useState<ProfileRow | null>(null);
  const [assignSelectedIds, setAssignSelectedIds] = useState<Set<string>>(new Set());
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignSaving, setAssignSaving] = useState(false);

  const [bootEmail, setBootEmail] = useState('');
  const [bootPassword, setBootPassword] = useState('');
  const [bootName, setBootName] = useState('');
  const [bootSecret, setBootSecret] = useState('');
  const [bootSubmitting, setBootSubmitting] = useState(false);

  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<'field' | 'admin'>('field');
  const [createSubmitting, setCreateSubmitting] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ProfileRow | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [editFullName, setEditFullName] = useState('');
  const [editRole, setEditRole] = useState<'field' | 'admin'>('field');
  const [editPassword, setEditPassword] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [userDeleteTarget, setUserDeleteTarget] = useState<ProfileRow | null>(null);
  const [userDeleteBusy, setUserDeleteBusy] = useState(false);

  const USERS_PAGE_SIZE = 35;
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [userListPage, setUserListPage] = useState(1);

  const loadHasAdmin = useCallback(async () => {
    const { data, error } = await supabase.rpc('has_admin');
    if (error) {
      console.warn('has_admin RPC:', error.message);
      setHasAdmin(false);
      return;
    }
    setHasAdmin(Boolean(data));
  }, []);

  const loadProfiles = useCallback(async () => {
    if (!session || profile?.role !== 'admin') return;
    setLoadingList(true);
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, role')
      .order('email');
    setLoadingList(false);
    if (!error && data) setProfiles(data as ProfileRow[]);
  }, [session, profile?.role]);

  useEffect(() => {
    loadHasAdmin();
  }, [loadHasAdmin]);

  useEffect(() => {
    if (hasAdmin && session && profile?.role === 'admin') {
      loadProfiles();
    }
  }, [hasAdmin, session, profile?.role, loadProfiles]);

  useEffect(() => {
    setUserListPage(1);
  }, [userSearchQuery]);

  const filteredProfiles = useMemo(() => {
    const q = userSearchQuery.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter((p) => {
      const email = (p.email ?? '').toLowerCase();
      const name = (p.full_name ?? '').toLowerCase();
      const id = (p.id ?? '').toLowerCase();
      return email.includes(q) || name.includes(q) || id.includes(q);
    });
  }, [profiles, userSearchQuery]);

  const userListPageCount = Math.max(1, Math.ceil(filteredProfiles.length / USERS_PAGE_SIZE));
  const pagedProfiles = useMemo(() => {
    const start = (userListPage - 1) * USERS_PAGE_SIZE;
    return filteredProfiles.slice(start, start + USERS_PAGE_SIZE);
  }, [filteredProfiles, userListPage]);

  useEffect(() => {
    if (userListPage > userListPageCount) setUserListPage(userListPageCount);
  }, [userListPage, userListPageCount]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onResume = () => {
      if (hasAdmin && session && profile?.role === 'admin') void loadProfiles();
    };
    window.addEventListener(WEB_APP_RESUME_EVENT, onResume);
    return () => window.removeEventListener(WEB_APP_RESUME_EVENT, onResume);
  }, [hasAdmin, session, profile?.role, loadProfiles]);

  const runBootstrap = async () => {
    if (!bootEmail.trim() || !bootPassword || !bootSecret.trim()) {
      showToast({ message: 'E-posta, şifre ve kurulum anahtarı gerekli.', variant: 'error' });
      return;
    }
    setBootSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('create-user', {
        body: {
          mode: 'bootstrap',
          email: bootEmail.trim(),
          password: bootPassword,
          full_name: bootName.trim(),
          bootstrap_secret: bootSecret.trim(),
        },
      });
      if (error) {
        const msg = await getFunctionInvokeErrorMessage(error, data);
        showToast({ message: msg, variant: 'error', duration: 7000 });
        return;
      }
      const errBody = data && typeof data === 'object' && data !== null && 'error' in data
        ? (data as { error?: string }).error
        : undefined;
      if (errBody) {
        showToast({ message: errBody, variant: 'error', duration: 7000 });
        return;
      }
      showToast({
        message: 'İlk yönetici oluşturuldu. Giriş sayfasına yönlendiriliyorsunuz.',
        duration: 3500,
      });
      setHasAdmin(true);
      setBootSecret('');
      setTimeout(() => router.replace(asHref('/login')), 1200);
    } finally {
      setBootSubmitting(false);
    }
  };

  const openAssignModal = useCallback(
    async (u: ProfileRow) => {
      if (u.role === 'admin') return;
      setAssignUser(u);
      setAssignModalOpen(true);
      setAssignLoading(true);
      setAssignSelectedIds(new Set());
      try {
        const { data, error } = await supabase
          .from('user_municipalities')
          .select('municipality_id')
          .eq('user_id', u.id);
        if (error) {
          showToast({ message: error.message, variant: 'error', duration: 6000 });
          setAssignModalOpen(false);
          return;
        }
        setAssignSelectedIds(new Set((data ?? []).map((r: { municipality_id: string }) => r.municipality_id)));
      } finally {
        setAssignLoading(false);
      }
    },
    [showToast]
  );

  const toggleAssignMunicipality = useCallback((municipalityId: string) => {
    setAssignSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(municipalityId)) next.delete(municipalityId);
      else next.add(municipalityId);
      return next;
    });
  }, []);

  const saveUserMunicipalities = async () => {
    if (!assignUser) return;
    setAssignSaving(true);
    try {
      const { error: delErr } = await supabase.from('user_municipalities').delete().eq('user_id', assignUser.id);
      if (delErr) throw new Error(delErr.message);
      const ids = [...assignSelectedIds];
      if (ids.length > 0) {
        const { error: insErr } = await supabase.from('user_municipalities').insert(
          ids.map((municipality_id) => ({ user_id: assignUser.id, municipality_id }))
        );
        if (insErr) throw new Error(insErr.message);
      }
      setAssignModalOpen(false);
      setAssignUser(null);
      showToast({ message: 'İşlem başarılı' });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast({ message: msg, variant: 'error', duration: 6000 });
    } finally {
      setAssignSaving(false);
    }
  };

  const openEditUser = useCallback((u: ProfileRow) => {
    setEditTarget(u);
    setEditEmail(u.email ?? '');
    setEditFullName(u.full_name ?? '');
    setEditRole(u.role === 'admin' ? 'admin' : 'field');
    setEditPassword('');
    setEditOpen(true);
  }, []);

  const saveEditUser = async () => {
    if (!editTarget || !session?.access_token) return;
    if (!editEmail.trim()) {
      showToast({ message: 'E-posta gerekli.', variant: 'error' });
      return;
    }
    setEditSaving(true);
    try {
      const body: Record<string, unknown> = {
        mode: 'update',
        user_id: editTarget.id,
        email: editEmail.trim().toLowerCase(),
        full_name: editFullName.trim(),
        role: editRole,
      };
      if (editPassword.trim()) body.password = editPassword.trim();

      const { data, error } = await supabase.functions.invoke('create-user', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body,
      });
      if (error) {
        throw new Error(await getFunctionInvokeErrorMessage(error, data));
      }
      const errBody =
        data && typeof data === 'object' && data !== null && 'error' in data
          ? (data as { error?: string }).error
          : undefined;
      if (errBody) throw new Error(errBody);

      setEditOpen(false);
      setEditTarget(null);
      showToast({ message: 'İşlem başarılı' });
      loadProfiles();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast({ message: msg, variant: 'error', duration: 7000 });
    } finally {
      setEditSaving(false);
    }
  };

  const dismissUserDelete = () => {
    if (!userDeleteBusy) setUserDeleteTarget(null);
  };

  const executeUserDelete = async () => {
    const u = userDeleteTarget;
    if (!u || !session?.access_token) return;
    setUserDeleteBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('delete-user', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { user_id: u.id },
      });
      if (error) {
        throw new Error(await getFunctionInvokeErrorMessage(error, data));
      }
      const errBody =
        data && typeof data === 'object' && data !== null && 'error' in data
          ? (data as { error?: string }).error
          : undefined;
      if (errBody) throw new Error(errBody);
      showToast({ message: 'İşlem başarılı' });
      setUserDeleteTarget(null);
      loadProfiles();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast({ message: msg, variant: 'error', duration: 7000 });
    } finally {
      setUserDeleteBusy(false);
    }
  };

  const confirmDeleteUser = (u: ProfileRow) => {
    if (u.id === session?.user?.id) {
      showToast({ message: 'Kendi hesabınızı silemezsiniz.', variant: 'error' });
      return;
    }
    setUserDeleteTarget(u);
  };

  const runCreateUser = async () => {
    if (!newEmail.trim() || !newPassword) {
      showToast({ message: 'E-posta ve şifre gerekli.', variant: 'error' });
      return;
    }
    if (!session?.access_token) {
      showToast({ message: 'Önce giriş yapın.', variant: 'error' });
      return;
    }
    setCreateSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('create-user', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: {
          mode: 'create',
          email: newEmail.trim(),
          password: newPassword,
          full_name: newName.trim(),
          role: newRole,
        },
      });
      if (error) {
        const msg = await getFunctionInvokeErrorMessage(error, data);
        showToast({ message: msg, variant: 'error', duration: 7000 });
        return;
      }
      const errBody = data && typeof data === 'object' && data !== null && 'error' in data
        ? (data as { error?: string }).error
        : undefined;
      if (errBody) {
        showToast({ message: errBody, variant: 'error', duration: 7000 });
        return;
      }
      showToast({ message: 'İşlem başarılı' });
      setNewEmail('');
      setNewPassword('');
      setNewName('');
      loadProfiles();
    } finally {
      setCreateSubmitting(false);
    }
  };

  if ((authLoading && !session) || hasAdmin === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={adminTheme.accent} />
        <Text style={styles.muted}>Yükleniyor…</Text>
      </View>
    );
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
              Kullanıcı ve rapor yönetimi yalnızca bilgisayar tarayıcısında açılır.
            </Text>
            <TouchableOpacity style={styles.primaryBtnSolid} onPress={() => router.replace(asHref('/'))}>
              <Text style={styles.primaryBtnSolidText}>Saha uygulamasına dön</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (!hasAdmin) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        <AdminTopBar mode="bootstrap" title="İlk yönetici" subtitle="Kurulum — bir kez" />
        <ScrollView contentContainerStyle={styles.scrollPad} keyboardShouldPersistTaps="handled">
          <View style={styles.banner}>
            <MaterialIcons name="info-outline" size={20} color={adminTheme.accentDark} style={{ marginBottom: 8 }} />
            <Text style={styles.bannerText}>
              Sistemde henüz yönetici yok. Supabase’te Edge Function için{' '}
              <Text style={styles.bannerBold}>BOOTSTRAP_SECRET</Text> tanımlayın; aynı değeri aşağıya
              yazın. Sonraki kullanıcılar bu panelden eklenir.
            </Text>
          </View>
          <View style={styles.sectionCard}>
          <Text style={styles.label}>E-posta</Text>
          <TextInput
            style={styles.input}
            value={bootEmail}
            onChangeText={setBootEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="yonetici@kurum.gov.tr"
            placeholderTextColor={adminTheme.textMuted}
          />
          <Text style={styles.label}>Şifre</Text>
          <TextInput
            style={styles.input}
            value={bootPassword}
            onChangeText={setBootPassword}
            secureTextEntry
            placeholder="••••••••"
            placeholderTextColor={adminTheme.textMuted}
          />
          <Text style={styles.label}>Ad soyad (isteğe bağlı)</Text>
          <TextInput style={styles.input} value={bootName} onChangeText={setBootName} placeholder="Ad Soyad" />
          <Text style={styles.label}>Kurulum anahtarı (BOOTSTRAP_SECRET)</Text>
          <TextInput
            style={styles.input}
            value={bootSecret}
            onChangeText={setBootSecret}
            secureTextEntry
            placeholder="Supabase’te tanımladığınız gizli değer"
            placeholderTextColor={adminTheme.textMuted}
          />
          <TouchableOpacity
            style={[styles.primaryBtn, bootSubmitting && styles.btnDisabled]}
            disabled={bootSubmitting}
            onPress={runBootstrap}
          >
            {bootSubmitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryBtnText}>İlk yöneticiyi oluştur</Text>
            )}
          </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (!session) {
    return <Redirect href={asHref('/login?redirect=/admin/users')} />;
  }

  if (profile?.role !== 'admin') {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.deniedWrap}>
          <View style={styles.deniedCard}>
            <View style={[styles.deniedIconCircle, { backgroundColor: adminTheme.dangerBg }]}>
              <MaterialIcons name="lock-outline" size={36} color={adminTheme.danger} />
            </View>
            <Text style={styles.deniedTitle}>Yetkisiz</Text>
            <Text style={styles.deniedText}>Bu sayfa yalnızca yöneticiler içindir.</Text>
            <Link href={asHref('/login')} asChild>
              <TouchableOpacity style={styles.outlineBtn}>
                <Text style={styles.outlineBtnText}>Giriş</Text>
              </TouchableOpacity>
            </Link>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <AdminTopBar title="Kullanıcılar" subtitle="Hesap oluşturma" />

      <ScrollView contentContainerStyle={styles.scrollPad} keyboardShouldPersistTaps="handled">
        <View style={styles.sectionCard}>
        <View style={styles.sectionCardHeader}>
          <MaterialIcons name="person-add" size={20} color={adminTheme.accent} />
          <Text style={styles.sectionTitle}>Yeni kullanıcı</Text>
        </View>
        <Text style={styles.label}>E-posta</Text>
        <TextInput
          style={styles.input}
          value={newEmail}
          onChangeText={setNewEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          placeholder="saha@kurum.gov.tr"
          placeholderTextColor={adminTheme.textMuted}
        />
        <Text style={styles.label}>Şifre</Text>
        <TextInput
          style={styles.input}
          value={newPassword}
          onChangeText={setNewPassword}
          secureTextEntry
          placeholder="••••••••"
          placeholderTextColor={adminTheme.textMuted}
        />
        <Text style={styles.label}>Ad soyad</Text>
        <TextInput style={styles.input} value={newName} onChangeText={setNewName} placeholder="İsteğe bağlı" />
        <Text style={styles.label}>Rol</Text>
        <View style={styles.roleRow}>
          {(['field', 'admin'] as const).map((r) => (
            <TouchableOpacity
              key={r}
              style={[styles.chip, newRole === r && styles.chipOn]}
              onPress={() => setNewRole(r)}
            >
              <Text style={[styles.chipText, newRole === r && styles.chipTextOn]}>
                {r === 'field' ? 'Saha' : 'Yönetici'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity
          style={[styles.primaryBtn, createSubmitting && styles.btnDisabled]}
          disabled={createSubmitting}
          onPress={runCreateUser}
        >
          {createSubmitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryBtnText}>Kullanıcı oluştur</Text>
          )}
        </TouchableOpacity>
        </View>

        <View style={[styles.sectionCard, styles.listSectionCard, { marginTop: 16 }]}>
        <View style={[styles.sectionCardHeader, styles.listHeaderRow]}>
          <MaterialIcons name="groups" size={20} color={adminTheme.accent} />
          <View style={{ flex: 1 }}>
            <Text style={styles.sectionTitle}>Kayıtlı kullanıcılar</Text>
            {!loadingList && profiles.length > 0 ? (
              <Text style={styles.listCountHint}>
                {filteredProfiles.length === profiles.length
                  ? `${profiles.length} kayıt`
                  : `${filteredProfiles.length} eşleşme (${profiles.length} toplam)`}
              </Text>
            ) : null}
          </View>
        </View>
        <View style={styles.listSearchWrap}>
          <MaterialIcons name="search" size={20} color={adminTheme.textMuted} style={styles.listSearchIcon} />
          <TextInput
            style={styles.listSearchInput}
            value={userSearchQuery}
            onChangeText={setUserSearchQuery}
            placeholder="E-posta, ad veya ID ile ara…"
            placeholderTextColor={adminTheme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="never"
          />
          {userSearchQuery.length > 0 ? (
            <TouchableOpacity
              onPress={() => setUserSearchQuery('')}
              style={styles.listSearchClear}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <MaterialIcons name="close" size={20} color={adminTheme.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>
        {loadingList ? (
          <ActivityIndicator color={adminTheme.accent} style={{ marginVertical: 20 }} />
        ) : profiles.length === 0 ? (
          <Text style={styles.muted}>Liste boş.</Text>
        ) : filteredProfiles.length === 0 ? (
          <Text style={styles.muted}>Aramanızla eşleşen kullanıcı yok.</Text>
        ) : (
          <>
            {pagedProfiles.map((item) => (
              <View key={item.id} style={styles.userRow}>
                <View style={styles.userRowLeft}>
                  <View style={styles.userAvatarSm}>
                    <Text style={styles.userAvatarTextSm}>
                      {(item.email || item.id || '?').slice(0, 1).toUpperCase()}
                    </Text>
                  </View>
                  <View style={styles.userRowText}>
                    <Text style={styles.rowEmailSm} numberOfLines={1}>
                      {item.email || item.id}
                    </Text>
                    {item.full_name ? (
                      <Text style={styles.rowSubSm} numberOfLines={1}>
                        {item.full_name}
                      </Text>
                    ) : null}
                  </View>
                </View>
                <View style={styles.userRowActions}>
                  <View style={item.role === 'admin' ? styles.badgeAdminSm : styles.badgeFieldSm}>
                    <Text style={item.role === 'admin' ? styles.badgeAdminTextSm : styles.badgeFieldTextSm}>
                      {item.role === 'admin' ? 'Yön.' : 'Saha'}
                    </Text>
                  </View>
                  {item.role === 'field' ? (
                    <TouchableOpacity
                      style={styles.iconActBtn}
                      onPress={() => void openAssignModal(item)}
                      accessibilityLabel="Belediyeler"
                    >
                      <MaterialIcons name="location-city" size={18} color={adminTheme.accentDark} />
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity
                    style={styles.iconActBtn}
                    onPress={() => openEditUser(item)}
                    accessibilityLabel="Düzenle"
                  >
                    <MaterialIcons name="edit" size={18} color={adminTheme.accentDark} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.iconActBtn, item.id === session?.user?.id && styles.btnDisabled]}
                    disabled={item.id === session?.user?.id}
                    onPress={() => confirmDeleteUser(item)}
                    accessibilityLabel="Sil"
                  >
                    <MaterialIcons
                      name="delete-outline"
                      size={18}
                      color={item.id === session?.user?.id ? adminTheme.textMuted : adminTheme.danger}
                    />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
            {userListPageCount > 1 ? (
              <View style={styles.pagination}>
                <TouchableOpacity
                  style={[styles.pageBtn, userListPage <= 1 && styles.pageBtnDisabled]}
                  disabled={userListPage <= 1}
                  onPress={() => setUserListPage((p) => Math.max(1, p - 1))}
                >
                  <MaterialIcons name="chevron-left" size={22} color={userListPage <= 1 ? adminTheme.textMuted : adminTheme.accent} />
                  <Text style={[styles.pageBtnText, userListPage <= 1 && styles.pageBtnTextDisabled]}>Önceki</Text>
                </TouchableOpacity>
                <Text style={styles.pageInfo}>
                  Sayfa {userListPage} / {userListPageCount}
                </Text>
                <TouchableOpacity
                  style={[styles.pageBtn, userListPage >= userListPageCount && styles.pageBtnDisabled]}
                  disabled={userListPage >= userListPageCount}
                  onPress={() => setUserListPage((p) => Math.min(userListPageCount, p + 1))}
                >
                  <Text style={[styles.pageBtnText, userListPage >= userListPageCount && styles.pageBtnTextDisabled]}>Sonraki</Text>
                  <MaterialIcons
                    name="chevron-right"
                    size={22}
                    color={userListPage >= userListPageCount ? adminTheme.textMuted : adminTheme.accent}
                  />
                </TouchableOpacity>
              </View>
            ) : null}
          </>
        )}
        </View>
      </ScrollView>

      <Modal visible={!!userDeleteTarget} transparent animationType="fade" onRequestClose={dismissUserDelete}>
        <View style={styles.assignModalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={dismissUserDelete} />
          <View style={styles.assignModalCard}>
            <Text style={styles.assignModalTitle}>Kullanıcıyı sil</Text>
            <Text style={styles.userDeleteBody}>
              {userDeleteTarget
                ? `“${userDeleteTarget.email || userDeleteTarget.id}” kullanıcısı silinsin mi? Bu işlem geri alınamaz.`
                : ''}
            </Text>
            <View style={styles.userDeleteRow}>
              <TouchableOpacity style={styles.userDeleteCancel} onPress={dismissUserDelete} disabled={userDeleteBusy}>
                <Text style={styles.userDeleteCancelText}>İptal</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.userDeleteDanger, userDeleteBusy && styles.btnDisabled]}
                onPress={() => void executeUserDelete()}
                disabled={userDeleteBusy}
              >
                {userDeleteBusy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.userDeleteDangerText}>Sil</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={editOpen} transparent animationType="fade" onRequestClose={() => !editSaving && setEditOpen(false)}>
        <View style={styles.assignModalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => !editSaving && setEditOpen(false)} />
          <View style={styles.assignModalCard}>
            <Text style={styles.assignModalTitle}>Kullanıcıyı düzenle</Text>
            <Text style={styles.assignModalHint}>E-posta, ad ve rol; şifreyi yalnızca değiştirecekseniz doldurun.</Text>
            <Text style={styles.label}>E-posta</Text>
            <TextInput
              style={styles.input}
              value={editEmail}
              onChangeText={setEditEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              editable={!editSaving}
            />
            <Text style={styles.label}>Ad soyad</Text>
            <TextInput style={styles.input} value={editFullName} onChangeText={setEditFullName} editable={!editSaving} />
            <Text style={styles.label}>Yeni şifre (isteğe bağlı)</Text>
            <TextInput
              style={styles.input}
              value={editPassword}
              onChangeText={setEditPassword}
              secureTextEntry
              placeholder="Boş bırakırsanız şifre değişmez"
              placeholderTextColor={adminTheme.textMuted}
              editable={!editSaving}
            />
            <Text style={styles.label}>Rol</Text>
            <View style={styles.roleRow}>
              {(['field', 'admin'] as const).map((r) => (
                <TouchableOpacity
                  key={r}
                  style={[styles.chip, editRole === r && styles.chipOn]}
                  onPress={() => setEditRole(r)}
                  disabled={editSaving}
                >
                  <Text style={[styles.chipText, editRole === r && styles.chipTextOn]}>
                    {r === 'field' ? 'Saha' : 'Yönetici'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.assignModalFooter}>
              <TouchableOpacity
                style={styles.assignModalCancel}
                disabled={editSaving}
                onPress={() => !editSaving && setEditOpen(false)}
              >
                <Text style={styles.assignModalCancelText}>İptal</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.assignModalSave, editSaving && styles.btnDisabled]}
                disabled={editSaving}
                onPress={() => void saveEditUser()}
              >
                {editSaving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.assignModalSaveText}>Kaydet</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={assignModalOpen} transparent animationType="fade" onRequestClose={() => setAssignModalOpen(false)}>
        <View style={styles.assignModalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => !assignSaving && setAssignModalOpen(false)} />
          <View style={styles.assignModalCard}>
            <Text style={styles.assignModalTitle}>
              Belediye ataması
              {assignUser?.email ? `\n${assignUser.email}` : ''}
            </Text>
            <Text style={styles.assignModalHint}>
              Saha kullanıcısı yalnızca işaretlenen belediyelere rapor yükleyebilir.
            </Text>
            {assignLoading || municipalitiesLoading ? (
              <ActivityIndicator color={adminTheme.accent} style={{ marginVertical: 24 }} />
            ) : municipalities.length === 0 ? (
              <Text style={styles.muted}>Önce Belediyeler ekranından belediye ekleyin.</Text>
            ) : (
              <ScrollView style={styles.assignModalScroll} keyboardShouldPersistTaps="handled">
                {municipalities.map((m) => {
                  const on = assignSelectedIds.has(m.id);
                  return (
                    <TouchableOpacity
                      key={m.id}
                      style={[styles.assignModalRow, on && styles.assignModalRowOn]}
                      onPress={() => toggleAssignMunicipality(m.id)}
                      activeOpacity={0.7}
                    >
                      <MaterialIcons
                        name={on ? 'check-box' : 'check-box-outline-blank'}
                        size={22}
                        color={on ? adminTheme.accent : adminTheme.textMuted}
                      />
                      <View style={{ flex: 1, marginLeft: 10 }}>
                        <Text style={styles.assignModalRowTitle}>{m.name}</Text>
                        <Text style={styles.assignModalRowSub}>
                          {m.district?.trim() ? `${m.district.trim()} · ${m.province}` : m.province}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
            <View style={styles.assignModalFooter}>
              <TouchableOpacity
                style={styles.assignModalCancel}
                disabled={assignSaving}
                onPress={() => !assignSaving && setAssignModalOpen(false)}
              >
                <Text style={styles.assignModalCancelText}>İptal</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.assignModalSave, assignSaving && styles.btnDisabled]}
                disabled={assignSaving || assignLoading}
                onPress={() => void saveUserMunicipalities()}
              >
                {assignSaving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.assignModalSaveText}>Kaydet</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: adminTheme.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: adminTheme.bg },
  muted: { color: adminTheme.textMuted, marginTop: 8, fontSize: 14 },
  deniedWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
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
  deniedText: { textAlign: 'center', color: adminTheme.textSecondary, fontSize: 15, lineHeight: 22, marginBottom: 8 },
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
    marginTop: 8,
  },
  outlineBtnText: { color: adminTheme.accent, fontWeight: '600', fontSize: 16 },
  scrollPad: { padding: 16, paddingBottom: 48, maxWidth: 880, width: '100%', alignSelf: 'center' },
  banner: {
    backgroundColor: adminTheme.accentLight,
    padding: 16,
    borderRadius: adminTheme.radiusMd,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: adminTheme.border,
  },
  bannerText: { color: adminTheme.textSecondary, fontSize: 14, lineHeight: 21 },
  bannerBold: { fontWeight: '700', color: adminTheme.accentDark },
  sectionCard: {
    backgroundColor: adminTheme.surface,
    borderRadius: adminTheme.radiusLg,
    padding: 20,
    borderWidth: 1,
    borderColor: adminTheme.border,
    ...adminTheme.shadowCard,
  },
  sectionCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  listSectionCard: {
    padding: 16,
  },
  listHeaderRow: {
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  listCountHint: {
    fontSize: 12,
    color: adminTheme.textMuted,
    marginTop: 4,
    fontWeight: '500',
  },
  listSearchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: adminTheme.surfaceMuted,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: adminTheme.border,
    paddingLeft: 10,
    paddingRight: 4,
    marginBottom: 12,
  },
  listSearchIcon: { marginRight: 4 },
  listSearchInput: {
    flex: 1,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    fontSize: 14,
    color: adminTheme.text,
    minWidth: 0,
  },
  listSearchClear: { padding: 6 },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: adminTheme.text, letterSpacing: -0.2 },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: adminTheme.textSecondary,
    marginBottom: 6,
    marginTop: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  input: {
    borderWidth: 1,
    borderColor: adminTheme.border,
    borderRadius: adminTheme.radiusMd,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10,
    backgroundColor: adminTheme.surfaceMuted,
    fontSize: 15,
    color: adminTheme.text,
  },
  primaryBtn: {
    backgroundColor: adminTheme.accent,
    paddingVertical: 14,
    borderRadius: adminTheme.radiusMd,
    alignItems: 'center',
    marginTop: 16,
  },
  primaryBtnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  btnDisabled: { opacity: 0.7 },
  roleRow: { flexDirection: 'row', gap: 10, marginTop: 6, marginBottom: 4 },
  chip: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: adminTheme.radiusFull,
    backgroundColor: adminTheme.chipInactive,
    borderWidth: 1,
    borderColor: adminTheme.border,
  },
  chipOn: { backgroundColor: adminTheme.accent, borderColor: adminTheme.accent },
  chipText: { color: adminTheme.chipInactiveText, fontWeight: '600', fontSize: 14 },
  chipTextOn: { color: '#fff' },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 2,
    minHeight: 48,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: adminTheme.border,
    gap: 8,
  },
  userRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
    gap: 10,
  },
  userAvatarSm: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: adminTheme.accentLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  userAvatarTextSm: { fontSize: 14, fontWeight: '700', color: adminTheme.accentDark },
  userRowText: { flex: 1, minWidth: 0 },
  rowEmailSm: { fontSize: 14, fontWeight: '600', color: adminTheme.text },
  rowSubSm: { fontSize: 12, color: adminTheme.textSecondary, marginTop: 1 },
  userRowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    flexShrink: 0,
  },
  badgeAdminSm: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: adminTheme.radiusFull,
    backgroundColor: adminTheme.accentLight,
    marginRight: 2,
  },
  badgeAdminTextSm: { fontSize: 10, fontWeight: '800', color: adminTheme.accentDark },
  badgeFieldSm: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: adminTheme.radiusFull,
    backgroundColor: adminTheme.chipInactive,
    marginRight: 2,
  },
  badgeFieldTextSm: { fontSize: 10, fontWeight: '800', color: adminTheme.textSecondary },
  iconActBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pagination: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingTop: 14,
    paddingBottom: 4,
    marginTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: adminTheme.border,
  },
  pageBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 6, paddingHorizontal: 10 },
  pageBtnDisabled: { opacity: 0.45 },
  pageBtnText: { fontSize: 14, fontWeight: '700', color: adminTheme.accent },
  pageBtnTextDisabled: { color: adminTheme.textMuted },
  pageInfo: { fontSize: 13, fontWeight: '600', color: adminTheme.textSecondary, minWidth: 100, textAlign: 'center' },
  assignModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'center',
    padding: 20,
  },
  assignModalCard: {
    backgroundColor: adminTheme.surface,
    borderRadius: 16,
    padding: 16,
    maxHeight: '80%',
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
  assignModalTitle: { fontSize: 17, fontWeight: '700', color: adminTheme.text, marginBottom: 6 },
  assignModalHint: { fontSize: 12, color: adminTheme.textSecondary, marginBottom: 12, lineHeight: 18 },
  assignModalScroll: { maxHeight: 360 },
  assignModalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: adminTheme.radiusSm,
    marginBottom: 4,
  },
  assignModalRowOn: { backgroundColor: adminTheme.accentLight },
  assignModalRowTitle: { fontSize: 15, fontWeight: '600', color: adminTheme.text },
  assignModalRowSub: { fontSize: 12, color: adminTheme.textMuted, marginTop: 2 },
  assignModalFooter: { flexDirection: 'row', gap: 12, marginTop: 16, justifyContent: 'flex-end' },
  assignModalCancel: { paddingVertical: 10, paddingHorizontal: 16 },
  assignModalCancelText: { color: adminTheme.textSecondary, fontWeight: '600' },
  assignModalSave: {
    backgroundColor: adminTheme.accent,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: adminTheme.radiusSm,
    minWidth: 100,
    alignItems: 'center',
  },
  assignModalSaveText: { color: '#fff', fontWeight: '700' },
  userDeleteBody: {
    fontSize: 15,
    lineHeight: 22,
    color: adminTheme.text,
    marginBottom: 18,
  },
  userDeleteRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  userDeleteCancel: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: adminTheme.radiusSm,
    borderWidth: 1,
    borderColor: adminTheme.border,
    backgroundColor: adminTheme.surfaceMuted,
  },
  userDeleteCancelText: { fontSize: 15, fontWeight: '600', color: adminTheme.textSecondary },
  userDeleteDanger: {
    minWidth: 100,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: adminTheme.radiusSm,
    backgroundColor: adminTheme.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  userDeleteDangerText: { fontSize: 15, fontWeight: '700', color: '#fff' },
});
