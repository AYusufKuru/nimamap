import type { MunicipalityDef } from '@/constants/belediyeMapData';
import { OTHER_MUNICIPALITY } from '@/constants/belediyeMapData';
import { supabase } from '@/supabase';
import { buildMunicipalitySearchQuery } from '@/utils/municipalityQuery';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type MunicipalityRow = {
  id: string;
  name: string;
  province: string;
  /** DB’de `district` kolonu yoksa (eski kurulum) gelmez */
  district?: string | null;
  query: string | null;
  lat: number;
  lng: number;
  logo_url: string | null;
  sort_order: number;
};

export function rowToMunicipalityDef(row: MunicipalityRow): MunicipalityDef {
  const district = row.district?.trim() ?? '';
  const q =
    (row.query && row.query.trim()) ||
    buildMunicipalitySearchQuery(row.name, row.province || '', district || null);
  return {
    id: row.id,
    name: row.name,
    province: row.province || '',
    district: district || undefined,
    query: q,
    coords: [Number(row.lat), Number(row.lng)] as [number, number],
    logo_url: row.logo_url,
    sort_order: row.sort_order,
  };
}

type MunicipalitiesContextValue = {
  municipalities: MunicipalityDef[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  getMunicipalityById: (id: string) => MunicipalityDef | undefined;
};

const MunicipalitiesContext = createContext<MunicipalitiesContextValue | undefined>(undefined);

export function MunicipalitiesProvider({ children }: { children: React.ReactNode }) {
  const [rows, setRows] = useState<MunicipalityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // `select('*')`: `district` kolonu henüz eklenmemiş eski DB’lerde 400 vermez; açık kolon listesinde district yoksa PostgREST 400 döner.
      const { data, error: qErr } = await supabase
        .from('municipalities')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true });
      if (qErr) {
        setError(qErr.message);
        setRows([]);
        return;
      }
      const list = (data || []) as MunicipalityRow[];
      setRows(list.filter((r) => r?.id));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      await supabase.auth.getSession();
      if (!cancelled) await load();
    };
    void boot();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      void load();
    });
    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [load]);

  const municipalities = useMemo(() => rows.map(rowToMunicipalityDef), [rows]);

  const getMunicipalityById = useCallback(
    (id: string): MunicipalityDef | undefined => {
      if (id === OTHER_MUNICIPALITY.id) return OTHER_MUNICIPALITY;
      return municipalities.find((m) => m.id === id);
    },
    [municipalities]
  );

  const value = useMemo<MunicipalitiesContextValue>(
    () => ({
      municipalities,
      loading,
      error,
      refresh: load,
      getMunicipalityById,
    }),
    [municipalities, loading, error, load, getMunicipalityById]
  );

  return <MunicipalitiesContext.Provider value={value}>{children}</MunicipalitiesContext.Provider>;
}

export function useMunicipalities() {
  const ctx = useContext(MunicipalitiesContext);
  if (!ctx) {
    throw new Error('useMunicipalities yalnızca MunicipalitiesProvider içinde kullanılabilir.');
  }
  return ctx;
}
