/* Cartochron browser: one selected track, either live or a fixed time interval.
 * Historical pages are intentionally bounded; a partial track is never
 * presented as though the entire interval had been loaded.
 */
'use strict';

const $ = id => document.getElementById(id);
const GAP_MS = 10 * 60 * 1000; // Don't invent a route across a recording gap.
const PAGE_SIZE = 1000;
const MAX_DISPLAY = 5000;
const MAX_NODES = 140; // Keep long routes inspectable without thousands of DOM/map layers.
const OVERLAY_COLOR = '#8724d5'; // Violet stays distinct from OSM's amber roads.
const OVERLAY_OUTLINE = '#162735'; // Dark casing works over light and busy tiles.
const map = L.map('map').setView([0, 0], 2);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin',
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);
const layer = L.layerGroup().addTo(map);
const compareLayer = L.layerGroup().addTo(map);

let catalogue = [];
let selectedTrack = '';
let compareTrack = '';
let compareGeneration = 0;
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
function trackInfo() { return catalogue.find(t => t.track_id === selectedTrack); }

function clearView() {
  revision++;
  points = [];
  recordingGaps = [];
  cursor = null;
  lastSignature = '';
  layer.clearLayers();
  compareGeneration++;
  compareLayer.clearLayers();
  $('compare-status').textContent = '';
  $('inspect').hidden = true;
  $('more').hidden = true;
  $('page-status').textContent = '';
  $('gap-status').textContent = '';
  status(selectedTrack ? 'Loading observations…' : 'Waiting for a recording run');
}

function pointText(p, index, track = selectedTrack, count = points.length) {
  // Use a text node: producer-controlled track IDs must never become HTML.
  const label = document.createElement('span');
  label.textContent = `${track} · ${index + 1}/${count} · ${localTime(p.time)} · `
    + `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`;
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
  const segments = [];
  const ends = new Set([0, observations.length - 1]);
  let current = [], previous = null;
  for (let index = 0; index < observations.length; index++) {
    const p = observations[index];
    if (previous && Date.parse(p.time) - Date.parse(previous.time) > GAP_MS) {
      gaps.push({before: index - 1, after: index, duration: Date.parse(p.time) - Date.parse(previous.time)});
      segments.push(current);
      ends.add(index - 1);
      ends.add(index);
      current = [];
    }
    current.push(index);
    previous = p;
  }
  if (current.length) segments.push(current);
  return {segments: segments.filter(segment => segment.length > 1), ends, gaps};
}

function fitObservations(observations) {
  if (!observations.length) return;
  const bounds = L.latLngBounds(observations.map(p => [p.lat, p.lon]));
  if (observations.length === 1) map.setView(bounds.getCenter(), 15);
  else map.fitBounds(bounds, {padding: [25, 25], maxZoom: 16});
}

function render(fit = false) {
  const signature = points.length + ':' + (points[0]?.id ?? points[0]?.time ?? '')
    + ':' + JSON.stringify(points.at(-1) || '');
  if (signature === lastSignature && !fit) return;
  lastSignature = signature;
  layer.clearLayers();
  inspectedMarker = null;
  if (!points.length) {
    $('inspect').hidden = true;
    status('No observations in this interval');
    return;
  }
  const {segments: routeSegments, ends, gaps} = routeParts(points);
  recordingGaps = gaps;
  $('gap-status').textContent = gaps.length
    ? `${gaps.length} recording gap${gaps.length === 1 ? '' : 's'} over 10 minutes (movement unknown)`
    : '';
  for (const segment of routeSegments) {
    L.polyline(segment.map(index => [points[index].lat, points[index].lon]), {
      color: '#57b9ef', weight: 3
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
      fillColor: first ? '#39b86f' : last ? '#f8b449' : '#57b9ef',
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

  if (mode === 'history') {
    $('inspect').hidden = false;
    $('position').max = String(points.length - 1);
    lastIndex = Math.min(lastIndex, points.length - 1);
    $('position').value = String(lastIndex);
    showInspection();
    status(`${points.length} observation${points.length === 1 ? '' : 's'} · ${routeSegments.length} route segment${routeSegments.length === 1 ? '' : 's'}`);
  } else {
    $('inspect').hidden = true;
    const p = points.at(-1);
    status(`${points.length} recent observations · Last received ${localTime(p.time)}`);
  }
  if (fit) {
    fitObservations(points);
  } else if (mode === 'live') {
    const latest = points.at(-1);
    map.panTo([latest.lat, latest.lon], {animate: false});
  }
}

let inspectedMarker = null;
function showInspection() {
  if (inspectedMarker) {layer.removeLayer(inspectedMarker); inspectedMarker = null;}
  if (mode !== 'history' || !points.length) return;
  lastIndex = Number($('position').value);
  const p = points[lastIndex];
  const adjacent = recordingGaps.find(g => g.before === lastIndex || g.after === lastIndex);
  const note = adjacent ? ` · ${adjacent.before === lastIndex ? 'Gap after' : 'Gap before'}: `
    + `${gapDuration(adjacent.duration)} without observations; movement unknown` : '';
  $('detail').textContent = `${lastIndex + 1}/${points.length} · ${localTime(p.time)} · ${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}${note}`;
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
  clearView();
  if (mode === 'history') {
    historyDefaults();
    loadHistory();
  } else refreshLive();
  // The visible area changes as controls appear; Leaflet needs its size updated.
  requestAnimationFrame(() => map.invalidateSize());
}

async function refreshTracks() {
  if (tracksBusy) return;
  tracksBusy = true;
  try {
    const result = await getJSON('/api/tracks');
    catalogue = result.tracks;
    const previous = selectedTrack;
    if (!selectedTrack && catalogue.length) selectedTrack = catalogue[0].track_id;
    const select = $('track');
    select.replaceChildren();
    if (!catalogue.length) {
      const option = new Option('No recordings', '');
      select.add(option);
      select.disabled = true;
    } else {
      select.disabled = false;
      for (const track of catalogue) select.add(new Option(track.track_id, track.track_id));
      if (selectedTrack && !catalogue.some(t => t.track_id === selectedTrack)) {
        select.add(new Option(selectedTrack + ' (not in recent list)', selectedTrack));
      }
      select.value = selectedTrack;
    }
    const secondary = $('compare');
    secondary.replaceChildren();
    secondary.add(new Option('None', ''));
    for (const track of catalogue) {
      if (track.track_id !== selectedTrack) {
        secondary.add(new Option(track.track_id, track.track_id));
      }
    }
    if (compareTrack === selectedTrack) compareTrack = '';
    if (compareTrack && !catalogue.some(t => t.track_id === compareTrack)) {
      secondary.add(new Option(compareTrack + ' (not in recent list)', compareTrack));
    }
    secondary.value = compareTrack;
    $('compare-time-control').hidden = !compareTrack;
    if (result.truncated) $('track').title = 'Showing the 100 most recently updated runs';
    else $('track').title = '';
    if (selectedTrack !== previous) {
      clearView();
      if (mode === 'history') {historyDefaults(); loadHistory();}
      else refreshLive();
    } else if (!catalogue.length) status('Waiting for a recording run');
  } catch (error) { status('Track catalogue unavailable: ' + error.message); }
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
    if (firstPage) loadComparison(); // Fit both routes only after the primary has rendered.
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

function renderComparison(observations, track) {
  compareLayer.clearLayers();
  if (!observations.length) return;
  const {segments, ends} = routeParts(observations);
  const show = index => {
    const p = observations[index];
    L.popup().setLatLng([p.lat, p.lon])
      .setContent(pointText(p, index, track, observations.length)).openOn(map);
  };
  for (const segment of segments) {
    const coordinates = segment.map(index => [observations[index].lat, observations[index].lon]);
    // A dark casing keeps the comparison legible over yellow roads and pale
    // map tiles. Only the visible violet line handles clicks.
    L.polyline(coordinates, {
      color: OVERLAY_OUTLINE, weight: 7, opacity: 0.9, interactive: false
    }).addTo(compareLayer);
    L.polyline(coordinates, {
      color: OVERLAY_COLOR, weight: 4, opacity: 1
    }).on('click', event => show(nearestIndex(event, segment, observations))).addTo(compareLayer);
  }
  const stride = Math.max(1, Math.ceil(observations.length / MAX_NODES));
  for (let index = 0; index < observations.length; index++) {
    if (index % stride !== 0 && !ends.has(index)) continue;
    const p = observations[index];
    L.circleMarker([p.lat, p.lon], {
      radius: 4, weight: 2, color: OVERLAY_OUTLINE,
      fillColor: OVERLAY_COLOR, fillOpacity: 1, bubblingMouseEvents: false
    }).bindTooltip(pointText(p, index, track, observations.length))
      .on('click', () => show(index)).addTo(compareLayer);
  }
}

async function loadComparison() {
  const generation = ++compareGeneration;
  const token = revision;
  const track = compareTrack;
  const scope = $('compare-time').value || 'all';
  compareLayer.clearLayers();
  $('compare-time-control').hidden = !track;
  $('compare-status').textContent = '';
  if (!track || track === selectedTrack || mode !== 'history' || !bounds) return;
  $('compare-status').textContent = 'Loading overlay…';
  try {
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
      if (generation !== compareGeneration || token !== revision || mode !== 'history') return;
      observations.push(...result.points);
      next = result.next_cursor;
    } while (next && observations.length < MAX_DISPLAY);
    renderComparison(observations, track);
    if (observations.length) fitObservations(points.concat(observations));
    const suffix = next ? ' (partial; narrow using Same interval)' : '';
    $('compare-status').textContent = observations.length
      ? `${observations.length} overlay fixes${suffix}`
      : scope === 'interval'
        ? 'No overlay fixes in this interval; try Entire run.'
        : 'This recording run has no observations.';
  } catch (error) {
    if (generation === compareGeneration && token === revision)
      $('compare-status').textContent = 'Overlay unavailable: ' + error.message;
  }
}

$('track').addEventListener('change', () => {
  selectedTrack = $('track').value;
  if (compareTrack === selectedTrack) {
    compareTrack = '';
    $('compare').value = '';
  }
  clearView();
  if (mode === 'history') {historyDefaults(); loadHistory();}
  else refreshLive();
});
$('compare').addEventListener('change', () => {
  compareTrack = $('compare').value;
  loadComparison();
});
$('compare-time').addEventListener('change', () => loadComparison());
$('live').addEventListener('click', () => setMode('live'));
$('history').addEventListener('click', () => setMode('history'));
$('apply').addEventListener('click', () => loadHistory());
$('more').addEventListener('click', () => {if (cursor && points.length < MAX_DISPLAY) loadHistory(true);});
$('position').addEventListener('input', showInspection);
refreshTracks();
setInterval(() => {
  ticks++;
  if (ticks % 3 === 0) refreshTracks();
  if (mode === 'live') refreshLive();
}, 2000);
