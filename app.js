/* RYWP-Nature based solutions
@author: Gustave-MB */
const catalogue = [
  { id: 'urban-trees', label: 'Urban trees', color: '#09f111', format: 'shapefile', url: './data/Urban-trees.zip' },
  { id: 'Reforestation', label: 'Reforestation', color: '#eb0ed8', format: 'shapefile', url: './data/Reforestation.zip' },
  { id: 'Open-spaces', label: 'Open spaces', color: '#2b4718', format: 'shapefile', url: './data/Open-spaces.zip' },
  { id: 'Bufferzones', label: 'Bufferzones', color: '#0530f0', format: 'shapefile', url: './data/Bufferzones.zip' },
  { id: 'Agroforestry', label: 'Agroforestry', color: '#b5f10e', format: 'shapefile', url: './data/Agroforestry.zip' },
  { id: 'Green-city-school', label: 'Green city club school', color: '#f39304', format: 'shapefile', url: './data/Green-City-club-schools.zip' },
  { id: 'Green-city-IDPMV', label: 'Green city club IDPMV', color: '#131212', format: 'shapefile', url: './data/Green-City-club-IDPMVs.zip' },
  { id: 'Institutions', label: 'Institutions', color: '#f51010', format: 'shapefile', url: './data/Insitutions.zip' }
  ]; 

const map = L.map('map', { zoomControl: false, fadeAnimation: false }).setView([-1.945, 30.06], 12);
L.control.zoom({ position: 'bottomright' }).addTo(map);
const basemaps = {
  streets: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }),
  satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles &copy; Esri' }),
  terrain: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap' })
};
basemaps.streets.addTo(map);
const basemapNotice = document.createElement('div');
basemapNotice.className = 'basemap-notice hidden';
basemapNotice.setAttribute('role', 'status');
basemapNotice.textContent = 'Basemap tiles could not load. Check your internet connection and reload.';
document.querySelector('.map-wrap').append(basemapNotice);
Object.values(basemaps).forEach(layer => {
  layer.on('tileerror', () => basemapNotice.classList.remove('hidden'));
  layer.on('tileload', () => basemapNotice.classList.add('hidden'));
});
document.querySelector('#basemap-select').addEventListener('change', event => {
  const nextBasemap = basemaps[event.target.value];
  if (!nextBasemap || map.hasLayer(nextBasemap)) return;
  Object.values(basemaps).forEach(layer => { if (map.hasLayer(layer)) map.removeLayer(layer); });
  nextBasemap.addTo(map);
});
window.addEventListener('resize', () => map.invalidateSize({ pan: false }));
requestAnimationFrame(() => map.invalidateSize({ pan: false }));

const layers = new Map();
const layerToggles = new Map();
const allFeatures = [];
let highlightedItem = null;
const sourceState = new Map(); // layer label -> 'loaded' | 'failed' (absent while still loading)
const els = {
  layerList: document.querySelector('#layer-list'), search: document.querySelector('#search-input'), intervention: document.querySelector('#intervention-filter'),
  district: document.querySelector('#district-filter'), sector: document.querySelector('#sector-filter'), 
  empty: document.querySelector('#empty-state'),
  dashboard: document.querySelector('#dashboard'), dashboardToggle: document.querySelector('#toggle-dashboard'),
  dashboardScope: document.querySelector('#dashboard-scope'), dashboardTitle: document.querySelector('.dashboard-title'),
  dashboardBody: document.querySelector('#dashboard-body'), dashboardDetails: document.querySelector('#dashboard-details'),
  featureDetails: document.querySelector('#feature-details-content')
};
const filterFields = [{ id: 'intervention', label: 'All interventions', catalogueValue: true }, { id: 'district', label: 'All districts' }, { id: 'sector', label: 'All sectors' }];
const pretty = key => key.replace(/_/g, ' ').replace(/\b\w/g, x => x.toUpperCase());
const slug = value => String(value).replace(/[^a-zA-Z0-9_-]+/g, '-');
const property = (feature, key) => Object.entries(feature.properties || {}).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
const featureName = feature => property(feature, 'name') || property(feature, 'title') || property(feature, 'id') || property(feature, 'SCHOOLS')|| property(feature, 'IDPMV NAME') || 'Untitled feature';
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
  { key: 'open-space', filterLabels: ['Open spaces'] },
  { key: 'green-city-club', filterLabels: ['Green city club IDPMV', 'Green city club school'] }
];
// Read area and length from the shapefile attributes. Names are matched
// case/space/underscore-insensitively; add variants here for other datasets.
const AREA_FIELD_CANDIDATES = [
  { names: ['area_ha', 'AREA', 'ha'], toSqm: v => v * 10000 },
  { names: ['area_sqm', 'area_m2', 'aream2', 'shape_area', 'st_area', 'area'], toSqm: v => v }
];
const LENGTH_FIELD_CANDIDATES = [
  { names: ['length_km', 'LENGTH', 'lenkm'], toM: v => v * 1000 },
  { names: ['length_m', 'lengthm', 'length', 'shape_leng', 'shape_length', 'st_length', 'perimeter', 'len'], toM: v => v }
];
const NUMBER_OF_TREES_FIELD_CANDIDATES = [
  { names: ['number_of_trees', 'trees'], toM: v => v }
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
    return { kind: 'count', value: 1 };
  }
  if (type === 'LineString' || type === 'MultiLineString') {
    const found = findFieldValue(feature, LENGTH_FIELD_CANDIDATES);
    if (found) return { kind: 'length', value: found.convert(found.value) };
    return { kind: 'count', value: 1 };
  }
  if (type === 'MultiPoint' || type === 'Point') {
    const found = findFieldValue(feature, NUMBER_OF_TREES_FIELD_CANDIDATES);
    if (found) return { kind: 'trees', value: found.convert(found.value) };
  }
  return { kind: 'count', value: type ? 1 : 0 };
}
function formatMetric(kind, value, metricKey) {
  if (kind === 'area') return `${(value / 10000).toLocaleString(undefined, { maximumFractionDigits: 1 })} ha`;
  if (kind === 'length') return `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`;
  if (kind === 'trees') return `${(value).toLocaleString(undefined, { maximumFractionDigits: 1 })} trees`;
  return `${value.toLocaleString()} ${value === 1 ? 'feature' : 'features'}`;
}
function computeDashboardStats() {
  const adminFields = ['district', 'sector'];
  return DASHBOARD_METRICS.map(group => {
    const items = allFeatures.filter(item => {
      if (!group.filterLabels.includes(item.source.label)) return false;
      return adminFields.every(id => els[id].value === 'all' || normalized(property(item.feature, id)) === els[id].value);
    });
    const totals = { area: 0, length: 0, trees: 0, count: 0 };
    items.forEach(item => { const m = featureMetric(item.feature); totals[m.kind] += m.value; });
    const kind = totals.area > 0 ? 'area' : totals.length > 0 ? 'length' : totals.trees > 0 ? 'trees': 'count';
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
    value.textContent = formatMetric(stat.kind, stat.value, stat.key);
  });
}

function styleFor(source) { return { color: source.color, weight: 2, fillColor: source.color, fillOpacity: .5 }; }
function pointIcon(color, highlighted = false) {
  const fill = highlighted ? '#00f7ff' : color;
  const stroke = highlighted ? '#00a99f' : '#fff';
  return L.divIcon({
    className: 'point-marker-wrap',
    html: `<svg class="point-marker${highlighted ? ' is-highlighted' : ''}" viewBox="0 0 24 30" aria-hidden="true"><path d="M12 1.5C6.2 1.5 1.5 6.2 1.5 12c0 7.1 10.5 16.3 10.5 16.3S22.5 19.1 22.5 12C22.5 6.2 17.8 1.5 12 1.5Z" fill="${fill}" stroke="${stroke}" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="#fff"/></svg>`,
    iconSize: [18, 23], iconAnchor: [9, 22], popupAnchor: [0, -20]
  });
}
function zoomToFeature(layer) {
  const bounds = layer.getBounds ? layer.getBounds() : null;
  if (bounds?.isValid()) map.fitBounds(bounds, { padding: [70, 70], maxZoom: 18, animate: false });
  else map.setView(layer.getLatLng(), 16, { animate: false });
}
function focusFeature(layer) {
  const bounds = layer.getBounds ? layer.getBounds() : null;
  if (bounds?.isValid()) map.fitBounds(bounds, { padding: [70, 70], maxZoom: 16, animate: false });
  else if (layer.getLatLng) map.setView(layer.getLatLng(), 16, { animate: false });
}
function highlightFeature(item) {
  if (highlightedItem && highlightedItem !== item) {
    const previous = highlightedItem;
    if (previous.isPoint) previous.layer.setIcon(pointIcon(previous.source.color));
    previous.layer.setStyle?.({
      color: previous.source.color,
      weight: 2,
      fillColor: previous.source.color,
      fillOpacity: previous.isPoint ? 1 : .5,
      radius: 7
    });
  }
  highlightedItem = item;
  if (item.isPoint) item.layer.setIcon(pointIcon(item.source.color, true));
  item.layer.setStyle?.({
    color: '#00ffea',
    weight: 4,
    fillColor: '#00f7ff',
    fillOpacity: item.isPoint ? 1 : .5,
    radius: 10
  });
  item.layer.bringToFront?.();
}
function clearFeatureHighlight() {
  if (!highlightedItem) return;
  const previous = highlightedItem;
  if (previous.isPoint) previous.layer.setIcon(pointIcon(previous.source.color));
  previous.layer.setStyle?.({
    color: previous.isPoint ? '#fff' : previous.source.color,
    weight: previous.isPoint ? 2 : 2,
    fillColor: previous.source.color,
    fillOpacity: previous.isPoint ? 1 : .5,
    radius: 7
  });
  highlightedItem = null;
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function buildPopupContent(feature) {
  const properties = feature.properties || {};
  const type = property(feature, 'type') || '—';
  const rows = Object.entries(properties)
    .filter(([key]) => !['name', 'description', 'type', 'phase', 'path', 'schools', 'idpmv name', 'latitude', 'longitude', 'elevation', 'progress', 'no'].includes(key.toLowerCase()))
    .map(([key, value]) => `<div><dt>${escapeHtml(pretty(key))}</dt><dd>${escapeHtml(value ?? '—')}</dd></div>`).join('');
  const content = document.createElement('div');
  content.className = 'popup-body';
  content.innerHTML = `
    <h3 class="popup-title">${escapeHtml(featureName(feature))}</h3>
    <p class="detail-subtitle">${escapeHtml(type)}</p>
    ${rows ? `<div class="detail-divider"></div><dl class="attribute-list">${rows}</dl>` : ''}`;
  return content;
}
// Replace the dashboard overview with the clicked feature's attributes.
function showFeatureDetails(item) {
  item.layer.closeTooltip();
  els.dashboard.classList.add('showing-details');
  els.dashboardBody.classList.add('hidden');
  els.dashboardDetails.classList.remove('hidden');
  els.dashboard.classList.remove('is-minimized');
  els.dashboardToggle.setAttribute('aria-expanded', 'true');
  els.featureDetails.replaceChildren(buildPopupContent(item.feature));
}
function showDashboardOverview() {
  els.dashboard.classList.remove('showing-details');
  els.dashboardTitle.textContent = 'Overview';
  els.dashboardScope.textContent = currentAdminScopeLabel();
  els.dashboardDetails.classList.add('hidden');
  els.dashboardBody.classList.remove('hidden');
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
    const group = layers.get(item.source.id);
    if (show && group && !group.hasLayer(item.layer)) group.addLayer(item.layer);
    else if (!show && group?.hasLayer(item.layer)) {
      item.layer.closeTooltip();
      if (highlightedItem === item) clearFeatureHighlight();
      group.removeLayer(item.layer);
    }
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
function hasGeographicBounds(layer) {
  const bounds = layer.getBounds?.();
  if (!bounds?.isValid()) return false;
  const southWest = bounds.getSouthWest(), northEast = bounds.getNorthEast();
  return [southWest.lat, southWest.lng, northEast.lat, northEast.lng].every(Number.isFinite)
    && southWest.lat >= -90 && northEast.lat <= 90
    && southWest.lng >= -180 && northEast.lng <= 180;
}
function fitVisible() {
  const shown = allFeatures.filter(item => item.show && hasGeographicBounds(item.layer)).map(item => item.layer);
  if (shown.length) map.fitBounds(L.featureGroup(shown).getBounds(), { padding: [45, 45], maxZoom: 16 });
}
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
  const group = L.geoJSON(data, { style: () => styleFor(source), pointToLayer: (_, latlng) => L.marker(latlng, { icon: pointIcon(source.color), keyboard: true, riseOnHover: true }), onEachFeature: (feature, layer) => { const item = { feature, layer, source, isPoint: feature.geometry.type.includes('Point'), isLine: /LineString/.test(feature.geometry.type), show: true }; allFeatures.push(item); layer.on('click', () => { if (!item.show) return; clearFeatureHighlight(); highlightFeature(item); if (item.isLine) zoomToFeature(layer); else focusFeature(layer); showFeatureDetails(item); }); layer.bindTooltip(featureName(feature), { direction: 'top', offset: [0, -8] }); } }).addTo(map);
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
document.querySelector('#back-to-overview').addEventListener('click', showDashboardOverview);
if (window.matchMedia('(max-width: 680px)').matches) setDashboardMinimized(true); // start minimized on phones
loadData().catch(error => console.error('Could not load map data', error));
