/* RYWP-Nature based solutions
@author: Gustave-MB */
const catalogue = [
  { id: 'urban-trees', label: 'Urban trees', color: '#09f111', format: 'shapefile', url: './data/Urban-trees.zip' },
  { id: 'Reforestation', label: 'Reforestation', color: '#066e1e', format: 'shapefile', url: './data/Reforestation.zip' },
  { id: 'Open spaces', label: 'Open spaces', color: '#087e73', format: 'shapefile', url: './data/Open-spaces.zip' },
  { id: 'Bufferzones', label: 'Bufferzones', color: '#ecdd08', format: 'shapefile', url: './data/Bufferzones.zip' },
  { id: 'Agroforestry', label: 'Agroforestry', color: '#a4e60b', format: 'shapefile', url: './data/Agroforestry.zip' },
  { id: 'Afforestation', label: 'Afforestation', color: '#2a5e1d', format: 'shapefile', url: './data/Afforestation.zip' }
  ];

const map = L.map('map', { zoomControl: false, fadeAnimation: false }).setView([-1.945, 30.06], 12);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);

const layers = new Map();
const layerToggles = new Map();
const allFeatures = [];
const sourceState = new Map(); // layer label -> 'loaded' | 'failed' (absent while still loading)
const els = {
  layerList: document.querySelector('#layer-list'), search: document.querySelector('#search-input'), intervention: document.querySelector('#intervention-filter'),
  district: document.querySelector('#district-filter'), sector: document.querySelector('#sector-filter'), 
  empty: document.querySelector('#empty-state'),
  dashboard: document.querySelector('#dashboard'), dashboardToggle: document.querySelector('#toggle-dashboard'),
  dashboardScope: document.querySelector('#dashboard-scope')
};
const filterFields = [{ id: 'intervention', label: 'All interventions', catalogueValue: true }, { id: 'district', label: 'All districts' }, { id: 'sector', label: 'All sectors' }];
const pretty = key => key.replace(/_/g, ' ').replace(/\b\w/g, x => x.toUpperCase());
const slug = value => String(value).replace(/[^a-zA-Z0-9_-]+/g, '-');
const property = (feature, key) => Object.entries(feature.properties || {}).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
const featureName = feature => property(feature, 'name') || property(feature, 'title') || property(feature, 'id') || 'Untitled feature';
const normalized = value => String(value ?? '').trim().toLocaleLowerCase();
const filterValue = (item, field) => field.catalogueValue ? item.source.label : property(item.feature, field.id);

// Dashboard summary cards. The card markup (icon + label) lives in index.html, keyed by
// data-metric="<key>"; this list only defines which catalogue layers feed each card.
// "Forest" combines the two forest-establishment interventions
// (Reforestation + Afforestation) since there's no single catalogue category named "Forest".
// Adjust the filterLabels arrays here if a different grouping is wanted.
const DASHBOARD_METRICS = [
  { key: 'forest', filterLabels: ['Reforestation', 'Afforestation'] },
  { key: 'agroforest', filterLabels: ['Agroforestry'] },
  { key: 'buffer', filterLabels: ['Bufferzones'] },
  { key: 'urban', filterLabels: ['Urban trees'] },
  { key: 'open-space', filterLabels: ['Open spaces'] }
];
const EARTH_RADIUS_M = 6378137;
const toRad = deg => deg * Math.PI / 180;
function ringArea(ring) {
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lng1, lat1] = ring[i], [lng2, lat2] = ring[(i + 1) % ring.length];
    total += toRad(lng2 - lng1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs(total * EARTH_RADIUS_M * EARTH_RADIUS_M / 2);
}
function polygonArea(coordinates) {
  if (!coordinates?.length) return 0;
  return coordinates.reduce((area, ring, i) => i === 0 ? area + ringArea(ring) : area - ringArea(ring), 0);
}
function haversine([lng1, lat1], [lng2, lat2]) {
  const dPhi = toRad(lat2 - lat1), dLambda = toRad(lng2 - lng1);
  const h = Math.sin(dPhi / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}
function lineLength(coordinates) { let total = 0; for (let i = 1; i < coordinates.length; i++) total += haversine(coordinates[i - 1], coordinates[i]); return total; }

// Names are matched case/space/underscore-insensitively; add more variants here if a dataset
// uses a field name not listed. Falls back to the geodesic calculation when no field matches.
const AREA_FIELD_CANDIDATES = [
  { names: ['area_ha', 'AREA', 'ha'], toSqm: v => v * 10000 },
  { names: ['area_sqm', 'area_m2', 'aream2', 'shape_area', 'st_area', 'area'], toSqm: v => v }
];
const LENGTH_FIELD_CANDIDATES = [
  { names: ['length_km', 'LENGTH', 'lenkm'], toM: v => v * 1000 },
  { names: ['length_m', 'lengthm', 'length', 'shape_leng', 'shape_length', 'st_length', 'perimeter', 'len'], toM: v => v }
];
const keyToken = key => key.toLowerCase().replace(/[^a-z0-9]/g, '');
function findFieldValue(feature, candidates) {
  const props = feature.properties || {};
  const tokenMap = new Map(Object.keys(props).map(k => [keyToken(k), k]));
  for (const candidate of candidates) {
    for (const name of candidate.names) {
      const actualKey = tokenMap.get(keyToken(name));
      if (actualKey === undefined) continue;
      const num = parseFloat(props[actualKey]);
      if (Number.isFinite(num) && num > 0) return { value: num, convert: candidate.toSqm || candidate.toM };
    }
  }
  return null;
}
function featureMetric(feature) {
  const type = feature.geometry?.type || '';
  const coords = feature.geometry?.coordinates;
  if (type === 'Polygon' || type === 'MultiPolygon') {
    const found = findFieldValue(feature, AREA_FIELD_CANDIDATES);
    if (found) return { kind: 'area', value: found.convert(found.value) };
    const area = type === 'Polygon' ? polygonArea(coords) : (coords || []).reduce((sum, poly) => sum + polygonArea(poly), 0);
    return { kind: 'area', value: area };
  }
  if (type === 'LineString' || type === 'MultiLineString') {
    const found = findFieldValue(feature, LENGTH_FIELD_CANDIDATES);
    if (found) return { kind: 'length', value: found.convert(found.value) };
    const length = type === 'LineString' ? lineLength(coords) : (coords || []).reduce((sum, line) => sum + lineLength(line), 0);
    return { kind: 'length', value: length };
  }
  if (type === 'MultiPoint') return { kind: 'count', value: (coords || []).length };
  return { kind: 'count', value: type ? 1 : 0 };
}
function formatMetric(kind, value) {
  if (kind === 'area') return `${(value / 10000).toLocaleString(undefined, { maximumFractionDigits: 1 })} ha`;
  if (kind === 'length') return `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`;
  return `${value.toLocaleString()} ${value === 1 ? 'feature' : 'features'}`;
}
function computeDashboardStats() {
  const adminFields = ['district', 'sector'];
  return DASHBOARD_METRICS.map(group => {
    const items = allFeatures.filter(item => {
      if (!group.filterLabels.includes(item.source.label)) return false;
      return adminFields.every(id => els[id].value === 'all' || normalized(property(item.feature, id)) === els[id].value);
    });
    const totals = { area: 0, length: 0, count: 0 };
    items.forEach(item => { const m = featureMetric(item.feature); totals[m.kind] += m.value; });
    const kind = totals.area > 0 ? 'area' : totals.length > 0 ? 'length' : 'count';
    return { ...group, featureCount: items.length, kind, value: totals[kind] };
  });
}
function currentAdminScopeLabel() {
  const parts = ['district', 'sector']
    .filter(id => els[id].value !== 'all')
    .map(id => els[id].selectedOptions[0]?.textContent || els[id].value);
  return parts.length ? parts.join(' · ') : 'All areas';
}
function renderDashboard() {
  els.dashboardScope.textContent = currentAdminScopeLabel();
  computeDashboardStats().forEach(stat => {
    const card = document.querySelector(`.dashboard-card[data-metric="${stat.key}"]`);
    if (!card) return;
    const value = card.querySelector('.dashboard-value');
    const states = stat.filterLabels.map(label => sourceState.get(label));
    if (!states.includes('loaded')) {
      const failed = states.every(state => state === 'failed');
      value.textContent = failed ? 'N/A' : '—';
      card.title = failed ? 'Data unavailable' : 'Loading…';
      return;
    }
    card.removeAttribute('title');
    value.textContent = formatMetric(stat.kind, stat.value);
  });
}

function styleFor(source) { return { color: source.color, weight: 2, fillColor: source.color, fillOpacity: .16 }; }
function zoomToFeature(layer) {
  const bounds = layer.getBounds ? layer.getBounds() : null;
  if (bounds?.isValid()) map.fitBounds(bounds, { padding: [70, 70], maxZoom: 16 });
  else map.setView(layer.getLatLng(), 16);
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function buildPopupContent(feature) {
  const properties = feature.properties || {};
  const location = ['district', 'sector'].map(key => property(feature, key)).filter(Boolean).join(' · ');
  const rows = Object.entries(properties)
    .filter(([key]) => !['name', 'description'].includes(key.toLowerCase()))
    .map(([key, value]) => `<div><dt>${escapeHtml(pretty(key))}</dt><dd>${escapeHtml(value ?? '—')}</dd></div>`).join('');
  const content = document.createElement('div');
  content.className = 'popup-body';
  content.innerHTML = `
    <h3 class="popup-title">${escapeHtml(featureName(feature))}</h3>
    <p class="detail-subtitle">${escapeHtml(location || property(feature, 'description') || 'Map feature')}</p>
    ${rows ? `<div class="detail-divider"></div><dl class="attribute-list">${rows}</dl>` : ''}`;
  return content;
}
// Opens the attribute popup where the feature was clicked. It closes with the × button,
// the Esc key, or a click on empty map; opening another feature replaces it.
function openFeaturePopup(item, latlng) {
  item.layer.closeTooltip();
  L.popup({ className: 'feature-popup', minWidth: 240, maxWidth: 300, maxHeight: 360, autoPanPadding: [24, 24] })
    .setLatLng(latlng)
    .setContent(buildPopupContent(item.feature))
    .openOn(map);
}
function setDashboardMinimized(minimized) {
  els.dashboard.classList.toggle('is-minimized', minimized);
  els.dashboardToggle.setAttribute('aria-expanded', String(!minimized));
  els.dashboardToggle.title = minimized ? 'Expand dashboard' : 'Minimize dashboard';
}
function matches(item, ignoredFilter) {
  const query = els.search.value.trim().toLocaleLowerCase();
  const searchableText = [item.source.label, ...Object.values(item.feature.properties || {})].join(' ').toLocaleLowerCase();
  const filtersMatch = filterFields.every(field => field.id === ignoredFilter || els[field.id].value === 'all' || normalized(filterValue(item, field)) === els[field.id].value);
  return (!query || searchableText.includes(query)) && filtersMatch;
}
function refresh() {
  let visible = 0;
  allFeatures.forEach(item => {
    const show = (layerToggles.get(item.source.id)?.checked ?? true) && matches(item);
    item.layer.setStyle?.({ opacity: show ? 1 : 0, fillOpacity: show ? (item.isPoint ? 1 : .16) : 0 });
    item.show = show; if (show) visible += 1;
  });
  els.empty.classList.toggle('hidden', visible !== 0);
  updateLayerListMuting();
}
function updateLayerListMuting() {
  const wanted = els.intervention.value;
  layerToggles.forEach((input, sourceId) => {
    const source = catalogue.find(entry => entry.id === sourceId);
    const row = input.closest('.layer-row');
    if (!row || !source) return;
    const isMatch = wanted === 'all' || normalized(source.label) === wanted;
    row.style.opacity = isMatch ? '' : '0.35';
  });
}
function populateFilters() {
  filterFields.forEach(field => {
    const select = els[field.id], priorValue = select.value, values = new Map();
    allFeatures.forEach(item => { const value = filterValue(item, field); if (value !== undefined && String(value).trim()) values.set(normalized(value), String(value).trim()); });
    select.innerHTML = `<option value="all">${field.label}</option>` + [...values.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    select.value = values.has(priorValue) ? priorValue : 'all';
  });
}
function fitVisible() { const shown = allFeatures.filter(item => item.show).map(item => item.layer); if (shown.length) map.fitBounds(L.featureGroup(shown).getBounds(), { padding: [45, 45], maxZoom: 14 }); }
async function getSourceData(source) { if (source.format === 'shapefile') return shp(source.url); const response = await fetch(source.url); if (!response.ok) throw new Error(`Could not load ${source.url}`); return response.json(); }
// shpjs returns an array of FeatureCollections when a ZIP holds more than one shapefile;
// merge them so every layer is handled as a single FeatureCollection.
function normalizeGeoJSON(data) {
  if (Array.isArray(data)) return { type: 'FeatureCollection', features: data.flatMap(part => part?.features || []) };
  return data;
}
function markLayerFailed(source, error) {
  console.error(`Could not load layer "${source.label}" (${source.url})`, error);
  sourceState.set(source.label, 'failed');
  els.layerList.insertAdjacentHTML('beforeend', `<div class="layer-row layer-error" title="Could not load ${source.url}"><i class="layer-swatch" style="background:${source.color}"></i><span>${source.label}</span><span class="layer-meta">unavailable</span></div>`);
}
function addLayer(source, data) {
  const group = L.geoJSON(data, { style: () => styleFor(source), pointToLayer: (_, latlng) => L.circleMarker(latlng, { radius: 7, color: '#fff', weight: 2, fillColor: source.color, fillOpacity: 1 }), onEachFeature: (feature, layer) => { const item = { feature, layer, source, isPoint: feature.geometry.type.includes('Point'), show: true }; allFeatures.push(item); layer.on('click', event => { if (!item.show) return; zoomToFeature(layer); openFeaturePopup(item, event.latlng); }); layer.bindTooltip(featureName(feature), { direction: 'top', offset: [0, -8] }); } }).addTo(map);
  layers.set(source.id, group);
  const toggleId = `toggle-${slug(source.id)}`;
  els.layerList.insertAdjacentHTML('beforeend', `<label class="layer-row"><input id="${toggleId}" type="checkbox" checked><i class="layer-swatch" style="background:${source.color}"></i><span>${source.label}</span></label>`);
  const toggleInput = document.getElementById(toggleId);
  layerToggles.set(source.id, toggleInput);
  toggleInput.addEventListener('change', refresh);
}
async function loadData() {
  // Request every layer in parallel, then add them in catalogue order as they arrive.
  // A layer that fails to load or draw is reported and skipped instead of blocking the others.
  const requests = catalogue.map(source => getSourceData(source).then(data => ({ source, data }), error => ({ source, error })));
  for (const request of requests) {
    const { source, data, error } = await request;
    try {
      if (error) throw error;
      addLayer(source, normalizeGeoJSON(data));
      sourceState.set(source.label, 'loaded');
    } catch (err) {
      markLayerFailed(source, err);
    }
    populateFilters(); refresh(); renderDashboard();
  }
  map.invalidateSize({ pan: false });
  fitVisible();
}

els.search.addEventListener('input', refresh);
filterFields.forEach(field => els[field.id].addEventListener('change', () => { populateFilters(); refresh(); fitVisible(); renderDashboard(); }));
document.querySelector('#clear-filters').addEventListener('click', () => { els.search.value = ''; filterFields.forEach(field => els[field.id].value = 'all'); populateFilters(); refresh(); fitVisible(); renderDashboard(); });
document.querySelector('#fit-map').addEventListener('click', fitVisible);
els.dashboardToggle.addEventListener('click', () => setDashboardMinimized(!els.dashboard.classList.contains('is-minimized')));
if (window.matchMedia('(max-width: 680px)').matches) setDashboardMinimized(true); // start minimized on phones
loadData().catch(error => console.error('Could not load map data', error));
