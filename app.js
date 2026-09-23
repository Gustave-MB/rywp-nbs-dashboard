/* RYWP-Nature based solutions
@author: Gustave-MB */
const catalogue = [
  { id: 'urban-trees', label: 'Urban trees', filterLabel: 'Urban trees', color: '#4CAF50', format: 'shapefile', url: './data/Urban-trees.zip' },
  { id: 'Reforestation', label: 'Reforestation', filterLabel: 'Reforestation', color: '#b5da11', format: 'shapefile', url: './data/Reforestation.zip' },
  { id: 'Open spaces', label: 'Open spaces', filterLabel: 'Open spaces', color: '#087e73', format: 'shapefile', url: './data/Open-spaces.zip' },
  { id: 'Bufferzones', label: 'Bufferzones', filterLabel: 'Bufferzones', color: '#e97b3c', format: 'shapefile', url: './data/Bufferzones.zip' },
  { id: 'Agroforestry', label: 'Agroforestry', filterLabel: 'Agroforestry', color: '#8BC34A', format: 'shapefile', url: './data/Agroforestry.zip' },
  { id: 'Afforestation', label: 'Afforestation', filterLabel: 'Afforestation', color: '#4CAF50', format: 'shapefile', url: './data/Afforestation.zip' }
  ];

const map = L.map('map', { zoomControl: false }).setView([-1.945, 30.06], 12);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);

const layers = new Map();
const layerToggles = new Map();
const allFeatures = [];
let selected = null;
const els = {
  layerList: document.querySelector('#layer-list'), search: document.querySelector('#search-input'), intervention: document.querySelector('#intervention-filter'),
  district: document.querySelector('#district-filter'), sector: document.querySelector('#sector-filter'), cell: document.querySelector('#cell-filter'),
  count: document.querySelector('#feature-count'), visible: document.querySelector('#visible-count'), empty: document.querySelector('#empty-state'),
  detailsEmpty: document.querySelector('#details-empty'), details: document.querySelector('#details-content')
};
const filterFields = [{ id: 'intervention', label: 'All interventions', catalogueValue: true }, { id: 'district', label: 'All districts' }, { id: 'sector', label: 'All sectors' }, { id: 'cell', label: 'All cells' }];
const pretty = key => key.replace(/_/g, ' ').replace(/\b\w/g, x => x.toUpperCase());
const slug = value => String(value).replace(/[^a-zA-Z0-9_-]+/g, '-');
const property = (feature, key) => Object.entries(feature.properties || {}).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
const featureName = feature => property(feature, 'name') || property(feature, 'title') || property(feature, 'id') || 'Untitled feature';
const normalized = value => String(value ?? '').trim().toLocaleLowerCase();
const filterValue = (item, field) => field.catalogueValue ? (item.source.filterLabel || item.source.label) : property(item.feature, field.id);

// Dashboard summary cards. "Forest" combines the two forest-establishment interventions
// (Reforestation + Afforestation) since there's no single catalogue category named "Forest".
// Adjust the filterLabels arrays here if a different grouping is wanted.
const DASHBOARD_METRICS = [
  { key: 'forest', icon: '🌳', label: 'Forest', filterLabels: ['Reforestation', 'Afforestation'] },
  { key: 'agroforest', icon: '🌾', label: 'Agroforestry', filterLabels: ['Agroforestry'] },
  { key: 'buffer', icon: '🛡️', label: 'Buffer zones', filterLabels: ['Bufferzones'] },
  { key: 'urban', icon: '🌲', label: 'Urban trees', filterLabels: ['Urban trees'] },
  {key: 'open-space', icon: '🌳', label: 'Open spaces', filterLabels: ['Open spaces'] }
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

// Prefer area/length values already computed in the dataset's attribute table (e.g. from
// ArcGIS/QGIS "Shape_Area", "Area_ha", "Shape_Leng" fields) over recomputing from geometry.
// Names are matched case/space/underscore-insensitively; add more variants here if a dataset
// uses a field name not listed. Falls back to the geodesic calculation when no field matches.
const AREA_FIELD_CANDIDATES = [
  { names: ['area_ha', 'AREA', 'hectares', 'ha'], toSqm: v => v * 10000 },
  { names: ['area_km2', 'areakm2', 'area_sqkm', 'sqkm'], toSqm: v => v * 1e6 },
  { names: ['area_sqm', 'area_m2', 'aream2', 'shape_area', 'st_area', 'area'], toSqm: v => v }
];
const LENGTH_FIELD_CANDIDATES = [
  { names: ['length_km', 'LENGTH', 'len_km', 'lenkm'], toM: v => v * 1000 },
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
  const adminFields = ['district', 'sector', 'cell'];
  return DASHBOARD_METRICS.map(group => {
    const items = allFeatures.filter(item => {
      if (!group.filterLabels.includes(item.source.filterLabel || item.source.label)) return false;
      return adminFields.every(id => els[id].value === 'all' || normalized(property(item.feature, id)) === els[id].value);
    });
    const totals = { area: 0, length: 0, count: 0 };
    items.forEach(item => { const m = featureMetric(item.feature); totals[m.kind] += m.value; });
    const kind = totals.area > 0 ? 'area' : totals.length > 0 ? 'length' : 'count';
    return { ...group, featureCount: items.length, kind, value: totals[kind] };
  });
}
function currentAdminScopeLabel() {
  const parts = ['district', 'sector', 'cell']
    .filter(id => els[id].value !== 'all')
    .map(id => els[id].selectedOptions[0]?.textContent || els[id].value);
  return parts.length ? parts.join(' · ') : 'All areas';
}
function injectDashboardStyles() {
  if (document.getElementById('dashboard-styles')) return;
  const style = document.createElement('style');
  style.id = 'dashboard-styles';
  style.textContent = `
    .dashboard { padding: 4px 2px; }
    .dashboard-title { margin: 0 0 2px; font-size: 15px; font-weight: 600; }
    .dashboard-scope { margin: 0 0 12px; font-size: 12px; font-weight: 500; color: #2563eb; }
    .dashboard-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .dashboard-card { background: #f4f6f5; border-radius: 10px; padding: 12px; }
    .dashboard-icon { font-size: 18px; }
    .dashboard-value { font-size: 18px; font-weight: 700; margin-top: 4px; }
    .dashboard-label { font-size: 12px; color: #4b5563; margin-top: 2px; }
    .dashboard-sub { font-size: 11px; color: #9ca3af; margin-top: 2px; }
    .dashboard-hint { margin-top: 14px; font-size: 12px; color: #6b7280; }
    .back-to-dashboard-btn { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 10px; background: none; border: none; color: #2563eb; font-size: 13px; cursor: pointer; padding: 0; }
    .back-to-dashboard-btn:hover { text-decoration: underline; }
  `;
  document.head.appendChild(style);
}
function renderDashboard() {
  const stats = computeDashboardStats();
  els.detailsEmpty.innerHTML = `
    <div class="dashboard">
      <h3 class="dashboard-title">Overview</h3>
      <p class="dashboard-scope">${currentAdminScopeLabel()}</p>
      <div class="dashboard-grid">
        ${stats.map(stat => `
          <div class="dashboard-card">
            <div class="dashboard-icon">${stat.icon}</div>
            <div class="dashboard-value">${formatMetric(stat.kind, stat.value)}</div>
            <div class="dashboard-label">${stat.label}</div>
            <div class="dashboard-sub">${stat.featureCount} feature${stat.featureCount === 1 ? '' : 's'}</div>
          </div>
        `).join('')}
      </div>
      <p class="dashboard-hint">Click a feature on the map to see its details.</p>
    </div>
  `;
}
function showDashboard() { selected = null; els.details.classList.add('hidden'); els.detailsEmpty.classList.remove('hidden'); }
function addBackToDashboardButton() {
  const anchor = document.querySelector('#detail-title');
  if (!anchor || document.getElementById('back-to-dashboard')) return;
  anchor.insertAdjacentHTML('beforebegin', `<button id="back-to-dashboard" type="button" class="back-to-dashboard-btn">← Back to dashboard</button>`);
  document.getElementById('back-to-dashboard').addEventListener('click', showDashboard);
}

function styleFor(source) { return { color: source.color, weight: 2, fillColor: source.color, fillOpacity: .16 }; }
function focus(feature, layer) { selected = { feature, layer }; const bounds = layer.getBounds ? layer.getBounds() : null; if (bounds?.isValid()) map.fitBounds(bounds, { padding: [70, 70], maxZoom: 16 }); else map.setView(layer.getLatLng(), 16); renderDetails(feature); }
function renderDetails(feature) {
  const properties = feature.properties || {};
  const location = ['district', 'sector', 'cell'].map(key => property(feature, key)).filter(Boolean).join(' · ');
  document.querySelector('#detail-title').textContent = featureName(feature);
  document.querySelector('#detail-subtitle').textContent = location || property(feature, 'description') || 'Map feature';
  document.querySelector('#detail-type').textContent = feature.geometry.type.replace('Multi', '').toUpperCase();
  document.querySelector('#attribute-list').innerHTML = Object.entries(properties).filter(([key]) => !['name', 'description'].includes(key.toLowerCase())).map(([key, value]) => `<div><dt>${pretty(key)}</dt><dd>${value ?? '—'}</dd></div>`).join('');
  els.detailsEmpty.classList.add('hidden'); els.details.classList.remove('hidden');
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
  els.visible.textContent = `${visible}/${allFeatures.length}`; els.empty.classList.toggle('hidden', visible !== 0);
  updateLayerListMuting();
}
function updateLayerListMuting() {
  const wanted = els.intervention.value;
  layerToggles.forEach((input, sourceId) => {
    const source = catalogue.find(entry => entry.id === sourceId);
    const row = input.closest('.layer-row');
    if (!row || !source) return;
    const isMatch = wanted === 'all' || normalized(source.filterLabel || source.label) === wanted;
    row.style.opacity = isMatch ? '' : '0.35';
  });
}
function populateFilters() {
  filterFields.forEach(field => {
    const select = els[field.id], priorValue = select.value, values = new Map();
    allFeatures.filter(item => matches(item, field.id)).forEach(item => { const value = filterValue(item, field); if (value !== undefined && String(value).trim()) values.set(normalized(value), String(value).trim()); });
    select.innerHTML = `<option value="all">${field.label}</option>` + [...values.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    select.value = values.has(priorValue) ? priorValue : 'all';
  });
}
function fitVisible() { const shown = allFeatures.filter(item => item.show).map(item => item.layer); if (shown.length) map.fitBounds(L.featureGroup(shown).getBounds(), { padding: [45, 45], maxZoom: 14 }); }
async function getSourceData(source) { if (source.format === 'shapefile') return shp(source.url); const response = await fetch(source.url); if (!response.ok) throw new Error(`Could not load ${source.url}`); return response.json(); }
async function loadData() {
  for (const source of catalogue) {
    const data = await getSourceData(source);
    const group = L.geoJSON(data, { style: () => styleFor(source), pointToLayer: (_, latlng) => L.circleMarker(latlng, { radius: 7, color: '#fff', weight: 2, fillColor: source.color, fillOpacity: 1 }), onEachFeature: (feature, layer) => { allFeatures.push({ feature, layer, source, isPoint: feature.geometry.type.includes('Point'), show: true }); layer.on('click', () => focus(feature, layer)); layer.bindTooltip(featureName(feature), { direction: 'top', offset: [0, -8] }); } }).addTo(map);
    layers.set(source.id, group);
    const toggleId = `toggle-${slug(source.id)}`;
    els.layerList.insertAdjacentHTML('beforeend', `<label class="layer-row"><input id="${toggleId}" type="checkbox" checked><i class="layer-swatch" style="background:${source.color}"></i><span>${source.label}</span><span class="layer-meta">${data.features.length}</span></label>`);
    const toggleInput = document.getElementById(toggleId);
    layerToggles.set(source.id, toggleInput);
    toggleInput.addEventListener('change', refresh);
  }
  els.count.textContent = allFeatures.length; populateFilters(); refresh(); fitVisible(); renderDashboard();
}

els.search.addEventListener('input', refresh);
filterFields.forEach(field => els[field.id].addEventListener('change', () => { populateFilters(); refresh(); fitVisible(); renderDashboard(); }));
document.querySelector('#clear-filters').addEventListener('click', () => { els.search.value = ''; filterFields.forEach(field => els[field.id].value = 'all'); populateFilters(); refresh(); fitVisible(); renderDashboard(); });
document.querySelector('#fit-map').addEventListener('click', fitVisible);
document.querySelector('#zoom-detail').addEventListener('click', () => selected && focus(selected.feature, selected.layer));
document.querySelector('#close-details').addEventListener('click', showDashboard);
injectDashboardStyles();
addBackToDashboardButton();
loadData().catch(error => console.error('Could not load map data', error));

