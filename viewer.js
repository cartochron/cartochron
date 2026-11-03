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
const NEARBY_FIX_MS = 5 * 60 * 1000; // Do not display an old fix as a current location.
const map = L.map('map').setView([0, 0], 2);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin',
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);
const layer = L.layerGroup().addTo(map);
const overlayLayers = new Map();
const timeLayer = L.layerGroup().addTo(map);

let catalogue = [];
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
  overlayGeneration++;
  for (const layer of overlayLayers.values()) {layer.clearLayers(); map.removeLayer(layer);}
  overlayLayers.clear();
  overlayPoints.clear();
  timeLayer.clearLayers();
  $('time-panel').hidden = true;
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
    updateTimeCursor();
  } else {
    $('inspect').hidden = true;
    timeLayer.clearLayers();
    $('time-panel').hidden = true;
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
  if (mode !== 'history') $('layers-panel').hidden = true;
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
    visibleOverlays.delete(selectedTrack);
    renderLayerPanel();
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

function renderLayerPanel() {
  const panel = $('layers-list');
  panel.replaceChildren();
  for (const record of catalogue) {
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
    label.textContent = track === selectedTrack ? `${track} (focused)` : track;
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
  } catch (error) {
    if (generation === overlayGeneration && token === revision)
      $('compare-status').textContent = 'Comparison unavailable: ' + error.message;
  }
}

$('track').addEventListener('change', () => {
  selectedTrack = $('track').value;
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
refreshTracks();
setInterval(() => {
  ticks++;
  if (ticks % 3 === 0) refreshTracks();
  if (mode === 'live') refreshLive();
}, 2000);
