/* Cartochron browser: one focused track, plus optional comparison layers.
 * Historical pages are intentionally bounded; a partial track is never
 * presented as though the entire interval had been loaded.
 */
'use strict';

const $ = id => document.getElementById(id);
const GAP_MS = 10 * 60 * 1000; // Don't invent a route across a recording gap.
const PAGE_SIZE = 1000;
const MAX_DISPLAY = 5000;
const MAX_NODES = 140; // Keep long routes inspectable without thousands of DOM/map layers.
const OVERLAY_COLORS = ['#8724d5', '#007c78', '#ca325a'];
const OVERLAY_OUTLINE = '#162735'; // Dark casing works over light and busy tiles.
const MAX_OVERLAYS = 3;
const NEARBY_FIX_MS = 5 * 60 * 1000; // Shared-time comparison, not live-feed status.
const RECENT_RECEIPT_MS = 2 * 60 * 1000; // Heuristic for receipts, not connection proof.
const JUMP_MIN_M = 200; // Review-only heuristic; not evidence of inaccurate GPS.
const JUMP_MIN_MPS = 25; // Apparent speed from *receipt* times, not measured motion.
const map = L.map('map').setView([0, 0], 2);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin',
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);
const layer = L.layerGroup().addTo(map);
const overlayLayers = new Map();
const timeLayer = L.layerGroup().addTo(map);
const placeLayer = L.layerGroup().addTo(map);
const monitorLayer = L.layerGroup().addTo(map);
const proximityLayer = L.layerGroup().addTo(map);
let proximityRevision = 0;
let proximityCursor = null;
let proximityCount = 0;
let proximityScanned = 0;
let proximityLimited = false;
const MAX_PROXIMITY_DISPLAY = 100;
let placeSelection = null;
let placeSearchRevision = 0;
let placeSearchCursor = null;
let placeSearchCount = 0;
let placeSearchMatches = [];
const MAX_PLACE_DISPLAY = 500;
const PLACE_GROUP_GAP_MS = 5 * 60 * 1000; // A display rule, not inferred dwell.
const MAX_PLACE_GROUPS = 80;
const MAX_PLACE_WITNESSES = 40; // Display only; qualifying pairs are counted.

let catalogue = [];
let monitorCatalogue = [];
let sourceCatalogue = [];
let selectedMonitorKey = '';
let cameraMode = 'free';
let initialMonitorFit = 'visible';
let cameraMoving = false;
let historyRunList = [];
let historyLoaded = false;
let historyRunCursor = null;
let historyRunBusy = false;
let historyRunGeneration = 0;
let historyFilter = '';
let historyTrack = '';
let selectedTrack = '';
const visibleOverlays = new Set();
const overlayPoints = new Map();
let overlayGeneration = 0;
let mode = 'live';
let points = [];
let cursor = null;
let revision = 0;
let liveBusy = false;
let tracksBusy = false;
let lastSignature = '';
let lastIndex = 0;
let ticks = 0;
let recordingGaps = [];
let positioningJumps = [];

function status(message) { $('status').textContent = message; }
function localTime(value) { return new Date(value).toLocaleString(); }
function localInput(value) {
  const d = new Date(value);
  const parts = [d.getFullYear(), d.getMonth() + 1, d.getDate(),
    d.getHours(), d.getMinutes(), d.getSeconds()];
  const [year, month, day, hour, minute, second] = parts.map(
    (n, i) => String(n).padStart(i === 0 ? 4 : 2, '0'));
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}
async function getJSON(url) {
  const response = await fetch(url, {cache: 'no-store'});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
function trackInfo() {
  return historyRunList.find(t => t.track_id === selectedTrack)
    || catalogue.find(t => t.track_id === selectedTrack);
}
function receiptState(time, now = Date.now()) {
  const received = Date.parse(time);
  const age = now - received;
  if (!Number.isFinite(age) || age < -30_000)
    return {kind: 'unknown', label: 'receipt time uncertain'};
  const elapsed = Math.max(0, age);
  const label = elapsed < 60_000 ? `${Math.floor(elapsed / 1000)}s ago`
    : elapsed < 3_600_000 ? `${Math.floor(elapsed / 60_000)}m ago`
    : elapsed < 86_400_000 ? `${Math.floor(elapsed / 3_600_000)}h ago`
    : `${Math.floor(elapsed / 86_400_000)}d ago`;
  return {kind: elapsed <= RECENT_RECEIPT_MS ? 'recent' : 'stale', label};
}
function feedState(kind, label) {
  $('feed-state').textContent = label;
  $('feed-state').setAttribute('data-state', kind);
}
function runLabel(record) {
  // History displays exact run IDs and stable receipt times; no ticking ages.
  const name = record.channel_label || record.source_label || record.channel_id || 'Unattributed';
  const first = record.first ? localTime(record.first) : '';
  const last = record.last ? localTime(record.last) : '';
  return `${name} · ${first && last ? `${first} – ${last}` : last}`
    + (record.count !== undefined ? ` · ${record.count} fixes` : '')
    + ` · ${record.track_id}`;
}
function monitorKey(item) { return `${item.kind}:${item.id}`; }
function monitorName(item) {
  if (item.kind === 'unattributed')
    return `Unattributed newest run (${item.runs} unassigned runs)`;
  if (item.kind === 'source') return item.source_label || item.id;
  // A channel's source assertions can differ across runs; do not label
  // mixed historical provenance using only its newest source's label.
  if (item.mixed_sources) return `${item.channel_label || item.id} (mixed source assertions)`;
  return item.channel_label || (item.source_label ? `${item.source_label} · ${item.id}` : item.id);
}
function monitorLabel(item) {
  const freshness = receiptState(item.last);
  const state = freshness.kind === 'recent' ? 'recent receipts'
    : freshness.kind === 'stale' ? 'no recent receipts' : 'time uncertain';
  return `${monitorName(item)} · ${state}`;
}
function updateSelector() {
  const select = $('track');
  const monitoring = mode === 'live';
  $('selection-label').textContent = monitoring ? 'Source / channel' : 'Recording run';
  select.setAttribute('aria-label', monitoring ? 'Monitored source or channel' : 'Recording run');
  select.replaceChildren();
  if (monitoring) {
    for (const item of monitorCatalogue)
      select.add(new Option(monitorLabel(item), monitorKey(item)));
    select.disabled = !monitorCatalogue.length;
    if (!monitorCatalogue.length) select.add(new Option('No observed channels', ''));
    select.value = selectedMonitorKey;
    select.title = 'One latest recording per identified source or channel; unassigned runs remain separate in History';
  } else {
    const choices = historyLoaded ? historyRunList : catalogue;
    for (const track of choices) select.add(new Option(runLabel(track), track.track_id));
    if (selectedTrack && !choices.some(t => t.track_id === selectedTrack))
      select.add(new Option(selectedTrack + ' (not in recent list)', selectedTrack));
    select.disabled = !choices.length && !selectedTrack;
    if (!choices.length && !selectedTrack) select.add(new Option('No recordings', ''));
    select.value = selectedTrack;
    select.title = 'Exact recorded runs; choose a channel/source filter or load older recordings';
  }
  updateProximityChoices();
}
function updateHistoryFilter() {
  const select = $('history-filter');
  const options = [new Option('All recordings', '')];
  const seen = new Set();
  for (const item of monitorCatalogue) {
    if (item.channel_id && !seen.has(`channel:${item.channel_id}`)) {
      seen.add(`channel:${item.channel_id}`);
      options.push(new Option(`Channel · ${item.channel_label || item.channel_id}`,
        `channel:${item.channel_id}`));
    }
  }
  for (const source of sourceCatalogue) {
    if (!seen.has(`source:${source.source_id}`)) {
      seen.add(`source:${source.source_id}`);
      options.push(new Option(`Source · ${source.label}`, `source:${source.source_id}`));
    }
  }
  select.replaceChildren(...options);
  select.value = historyFilter;
  // The place query has its own scope: it must not change History's run selection.
  const placeScope = $('place-scope');
  const previous = placeScope.value;
  placeScope.replaceChildren(new Option('All sources and channels', ''),
    ...options.slice(1).map(item => new Option(item.text, item.value)));
  placeScope.value = options.some(item => item.value === previous) ? previous : '';
  if (previous && placeScope.value !== previous) resetDatabasePlaceSearch();
}

function updateProximityChoices() {
  // Suggestions do not restrict the search: an older run ID can be entered
  // explicitly, even when the History list is filtered to one source.
  const input = $('proximity-other');
  const previous = input.value;
  const seen = new Set();
  const choices = [...historyRunList, ...catalogue].filter(item => {
    if (item.track_id === selectedTrack || seen.has(item.track_id)) return false;
    seen.add(item.track_id);
    return true;
  });
  $('proximity-known-runs').replaceChildren(...choices.map(item =>
    new Option(runLabel(item), item.track_id)));
  if (!previous || previous === selectedTrack) input.value = choices[0]?.track_id || '';
  $('proximity-search').disabled = !selectedTrack || !input.value;
}

function resetRunProximity() {
  proximityRevision++;
  proximityCursor = null;
  proximityCount = 0;
  proximityScanned = 0;
  proximityLimited = false;
  proximityLayer.clearLayers();
  $('proximity-results').replaceChildren();
  $('proximity-next').hidden = true;
  $('proximity-search').disabled = !selectedTrack || !$('proximity-other').value;
  $('proximity-status').textContent = 'Choose two recording runs and search their stored observations.';
}

function showRunWitness(pair) {
  // Two reported fixes, never a line suggesting movement or an encounter.
  proximityLayer.clearLayers();
  const locations = new Map();
  for (const [side, point] of [['A', pair.a], ['B', pair.b]]) {
    const key = `${point.lat},${point.lon}`;
    if (!locations.has(key)) locations.set(key, []);
    locations.get(key).push({side, point});
  }
  for (const entries of locations.values()) {
    const first = entries[0].point;
    const label = document.createElement('span');
    label.textContent = entries.map(({side, point}) =>
      `${side}: ${point.track_id} / fix ${point.id} · ${localTime(point.time)} · ${fixDetails(point)}`)
      .join(' | ');
    L.circleMarker([first.lat, first.lon], {
      radius: 8, color: '#edf2f5', weight: 2,
      fillColor: entries.length > 1 ? '#f8b449' : entries[0].side === 'A' ? '#57b9ef' : '#8724d5',
      fillOpacity: 0.95
    }).bindTooltip(label).on('click', () => L.popup()
      .setLatLng([first.lat, first.lon]).setContent(label).openOn(map)).addTo(proximityLayer);
  }
  fitObservations([pair.a, pair.b]);
}

async function searchRunProximity(more = false) {
  if (mode !== 'history' || $('proximity-panel').hidden) return;
  if (more && (!proximityCursor || proximityCount >= MAX_PROXIMITY_DISPLAY)) return;
  const a = selectedTrack, b = $('proximity-other').value;
  if (!a || !b || a === b) {
    $('proximity-status').textContent = 'Select two different recording runs.';
    return;
  }
  const query = new URLSearchParams({track_id: a, other_track_id: b,
    radius_m: $('proximity-radius').value, window_s: $('proximity-window').value,
    limit: String(Math.min(20, MAX_PROXIMITY_DISPLAY - (more ? proximityCount : 0)))});
  try {
    if ($('proximity-interval').checked) {
      const from = placeReceiptFilter('from', 'From');
      const to = placeReceiptFilter('to', 'To');
      if (from && to && from >= to) throw new Error('From must precede To');
      if (from) query.set('from', from);
      if (to) query.set('to', to);
    }
  } catch (error) {
    $('proximity-status').textContent = 'Invalid receipt-time interval: ' + error.message;
    return;
  }
  if (more) query.set('before', proximityCursor);
  else resetRunProximity();
  const token = ++proximityRevision;
  $('proximity-search').disabled = true;
  $('proximity-next').hidden = true;
  $('proximity-status').textContent = 'Comparing stored observations…';
  try {
    const result = await getJSON('/api/proximity?' + query);
    if (token !== proximityRevision || mode !== 'history') return;
    proximityScanned += result.scanned;
    proximityLimited ||= result.candidate_limited;
    proximityCount += result.pairs.length;
    proximityCursor = result.next_cursor;
    for (const pair of result.pairs) {
      const li = document.createElement('li');
      const details = document.createElement('span');
      const kind = pair.identity_kind === 'source'
        ? 'Different enrolled source claims' : 'Different channel claims only';
      const name = point => point.channel_label || point.source_label
        || point.channel_id || point.source_id || 'Unattributed';
      details.textContent = `${kind}: ${name(pair.a)} (${pair.a.track_id} / fix ${pair.a.id}) and `
        + `${name(pair.b)} (${pair.b.track_id} / fix ${pair.b.id})`
        + ` · received ${localTime(pair.a.time)} / ${localTime(pair.b.time)}`
        + ` · Δt ${(pair.receipt_delta_ms / 1000).toFixed(1)}s`
        + ` · reported positions ${pair.distance_m} m apart`
        + ` · reported accuracy ${pair.a.accuracy_m ?? 'unknown'} m / ${pair.b.accuracy_m ?? 'unknown'} m`;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Map pair';
      button.addEventListener('click', () => showRunWitness(pair));
      li.appendChild(details);
      li.appendChild(button);
      $('proximity-results').appendChild(li);
    }
    const capped = proximityCount >= MAX_PROXIMITY_DISPLAY;
    $('proximity-next').hidden = !proximityCursor || capped;
    $('proximity-status').textContent = `${proximityCount} candidate pair${proximityCount === 1 ? '' : 's'} from `
      + `${proximityScanned} examined anchor fixes` + (proximityCursor
        ? '; older anchors remain unexamined' : '; anchor search reached its end')
      + (proximityLimited ? '; dense time windows were capped: matches may be missing' : '')
      + (capped ? '; display limit reached' : '')
      + '. One witness per anchor, not exhaustive pair enumeration; no inference of encounters.';
  } catch (error) {
    if (token === proximityRevision)
      $('proximity-status').textContent = 'Cross-run comparison unavailable: ' + error.message;
  } finally {
    if (token === proximityRevision) $('proximity-search').disabled = false;
  }
}

function monitorPositions() {
  return monitorCatalogue.filter(item =>
    Number.isFinite(item.lat) && Number.isFinite(item.lon) &&
    (item.kind !== 'unattributed' || monitorKey(item) === selectedMonitorKey) &&
    (monitorKey(item) === selectedMonitorKey || $('show-inactive').checked ||
     receiptState(item.last).kind === 'recent'));
}

function selectMonitor(item) {
  const key = monitorKey(item);
  if (key === selectedMonitorKey) return;
  selectedMonitorKey = key;
  selectedTrack = item.track_id;
  initialMonitorFit = cameraMode === 'visible' ? 'visible' : 'selected'; // Operator choice.
  updateSelector();
  clearView();
  refreshLive();
}

function updateMonitorMarkers() {
  monitorLayer.clearLayers();
  if (mode !== 'live') return;
  const items = monitorPositions();
  // Identical reported coordinates would hide all but the top marker. Combine
  // only exactly coincident symbols; do not merge source histories or fixes.
  const groups = new Map();
  for (const item of items) {
    const key = `${item.lat},${item.lon}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const group of groups.values()) {
    const chosen = group.some(item => monitorKey(item) === selectedMonitorKey);
    const recent = group.some(item => receiptState(item.last).kind === 'recent');
    const first = group[0];
    const p = [first.lat, first.lon];
    const label = document.createElement('span');
    label.textContent = group.length === 1
      ? `${monitorName(first)} · ${recent ? 'Recent receipt' : 'No verified recent receipt'} · ${localTime(first.last)}`
      : `${group.length} sources at identical reported coordinates · Click to choose`;
    L.circleMarker(p, {radius: group.length > 1 ? 11 : chosen ? 10 : 8,
      weight: chosen ? 3 : 2, color: chosen ? '#132936' : '#edf2f5',
      fillColor: recent ? (chosen ? '#f8b449' : '#68ccae') : '#748391',
      fillOpacity: 0.95, bubblingMouseEvents: false})
      .bindTooltip(label)
      .on('click', () => {
        if (group.length === 1) return selectMonitor(first);
        const choices = document.createElement('div');
        for (const item of group) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = `${monitorName(item)} · ${localTime(item.last)}`;
          button.addEventListener('click', () => { map.closePopup(); selectMonitor(item); });
          choices.appendChild(button);
        }
        L.popup().setLatLng(p).setContent(choices).openOn(map);
      }).addTo(monitorLayer);
  }
  $('monitor-count').textContent = `${items.length} positions shown · receipt status, not connectivity`;
}

function moveCamera(action, force = false) {
  if (mode !== 'live') return;
  const items = monitorPositions();
  let positions;
  if (action === 'selected') {
    const chosen = items.find(item => monitorKey(item) === selectedMonitorKey);
    positions = chosen ? [[chosen.lat, chosen.lon]] : [];
  } else if (action === 'visible') {
    positions = items.map(item => [item.lat, item.lon]);
  } else return;
  if (!positions.length) return;
  const inner = map.getBounds().pad(-0.25);
  if (!force && positions.every(pos => inner.contains(pos))) return;
  cameraMoving = true;
  try {
    if (action === 'selected' || positions.length === 1) {
      map.panTo(positions[0], {animate: false});
    } else {
      // Never zoom in on each update. Framing distant cities can zoom out.
      map.fitBounds(L.latLngBounds(positions), {
        padding: [40, 40], maxZoom: Math.min(map.getZoom(), 16), animate: false
      });
    }
  } finally { cameraMoving = false; }
}

function updateMonitorCamera() {
  if (mode !== 'live') return;
  if (initialMonitorFit) {
    moveCamera(initialMonitorFit, true);
    initialMonitorFit = false;
  } else if (cameraMode !== 'free') moveCamera(cameraMode);
}

function updateRunPageStatus() {
  $('older-runs').hidden = !historyRunCursor || mode !== 'history';
  $('runs-status').textContent = historyRunList.length
    ? `${historyRunList.length}${historyRunCursor ? '+' : ''} runs listed`
    : historyLoaded ? 'No runs for this selection' : 'Loading recordings…';
}

async function loadRunPage(reset = false) {
  if (reset) {
    historyRunGeneration++;
    historyRunCursor = null;
    historyRunList = [];
    historyLoaded = false;
  } else if (!historyRunCursor || historyRunBusy) return;
  const token = historyRunGeneration;
  historyRunBusy = true;
  updateRunPageStatus();
  try {
    const query = new URLSearchParams({limit: '50'});
    if (historyFilter.startsWith('channel:')) query.set('channel_id', historyFilter.slice(8));
    if (historyFilter.startsWith('source:')) query.set('source_id', historyFilter.slice(7));
    if (!reset && historyRunCursor) query.set('before', historyRunCursor);
    const response = await getJSON('/api/runs?' + query);
    if (token !== historyRunGeneration) return;
    historyRunList.push(...response.tracks);
    historyRunCursor = response.next_cursor;
    historyLoaded = true;
    if (mode === 'history') {
      if (!historyTrack && historyRunList.length) {
        historyTrack = historyRunList[0].track_id;
        selectedTrack = historyTrack;
        historyDefaults();
        loadHistory();
      }
      updateSelector();
      renderLayerPanel();
    }
  } catch (error) {
    if (token === historyRunGeneration) {
      historyLoaded = true;
      updateRunPageStatus();
      $('runs-status').textContent = 'Cannot browse runs: ' + error.message;
    }
  } finally {
    if (token === historyRunGeneration) {
      historyRunBusy = false;
      $('older-runs').hidden = !historyRunCursor || mode !== 'history';
    }
  }
}

function showLiveStatus() {
  if (mode !== 'live') return;
  if (!points.length) {
    feedState('unknown', 'No observations');
    status('Monitor · No recorded observations for this run');
    return;
  }
  const latest = points.at(-1);
  const receipt = receiptState(latest.time);
  feedState(receipt.kind, receipt.kind === 'recent' ? 'Recent receipts' :
    receipt.kind === 'stale' ? 'No recent receipts' : 'Receipt time uncertain');
  const summary = receipt.kind === 'recent' ?
    `Received ${receipt.label}; connection not verified` :
    receipt.kind === 'stale' ? `Last received ${receipt.label}; position is not current` :
    'Receipt time uncertain; position is not confirmed current';
  status(`Monitor · ${points.length} stored observations · ${summary} · ${localTime(latest.time)}`
    + (positioningJumps.length ? ` · ${positioningJumps.length} possible positioning jump${positioningJumps.length === 1 ? '' : 's'}` : ''));
}

function clearView() {
  revision++;
  points = [];
  recordingGaps = [];
  positioningJumps = [];
  cursor = null;
  lastSignature = '';
  layer.clearLayers();
  overlayGeneration++;
  for (const layer of overlayLayers.values()) {layer.clearLayers(); map.removeLayer(layer);}
  overlayLayers.clear();
  overlayPoints.clear();
  timeLayer.clearLayers();
  placeLayer.clearLayers();
  if (mode !== 'live') monitorLayer.clearLayers();
  placeSelection = null;
  resetDatabasePlaceSearch();
  resetRunProximity();
  $('place-results').replaceChildren();
  $('place-status').textContent = 'Click a location on the map to inspect loaded observations.';
  $('time-panel').hidden = true;
  $('compare-status').textContent = '';
  $('inspect').hidden = true;
  $('more').hidden = true;
  $('page-status').textContent = '';
  $('gap-status').textContent = '';
  feedState(mode === 'live' ? 'unknown' : 'history', mode === 'live' ? 'Checking receipts' : 'History');
  status(selectedTrack ? 'Loading observations…' : 'Waiting for observations');
}

function fixDetails(p) {
  // Producer metadata is reported, not verified. Do not substitute receipt time.
  return (p.measured_time ? `Reported fix time ${localTime(p.measured_time)}`
    : 'Fix acquisition time unknown')
    + (p.provider ? ` · Reported provider ${p.provider}` : '')
    + (p.accuracy_m !== undefined ? ` · Reported accuracy ${p.accuracy_m} m`
      : ' · Accuracy unknown');
}

function pointText(p, index, track = selectedTrack, count = points.length) {
  // Use a text node: producer-controlled track IDs must never become HTML.
  const label = document.createElement('span');
  label.textContent = `${track} · ${index + 1}/${count} · Received ${localTime(p.time)} · `
    + `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)} · ${fixDetails(p)}`;
  return label;
}

function inspectPoint(index) {
  if (mode === 'history') {
    lastIndex = index;
    $('position').value = String(index);
    showInspection();
  } else {
    const p = points[index];
    L.popup().setLatLng([p.lat, p.lon]).setContent(pointText(p, index)).openOn(map);
  }
}

function nearestIndex(event, indices, observations) {
  // A polyline is clickable even where visual nodes were thinned out.
  // Compare positions in screen pixels rather than geographical degrees.
  const cursor = map.latLngToLayerPoint(event.latlng);
  let nearest = indices[0], distance = Infinity;
  for (const index of indices) {
    const p = observations[index];
    const q = map.latLngToLayerPoint([p.lat, p.lon]);
    const square = (q.x - cursor.x) ** 2 + (q.y - cursor.y) ** 2;
    if (square < distance) { nearest = index; distance = square; }
  }
  return nearest;
}

function gapDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return [hours && `${hours}h`, minutes && `${minutes}m`, (rest || (!hours && !minutes)) && `${rest}s`]
    .filter(Boolean).join(' ');
}

function routeParts(observations) {
  const gaps = [];
  const jumps = [];
  const segments = [];
  const ends = new Set([0, observations.length - 1]);
  let current = [], previous = null;
  for (let index = 0; index < observations.length; index++) {
    const p = observations[index];
    if (previous) {
      const elapsed = Date.parse(p.time) - Date.parse(previous.time);
      if (elapsed > GAP_MS) {
        gaps.push({before: index - 1, after: index, duration: elapsed});
      } else if (elapsed >= 0) {
        const meters = distanceMeters(previous, p);
        if (meters >= JUMP_MIN_M &&
            (elapsed === 0 || meters / (elapsed / 1000) >= JUMP_MIN_MPS))
          jumps.push({before: index - 1, after: index, meters, elapsed});
      }
      const isGap = gaps.at(-1)?.after === index;
      if (isGap || jumps.at(-1)?.after === index) {
        segments.push(current);
        if (isGap) {
          ends.add(index - 1);
          ends.add(index);
        }
        current = [];
      }
    }
    current.push(index);
    previous = p;
  }
  if (current.length) segments.push(current);
  return {segments: segments.filter(segment => segment.length > 1), ends, gaps, jumps};
}

function fitObservations(observations) {
  if (!observations.length) return;
  const bounds = L.latLngBounds(observations.map(p => [p.lat, p.lon]));
  if (observations.length === 1) map.setView(bounds.getCenter(), 15);
  else map.fitBounds(bounds, {padding: [25, 25], maxZoom: 16});
}

function render(fit = false) {
  const freshness = mode === 'live' && points.length ? receiptState(points.at(-1).time) : null;
  const signature = (freshness?.kind || '') + ':' + points.length + ':' + (points[0]?.id ?? points[0]?.time ?? '')
    + ':' + JSON.stringify(points.at(-1) || '');
  if (signature === lastSignature && !fit) { showLiveStatus(); return; }
  lastSignature = signature;
  layer.clearLayers();
  inspectedMarker = null;
  if (!points.length) {
    $('inspect').hidden = true;
    if (mode === 'live') showLiveStatus();
    else status('No observations in this interval');
    return;
  }
  const {segments: routeSegments, ends, gaps, jumps} = routeParts(points);
  recordingGaps = gaps;
  positioningJumps = jumps;
  const warnings = [];
  if (gaps.length)
    warnings.push(`${gaps.length} recording gap${gaps.length === 1 ? '' : 's'} over 10 minutes (movement unknown)`);
  if (jumps.length)
    warnings.push(`${jumps.length} possible positioning jump${jumps.length === 1 ? '' : 's'} (movement unverified)`);
  $('gap-status').textContent = warnings.join(' · ');
  const stale = mode === 'live' && freshness?.kind !== 'recent';
  for (const segment of routeSegments) {
    L.polyline(segment.map(index => [points[index].lat, points[index].lon]), {
      color: stale ? '#748391' : '#57b9ef', weight: 3
    }).on('click', event => inspectPoint(nearestIndex(event, segment, points))).addTo(layer);
  }

  // Draw sparse, clickable observation nodes. Always retain segment ends,
  // including both sides of a recording gap. Clicking the line finds any
  // intermediate observation, even when no visible node was drawn for it.
  const stride = Math.max(1, Math.ceil(points.length / MAX_NODES));
  for (let index = 0; index < points.length; index++) {
    if (index % stride !== 0 && !ends.has(index)) continue;
    const p = points[index];
    const first = index === 0, last = index === points.length - 1;
    L.circleMarker([p.lat, p.lon], {
      radius: first ? 5 : last ? 6 : 3,
      weight: 1, color: '#edf2f5',
      fillColor: stale ? '#748391' : first ? '#39b86f' : last ? '#f8b449' : '#57b9ef',
      fillOpacity: 0.9, bubblingMouseEvents: false
    }).bindTooltip(pointText(p, index))
      .on('click', () => inspectPoint(index)).addTo(layer);
  }

  // Explicitly mark *both* observed endpoints. The missing interval is time,
  // not an inferred straight-line journey between the recorded fixes.
  for (const gap of gaps) {
    for (const [index, side] of [[gap.before, 'Last fix before'], [gap.after, 'First fix after']]) {
      const p = points[index];
      const label = document.createElement('span');
      label.textContent = `${side} ${gapDuration(gap.duration)} without observations · `
        + `${localTime(p.time)} · Movement unknown`;
      L.circleMarker([p.lat, p.lon], {
        radius: 8, weight: 3, color: '#14212b', fillColor: '#f2d6ff',
        fillOpacity: 0.95, bubblingMouseEvents: false
      }).bindTooltip(label).on('click', () => inspectPoint(index)).addTo(layer);
    }
  }

  // A receipt-time discontinuity is not a proven movement or a proven bad fix.
  // Keep both original measurements; do not connect them with a route line.
  // Keep highlighted endpoints bounded, even if every incoming fix jumps.
  const jumpStride = Math.max(1, Math.ceil(jumps.length / MAX_NODES));
  for (let i = 0; i < jumps.length; i += jumpStride) {
    const jump = jumps[i];
    for (const [index, side] of [[jump.before, 'Before'], [jump.after, 'After']]) {
      const p = points[index];
      const label = document.createElement('span');
      label.textContent = `${side} possible positioning jump: ${Math.round(jump.meters)} m in `
        + `${(jump.elapsed / 1000).toFixed(1)}s between receipts · Movement unverified`;
      L.circleMarker([p.lat, p.lon], {
        radius: 8, weight: 3, color: '#14212b', fillColor: '#ffc56b',
        fillOpacity: 0.95, bubblingMouseEvents: false
      }).bindTooltip(label).on('click', () => inspectPoint(index)).addTo(layer);
    }
  }

  if (mode === 'history') {
    $('inspect').hidden = false;
    $('position').max = String(points.length - 1);
    lastIndex = Math.min(lastIndex, points.length - 1);
    $('position').value = String(lastIndex);
    showInspection();
    feedState('history', 'Historical interval');
    status(`History · ${points.length} observation${points.length === 1 ? '' : 's'} · ${routeSegments.length} route segment${routeSegments.length === 1 ? '' : 's'}`);
    updateTimeCursor();
    updatePlaceInspector();
  } else {
    $('inspect').hidden = true;
    timeLayer.clearLayers();
    $('time-panel').hidden = true;
    showLiveStatus();
  }
  if (mode === 'history' && fit) fitObservations(points);
  if (mode === 'live') {
    updateMonitorMarkers();
    updateMonitorCamera();
  }
}

let inspectedMarker = null;
function showInspection() {
  if (inspectedMarker) {layer.removeLayer(inspectedMarker); inspectedMarker = null;}
  if (mode !== 'history' || !points.length) return;
  lastIndex = Number($('position').value);
  const p = points[lastIndex];
  const adjacent = recordingGaps.find(g => g.before === lastIndex || g.after === lastIndex);
  const jump = positioningJumps.find(j => j.before === lastIndex || j.after === lastIndex);
  const note = adjacent ? ` · ${adjacent.before === lastIndex ? 'Gap after' : 'Gap before'}: `
    + `${gapDuration(adjacent.duration)} without observations; movement unknown` : '';
  const jumpNote = jump ? ` · Possible positioning jump: ${Math.round(jump.meters)} m `
    + `in ${(jump.elapsed / 1000).toFixed(1)}s between receipts; movement unverified` : '';
  $('detail').textContent = `${lastIndex + 1}/${points.length} · Received ${localTime(p.time)} · `
    + `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)} · ${fixDetails(p)}${note}${jumpNote}`;
  inspectedMarker = L.circleMarker([p.lat, p.lon], {
    radius: 8, weight: 2, color: '#edf2f5', fillColor: '#dc6adc', fillOpacity: 1
  }).addTo(layer);
}

function historyDefaults() {
  const track = trackInfo();
  if (!track) return;
  $('from').value = localInput(new Date(Date.parse(track.first) - 1000));
  $('to').value = localInput(new Date(Date.parse(track.last) + 1000));
}
function setMode(next) {
  if (mode === next) return;
  mode = next;
  $('live').setAttribute('aria-pressed', String(mode === 'live'));
  $('history').setAttribute('aria-pressed', String(mode === 'history'));
  $('history-controls').hidden = mode !== 'history';
  $('monitor-controls').hidden = mode !== 'live';
  if (mode !== 'history') {
    $('layers-panel').hidden = true;
    $('place-panel').hidden = true;
    $('proximity-panel').hidden = true;
    proximityLayer.clearLayers();
    $('proximity-toggle').setAttribute('aria-expanded', 'false');
    $('layers-toggle').setAttribute('aria-expanded', 'false');
    $('place-toggle').setAttribute('aria-expanded', 'false');
  }
  if (mode === 'history') {
    selectedTrack = historyTrack || selectedTrack || catalogue[0]?.track_id || '';
    historyTrack = selectedTrack;
  } else {
    selectedTrack = monitorCatalogue.find(item => monitorKey(item) === selectedMonitorKey)?.track_id || '';
  }
  updateSelector();
  clearView();
  if (mode === 'history') {
    historyDefaults();
    loadHistory();
    loadRunPage(true);
    updateRunPageStatus();
  } else {
    initialMonitorFit = cameraMode === 'free' ? 'visible' : cameraMode;
    updateMonitorMarkers();
    refreshLive();
  }
  // The visible area changes as controls appear; Leaflet needs its size updated.
  requestAnimationFrame(() => map.invalidateSize());
}

async function refreshTracks() {
  if (tracksBusy) return;
  tracksBusy = true;
  try {
    const [runs, monitored, sources] = await Promise.all([
      getJSON('/api/tracks'), getJSON('/api/monitor'), getJSON('/api/sources')
    ]);
    catalogue = runs.tracks;
    monitorCatalogue = monitored.entries;
    sourceCatalogue = sources.sources;
    updateHistoryFilter();
    const previous = selectedTrack;
    if (!historyTrack && catalogue.length) historyTrack = catalogue[0].track_id;
    if (mode === 'live') {
      if (!monitorCatalogue.some(item => monitorKey(item) === selectedMonitorKey))
        selectedMonitorKey = monitorCatalogue.length ? monitorKey(monitorCatalogue[0]) : '';
      selectedTrack = monitorCatalogue.find(item => monitorKey(item) === selectedMonitorKey)?.track_id || '';
    } else {
      selectedTrack = historyTrack;
    }
    updateSelector();
    updateMonitorMarkers();
    if (mode === 'live' && points.length) updateMonitorCamera();
    visibleOverlays.delete(selectedTrack);
    renderLayerPanel();
    if (selectedTrack !== previous) {
      clearView();
      if (mode === 'history') {historyDefaults(); loadHistory();}
      else refreshLive();
    } else if (!selectedTrack) status('Waiting for observations');
    if (mode === 'history') updateRunPageStatus();
  } catch (error) { status('Observation catalogue unavailable: ' + error.message); }
  finally { tracksBusy = false; }
}

async function refreshLive() {
  if (!selectedTrack || mode !== 'live' || liveBusy) return;
  liveBusy = true;
  const token = revision;
  try {
    const result = await getJSON('/api/points/recent?track_id=' + encodeURIComponent(selectedTrack));
    if (token !== revision || mode !== 'live') return;
    const firstLoad = !points.length;
    points = result.points;
    render(firstLoad);
  } catch (error) {
    if (token === revision) status('Recent observations unavailable: ' + error.message);
  } finally { liveBusy = false; }
}

let bounds = null;
async function loadHistory(more = false) {
  if (!selectedTrack || mode !== 'history') return;
  if (!more) {
    clearView();
    const from = $('from').value, to = $('to').value;
    if (!from || !to || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) ||
        Date.parse(from) >= Date.parse(to)) {
      status('Choose a valid interval: From must precede To');
      return;
    }
    bounds = {from: new Date(from).toISOString(), to: new Date(to).toISOString()};
    lastIndex = 0;
  }
  const token = revision;
  const url = new URLSearchParams({track_id: selectedTrack, from: bounds.from,
    to: bounds.to, limit: String(PAGE_SIZE)});
  if (more && cursor) url.set('cursor', cursor);
  $('more').disabled = true;
  try {
    const result = await getJSON('/api/points?' + url);
    if (token !== revision || mode !== 'history') return;
    const firstPage = !more;
    points = more ? points.concat(result.points) : result.points;
    cursor = result.next_cursor;
    render(firstPage);
    if (firstPage) loadOverlays(); // Refit both/all routes after the focused run renders.
    const capped = points.length >= MAX_DISPLAY && cursor;
    $('more').hidden = !cursor || Boolean(capped);
    $('page-status').textContent = capped
      ? `First ${points.length} shown; narrow the interval for the rest.`
      : cursor ? `${points.length} shown · more observations available`
        : `${points.length} shown · interval complete`;
  } catch (error) {
    if (token === revision) status('Historical query failed: ' + error.message);
  } finally { $('more').disabled = false; }
}

function updateTimeCursor() {
  timeLayer.clearLayers();
  const panel = $('time-panel');
  if (mode !== 'history' || !points.length) {panel.hidden = true; return;}
  panel.hidden = false;
  const runs = [{name: selectedTrack, fixes: points, color: '#57b9ef'}];
  for (const [i, track] of [...visibleOverlays].entries()) {
    if (overlayPoints.has(track)) {
      runs.push({name: track, fixes: overlayPoints.get(track), color: OVERLAY_COLORS[i]});
    }
  }
  const times = runs.flatMap(run => run.fixes.map(p => Date.parse(p.time)));
  const first = Math.min(...times), last = Math.max(...times);
  const fraction = Number($('time-cursor').value || 0) / 1000;
  const instant = first + Math.round((last - first) * fraction);
  $('time-value').textContent = localTime(instant)
    + ' · fixes older than 5 minutes are not shown as positions';
  const result = $('time-results');
  result.replaceChildren();
  for (const run of runs) {
    // Pages are in timestamp order; no interpolation, no claim of continuous presence.
    let observed = null;
    for (const p of run.fixes) {
      if (Date.parse(p.time) > instant) break;
      observed = p;
    }
    const age = observed ? instant - Date.parse(observed.time) : Infinity;
    const recent = observed && age <= NEARBY_FIX_MS;
    const item = document.createElement('span');
    item.className = 'time-result';
    item.textContent = `${run.name}: ${recent ? localTime(observed.time) : 'no recent fix'}`;
    result.appendChild(item);
    if (recent) {
      L.circleMarker([observed.lat, observed.lon], {
        radius: 9, weight: 3, color: '#101820', fillColor: run.color,
        fillOpacity: 1, bubblingMouseEvents: false
      }).bindTooltip(pointText(observed, run.fixes.indexOf(observed), run.name, run.fixes.length))
        .addTo(timeLayer);
    }
  }
}

function distanceMeters(a, b) {
  const radians = Math.PI / 180;
  const aLat = a.lat * radians, bLat = b.lat * radians;
  const deltaLat = (b.lat - a.lat) * radians;
  const deltaLon = (b.lon - a.lon) * radians;
  const h = Math.sin(deltaLat / 2) ** 2 + Math.cos(aLat) * Math.cos(bLat)
    * Math.sin(deltaLon / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function resetDatabasePlaceSearch() {
  // Invalidate pending results whenever the chosen location or view changes.
  placeSearchRevision++;
  placeSearchCursor = null;
  placeSearchCount = 0;
  placeSearchMatches = [];
  $('place-db-results').replaceChildren();
  $('place-clusters').replaceChildren();
  $('place-cluster-status').textContent = 'Matching-fix groups appear after searching.';
  $('place-proximity-results').replaceChildren();
  $('place-proximity-status').textContent = 'Search recorded history to compare receipt times.';
  $('place-next').hidden = true;
  $('place-search').disabled = !placeSelection || mode !== 'history';
  $('place-db-status').textContent = placeSelection
    ? 'Search recorded history to examine all runs, not just loaded points.'
    : 'Select a place to search across all recorded runs.';
}

function groupedMatchingFixes(fixes) {
  // Group only retrieved *matching* fixes, by run and receipt-time proximity.
  // An unobserved departure can occur between any two of these reports.
  const valid = fixes.filter(p => Number.isFinite(Date.parse(p.time)));
  valid.sort((a, b) => a.track_id < b.track_id ? -1 : a.track_id > b.track_id ? 1
    : Date.parse(a.time) - Date.parse(b.time) || a.id - b.id);
  const groups = [];
  for (const p of valid) {
    const time = Date.parse(p.time);
    let group = groups.at(-1);
    if (!group || group.track_id !== p.track_id || time - group.last > PLACE_GROUP_GAP_MS) {
      group = {track_id: p.track_id, name: p.channel_label || p.source_label ||
        p.channel_id || p.source_id || 'Unattributed', first: time, last: time, count: 0};
      groups.push(group);
    }
    group.last = time;
    group.count++;
  }
  return groups.sort((a, b) => b.last - a.last);
}

function renderPlaceGroups() {
  const groups = groupedMatchingFixes(placeSearchMatches);
  const list = $('place-clusters');
  list.replaceChildren();
  for (const group of groups.slice(0, MAX_PLACE_GROUPS)) {
    const li = document.createElement('li');
    li.textContent = `${group.name} · run ${group.track_id} · ${group.count} matching fix${group.count === 1 ? '' : 'es'} · `
      + `${localTime(group.first)}${group.last !== group.first ? ' – ' + localTime(group.last) : ''}`;
    list.appendChild(li);
  }
  $('place-cluster-status').textContent = `${groups.length} matching-fix group${groups.length === 1 ? '' : 's'} in retrieved results`
    + (groups.length > MAX_PLACE_GROUPS ? `; showing ${MAX_PLACE_GROUPS}` : '')
    + (placeSearchCursor ? ' (more historical candidates remain)' : '')
    + '. Groups use a 5-minute maximum gap between matching receipts in the same run;'
    + ' they are not visits or evidence of continuous presence.';
}

function proximityIdentity(a, b) {
  // Enrollment claims are stronger than channel claims, but neither proves a
  // device or person. Two channels of the SAME enrolled source are not two
  // independently identified sources. A common channel is also not separate.
  if (a.track_id === b.track_id) return null;
  if (a.source_id && b.source_id && a.source_id === b.source_id) return null;
  if (a.channel_id && b.channel_id && a.channel_id === b.channel_id) return null;
  if (a.source_id && b.source_id) {
    return {kind: 'source',
      left: a.source_label ? `${a.source_label} [${a.source_id}]` : a.source_id,
      right: b.source_label ? `${b.source_label} [${b.source_id}]` : b.source_id};
  }
  if (a.channel_id && b.channel_id) {
    return {kind: 'channel',
      left: a.channel_label ? `${a.channel_label} [${a.channel_id}]` : a.channel_id,
      right: b.channel_label ? `${b.channel_label} [${b.channel_id}]` : b.channel_id};
  }
  // Run IDs, provider names and coincident positions do not establish
  // independent acquisition identities.
  return null;
}

function mixedSourceChannels(fixes) {
  // A channel carrying incompatible enrolled-source claims is ambiguous.
  // Do not use it to support a cross-source candidate on these loaded pages.
  const claims = new Map();
  for (const p of fixes) if (p.channel_id && p.source_id) {
    if (!claims.has(p.channel_id)) claims.set(p.channel_id, new Set());
    claims.get(p.channel_id).add(p.source_id);
  }
  return new Set([...claims].filter(([, sources]) => sources.size > 1)
    .map(([channel]) => channel));
}

function temporalProximityWitnesses(fixes, windowMs) {
  // Every witness is exactly two retrieved observations from different runs.
  // Sort by *receiver receipt time*, not arrival order or claimed GPS time.
  const conflicts = mixedSourceChannels(fixes);
  const ordered = fixes.filter(p => !conflicts.has(p.channel_id))
    .map(p => ({p, ms: Date.parse(p.time)}))
    .filter(entry => Number.isFinite(entry.ms))
    .sort((a, b) => a.ms - b.ms || a.p.id - b.p.id);
  const witnesses = [];
  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    for (let j = i + 1; j < ordered.length; j++) {
      const b = ordered[j];
      const difference = b.ms - a.ms;
      if (difference > windowMs) break;
      const identity = proximityIdentity(a.p, b.p);
      if (!identity) continue;
      witnesses.push({a: a.p, b: b.p, difference, identity,
        separation: distanceMeters(a.p, b.p)});
    }
  }
  // Show the tightest receipt-time matches first. Repeated reports may
  // multiply pairs; the count is comparisons, not distinct encounters.
  witnesses.sort((a, b) => a.difference - b.difference
    || Math.max(Date.parse(b.a.time), Date.parse(b.b.time))
       - Math.max(Date.parse(a.a.time), Date.parse(a.b.time))
    || a.a.id - b.a.id || a.b.id - b.b.id);
  return witnesses;
}

function renderPlaceProximity() {
  const list = $('place-proximity-results');
  list.replaceChildren();
  if (!placeSearchCount) {
    $('place-proximity-status').textContent = 'No retrieved matching fixes to compare.';
    return;
  }
  const windowMinutes = Number($('place-proximity-window').value || 5);
  const conflicts = mixedSourceChannels(placeSearchMatches);
  const matches = temporalProximityWitnesses(placeSearchMatches, windowMinutes * 60_000);
  for (const match of matches.slice(0, MAX_PLACE_WITNESSES)) {
    const li = document.createElement('li');
    const kind = match.identity.kind === 'source'
      ? 'Different enrolled source claims' : 'Different channel claims only';
    const seconds = Math.round(match.difference / 1000);
    li.textContent = `${kind}: ${match.identity.left} (${match.a.track_id} / fix ${match.a.id})`
      + ` and ${match.identity.right} (${match.b.track_id} / fix ${match.b.id})`
      + ` · receipts ${localTime(match.a.time)} / ${localTime(match.b.time)}`
      + ` · Δt ${seconds}s · reported positions ${Math.round(match.separation)} m apart`
      + ` · reported accuracy ${match.a.accuracy_m ?? 'unknown'} m / ${match.b.accuracy_m ?? 'unknown'} m`;
    list.appendChild(li);
  }
  const incomplete = Boolean(placeSearchCursor) || placeSearchCount >= MAX_PLACE_DISPLAY;
  $('place-proximity-status').textContent = `${matches.length} qualifying observation pair${matches.length === 1 ? '' : 's'}`
    + ` within ${windowMinutes} minute${windowMinutes === 1 ? '' : 's'} of RECEIPT time`
    + ` (showing ${Math.min(matches.length, MAX_PLACE_WITNESSES)} closest pairs)`
    + (incomplete ? '; incomplete retrieved coverage, more history may remain' : '; retrieved search complete at query time')
    + (conflicts.size ? `; excluded ${conflicts.size} channel${conflicts.size === 1 ? '' : 's'} with mixed source claims` : '')
    + '. Pairs are not meetings, co-presence, independent fixes, or continuous presence.';
}

function placeReceiptFilter(id, name) {
  const value = $(id).value;
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${name} time`);
  return date.toISOString(); // datetime-local is operator-local; API is UTC.
}

async function searchRecordedPlace(more = false) {
  if (!placeSelection || mode !== 'history' || $('place-panel').hidden) return;
  if (more && !placeSearchCursor) return;
  const request = ++placeSearchRevision;
  const query = new URLSearchParams({
    lat: String(placeSelection.lat), lon: String(placeSelection.lon),
    radius_m: $('place-radius').value, limit: '50'
  });
  try {
    const from = placeReceiptFilter('place-from', 'From');
    const to = placeReceiptFilter('place-to', 'To');
    if (from && to && from >= to) throw new Error('From must precede To');
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    const scope = $('place-scope').value;
    if (scope.startsWith('channel:')) query.set('channel_id', scope.slice(8));
    if (scope.startsWith('source:')) query.set('source_id', scope.slice(7));
  } catch (error) {
    $('place-db-status').textContent = 'Invalid place search filter: ' + error.message;
    return;
  }
  if (more) query.set('before', placeSearchCursor);
  else {
    placeSearchCursor = null;
    placeSearchCount = 0;
    placeSearchMatches = [];
    $('place-db-results').replaceChildren();
    $('place-clusters').replaceChildren();
    $('place-proximity-results').replaceChildren();
    $('place-proximity-status').textContent = 'Searching recorded observations…';
  }
  $('place-search').disabled = true;
  $('place-next').hidden = true;
  $('place-db-status').textContent = 'Searching recorded observations…';
  try {
    const page = await getJSON('/api/place/observations?' + query);
    if (request !== placeSearchRevision) return;
    for (const p of page.points) {
      const item = document.createElement('li');
      const name = p.channel_label || p.source_label || p.channel_id || p.source_id || 'Unattributed';
      item.textContent = `${localTime(p.time)} · ${name} · run ${p.track_id} · `
        + `${p.distance_m} m · ${fixDetails(p)}`;
      $('place-db-results').appendChild(item);
      placeSearchMatches.push(p);
      placeSearchCount++;
    }
    placeSearchCursor = page.next_cursor;
    renderPlaceGroups();
    renderPlaceProximity();
    const moreAvailable = Boolean(page.next_cursor);
    const capped = placeSearchCount >= MAX_PLACE_DISPLAY;
    $('place-next').hidden = !moreAvailable || capped;
    $('place-db-status').textContent = `${placeSearchCount} matching recorded fixes shown, newest ingested first. `
      + (capped ? 'Display limit reached; no claim of complete coverage.'
        : moreAvailable ? 'Older candidates remain; this is not a complete search.'
        : 'Search complete for the selected place at this point in time.')
      + ' Proximity is not proof of continuous presence.';
  } catch (error) {
    if (request === placeSearchRevision)
      $('place-db-status').textContent = 'Recorded history search failed: ' + error.message;
  } finally {
    if (request === placeSearchRevision)
      $('place-search').disabled = false;
  }
}

function updatePlaceInspector() {
  placeLayer.clearLayers();
  if (!placeSelection || mode !== 'history') return;
  const radius = Number($('place-radius').value);
  L.circle([placeSelection.lat, placeSelection.lon], {
    radius, color: '#f2d6ff', fillColor: '#8724d5', fillOpacity: 0.12, weight: 2
  }).addTo(placeLayer);
  const found = [];
  const runs = [{track: selectedTrack, fixes: points},
    ...[...overlayPoints].map(([track, fixes]) => ({track, fixes}))];
  for (const run of runs) for (const p of run.fixes) {
    const meters = distanceMeters(placeSelection, p);
    if (meters <= radius) found.push({track: run.track, point: p, meters});
  }
  found.sort((a, b) => Date.parse(a.point.time) - Date.parse(b.point.time));
  const results = $('place-results');
  results.replaceChildren();
  $('place-status').textContent = `${found.length} loaded fix${found.length === 1 ? '' : 'es'} within ${radius} m `
    + '(not a complete database search; gaps and unloaded pages are excluded)';
  for (const entry of found.slice(0, 40)) {
    const item = document.createElement('li');
    item.textContent = `${localTime(entry.point.time)} · ${entry.track} · ${Math.round(entry.meters)} m`;
    results.appendChild(item);
  }
  if (found.length > 40) {
    const item = document.createElement('li');
    item.textContent = `First 40 of ${found.length} fixes shown; narrow the selection.`;
    results.appendChild(item);
  }
}

function renderLayerPanel() {
  const panel = $('layers-list');
  panel.replaceChildren();
  const choices = mode === 'history' && historyLoaded ? historyRunList : catalogue;
  for (const record of choices) {
    const track = record.track_id;
    const row = document.createElement('label');
    row.className = 'track-layer';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = track === selectedTrack || visibleOverlays.has(track);
    input.disabled = track === selectedTrack;
    input.addEventListener('change', () => {
      if (input.checked && visibleOverlays.size >= MAX_OVERLAYS) {
        input.checked = false;
        $('compare-status').textContent = `Up to ${MAX_OVERLAYS + 1} runs at once; hide another first.`;
        return;
      }
      if (input.checked) visibleOverlays.add(track);
      else visibleOverlays.delete(track);
      renderLayerPanel();
      loadOverlays();
    });
    row.appendChild(input);
    const label = document.createElement('span');
    label.textContent = (track === selectedTrack ? `${track} (focused)` : track)
      + ` · ${record.channel_label || record.source_label || record.channel_id || 'unassigned'}`;
    row.appendChild(label);
    panel.appendChild(row);
  }
  $('layer-count').textContent = `${visibleOverlays.size + (selectedTrack ? 1 : 0)} visible`;
}

function clearOverlayLayers() {
  for (const item of overlayLayers.values()) {item.clearLayers(); map.removeLayer(item);}
  overlayLayers.clear();
  overlayPoints.clear();
}

function renderOverlay(observations, track, color) {
  const group = L.layerGroup().addTo(map);
  overlayLayers.set(track, group);
  if (!observations.length) return;
  const {segments, ends} = routeParts(observations);
  const show = index => {
    const p = observations[index];
    L.popup().setLatLng([p.lat, p.lon])
      .setContent(pointText(p, index, track, observations.length)).openOn(map);
  };
  for (const segment of segments) {
    const coordinates = segment.map(index => [observations[index].lat, observations[index].lon]);
    L.polyline(coordinates, {
      color: OVERLAY_OUTLINE, weight: 7, opacity: 0.9, interactive: false
    }).addTo(group);
    L.polyline(coordinates, {
      color, weight: 4, opacity: 1
    }).on('click', event => show(nearestIndex(event, segment, observations))).addTo(group);
  }
  const stride = Math.max(1, Math.ceil(observations.length / MAX_NODES));
  for (let index = 0; index < observations.length; index++) {
    if (index % stride !== 0 && !ends.has(index)) continue;
    const p = observations[index];
    L.circleMarker([p.lat, p.lon], {
      radius: 4, weight: 2, color: OVERLAY_OUTLINE,
      fillColor: color, fillOpacity: 1, bubblingMouseEvents: false
    }).bindTooltip(pointText(p, index, track, observations.length))
      .on('click', () => show(index)).addTo(group);
  }
}

async function loadOverlays() {
  const generation = ++overlayGeneration;
  const token = revision;
  clearOverlayLayers();
  $('compare-status').textContent = '';
  if (mode !== 'history' || !bounds || !visibleOverlays.size) {updateTimeCursor(); return;}
  const tracks = [...visibleOverlays].filter(t => t !== selectedTrack);
  const scope = $('compare-time').value || 'all';
  $('compare-status').textContent = 'Loading comparison tracks…';
  const fitPoints = [...points];
  const notes = [];
  try {
    for (const [i, track] of tracks.entries()) {
      const observations = [];
      let next = null;
      do {
        const query = new URLSearchParams({track_id: track, limit: String(PAGE_SIZE)});
        if (scope === 'interval') {
          query.set('from', bounds.from);
          query.set('to', bounds.to);
        }
        if (next) query.set('cursor', next);
        const result = await getJSON('/api/points?' + query);
        if (generation !== overlayGeneration || token !== revision || mode !== 'history') return;
        observations.push(...result.points);
        next = result.next_cursor;
      } while (next && observations.length < MAX_DISPLAY);
      overlayPoints.set(track, observations);
      renderOverlay(observations, track, OVERLAY_COLORS[i]);
      fitPoints.push(...observations);
      notes.push(`${track}: ${observations.length}${next ? '+ (partial)' : ''}`);
    }
    if (generation !== overlayGeneration || token !== revision) return;
    if (fitPoints.length) fitObservations(fitPoints);
    $('compare-status').textContent = notes.join(' · ')
      + (scope === 'interval' && tracks.every(t => !overlayPoints.get(t)?.length)
        ? ' · No comparison fixes in this interval; try Entire run.' : '');
    updateTimeCursor();
    updatePlaceInspector();
  } catch (error) {
    if (generation === overlayGeneration && token === revision)
      $('compare-status').textContent = 'Comparison unavailable: ' + error.message;
  }
}

$('camera').addEventListener('change', () => {
  cameraMode = $('camera').value;
  initialMonitorFit = false;
  if (cameraMode !== 'free') moveCamera(cameraMode, true);
});
$('fit-visible').addEventListener('click', () => {
  initialMonitorFit = false;
  moveCamera('visible', true);
});
$('show-inactive').addEventListener('change', () => {
  updateMonitorMarkers();
  updateMonitorCamera();
});
function releaseCamera() {
  if (mode === 'live' && !cameraMoving) {
    cameraMode = 'free';
    initialMonitorFit = false;
    $('camera').value = 'free';
  }
}
map.on('dragstart', releaseCamera);
map.on('zoomstart', releaseCamera);
$('history-filter').addEventListener('change', () => {
  historyFilter = $('history-filter').value;
  historyTrack = '';
  selectedTrack = '';
  visibleOverlays.clear();
  clearView();
  loadRunPage(true);
});
$('older-runs').addEventListener('click', () => loadRunPage(false));
$('track').addEventListener('change', () => {
  if (mode === 'live') {
    selectedMonitorKey = $('track').value;
    selectedTrack = monitorCatalogue.find(item => monitorKey(item) === selectedMonitorKey)?.track_id || '';
    initialMonitorFit = cameraMode === 'visible' ? 'visible' : 'selected';
  } else {
    historyTrack = $('track').value;
    selectedTrack = historyTrack;
  }
  visibleOverlays.delete(selectedTrack);
  renderLayerPanel();
  clearView();
  if (mode === 'history') {historyDefaults(); loadHistory();}
  else refreshLive();
});
$('layers-toggle').addEventListener('click', () => {
  $('layers-panel').hidden = !$('layers-panel').hidden;
  $('layers-toggle').setAttribute('aria-expanded', String(!$('layers-panel').hidden));
});
$('compare-time').addEventListener('change', () => loadOverlays());
$('live').addEventListener('click', () => setMode('live'));
$('history').addEventListener('click', () => setMode('history'));
$('apply').addEventListener('click', () => loadHistory());
$('more').addEventListener('click', () => {if (cursor && points.length < MAX_DISPLAY) loadHistory(true);});
$('position').addEventListener('input', showInspection);
$('time-cursor').addEventListener('input', updateTimeCursor);
$('place-toggle').addEventListener('click', () => {
  $('place-panel').hidden = !$('place-panel').hidden;
  $('place-toggle').setAttribute('aria-expanded', String(!$('place-panel').hidden));
  if ($('place-panel').hidden) {placeSelection = null; placeLayer.clearLayers(); resetDatabasePlaceSearch();}
});
$('place-radius').addEventListener('change', () => {resetDatabasePlaceSearch(); updatePlaceInspector();});
for (const id of ['place-scope', 'place-from', 'place-to'])
  $(id).addEventListener('change', resetDatabasePlaceSearch);
$('place-search').addEventListener('click', () => searchRecordedPlace());
$('place-next').addEventListener('click', () => searchRecordedPlace(true));
$('place-proximity-window').addEventListener('change', renderPlaceProximity);
$('proximity-toggle').addEventListener('click', () => {
  $('proximity-panel').hidden = !$('proximity-panel').hidden;
  $('proximity-toggle').setAttribute('aria-expanded', String(!$('proximity-panel').hidden));
  updateProximityChoices();
  if ($('proximity-panel').hidden) resetRunProximity();
});
$('proximity-other').addEventListener('change', resetRunProximity);
$('proximity-other').addEventListener('input', resetRunProximity);
for (const id of ['proximity-radius', 'proximity-window', 'proximity-interval', 'from', 'to'])
  $(id).addEventListener('change', resetRunProximity);
$('proximity-search').addEventListener('click', () => searchRunProximity());
$('proximity-next').addEventListener('click', () => searchRunProximity(true));
map.on('click', event => {
  if (mode !== 'history' || $('place-panel').hidden) return;
  placeSelection = {lat: event.latlng.lat, lon: event.latlng.lng};
  resetDatabasePlaceSearch();
  updatePlaceInspector();
});
refreshTracks();
setInterval(() => {
  ticks++;
  if (ticks % 3 === 0) refreshTracks();
  if (mode === 'live') refreshLive();
}, 2000);
