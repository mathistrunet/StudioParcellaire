// Clé d'accès GeoPlateforme facultative : plusieurs couches sont publiques,
// mais VITE_GEO_PORTAIL_API_KEY peut être défini pour accéder aux ressources
// qui le nécessitent.
const GEO_PORTAIL_KEY =
  import.meta.env.VITE_GEO_PORTAIL_API_KEY?.trim() || null;

const withOptionalKey = (baseUrl) => {
  if (!GEO_PORTAIL_KEY) {
    return baseUrl;
  }
  const [url, hash] = baseUrl.split("#");
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}apikey=${encodeURIComponent(
    GEO_PORTAIL_KEY,
  )}${hash ? `#${hash}` : ""}`;
};

const normaliseFeatureCollection = (payload) => {
  if (!payload) return { items: [], summary: null };

  if (typeof payload === "string") {
    return { items: [], summary: payload };
  }

  if (payload.text && typeof payload.text === "string") {
    return { items: [], summary: payload.text };
  }

  const featureCollection =
    payload?.type === "FeatureCollection"
      ? payload
      : payload?.FeatureCollection?.type === "FeatureCollection"
      ? payload.FeatureCollection
      : null;

  const features = Array.isArray(featureCollection?.features)
    ? featureCollection.features
    : Array.isArray(payload?.features)
    ? payload.features
    : [];

  const items = features.map((feature, index) => {
    const props = feature?.properties || {};
    const candidateTitle =
      feature?.id ||
      props.nom ||
      props.NOM ||
      props.libelle ||
      props.LIBELLE ||
      props.appellation ||
      props.APPELLATION ||
      `Entité ${index + 1}`;

    return {
      id: feature?.id ?? index,
      title: String(candidateTitle),
      properties: props,
    };
  });

  const summary =
    items.length > 0 ? `${items.length} élément${items.length > 1 ? "s" : ""}` : null;

  return { items, summary };
};

const defaultFeatureInfoParser = (payload) => normaliseFeatureCollection(payload);

export const DEFAULT_FEATURE_INFO_PARSER = defaultFeatureInfoParser;

export const RASTER_LAYERS = [
  {
    id: "osm_std",
    label: "Fond OpenStreetMap",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    subdomains: null,
    tileSize: 256,
    attribution: "© OpenStreetMap",
    defaultVisible: true,
    defaultOpacity: 1.0,
  },
  {
    id: "opentopo",
    label: "OpenTopoMap",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c"],
    tileSize: 256,
    attribution: "© OpenTopoMap",
    defaultVisible: false,
    defaultOpacity: 0.8,
  },
  {
    id: "esri_satellite",
    label: "Satellite mondial (ESRI)",
    // ESRI World Imagery — couverture mondiale, géoréférencement précis.
    // L'URL utilise {z}/{y}/{x} (MapLibre remplace y=row, x=col) — correct pour l'API ArcGIS.
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    subdomains: null,
    tileSize: 256,
    attribution: "© Esri, Maxar, Earthstar Geographics",
    defaultVisible: false,
    defaultOpacity: 1.0,
  },
  {
    id: "ign_satellite",
    label: "IGN Satellite (France)",
    // Service GeoPlateforme IGN — orthophotos haute résolution couverture France uniquement.
    // bounds limité à la France métropolitaine + DOM pour éviter les tuiles vides/décalées à l'étranger.
    url: withOptionalKey(
      "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILECOL={x}&TILEROW={y}&FORMAT=image/jpeg",
    ),
    subdomains: null,
    tileSize: 256,
    attribution: "© IGN",
    bounds: [-5.5, 41.2, 10.0, 51.5],
    defaultVisible: false,
    defaultOpacity: 1.0,
  },
  {
    id: "fr_soils",
    label: "Types de sols (GisSol / INRAE)",
    url: "https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&LAYER=INRA.CARTE.SOLS&STYLE=CARTE%20DES%20SOLS&FORMAT=image/png&TILEMATRIXSET=PM&TILEMATRIX={z}&TILECOL={x}&TILEROW={y}",
    subdomains: null,
    tileSize: 256,
    attribution: "© IGN · © GisSol/INRAE",
    mapLayerId: "soil-wmts",
    sourceId: "soil-wmts",
    managedExternally: true,
    defaultVisible: false,
    defaultOpacity: 0.85,
  },
];
