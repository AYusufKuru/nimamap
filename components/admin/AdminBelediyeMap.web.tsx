/**
 * Belediye analitik haritası (web) — Leaflet + yan panel, referans arayüze uygun.
 * Leaflet yalnızca tarayıcıda dynamic import edilir (SSR / Metro ortamında `window` hatası olmaması için).
 */
import {
  getIconClassForType,
  ITEM_TYPES,
  type MapItem,
  type MunicipalityDef,
  OTHER_MUNICIPALITY,
} from '@/constants/belediyeMapData';
import { useAuth } from '@/contexts/AuthContext';
import { useAdminToast } from '@/contexts/AdminToastContext';
import { useMunicipalities } from '@/contexts/MunicipalitiesContext';
import { supabase } from '@/supabase';
import { WEB_APP_RESUME_EVENT } from '@/utils/webAppResume';
import { buildBoundaryNominatimQuery, buildBoundaryNominatimQueryAlt } from '@/utils/municipalityQuery';
import {
  MIN_TYPICAL_DISTRICT_BBOX_DEG2,
  nominatimHitBBoxAreaDeg2,
  pickMunicipalityBoundaryHit,
  type NominatimSearchHit,
} from '@/utils/nominatimPickBoundary';
import { reportRowToMapItem, type ReportRowForMap } from '@/utils/reportMapFromSupabase';
import type { GeoJSON as LeafletGeoJSONLayer, LayerGroup, Map as LeafletMap } from 'leaflet';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import '@/styles/adminBelediyeMap.css';
import './leafletMapStyles.web';

type ViewMode = 'Global' | 'Province' | 'Region' | 'Item';

type LeafletNs = typeof import('leaflet');

/** Harita pini / tooltip — türe göre sabit renk (durum rengi yok). */
function getMapTypeColor(type: string): string {
  switch (type) {
    case 'Menhol':
      return '#6366f1';
    case 'Kabin':
      return '#8b5cf6';
    case 'Baz İstasyonu':
      return '#0ea5e9';
    case 'Elektrik Direği':
      return '#ca8a04';
    case 'Elektrik Panosu':
      return '#ea580c';
    case 'Doğalgaz':
      return '#dc2626';
    case 'Trafo':
      return '#0d9488';
    default:
      return '#64748b';
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return `rgba(100,116,139,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Kurulum tarihi: `gg.aa.yyyy` (Türkiye). */
function formatKurulumTr(raw: string): string {
  const t = raw?.trim();
  if (!t) return '—';
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) {
    const [, y, m, d] = iso;
    return `${d}.${m}.${y}`;
  }
  const dmy = /^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/.exec(t);
  if (dmy) {
    const dd = dmy[1].padStart(2, '0');
    const mm = dmy[2].padStart(2, '0');
    const yy = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${dd}.${mm}.${yy}`;
  }
  return t;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** İşletici firma rozeti (cyan) */
const OPERATOR_CYAN = '#0891b2';

/** Kompakt liste satırı: küçük kutu; PDF/ikon büyümez. */
const LIST_ROW_THUMB_SIZE = 40;

function renderItemPreview(
  s: MapItem,
  getIconClassForTypeFn: (t: string) => string,
  stopPdfClick?: boolean,
  compact?: boolean
) {
  const onPdf = stopPdfClick ? (e: { stopPropagation: () => void }) => e.stopPropagation() : undefined;
  if (s.image?.trim()) {
    return (
      <img
        src={s.image.trim()}
        alt=""
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          ...(compact ? { display: 'block' } : {}),
        }}
      />
    );
  }
  if (s.pdfUrl) {
    return (
      <a
        href={s.pdfUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onPdf}
        style={{
          display: 'flex',
          flexDirection: compact ? 'row' : 'column',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          color: '#64748b',
          textDecoration: 'none',
          fontSize: compact ? 9 : 11,
          fontWeight: 800,
          gap: compact ? 4 : 6,
          textAlign: 'center',
          lineHeight: compact ? 1.1 : undefined,
        }}
      >
        <i className="fas fa-file-pdf" style={{ fontSize: compact ? 22 : 40, color: '#dc2626', flexShrink: 0 }} />
        {compact ? 'PDF' : 'Rapor PDF'}
      </a>
    );
  }
  return (
    <i
      className={`fas ${getIconClassForTypeFn(s.type)}`}
      style={{ fontSize: compact ? '1.15rem' : '2.5rem', color: '#cbd5e1' }}
    />
  );
}

const NOMINATIM_HEADERS: HeadersInit = {
  Accept: 'application/json',
  'Accept-Language': 'tr',
  'User-Agent': 'nima-map-admin/1.0 (district boundary)',
};

async function fetchNominatimBoundaryHits(query: string): Promise<NominatimSearchHit[]> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&polygon_geojson=1&limit=20&countrycodes=tr&accept-language=tr`,
      { headers: NOMINATIM_HEADERS }
    );
    if (!res.ok) return [];
    return ((await res.json()) as NominatimSearchHit[]) ?? [];
  } catch {
    return [];
  }
}

/** Bina boyutunda kutuysa flyToBounds ile aşırı zoom yapılmasın. */
const MIN_FLYTO_BOUNDS_BBOX_DEG2 = 0.00008;

function flyToBelDistrictView(
  map: LeafletMap,
  bel: MunicipalityDef,
  layer: LeafletGeoJSONLayer | undefined,
  opts: { padding?: [number, number]; duration: number }
) {
  const padding = opts.padding ?? [20, 20];
  if (layer) {
    if (!map.hasLayer(layer)) map.addLayer(layer);
    const b = layer.getBounds();
    if (b.isValid()) {
      const sw = b.getSouthWest();
      const ne = b.getNorthEast();
      const latSpan = Math.abs(ne.lat - sw.lat);
      const lngSpan = Math.abs(ne.lng - sw.lng);
      const product = latSpan * lngSpan;
      if (product >= MIN_FLYTO_BOUNDS_BBOX_DEG2 && Math.max(latSpan, lngSpan) >= 0.008) {
        map.flyToBounds(b, { padding, duration: opts.duration });
        return;
      }
    }
  }
  map.flyTo(bel.coords, 12, { duration: opts.duration });
}

export default function AdminBelediyeMap() {
  const { session } = useAuth();
  const showToast = useAdminToast();
  const { municipalities, loading: municipalitiesLoading, getMunicipalityById } = useMunicipalities();
  const mapEl = useRef<HTMLDivElement>(null);
  const leafletRef = useRef<LeafletNs | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const clusterRef = useRef<LayerGroup | null>(null);
  const boundaryRef = useRef<Record<string, LeafletGeoJSONLayer>>({});
  const selectedBelediyeRef = useRef<string>('All');
  const zoomToItemRef = useRef<(item: MapItem) => void>(() => {});
  const mapResizeObserverRef = useRef<ResizeObserver | null>(null);
  const winResizeHandlerRef = useRef<(() => void) | null>(null);

  const [booting, setBooting] = useState(true);
  const [reportRows, setReportRows] = useState<ReportRowForMap[]>([]);
  const [localMapItems, setLocalMapItems] = useState<MapItem[]>([]);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<ViewMode>('Global');
  const [selectedProvince, setSelectedProvince] = useState<string | null>(null);
  const [selectedBelediye, setSelectedBelediye] = useState<string>('All');
  const [selectedItem, setSelectedItem] = useState<MapItem | null>(null);
  const [filterType, setFilterType] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState(480);
  const [filterOpen, setFilterOpen] = useState(false);
  const [statusLine, setStatusLine] = useState('Sistem Senkronize Ediliyor...');
  /** Leaflet yalnızca istemcide yüklendikten sonra true */
  const [mapReady, setMapReady] = useState(false);
  /** Sekme dönüşünde raporları yeniden çekmek için */
  const [resumeTick, setResumeTick] = useState(0);

  const items = useMemo(() => {
    const mapped = reportRows
      .map((r) => reportRowToMapItem(r, municipalities))
      .filter((x): x is MapItem => x != null);
    return [...mapped, ...localMapItems];
  }, [reportRows, municipalities, localMapItems]);

  /** Leaflet import/sekme yarışında örtü sonsuz kalmasın */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const t = window.setTimeout(() => setBooting(false), 16_000);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResume = () => setResumeTick((n) => n + 1);
    window.addEventListener(WEB_APP_RESUME_EVENT, onResume);
    return () => window.removeEventListener(WEB_APP_RESUME_EVENT, onResume);
  }, []);

  useEffect(() => {
    if (!session?.user) {
      setReportRows([]);
      setReportsLoading(false);
      setReportsError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setReportsLoading(true);
      setReportsError(null);
      try {
        const { data, error } = await supabase.from('report_logs').select('*').limit(8000);
        if (cancelled) return;
        if (error) {
          setReportsError(error.message);
          setReportRows([]);
          return;
        }
        const rows = (data || []) as ReportRowForMap[];
        const sorted = [...rows].sort((a, b) => {
          const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
          const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
          return tb - ta;
        });
        if (!cancelled) setReportRows(sorted);
      } finally {
        if (!cancelled) setReportsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id, resumeTick]);

  useEffect(() => {
    selectedBelediyeRef.current = selectedBelediye;
  }, [selectedBelediye]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const fa = document.createElement('link');
    fa.rel = 'stylesheet';
    fa.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
    document.head.appendChild(fa);
    return () => {
      document.head.removeChild(fa);
    };
  }, []);

  useEffect(() => {
    if (!session?.user) {
      setStatusLine('Giriş gerekli');
      return;
    }
    if (reportsLoading) {
      setStatusLine('Raporlar yükleniyor…');
      return;
    }
    if (reportsError) {
      setStatusLine('Senkronizasyon hatası');
      return;
    }
    setStatusLine(`${items.length} konumlu kayıt (Supabase)`);
  }, [session?.user, reportsLoading, reportsError, items.length]);

  const markerSyncId = useMemo(() => {
    if (currentView === 'Item' && selectedItem) return selectedItem.belediyeId;
    if (currentView === 'Region') return selectedBelediye;
    return 'All';
  }, [currentView, selectedItem, selectedBelediye]);

  const filteredForMarkers = useMemo(() => {
    let list =
      markerSyncId === 'All' ? items : items.filter((s) => s.belediyeId === markerSyncId);
    if (filterType && filterType !== 'All') {
      list = list.filter((s) => s.type === filterType);
    }
    return list;
  }, [items, markerSyncId, filterType]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!mapEl.current || mapRef.current) return;

    let cancelled = false;

    (async () => {
      try {
        const leafletMod = await import('leaflet');
        const L = (leafletMod as { default?: LeafletNs }).default ?? (leafletMod as unknown as LeafletNs);
        await import('leaflet.markercluster');

        if (cancelled || !mapEl.current) return;

        leafletRef.current = L;

      const markerClusterGroup = (
        L as LeafletNs & {
          markerClusterGroup: (o: Record<string, unknown>) => LayerGroup;
        }
      ).markerClusterGroup;

      const bounds = L.latLngBounds(L.latLng(35.0, 25.0), L.latLng(42.5, 45.0));
      const map = L.map(mapEl.current, {
        center: [39.0, 35.0],
        zoom: 6,
        minZoom: 5,
        maxZoom: 18,
        zoomControl: false,
        attributionControl: false,
        maxBounds: bounds,
      });

      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        noWrap: true,
      }).addTo(map);

      const markerCluster = markerClusterGroup({
        maxClusterRadius: 40,
        disableClusteringAtZoom: 14,
        iconCreateFunction: (cluster: { getChildCount: () => number }) => {
          const count = cluster.getChildCount();
          const sizeClass = count < 10 ? 'v11-sm' : count < 30 ? 'v11-md' : 'v11-lg';
          return L.divIcon({
            html: `<div class="v11-cluster ${sizeClass}"><span>${count}</span></div>`,
            className: 'v11-cluster-wrap',
            iconSize: [45, 45],
          });
        },
      });

      map.addLayer(markerCluster);
      L.control.zoom({ position: 'bottomright' }).addTo(map);

      mapRef.current = map;
      clusterRef.current = markerCluster;

      const invalidateSize = () => {
        try {
          map.invalidateSize({ animate: false });
        } catch {
          /* ignore */
        }
      };
      requestAnimationFrame(invalidateSize);
      setTimeout(invalidateSize, 50);
      setTimeout(invalidateSize, 250);

      if (typeof ResizeObserver !== 'undefined' && mapEl.current) {
        mapResizeObserverRef.current?.disconnect();
        mapResizeObserverRef.current = new ResizeObserver(() => invalidateSize());
        mapResizeObserverRef.current.observe(mapEl.current);
      }

      const onWinResize = () => invalidateSize();
      winResizeHandlerRef.current = onWinResize;
      window.addEventListener('resize', onWinResize);

        setMapReady(true);
      } catch (err) {
        console.error('Leaflet yüklenemedi:', err);
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();

    return () => {
      cancelled = true;
      if (winResizeHandlerRef.current) {
        window.removeEventListener('resize', winResizeHandlerRef.current);
        winResizeHandlerRef.current = null;
      }
      mapResizeObserverRef.current?.disconnect();
      mapResizeObserverRef.current = null;
      const map = mapRef.current;
      if (map) {
        map.remove();
      }
      mapRef.current = null;
      clusterRef.current = null;
      leafletRef.current = null;
      setMapReady(false);
    };
  }, []);

  /**
   * Sekme görünür olunca yalnızca Leaflet harita boyutunu düzeltir (veri yenilemesi yok).
   */
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const refreshMapLayout = () => {
      const map = mapRef.current;
      if (!map) return;
      requestAnimationFrame(() => {
        try {
          map.invalidateSize({ animate: false });
        } catch {
          /* ignore */
        }
      });
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        refreshMapLayout();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    const L = leafletRef.current;
    const cluster = clusterRef.current;
    if (!mapReady || !L || !cluster) return;
    cluster.clearLayers();

    filteredForMarkers.forEach((s) => {
      const typeColor = getMapTypeColor(s.type);
      const iconClass = getIconClassForType(s.type);
      const icon = L.divIcon({
        className: 'v11-node-marker',
        html: `<div class="v11-pin" style="background:${typeColor}"><i class="fas ${iconClass}"></i></div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      });
      const m = L.marker(s.coords, { icon });
      const tipType = escapeHtml(s.type);
      const tipBel = escapeHtml(s.belediyeName ?? '');
      m.bindTooltip(
        `<div class="v11-map-tip"><div class="tip-id tip-id--type"><i class="fas ${iconClass}" style="margin-right:6px;color:${typeColor}"></i><span style="color:${typeColor};font-weight:800">${tipType}</span></div><div class="tip-rev">Birim: <b>${tipBel}</b></div></div>`,
        { direction: 'top', offset: [0, -10], opacity: 1, sticky: true }
      );
      m.on('click', () => zoomToItemRef.current(s));
      cluster.addLayer(m);
    });
  }, [filteredForMarkers, mapReady]);

  useEffect(() => {
    if (typeof window === 'undefined' || !mapReady) return;
    const L = leafletRef.current;
    if (!L) return;

    let cancelled = false;
    (async () => {
      for (const bel of municipalities) {
        if (cancelled) return;
        const cacheKey = `geo_boundary_v6_${bel.id}`;
        let geoData: string | null = null;
        try {
          geoData = window.localStorage.getItem(cacheKey);
        } catch {
          /* ignore */
        }
        if (!geoData) {
          try {
            const q1 = buildBoundaryNominatimQuery(bel);
            let data = await fetchNominatimBoundaryHits(q1);
            let hit = pickMunicipalityBoundaryHit(data);
            let area = hit ? nominatimHitBBoxAreaDeg2(hit) : 0;
            const q2 = buildBoundaryNominatimQueryAlt(bel);
            if (area < MIN_TYPICAL_DISTRICT_BBOX_DEG2 && q2 !== q1) {
              await new Promise((r) => setTimeout(r, 1100));
              const data2 = await fetchNominatimBoundaryHits(q2);
              const hit2 = pickMunicipalityBoundaryHit(data2);
              const area2 = hit2 ? nominatimHitBBoxAreaDeg2(hit2) : 0;
              if (hit2 && area2 > area) {
                hit = hit2;
                area = area2;
              }
            }
            if (hit?.geojson) {
              geoData = JSON.stringify(hit.geojson);
              try {
                window.localStorage.setItem(cacheKey, geoData);
              } catch {
                /* ignore */
              }
            }
          } catch {
            /* ignore */
          }
          await new Promise((r) => setTimeout(r, 1100));
        }
        if (geoData && mapRef.current) {
          try {
            const parsedGeo = JSON.parse(geoData);
            const boundaryLayer = L.geoJSON(parsedGeo as never, {
              style: {
                color: '#ef4444',
                weight: 3,
                dashArray: '8, 10',
                opacity: 1,
                fillColor: '#ef4444',
                fillOpacity: 0.06,
              },
              interactive: false,
              /** Nominatim Point dönerse Leaflet varsayılan pin koymasın — kırmızı halka. */
              pointToLayer: (_feature, latlng) =>
                L.circleMarker(latlng, {
                  radius: 10,
                  color: '#ef4444',
                  weight: 3,
                  opacity: 1,
                  fillColor: '#ef4444',
                  fillOpacity: 0.15,
                }),
            });
            boundaryRef.current[bel.id] = boundaryLayer;
          } catch {
            /* ignore */
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mapReady, municipalities]);

  const removeBoundaryLayers = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    Object.values(boundaryRef.current).forEach((layer) => {
      if (layer && map.hasLayer(layer)) map.removeLayer(layer);
    });
  }, []);

  const showBoundaryFor = useCallback((belId: string) => {
    const map = mapRef.current;
    if (!map) return;
    removeBoundaryLayers();
    const layer = boundaryRef.current[belId];
    if (layer && !map.hasLayer(layer)) map.addLayer(layer);
  }, [removeBoundaryLayers]);

  const zoomToItem = useCallback(
    (item: MapItem) => {
      const map = mapRef.current;
      if (!map) return;
      setCurrentView('Item');
      setSelectedItem(item);
      setSelectedBelediye(item.belediyeId);
      selectedBelediyeRef.current = item.belediyeId;
      const bel = getMunicipalityById(item.belediyeId);
      if (bel) {
        setSelectedProvince(bel.province);
        showBoundaryFor(bel.id);
      }
      map.flyTo(item.coords, 17, { duration: 2.0 });
    },
    [showBoundaryFor]
  );

  useEffect(() => {
    zoomToItemRef.current = zoomToItem;
  }, [zoomToItem]);

  const goBack = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    if (currentView === 'Item') {
      setCurrentView('Region');
      setSelectedItem(null);
      const bel = getMunicipalityById(selectedBelediye);
      if (bel) {
        setSelectedProvince(bel.province);
        showBoundaryFor(bel.id);
        const layer = boundaryRef.current[bel.id];
        flyToBelDistrictView(map, bel, layer, { padding: [20, 20], duration: 2.0 });
      }
      return;
    }

    if (currentView === 'Region') {
      setCurrentView('Province');
      setSelectedBelediye('All');
      selectedBelediyeRef.current = 'All';
      removeBoundaryLayers();
      const provinceMuns =
        selectedProvince === 'Diğer'
          ? [OTHER_MUNICIPALITY]
          : municipalities.filter((m) => m.province === selectedProvince);
      if (provinceMuns.length > 0) {
        let alat = 0;
        let alng = 0;
        provinceMuns.forEach((m) => {
          alat += m.coords[0];
          alng += m.coords[1];
        });
        alat /= provinceMuns.length;
        alng /= provinceMuns.length;
        map.flyTo([alat, alng], 9, { duration: 2.0 });
      }
      return;
    }

    if (currentView === 'Province') {
      setCurrentView('Global');
      setSelectedProvince(null);
      setSelectedBelediye('All');
      selectedBelediyeRef.current = 'All';
      removeBoundaryLayers();
      map.flyTo([39.0, 35.0], 6, { duration: 3 });
    }
  }, [currentView, selectedBelediye, selectedProvince, removeBoundaryLayers, showBoundaryFor]);

  const drillToProvince = (provinceName: string) => {
    setCurrentView('Province');
    setSelectedProvince(provinceName);
    const provinceMuns =
      provinceName === 'Diğer'
        ? [OTHER_MUNICIPALITY]
        : municipalities.filter((m) => m.province === provinceName);
    if (provinceMuns.length === 0) return;
    let alat = 0;
    let alng = 0;
    provinceMuns.forEach((m) => {
      alat += m.coords[0];
      alng += m.coords[1];
    });
    alat /= provinceMuns.length;
    alng /= provinceMuns.length;
    mapRef.current?.flyTo([alat, alng], 9, { duration: 2.0 });
  };

  const drillToBelediye = (belId: string) => {
    setCurrentView('Region');
    setSelectedBelediye(belId);
    selectedBelediyeRef.current = belId;
    const bel = getMunicipalityById(belId);
    if (bel) setSelectedProvince(bel.province);
    removeBoundaryLayers();
    const layer = boundaryRef.current[belId];
    const map = mapRef.current;
    if (!map || !bel) return;
    flyToBelDistrictView(map, bel, layer, { padding: [20, 20], duration: 2.5 });
  };

  const deleteItem = async (id: string, source?: MapItem['source']) => {
    if (source === 'supabase') {
      const { error } = await supabase.from('report_logs').delete().eq('id', id);
      if (error) {
        showToast({ message: error.message, variant: 'error', duration: 7000 });
        return;
      }
      setReportRows((prev) => prev.filter((r) => r.id !== id));
    } else {
      setLocalMapItems((prev) => prev.filter((x) => x.id !== id));
    }
    if (selectedItem?.id === id) {
      setSelectedItem(null);
      setCurrentView('Region');
    }
  };

  const provincesWithData = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) {
      const m = getMunicipalityById(it.belediyeId);
      if (m) set.add(m.province);
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'tr'));
  }, [items]);

  const searchResults = useMemo(() => {
    const t = searchQuery.trim().toLowerCase();
    if (!t) return [];
    const filtered = items.filter(
      (s) =>
        (s.type && s.type.toLowerCase().includes(t)) ||
        (s.belediyeName && s.belediyeName.toLowerCase().includes(t)) ||
        (s.title && s.title.toLowerCase().includes(t))
    );
    const matchingMuns = municipalities.filter(
      (m) =>
        (m.name && m.name.toLowerCase().includes(t)) || (m.province && m.province.toLowerCase().includes(t))
    );
    let final = [...filtered];
    matchingMuns.forEach((m) => {
      items
        .filter((it) => it.belediyeId === m.id)
        .forEach((mi) => {
          if (!final.find((fr) => fr.id === mi.id)) final.push(mi);
        });
    });
    return final.slice(0, 30);
  }, [searchQuery, items]);

  useEffect(() => {
    const onDocClick = () => setFilterOpen(false);
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  const resizeRef = useRef<{ active: boolean }>({ active: false });

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!resizeRef.current.active) return;
      let w = e.clientX;
      if (w < 300) w = 300;
      if (w > window.innerWidth - 300) w = window.innerWidth - 300;
      setSidebarWidth(w);
      mapRef.current?.invalidateSize();
    };
    const onUp = () => {
      if (resizeRef.current.active) {
        resizeRef.current.active = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
  }, []);

  const renderSidebarInner = () => {
    if (searchQuery.trim()) {
      return (
        <>
          <h5 style={{ color: '#94a3b8', fontSize: '0.75rem', marginBottom: 15, letterSpacing: 0.5, textTransform: 'uppercase' }}>
            ARAMA SONUÇLARI ({searchResults.length})
          </h5>
          {searchResults.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 30, color: '#94a3b8', fontSize: '0.85rem' }}>Sonuç Bulunamadı</div>
          ) : (
            searchResults.map((s) => {
              const typeColor = getMapTypeColor(s.type);
              return (
              <div
                key={s.id}
                className="v11-list-row v11-list-row--compact"
                onClick={() => zoomToItem(s)}
                style={{ display: 'block' }}
              >
                <div className="v11-row-main" style={{ width: '100%' }}>
                  <strong
                    style={{
                      color: '#3b82f6',
                      fontSize: 12,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                      lineHeight: 1.35,
                    }}
                  >
                    {s.title}
                  </strong>
                  <p style={{ marginTop: 4, fontSize: 11, color: '#64748b' }}>
                    <i className="fas fa-map-marker-alt" /> {s.belediyeName}
                  </p>
                  <div
                    style={{
                      marginTop: 6,
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <span
                      className="v11-type-badge"
                      style={{
                        display: 'inline-block',
                        padding: '3px 9px',
                        borderRadius: 6,
                        fontSize: 10,
                        fontWeight: 800,
                        color: typeColor,
                        backgroundColor: hexToRgba(typeColor, 0.14),
                        border: `1px solid ${hexToRgba(typeColor, 0.45)}`,
                      }}
                    >
                      {s.type}
                    </span>
                    {s.operator?.trim() ? (
                      <span
                        className="v11-operator-badge"
                        style={{
                          display: 'inline-block',
                          padding: '3px 9px',
                          borderRadius: 6,
                          fontSize: 10,
                          fontWeight: 800,
                          color: OPERATOR_CYAN,
                          backgroundColor: hexToRgba(OPERATOR_CYAN, 0.12),
                          border: `1px solid ${hexToRgba(OPERATOR_CYAN, 0.42)}`,
                          maxWidth: '100%',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={s.operator.trim()}
                      >
                        {s.operator.trim()}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              );
            })
          )}
        </>
      );
    }

    if (currentView === 'Global') {
      if (!session?.user) {
        return (
          <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8', fontSize: '0.9rem' }}>
            Haritadaki raporları görmek için giriş yapın.
          </div>
        );
      }
      if (reportsLoading) {
        return (
          <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
            <i className="fas fa-spinner fa-spin" style={{ marginRight: 8 }} />
            Raporlar yükleniyor…
          </div>
        );
      }
      if (reportsError) {
        return (
          <div style={{ textAlign: 'center', padding: 40, color: '#ef4444', fontSize: '0.9rem' }}>
            {reportsError}
          </div>
        );
      }
      if (provincesWithData.length === 0) {
        return (
          <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8', fontSize: '0.9rem' }}>
            Konumlu rapor yok. Saha uygulamasından enlem/boylam kayıtlı rapor gönderin.
          </div>
        );
      }
      return (
        <div className="v11-grid-container">
          {provincesWithData.map((prov) => {
            const provItems = items.filter((s) => getMunicipalityById(s.belediyeId)?.province === prov);
            const provMunsTotal =
              prov === 'Diğer' ? 1 : municipalities.filter((m) => m.province === prov).length;
            const activeCount = provItems.filter((s) => s.status === 'Aktif').length;
            const avgEff = provItems.length > 0 ? Math.round((activeCount / provItems.length) * 100) : 0;
            return (
              <div key={prov} className="v11-region-card">
                <div className="v11-card-top">
                  <h3>{prov === 'Diğer' ? 'Diğer' : `${prov} İli`}</h3>
                  <span className="v11-count">
                    {provMunsTotal} Belediye / {provItems.length} Öğe
                  </span>
                </div>
                <div className="v11-card-metrics">
                  <div className="v11-m-item">
                    <small>AKTİF ÖĞE</small>
                    <strong>{activeCount}</strong>
                  </div>
                  <div className="v11-m-item">
                    <small>SİSTEM SAĞLIĞI</small>
                    <strong className={avgEff > 80 ? 'green' : avgEff > 50 ? 'orange' : 'red'}>%{avgEff}</strong>
                  </div>
                </div>
                <div className="v11-prog-bg">
                  <div className="v11-prog-fill" style={{ width: `${avgEff}%` }} />
                </div>
                <button type="button" className="v11-btn-drill" onClick={() => drillToProvince(prov)}>
                  BELEDİYELERİ GÖR <i className="fas fa-arrow-right" />
                </button>
              </div>
            );
          })}
        </div>
      );
    }

    if (currentView === 'Province' && selectedProvince) {
      return (
        <>
          <div className="v11-header-nav">
            <button type="button" className="v11-back-btn" onClick={goBack}>
              <i className="fas fa-chevron-left" /> İLLERE DÖN
            </button>
            <h2 style={{ fontSize: '1.5rem', marginBottom: 15 }}>{selectedProvince} Belediyeleri</h2>
          </div>
          <div className="v11-grid-container">
            {(selectedProvince === 'Diğer'
              ? [OTHER_MUNICIPALITY]
              : municipalities.filter((m) => m.province === selectedProvince)
            ).map((bel) => {
              const bItems = items.filter((s) => s.belediyeId === bel.id);
              const activeCount = bItems.filter((s) => s.status === 'Aktif').length;
              const avgEff = bItems.length > 0 ? Math.round((activeCount / bItems.length) * 100) : 0;
              return (
                <div key={bel.id} className="v11-region-card">
                  <div className="v11-card-top">
                    <h3>{bel.name}</h3>
                    <span className="v11-count">{bItems.length} Öğe</span>
                  </div>
                  <div className="v11-card-metrics">
                    <div className="v11-m-item">
                      <small>AKTİF BAĞLANTI</small>
                      <strong>{activeCount}</strong>
                    </div>
                    <div className="v11-m-item">
                      <small>SİSTEM SAĞLIĞI</small>
                      <strong className={avgEff > 80 ? 'green' : avgEff > 50 ? 'orange' : 'red'}>%{avgEff}</strong>
                    </div>
                  </div>
                  <div className="v11-prog-bg">
                    <div className="v11-prog-fill" style={{ width: `${avgEff}%` }} />
                  </div>
                  <button type="button" className="v11-btn-drill" onClick={() => drillToBelediye(bel.id)}>
                    BÖLGEYİ AÇ <i className="fas fa-arrow-right" />
                  </button>
                </div>
              );
            })}
          </div>
        </>
      );
    }

    if (currentView === 'Region') {
      const bel = getMunicipalityById(selectedBelediye);
      if (!bel) return null;
      let list = items.filter((s) => s.belediyeId === selectedBelediye);
      if (filterType && filterType !== 'All') list = list.filter((s) => s.type === filterType);

      return (
        <>
          <div className="v11-header-nav">
            <button type="button" className="v11-back-btn" style={{ marginBottom: 8 }} onClick={goBack}>
              <i className="fas fa-chevron-left" /> BÖLGELERE DÖN
            </button>
            <h2 style={{ fontSize: '1.4rem' }}>{bel.name}</h2>
          </div>

          <div className="v11-filter-wrapper">
            <button
              type="button"
              className="v11-custom-select"
              onClick={(e) => {
                e.stopPropagation();
                setFilterOpen((o) => !o);
              }}
            >
              <span>
                <i className="fas fa-filter" style={{ color: '#94a3b8', marginRight: 8 }} />
                {filterType === 'All' ? 'Tüm Kategorileri Göster' : filterType}
              </span>
              <i className="fas fa-chevron-down" style={{ color: '#94a3b8' }} />
            </button>
            <div className={`v11-dropdown-menu ${filterOpen ? 'open' : ''}`} onClick={(e) => e.stopPropagation()}>
              <div
                className={`v11-dropdown-item ${filterType === 'All' ? 'active' : ''}`}
                onClick={() => {
                  setFilterType('All');
                  setFilterOpen(false);
                }}
              >
                <i className="fas fa-layer-group" /> Tümü
              </div>
              {ITEM_TYPES.map((type) => (
                <div
                  key={type}
                  className={`v11-dropdown-item ${filterType === type ? 'active' : ''}`}
                  onClick={() => {
                    setFilterType(type);
                    setFilterOpen(false);
                  }}
                >
                  <i className={`fas ${getIconClassForType(type)}`} /> {type}
                </div>
              ))}
            </div>
          </div>

          <div className="v11-grid-container">
            {list.length === 0 ? (
              <div
                style={{
                  textAlign: 'center',
                  padding: '30px 20px',
                  color: '#64748b',
                  fontSize: '0.8rem',
                  border: '2px dashed #e2e8f0',
                  borderRadius: 15,
                  gridColumn: '1 / -1',
                }}
              >
                Bu kategoride henüz öğe yok.
              </div>
            ) : (
              list.map((s) => {
                const typeColor = getMapTypeColor(s.type);
                return (
                <div
                  key={s.id}
                  className="v11-list-row v11-list-row--compact"
                  style={{
                    flexDirection: 'row',
                    alignItems: 'stretch',
                    gap: 10,
                    overflow: 'hidden',
                    minHeight: LIST_ROW_THUMB_SIZE + 10,
                  }}
                  onClick={() => zoomToItem(s)}
                >
                  <div
                    style={{
                      flexShrink: 0,
                      width: LIST_ROW_THUMB_SIZE,
                      height: LIST_ROW_THUMB_SIZE,
                      borderRadius: 8,
                      background: '#f1f5f9',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                      border: '1px solid #e2e8f0',
                    }}
                  >
                    {renderItemPreview(s, getIconClassForType, true, true)}
                  </div>
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: 8,
                    }}
                  >
                    <div className="v11-row-main" style={{ minWidth: 0 }}>
                      <strong
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                          lineHeight: 1.35,
                          color: '#0f172a',
                        }}
                      >
                        {s.title}
                      </strong>
                      <div
                        style={{
                          marginTop: 6,
                          display: 'flex',
                          flexWrap: 'wrap',
                          alignItems: 'center',
                          gap: 6,
                        }}
                      >
                        <span
                          className="v11-type-badge"
                          style={{
                            display: 'inline-block',
                            padding: '3px 9px',
                            borderRadius: 6,
                            fontSize: 10,
                            fontWeight: 800,
                            letterSpacing: 0.2,
                            color: typeColor,
                            backgroundColor: hexToRgba(typeColor, 0.14),
                            border: `1px solid ${hexToRgba(typeColor, 0.45)}`,
                          }}
                        >
                          {s.type}
                        </span>
                        {s.operator?.trim() ? (
                          <span
                            className="v11-operator-badge"
                            style={{
                              display: 'inline-block',
                              padding: '3px 9px',
                              borderRadius: 6,
                              fontSize: 10,
                              fontWeight: 800,
                              color: OPERATOR_CYAN,
                              backgroundColor: hexToRgba(OPERATOR_CYAN, 0.12),
                              border: `1px solid ${hexToRgba(OPERATOR_CYAN, 0.42)}`,
                              maxWidth: 'min(100%, 200px)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                            title={s.operator.trim()}
                          >
                            {s.operator.trim()}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteItem(s.id, s.source);
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#ef4444',
                        fontSize: 16,
                        cursor: 'pointer',
                        padding: 4,
                        flexShrink: 0,
                        lineHeight: 1,
                      }}
                      aria-label="Sil"
                    >
                      <i className="fas fa-times" />
                    </button>
                  </div>
                </div>
                );
              })
            )}
          </div>
        </>
      );
    }

    if (currentView === 'Item' && selectedItem) {
      const s = selectedItem;
      const typeColor = getMapTypeColor(s.type);
      const itemDetailLabel: CSSProperties = {
        fontSize: 10,
        color: '#94a3b8',
        fontWeight: 900,
        letterSpacing: '0.06em',
        display: 'block',
        lineHeight: 1.35,
      };
      const itemDetailFieldShell: CSSProperties = {
        background: 'white',
        padding: 10,
        borderRadius: 10,
        border: '1px solid #f1f5f9',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginBottom: 8,
      };
      return (
        <div
          className="v11-item-detail-wrap"
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
          }}
        >
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            <div className="v11-header-nav">
              <button type="button" className="v11-back-btn" onClick={goBack}>
                <i className="fas fa-chevron-left" /> LİSTEYE DÖN
              </button>
              <h2 style={{ fontSize: '1.15rem', lineHeight: 1.35 }}>{s.title}</h2>
            </div>
            <div
              style={{
                padding: 12,
                background: '#f8fafc',
                borderRadius: 14,
                marginBottom: 8,
                border: '1px solid #f1f5f9',
              }}
            >
            <div style={itemDetailFieldShell}>
              <label style={itemDetailLabel}>BELEDİYE</label>
              <strong
                style={{
                  fontSize: 18,
                  lineHeight: 1.4,
                  color: '#0f172a',
                  fontWeight: 700,
                }}
              >
                {s.belediyeName}
              </strong>
            </div>

            <div style={itemDetailFieldShell}>
              <label style={itemDetailLabel}>TÜR</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <i className={`fas ${getIconClassForType(s.type)}`} style={{ fontSize: 24, color: typeColor, flexShrink: 0 }} />
                <strong style={{ fontSize: 17, lineHeight: 1.35, color: typeColor, fontWeight: 800 }}>{s.type}</strong>
              </div>
            </div>

            {s.operator?.trim() ? (
              <div style={itemDetailFieldShell}>
                <label style={itemDetailLabel}>İŞLETMECİ</label>
                <span
                  className="v11-operator-badge"
                  style={{
                    alignSelf: 'flex-start',
                    padding: '6px 12px',
                    borderRadius: 8,
                    fontSize: 15,
                    fontWeight: 800,
                    color: OPERATOR_CYAN,
                    backgroundColor: hexToRgba(OPERATOR_CYAN, 0.12),
                    border: `1px solid ${hexToRgba(OPERATOR_CYAN, 0.42)}`,
                    wordBreak: 'break-word',
                    lineHeight: 1.35,
                  }}
                >
                  {s.operator.trim()}
                </span>
              </div>
            ) : null}

            <div
              style={{
                ...itemDetailFieldShell,
                marginBottom: s.pdfUrl ? 8 : 0,
              }}
            >
              <label style={itemDetailLabel}>KURULUM</label>
              <strong style={{ fontSize: 16, lineHeight: 1.4, color: '#0f172a', fontWeight: 700 }}>
                {formatKurulumTr(s.kurulumTarihi)}
              </strong>
            </div>

            {s.pdfUrl ? (
              <div style={{ ...itemDetailFieldShell, marginBottom: 0 }}>
                <label style={itemDetailLabel}>RAPOR</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <a
                    href={s.pdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '10px 14px',
                      background: '#fef2f2',
                      color: '#b91c1c',
                      borderRadius: 10,
                      fontWeight: 800,
                      fontSize: 14,
                      textDecoration: 'none',
                      lineHeight: 1.3,
                    }}
                  >
                    <i className="fas fa-file-pdf" /> PDF’i aç
                  </a>
                </div>
              </div>
            ) : null}
            </div>
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <div className="belediye-map-wrap">
      {booting && (
        <div className="belediye-map-loader">
          <div className="loader-content">
            <div className="v11-loader-spin" />
          </div>
        </div>
      )}

      <div id="belediye-app">
        <aside className="sidebar" style={{ flex: `0 0 ${sidebarWidth}px`, width: sidebarWidth }}>
          <div className="sidebar-header">
            <div className="search-section">
              <div className="search-bar">
                <i className="fas fa-search" />
                <input
                  type="search"
                  placeholder="İl, İlçe veya Öğe Ara..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </div>
          </div>
          <div className="sidebar-content" id="sidebarContent">
            {renderSidebarInner()}
          </div>
          <div className="system-status">
            <span className="pulse-dot" />
            <span>{statusLine}</span>
          </div>
        </aside>

        <div
          className="desktop-resizer"
          onPointerDown={(e) => {
            e.preventDefault();
            resizeRef.current.active = true;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
          }}
          style={{ touchAction: 'none' }}
          role="separator"
          aria-orientation="vertical"
          aria-label="Yan panel genişliği"
        />

        <main className="map-frame">
          <div ref={mapEl} className="belediye-leaflet" />
        </main>
      </div>
    </div>
  );
}
