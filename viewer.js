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
const WITNESS_CONTEXT_MS = 15 * 60 * 1000;
const WITNESS_CONTEXT_LIMIT = 1000; // One bounded history page per run, never a complete-history claim.
let witnessTimelineRevision = 0;
let timelineReturnTarget = null; // Button that opened the exact witness pair.
let witnessAnnotationPair = null;
let witnessAnnotationCursor = null;
let witnessAnnotationRevision = 0;
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
const monitorMarkers = new Map(); // Reconcile by reported position; preserve popups on refresh.
let pickingPlace = false;
let viewingMap = false;
let mapReturnTarget = null; // Exact evidence action, when returning from the map.
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
let workspaceAction = null;
// A missing observation, an incomplete query, and an unavailable receiver are
// different states. Never claim that empty results prove nothing happened.
function workspaceState(kind, title, explanation, actionLabel = '', action = null) {
  const panel = $('workspace-state');
  panel.dataset.kind = kind;
  $('workspace-title').textContent = title;
  $('workspace-description').textContent = explanation;
  $('workspace-action').hidden = !action;
  $('workspace-action').textContent = actionLabel;
  workspaceAction = action;
  panel.hidden = false;
}
function hideWorkspaceState() {
  $('workspace-state').hidden = true;
  workspaceAction = null;
}
function noRecordingsState(filtered = false) {
  if (filtered) {
    workspaceState('empty', 'No recordings in this selection',
      'Other recordings may still exist. Remove the filter to browse them.',
      'Show all recordings', () => {
        historyFilter = '';
        $('history-filter').value = '';
        historyTrack = '';
        selectedTrack = '';
        loadRunPage(true);
      });
  } else {
    workspaceState('empty', 'No recordings yet',
      'Cartochron displays reported observations after a producer sends them. '
      + 'To explore safely, run make demo in a separate Cartochron checkout; '
      + 'the demo does not use this database.');
  }
}
function emptyIntervalState() {
  workspaceState('empty', 'No observations in this interval',
    'This time window contains no recorded fixes for the selected run. '
    + 'That does not establish what happened between observations.',
    'Change time interval', () => {
      $('history-actions').open = true;
      const options = $('from');
      // Native details and date inputs are a better recovery path than
      // silently widening a forensic query.
      options.focus();
    });
}
$('workspace-action').addEventListener('click', () => {
  if (workspaceAction) workspaceAction();
});

function status(message) {
  if ($('status').textContent === message) return;
  $('status').textContent = message;
  // The ticking receipt age is informative but must not be announced every
  // two seconds. Only genuine failures enter the assertive live region.
  $('status-alert').textContent = /unavailable|failed|invalid|error|rejected|HTTP [45]\d\d/i.test(message)
    ? message : '';
}
// One consistent answer structure for evidence searches. The finding is announced;
// limitations and the next action remain readable without a live-region monologue.
function investigationResult(prefix, state, finding, coverage, next) {
  $(prefix + '-status').textContent = finding;
  $(prefix + '-coverage').textContent = coverage ? 'Coverage · ' + coverage : '';
  $(prefix + '-next-step').textContent = next ? 'Next · ' + next : '';
  $(prefix + '-summary').dataset.state = state;
}
// One concise reading layer, with exact provenance available on demand.
// All producer and operator text enters through textContent, never HTML.
function evidenceCard(title, summary, provenance = [], actions = []) {
  const li = document.createElement('li');
  li.className = 'evidence-card';
  const heading = document.createElement('strong');
  heading.className = 'evidence-title';
  heading.textContent = title;
  li.appendChild(heading);
  const description = document.createElement('p');
  description.className = 'evidence-text';
  description.textContent = summary;
  li.appendChild(description);
  if (provenance.length) {
    const disclosure = document.createElement('details');
    disclosure.className = 'evidence-provenance';
    const toggle = document.createElement('summary');
    toggle.textContent = 'Exact evidence and provenance';
    disclosure.appendChild(toggle);
    for (const line of provenance) {
      const detail = document.createElement('p');
      detail.textContent = line;
      disclosure.appendChild(detail);
    }
    li.appendChild(disclosure);
  }
  if (actions.length) {
    const controls = document.createElement('div');
    controls.className = 'evidence-actions';
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', () => action.run(button));
      controls.appendChild(button);
    }
    li.appendChild(controls);
  }
  return li;
}
function evidenceName(point) {
  return point.channel_label || point.source_label || point.channel_id || point.source_id || 'Unattributed';
}
function evidenceFix(point, side) {
  return `${side} · ${evidenceName(point)} · run ${point.track_id} / fix ${point.id}`
    + ` · received ${localTime(point.time)}`
    + (Number.isFinite(point.lat) && Number.isFinite(point.lon)
      ? ` · reported coordinates ${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}` : '')
    + ` · ${fixDetails(point)}`
    + (point.channel_id ? ` · channel ${point.channel_id}` : '')
    + (point.source_id ? ` · enrolled source ${point.source_id}` : '');
}
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
  if ($('feed-state').textContent !== label) $('feed-state').textContent = label;
  if ($('feed-state').getAttribute('data-state') !== kind) $('feed-state').setAttribute('data-state', kind);
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

function comparisonRunLabel(record) {
  if (!record.first && !record.last && record.count === undefined)
    return `Selected older recording · ${record.track_id}`;
  const name = record.channel_label || record.source_label || record.channel_id || 'Unattributed recording';
  const time = record.last ? localTime(record.last) : 'receipt time unknown';
  const count = record.count === undefined ? '' : ` · ${record.count} fixes`;
  // The suffix is a visual disambiguator, not an identity or proof of a phone.
  return `${name} · ${time}${count} · …${record.track_id.slice(-8)}`;
}
function comparisonRun() {
  // An explicitly entered older run is the fallback, not a guessed device ID.
  return $('proximity-other').value.trim() || $('proximity-pick').value;
}
function updateComparisonSelection() {
  const manual = $('proximity-other').value.trim();
  const choice = $('proximity-pick').value;
  const other = comparisonRun();
  $('proximity-search').disabled = !selectedTrack || !other || other === selectedTrack;
  $('proximity-current').textContent = selectedTrack
    ? 'First recording · ' + (trackInfo() ? comparisonRunLabel(trackInfo()) : selectedTrack)
    : 'First recording · Choose a recording in History.';
  $('proximity-choice-help').textContent = manual
    ? `Using exact ID: ${manual}. This is a run identifier, not proof of device identity.`
    : choice ? `Selected recording: ${Array.from($('proximity-pick').children).find(option => option.value === choice)?.text || choice}`
      : 'Choose a different recording above, or enter an exact older run ID.';
}
function updateProximityChoices() {
  // Human-readable choices include recent *unfiltered* runs as well as runs
  // paged in History. Exact older IDs remain possible without guessing labels.
  const input = $('proximity-other');
  if (input.value === selectedTrack) input.value = '';
  const pick = $('proximity-pick');
  const previous = pick.value;
  const seen = new Set();
  const choices = [...historyRunList, ...catalogue].filter(item => {
    if (item.track_id === selectedTrack || seen.has(item.track_id)) return false;
    seen.add(item.track_id);
    return true;
  });
  // Preserve an explicitly selected older run if it disappears from the
  // bounded catalogue on refresh. Never silently switch the comparison.
  if (previous && previous !== selectedTrack && !seen.has(previous))
    choices.push({track_id: previous});
  // Don't rebuild an unchanged native select on every polling tick: doing so
  // can close an open OS dropdown while the operator is choosing a recording.
  const options = choices.map(item => new Option(comparisonRunLabel(item), item.track_id));
  function refreshOptions(control, next) {
    const current = Array.from(control.children);
    if (current.length !== next.length || current.some((option, i) =>
      option.value !== next[i].value || option.text !== next[i].text))
      control.replaceChildren(...next);
  }
  refreshOptions(pick, [new Option('Choose a recording…', ''), ...options]);
  const wanted = previous && previous !== selectedTrack ? previous : '';
  if (pick.value !== wanted) pick.value = wanted;
  refreshOptions($('proximity-known-runs'), options);
  updateComparisonSelection();
}

function clearWitnessTimeline() {
  witnessTimelineRevision++;
  timelineReturnTarget = null;
  $('witness-timeline').hidden = true;
  $('witness-timeline-events').replaceChildren();
  $('witness-timeline-status').textContent = '';
  witnessAnnotationRevision++;
  witnessAnnotationPair = null;
  witnessAnnotationCursor = null;
  $('witness-annotation-results').replaceChildren();
  $('witness-annotation-status').textContent = '';
  $('witness-annotation-next').hidden = true;
  $('witness-annotation-load').disabled = false;
  $('witness-annotation-command').textContent = '';
}

async function loadWitnessAnnotations(more = false) {
  const pair = witnessAnnotationPair;
  if (!pair || (more && !witnessAnnotationCursor)) return;
  const token = ++witnessAnnotationRevision;
  const query = new URLSearchParams({fix_id: String(pair[0]), limit: '20'});
  query.append('fix_id', String(pair[1]));
  if (more) query.set('before', witnessAnnotationCursor);
  $('witness-annotation-load').disabled = true;
  $('witness-annotation-next').hidden = true;
  $('witness-annotation-status').textContent = 'Reading saved operator interpretations…';
  try {
    const result = await getJSON('/api/annotations?' + query);
    if (token !== witnessAnnotationRevision || $('witness-timeline').hidden || mode !== 'history') return;
    if (!more) $('witness-annotation-results').replaceChildren();
    for (const note of result.annotations) {
      $('witness-annotation-results').appendChild(evidenceCard(
        `Operator interpretation · ${localTime(note.created)}`, note.note,
        [`Annotation #${note.id} · linked fix IDs ${note.fix_ids.join(' + ')}`,
          'This is an operator-authored interpretation, not recorded location evidence.']));
    }
    witnessAnnotationCursor = result.next_cursor;
    $('witness-annotation-next').hidden = !witnessAnnotationCursor;
    $('witness-annotation-status').textContent = result.annotations.length
      ? `Loaded ${$('witness-annotation-results').children.length} saved interpretation(s)`
        + (witnessAnnotationCursor ? ' · More notes remain' : ' · End of notes')
      : 'No saved interpretations for this exact evidence pair.';
  } catch (error) {
    if (token === witnessAnnotationRevision)
      $('witness-annotation-status').textContent = 'Annotations unavailable: ' + error.message;
  } finally {
    if (token === witnessAnnotationRevision) $('witness-annotation-load').disabled = false;
  }
}

function witnessAnnotationCommand(pair) {
  // Exact IDs only: no coordinates, credentials or note contents in arguments.
  return `docker compose exec -T cartochron python3 annotations.py `
    + `--db /data/observations.sqlite3 add --fix ${pair.a.id} --fix ${pair.b.id} <<'NOTE'\n`
    + `State an interpretation and its uncertainty.\nNOTE`;
}

function receiptMs(point) {
  return Number.isFinite(point.received_ms) ? point.received_ms : Date.parse(point.time);
}

function witnessContextEvents(pair, windows) {
  // Each run's page is ordered by receiver receipt time. A gap is only
  // meaningful between consecutive retrieved fixes of that *same* run.
  // Never infer a gap across page or interval boundaries.
  const events = [];
  for (const side of ['a', 'b']) {
    const fixes = windows[side].points;
    const witness = pair[side];
    const index = fixes.findIndex(p => p.id === witness.id);
    if (index < 0) {
      events.push({kind: 'witness', side, point: witness, outsidePage: true,
        at: receiptMs(witness)});
    } else {
      if (index > 0)
        events.push({kind: 'neighbor', side, point: fixes[index - 1],
          relation: 'Preceding fix', at: receiptMs(fixes[index - 1])});
      events.push({kind: 'witness', side, point: witness, at: receiptMs(witness)});
      if (index + 1 < fixes.length)
        events.push({kind: 'neighbor', side, point: fixes[index + 1],
          relation: 'Following fix', at: receiptMs(fixes[index + 1])});
    }
    for (let i = 1; i < fixes.length; i++) {
      const previous = fixes[i - 1], current = fixes[i];
      const gap = receiptMs(current) - receiptMs(previous);
      if (gap > GAP_MS) events.push({kind: 'gap', side, before: previous, after: current,
        gap, at: receiptMs(current)});
    }
  }
  // Chronological, not grouped by source or sorted by reported measurement clock.
  return events.sort((a, b) => a.at - b.at || a.side.localeCompare(b.side));
}

function witnessIdentity(point) {
  // Descriptive claims, never independently verified physical device identities.
  const channel = point.channel_label || point.channel_id;
  const source = point.source_label || point.source_id;
  return [channel ? `channel ${channel}` : '', source ? `source ${source}` : '']
    .filter(Boolean).join(' · ') || 'unattributed';
}

function mapWitnessFix(side, point, origin = null) {
  // A standalone observation marker; never connect the two sources with a line.
  proximityLayer.clearLayers();
  const label = document.createElement('span');
  label.textContent = `${side.toUpperCase()}: ${witnessIdentity(point)} · ${point.track_id} / fix ${point.id}`
    + ` · Received ${localTime(point.time)} · ${fixDetails(point)}`;
  L.circleMarker([point.lat, point.lon], {
    radius: 8, color: '#edf2f5', weight: 2,
    fillColor: side === 'a' ? '#57b9ef' : '#8724d5', fillOpacity: 0.95
  }).bindTooltip(label).on('click', () => L.popup()
    .setLatLng([point.lat, point.lon]).setContent(label).openOn(map)).addTo(proximityLayer);
  revealEvidenceOnMap(origin, 'Back to timeline');
  fitObservations([point]);
}

function focusWitnessTimeline() {
  $('witness-timeline-heading').scrollIntoView?.({block: 'start'});
  $('witness-timeline-heading').focus();
}

function backToWitnessPair() {
  const target = timelineReturnTarget?.isConnected === false ? null : timelineReturnTarget;
  (target || $('proximity-search')).focus();
}

async function inspectWitnessTimeline(pair, origin = null) {
  // Revisiting the same selected pair must not discard loaded context or notes.
  if (witnessAnnotationPair?.[0] === pair.a.id && witnessAnnotationPair?.[1] === pair.b.id
      && !$('witness-timeline').hidden) {
    if (origin) timelineReturnTarget = origin;
    focusWitnessTimeline();
    return;
  }
  clearWitnessTimeline();
  timelineReturnTarget = origin;
  const token = witnessTimelineRevision;
  $('witness-timeline').hidden = false;
  $('witness-pair-label').textContent = `${evidenceName(pair.a)} ↔ ${evidenceName(pair.b)}`
    + ` · recorded fixes #${pair.a.id} and #${pair.b.id}`;
  focusWitnessTimeline();
  $('witness-timeline-status').textContent = 'Loading recorded context from both runs…';
  // This pair is a derived comparison; its exact fix IDs are stored evidence.
  if (![pair.a.id, pair.b.id].every(id => Number.isSafeInteger(id) && id > 0)
      || pair.a.id === pair.b.id) {
    $('witness-timeline-status').textContent = 'Cannot annotate this pair: invalid fix IDs.';
    return;
  }
  witnessAnnotationPair = [pair.a.id, pair.b.id];
  $('witness-annotation-command').textContent = witnessAnnotationCommand(pair);
  const times = [receiptMs(pair.a), receiptMs(pair.b)];
  if (!times.every(Number.isFinite)) {
    $('witness-timeline-status').textContent = 'Cannot inspect this pair: invalid receipt time.';
    return;
  }
  const start = Math.max(0, Math.min(...times) - WITNESS_CONTEXT_MS);
  const end = Math.max(...times) + WITNESS_CONTEXT_MS + 1;
  const query = point => '/api/points?' + new URLSearchParams({
    track_id: point.track_id, from: new Date(start).toISOString(),
    to: new Date(end).toISOString(), limit: String(WITNESS_CONTEXT_LIMIT)
  });
  try {
    const [a, b] = await Promise.all([getJSON(query(pair.a)), getJSON(query(pair.b))]);
    if (token !== witnessTimelineRevision || mode !== 'history' || $('proximity-panel').hidden) return;
    if (a.track_id !== pair.a.track_id || b.track_id !== pair.b.track_id)
      throw new Error('history response run mismatch');
    // Point history has run identity at response level, not on each fix.
    // Attach it only to these presentation copies; stored evidence is unchanged.
    const windows = {
      a: {...a, points: a.points.map(point => ({...point, track_id: a.track_id}))},
      b: {...b, points: b.points.map(point => ({...point, track_id: b.track_id}))}
    };
    const events = witnessContextEvents(pair, windows);
    for (const event of events) {
      const side = event.side.toUpperCase();
      const identity = witnessIdentity(pair[event.side]);
      if (event.kind === 'gap') {
        $('witness-timeline-events').appendChild(evidenceCard(
          `${side} · ${Math.round(event.gap / 60000)}-minute gap between recorded fixes`,
          `${identity} · ${localTime(event.before.time)} – ${localTime(event.after.time)}`,
          [`Same run: ${event.before.track_id} · fix ${event.before.id} to fix ${event.after.id}`,
            'No intervening recorded fixes in this retrieved interval. Movement and connectivity unknown.']));
      } else {
        const prefix = event.kind === 'witness' ? 'Selected witness' : event.relation;
        $('witness-timeline-events').appendChild(evidenceCard(
          `${side} · ${prefix} · ${localTime(event.point.time)}`,
          `${identity}${event.outsidePage ? ' · Not in retrieved context page' : ''}`,
          [evidenceFix({...event.point, channel_label: pair[event.side].channel_label,
            channel_id: pair[event.side].channel_id, source_label: pair[event.side].source_label,
            source_id: pair[event.side].source_id}, side)],
          [{label: 'Map fix', run: button => mapWitnessFix(event.side, {...event.point,
            channel_label: pair[event.side].channel_label, channel_id: pair[event.side].channel_id,
            source_label: pair[event.side].source_label, source_id: pair[event.side].source_id}, button)}]));
      }
    }
    const partial = a.truncated || b.truncated || a.next_cursor || b.next_cursor;
    const outside = events.some(event => event.outsidePage);
    const gaps = events.filter(event => event.kind === 'gap').length;
    $('witness-timeline-status').textContent = `Receipt-time window ${localTime(new Date(start))} – `
      + `${localTime(new Date(end))}. Loaded A: ${a.points.length} fixes; B: ${b.points.length} fixes. `
      + `Showing both witnesses, immediate neighboring fixes and ${gaps} internal gap${gaps === 1 ? '' : 's'}. `
      + (partial ? 'Partial context: more recorded observations remain in at least one run; later receipts may be omitted. ' :
        'The requested interval was retrieved, not necessarily the full runs. ')
      + (outside ? 'At least one witness is outside the retrieved context page. ' : '')
      + 'All times are receiver receipts; gaps do not establish disconnection, and proximity does not establish a meeting.';
  } catch (error) {
    if (token === witnessTimelineRevision)
      $('witness-timeline-status').textContent = 'Witness context unavailable: ' + error.message;
  }
}

function resetRunProximity() {
  clearWitnessTimeline();
  proximityRevision++;
  proximityCursor = null;
  proximityCount = 0;
  proximityScanned = 0;
  proximityLimited = false;
  proximityLayer.clearLayers();
  $('proximity-results').replaceChildren();
  $('proximity-next').hidden = true;
  updateComparisonSelection();
  investigationResult('proximity', 'ready', 'Choose two recording runs',
    'No comparison has run for the current selection.',
    'Choose the second run and select Find observation pairs.');
}

function showRunWitness(pair, origin = null) {
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
  revealEvidenceOnMap(origin, 'Back to comparison');
  fitObservations([pair.a, pair.b]);
}

async function searchRunProximity(more = false) {
  if (mode !== 'history' || $('proximity-panel').hidden) return;
  if (more && (!proximityCursor || proximityCount >= MAX_PROXIMITY_DISPLAY)) return;
  const a = selectedTrack, b = comparisonRun();
  if (!a || !b || a === b) {
    investigationResult('proximity', 'error', 'Select two different recording runs.',
      'No comparison has run.', 'Choose another run and try again.');
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
    investigationResult('proximity', 'error', 'Invalid receipt-time interval: ' + error.message,
      'No comparison has run.', 'Correct From/To or disable Use History From/To.');
    return;
  }
  const pageWasFocused = more && document.activeElement === $('proximity-next');
  if (more) query.set('before', proximityCursor);
  else resetRunProximity();
  const token = ++proximityRevision;
  $('proximity-search').disabled = true;
  $('proximity-next').hidden = true;
  investigationResult('proximity', 'loading', 'Comparing stored observations…',
    'Search coverage is not yet known.', '');
  try {
    const result = await getJSON('/api/proximity?' + query);
    if (token !== proximityRevision || mode !== 'history') return;
    proximityScanned += result.scanned;
    proximityLimited ||= result.candidate_limited;
    proximityCount += result.pairs.length;
    proximityCursor = result.next_cursor;
    for (const pair of result.pairs) {
      const kind = pair.identity_kind === 'source'
        ? 'Different enrolled source claims' : 'Different channel claims only';
      $('proximity-results').appendChild(evidenceCard(
        `${evidenceName(pair.a)} ↔ ${evidenceName(pair.b)}`,
        `${(pair.receipt_delta_ms / 1000).toFixed(1)} s between receipts · `
          + `${pair.distance_m} m between reported positions`,
        [kind, evidenceFix(pair.a, 'A'), evidenceFix(pair.b, 'B'),
          'Nearby reports do not establish a meeting or continuous presence.'],
        [{label: 'Map pair', run: button => showRunWitness(pair, button)},
          {label: 'Inspect timeline', run: button => inspectWitnessTimeline(pair, button)}]));
    }
    const capped = proximityCount >= MAX_PROXIMITY_DISPLAY;
    $('proximity-next').hidden = !proximityCursor || capped;
    const coverage = [
      `${proximityScanned} anchor fixes examined`,
      proximityCursor ? 'Partial search: older anchors remain unexamined'
        : 'Anchor search reached its end at query time',
      proximityLimited ? 'Dense time windows were capped: candidate matches may be missing' : '',
      capped ? '100-pair display limit reached' : ''
    ].filter(Boolean).join(' · ');
    const next = capped ? 'Narrow the time interval or comparison limits and search again.'
      : proximityCursor ? 'Select Continue into older fixes to extend the search.'
        : proximityLimited ? 'Narrow the time window to reduce capped candidates, then search again.'
        : proximityCount ? 'Select Map pair or Inspect timeline to examine supporting fixes.'
          : 'Try a wider receipt-time window, distance, or a different pair of runs.';
    investigationResult('proximity', capped || proximityCursor || proximityLimited ? 'partial' : 'complete',
      `${proximityCount} candidate pair${proximityCount === 1 ? '' : 's'} found`,
      coverage + '. One witness per anchor, not exhaustive pair enumeration; no inference of encounters.',
      next);
  } catch (error) {
    if (token === proximityRevision) {
      $('proximity-next').hidden = !proximityCursor || proximityCount >= MAX_PROXIMITY_DISPLAY;
      investigationResult('proximity', 'error', 'Cross-run comparison unavailable: ' + error.message,
        'Search coverage is unknown; any previously retrieved rows may be incomplete.',
        proximityCursor ? 'Select Continue into older fixes to retry this page.'
          : 'Check the receiver and retry the comparison.');
    }
  } finally {
    if (token === proximityRevision) {
      $('proximity-search').disabled = false;
      if (pageWasFocused)
        ($('proximity-next').hidden ? $('proximity-search') : $('proximity-next')).focus();
    }
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

function monitorMarkerChoices(group, position) {
  const choices = document.createElement('div');
  for (const item of group) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${monitorName(item)} · ${localTime(item.last)}`;
    button.addEventListener('click', () => { map.closePopup(); selectMonitor(item); });
    choices.appendChild(button);
  }
  return choices;
}

function updateMonitorMarkers() {
  if (mode !== 'live') {
    monitorLayer.clearLayers();
    monitorMarkers.clear();
    return;
  }
  const items = monitorPositions();
  // Share a symbol only for exactly coincident reported coordinates, never
  // merge the underlying source claims, observations or recording runs.
  const groups = new Map();
  for (const item of items) {
    const key = `${item.lat},${item.lon}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const [key, entry] of monitorMarkers) {
    if (!groups.has(key)) {
      monitorLayer.removeLayer(entry.layer);
      monitorMarkers.delete(key);
    }
  }
  for (const [key, group] of groups) {
    const chosen = group.some(item => monitorKey(item) === selectedMonitorKey);
    const recent = group.some(item => receiptState(item.last).kind === 'recent');
    const first = group[0];
    const position = [first.lat, first.lon];
    const signature = JSON.stringify([chosen, recent, group.map(item =>
      [monitorKey(item), monitorName(item), item.last])]);
    let entry = monitorMarkers.get(key);
    if (entry && entry.signature === signature) continue;
    const options = {radius: group.length > 1 ? 11 : chosen ? 10 : 8,
      weight: chosen ? 3 : 2, color: chosen ? '#132936' : '#edf2f5',
      fillColor: recent ? (chosen ? '#f8b449' : '#68ccae') : '#748391',
      fillOpacity: 0.95, bubblingMouseEvents: false};
    const label = document.createElement('span');
    label.textContent = group.length === 1
      ? `${monitorName(first)} · ${recent ? 'Recent receipt' : 'No verified recent receipt'} · ${localTime(first.last)}`
      : `${group.length} sources at identical reported coordinates · Click to choose`;
    if (!entry) {
      entry = {group, signature};
      entry.layer = L.circleMarker(position, options).bindTooltip(label)
        .on('click', () => {
          if (entry.group.length === 1) return selectMonitor(entry.group[0]);
          entry.popup = L.popup().setLatLng(position)
            .setContent(monitorMarkerChoices(entry.group, position)).openOn(map);
        }).addTo(monitorLayer);
      monitorMarkers.set(key, entry);
    } else {
      entry.group = group;
      entry.signature = signature;
      entry.layer.setStyle(options).setRadius(options.radius);
      entry.layer.setTooltipContent(label);
      if (entry.popup) entry.popup.setContent(monitorMarkerChoices(group, position));
    }
  }
  const count = `${items.length} positions shown · receipt status, not connectivity`;
  if ($('monitor-count').textContent !== count) $('monitor-count').textContent = count;
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
      if (!historyRunList.length && !points.length && !historyTrack)
        noRecordingsState(Boolean(historyFilter));
    }
  } catch (error) {
    if (token === historyRunGeneration) {
      if (!points.length) workspaceState('error', 'Could not browse recordings',
        'The recording catalogue could not be loaded. Existing observations have not been deleted.',
        'Try again', () => loadRunPage(true));
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
  if (selectedTrack) workspaceState('loading', 'Loading recorded observations…',
    'Reading the selected recording.');
  else workspaceState('loading', 'Checking for recordings…',
    'Looking for observations you can explore.');
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
  // A full-height mobile results sheet covers the map. Reveal the actual
  // evidence first, with a conspicuous way back to the preserved results.
  if (!$('analysis-drawer').hidden && typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 720px)').matches) showMapInsteadOfDrawer();
  const mapRect = $('map').getBoundingClientRect?.();
  const drawerRect = !$('analysis-drawer').hidden && $('analysis-drawer').getBoundingClientRect?.();
  const obscuredRight = mapRect && drawerRect
    ? Math.max(0, Math.min(mapRect.right, drawerRect.right) - Math.max(mapRect.left, drawerRect.left)) : 0;
  // On desktop, fit reported points in the unobscured map area, not behind
  // the right-hand evidence drawer. A map pair is *not* a connecting route.
  const padding = obscuredRight > 0 && drawerRect.left > mapRect.left
    ? {paddingTopLeft: [25, 25], paddingBottomRight: [obscuredRight + 25, 25]}
    : {padding: [25, 25]};
  const bounds = L.latLngBounds(observations.map(p => [p.lat, p.lon]));
  if (observations.length === 1 && !obscuredRight) map.setView(bounds.getCenter(), 15);
  else map.fitBounds(bounds, {...padding, maxZoom: observations.length === 1 ? 15 : 16});
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
    if (mode === 'live') {
      showLiveStatus();
      workspaceState('empty', 'No observations in this recording',
        'This recording has no stored positions yet. Receipt status does not prove a producer is connected.',
        'Check again', () => refreshLive());
    } else {
      status('No observations in this interval');
      emptyIntervalState();
    }
    return;
  }
  hideWorkspaceState();
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

// datetime-local has no UTC offset. During the autumn clock change, the same
// wall time can identify two different receipts. Keep the exact UTC bounds
// while the displayed default remains unchanged; edited fields use local time.
function defaultHistoryTime(id, epochMs) {
  const input = $(id);
  input.dataset.defaultUtc = new Date(epochMs).toISOString();
  input.value = localInput(epochMs);
  input.dataset.defaultLocal = input.value;
}
function historyTimeUtc(id) {
  const input = $(id);
  return input.dataset.defaultUtc && input.value === input.dataset.defaultLocal
    ? input.dataset.defaultUtc : new Date(input.value).toISOString();
}
function historyDefaults() {
  const track = trackInfo();
  if (!track) return;
  $('history-interval-toggle').textContent = 'Time interval';
  defaultHistoryTime('from', Date.parse(track.first) - 1000);
  defaultHistoryTime('to', Date.parse(track.last) + 1000);
  $('history-time-error').hidden = true;
}
function setMode(next) {
  if (mode === next) return;
  closeOptionPanels();
  closeAnalysisDrawer({restoreFocus: false});
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
    updateMonitorMarkers();
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
    } else if (!selectedTrack) {
      status('Waiting for observations');
      if (mode === 'live' && !monitorCatalogue.length) {
        if (catalogue.length) workspaceState('empty', 'No monitored positions',
          'Recording history exists, but there is no current monitor entry. Browse the stored runs in History.',
          'Open History', () => setMode('history'));
        else noRecordingsState();
      }
    }
    if (mode === 'history') updateRunPageStatus();
  } catch (error) {
    status('Observation catalogue unavailable: ' + error.message);
    if (!points.length) workspaceState('error', 'Cannot load recordings',
      'Cartochron could not retrieve the catalogue. This is a loading failure, not an empty database.',
      'Try again', () => refreshTracks());
  }
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
    if (token === revision) {
      status('Recent observations unavailable: ' + error.message);
      if (!points.length) workspaceState('error', 'Cannot load observations',
        'The selected recording could not be loaded. Try again; no observations were removed.',
        'Try again', () => refreshLive());
    }
  } finally { liveBusy = false; }
}

let bounds = null;
async function loadHistory(more = false) {
  if (!selectedTrack || mode !== 'history') return;
  if (!more) {
    const from = $('from').value, to = $('to').value;
    let interval;
    try {
      if (!from || !to) throw new RangeError('missing endpoint');
      interval = {from: historyTimeUtc('from'), to: historyTimeUtc('to')};
      if (Date.parse(interval.from) >= Date.parse(interval.to))
        throw new RangeError('reversed interval');
    } catch (error) {
      // Invalid input must not discard an already loaded investigation.
      $('history-time-error').textContent = 'Choose a valid interval: From must be earlier than To.';
      $('history-time-error').hidden = false;
      $('history-actions').open = true;
      status('Choose a valid interval: From must precede To');
      $('from').focus();
      return false;
    }
    $('history-time-error').hidden = true;
    clearView();
    bounds = interval;
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
    return true;
  } catch (error) {
    if (token === revision) {
      status('Historical query failed: ' + error.message);
      if (!points.length) workspaceState('error', 'Cannot load this interval',
        'The history request failed. This does not mean the interval has no observations.',
        'Try again', () => loadHistory());
    }
  } finally { $('more').disabled = false; }
  return false;
}

function updateTimeCursor() {
  timeLayer.clearLayers();
  const panel = $('time-panel');
  // Shared time compares recordings. A single run already has Inspect point.
  const otherRuns = [...visibleOverlays].filter(track => overlayPoints.has(track));
  if (mode !== 'history' || !points.length || !otherRuns.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const runs = [{name: selectedTrack, fixes: points, color: '#57b9ef'}];
  for (const [i, track] of otherRuns.entries()) {
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
  investigationResult('place-db', 'ready', placeSelection
    ? 'Ready to search this place' : 'Choose a place to search',
    'No recorded-history search has run for this location and filters.',
    placeSelection ? 'Select Search recorded history to examine all runs, not only loaded points.'
      : 'Choose a place on the map, then select Search recorded history.');
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
    const kind = match.identity.kind === 'source'
      ? 'Different enrolled source claims' : 'Different channel claims only';
    list.appendChild(evidenceCard(
      `${evidenceName(match.a)} ↔ ${evidenceName(match.b)}`,
      `${Math.round(match.difference / 1000)} s between receipts · `
        + `${Math.round(match.separation)} m between reported positions`,
      [kind, evidenceFix(match.a, 'A'), evidenceFix(match.b, 'B'),
        'Derived from retrieved matching fixes only; not proof of an encounter.']));
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
    investigationResult('place-db', 'error', 'Invalid place search filter: ' + error.message,
      'No new search was performed.', 'Correct the time or scope filter and search again.');
    return;
  }
  const pageWasFocused = more && document.activeElement === $('place-next');
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
  investigationResult('place-db', 'loading', 'Searching recorded observations…',
    'The result is not yet known.', '');
  try {
    const page = await getJSON('/api/place/observations?' + query);
    if (request !== placeSearchRevision) return;
    for (const p of page.points) {
      $('place-db-results').appendChild(evidenceCard(
        `${evidenceName(p)} · ${localTime(p.time)}`,
        `${p.distance_m} m from selected place · recorded fix`,
        [evidenceFix(p, 'Fix'), 'Distance is between reported coordinates, not proof of physical presence.']));
      placeSearchMatches.push(p);
      placeSearchCount++;
    }
    placeSearchCursor = page.next_cursor;
    renderPlaceGroups();
    renderPlaceProximity();
    const moreAvailable = Boolean(page.next_cursor);
    const capped = placeSearchCount >= MAX_PLACE_DISPLAY;
    $('place-next').hidden = !moreAvailable || capped;
    const finding = placeSearchCount
      ? `${placeSearchCount} matching recorded fix${placeSearchCount === 1 ? '' : 'es'} found`
      : 'No matching recorded fixes in retrieved pages';
    const coverage = capped
      ? 'Partial display: 500-fix limit reached. Older results may be missing.'
      : moreAvailable ? 'Partial search: Older candidates remain unexamined.'
        : 'Search complete for the chosen radius, scope and receipt-time interval at query time.';
    const next = capped
      ? 'Narrow the receipt-time interval or source filter and search again.'
      : moreAvailable
        ? 'Select Search older records. An empty page is not proof of no matches.'
        : placeSearchCount
          ? 'Explore matching-fix groups and original observations below.'
          : 'Try a wider radius, time interval or source scope and search again.';
    investigationResult('place-db', capped || moreAvailable ? 'partial' : 'complete',
      finding, coverage + ' Reported proximity does not prove continuous presence.', next);
  } catch (error) {
    if (request === placeSearchRevision) {
      $('place-next').hidden = !placeSearchCursor || placeSearchCount >= MAX_PLACE_DISPLAY;
      investigationResult('place-db', 'error', 'Recorded history search failed: ' + error.message,
        'Search coverage is unknown; any previously retrieved rows may be incomplete.',
        placeSearchCursor ? 'Select Search older records to retry this page.'
          : 'Check the receiver and try Search recorded history again.');
    }
  } finally {
    if (request === placeSearchRevision) {
      $('place-search').disabled = false;
      if (pageWasFocused)
        ($('place-next').hidden ? $('place-search') : $('place-next')).focus();
    }
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
  closeHistoryTools();
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
// Visible investigation questions share one non-modal drawer. Focus moves into
// the opened tool and back to its launcher; map interaction remains available.
const ANALYSIS_TOOLS = [
  ['layers-panel', 'layers-toggle', 'Compare routes',
    'Choose additional recordings to compare their reported paths and time coverage.'],
  ['place-panel', 'place-toggle', 'What was observed here?',
    'Choose a location on the map, then search recorded observations near it.'],
  ['proximity-panel', 'proximity-toggle', 'Where did two recordings overlap?',
    'Choose another recording and find original fixes close in reported space and receipt time.']
];
function returnFromMap() {
  if (!viewingMap) return;
  viewingMap = false;
  $('map-return').hidden = true;
  $('analysis-drawer').hidden = false;
  const target = mapReturnTarget?.isConnected === false ? null : mapReturnTarget;
  mapReturnTarget = null;
  (target || $('drawer-map')).focus();
  $('return-results').textContent = 'Back to results';
}
function finishPlacePick(chosen = false) {
  if (!pickingPlace) return;
  pickingPlace = false;
  $('place-pick-hint').hidden = true;
  $('analysis-drawer').hidden = false;
  (chosen ? $('place-search') : $('place-pick')).focus();
}
function closeAnalysisDrawer({restoreFocus = true} = {}) {
  const opened = ANALYSIS_TOOLS.find(([panel]) => !$(panel).hidden);
  const placeWasOpen = !$('place-panel').hidden;
  const acrossWasOpen = !$('proximity-panel').hidden;
  pickingPlace = false;
  viewingMap = false;
  mapReturnTarget = null;
  $('place-pick-hint').hidden = true;
  $('map-return').hidden = true;
  for (const [panel, toggle] of ANALYSIS_TOOLS) {
    $(panel).hidden = true;
    $(toggle).setAttribute('aria-expanded', 'false');
  }
  $('analysis-drawer').hidden = true;
  if (placeWasOpen) {
    placeSelection = null;
    placeLayer.clearLayers();
    resetDatabasePlaceSearch();
  }
  if (acrossWasOpen) resetRunProximity();
  if (restoreFocus && opened && mode === 'history') $(opened[1]).focus();
}
function toggleAnalysisDrawer(panelId) {
  const selected = ANALYSIS_TOOLS.find(([panel]) => panel === panelId);
  if (!selected) return;
  const opening = $(panelId).hidden;
  closeAnalysisDrawer({restoreFocus: false});
  if (!opening) {$(selected[1]).focus(); return;}
  $(panelId).hidden = false;
  $(selected[1]).setAttribute('aria-expanded', 'true');
  $('drawer-title').textContent = selected[2];
  $('drawer-instruction').textContent = selected[3];
  $('analysis-drawer').hidden = false;
  $('history-actions').open = false;
  if (panelId === 'proximity-panel') updateProximityChoices();
  $('drawer-close').focus();
}
function startPlacePick() {
  if (mode !== 'history' || $('place-panel').hidden) return;
  viewingMap = false;
  pickingPlace = true;
  $('analysis-drawer').hidden = true;
  $('place-pick-hint').hidden = false;
  $('place-pick-cancel').focus();
}
function showMapInsteadOfDrawer(origin = null, returnLabel = 'Back to results') {
  if ($('analysis-drawer').hidden) return;
  viewingMap = true;
  mapReturnTarget = origin;
  $('analysis-drawer').hidden = true;
  $('map-return').hidden = false;
  $('return-results').textContent = returnLabel;
  $('return-results').focus();
}
function revealEvidenceOnMap(origin, returnLabel) {
  // Make the requested observation visible, on desktop as well as phones.
  // On return, focus the action in the *same* evidence row.
  if (!$('analysis-drawer').hidden) showMapInsteadOfDrawer(origin, returnLabel);
}
$('place-pick').addEventListener('click', startPlacePick);
$('place-pick-cancel').addEventListener('click', () => finishPlacePick());
$('drawer-map').addEventListener('click', () => showMapInsteadOfDrawer());
// The two everyday option panels obey the same lifecycle and focus rules.
function closeHistoryTools(restoreFocus = false) {
  const body = $('history-tools-body');
  const wasOpen = body.dataset.open === 'true';
  body.dataset.open = 'false';
  $('history-tools-toggle').setAttribute('aria-expanded', 'false');
  if (wasOpen && restoreFocus) $('history-tools-toggle').focus();
}
function closeOptionPanels() {
  closeHistoryTools();
  $('history-actions').open = false;
  const monitor = $('monitor-view-options');
  if (monitor) monitor.open = false;
}
$('history-tools-toggle').addEventListener('click', () => {
  const next = $('history-tools-body').dataset.open !== 'true';
  closeOptionPanels();
  $('history-tools-body').dataset.open = String(next);
  $('history-tools-toggle').setAttribute('aria-expanded', String(next));
});
$('history-actions').addEventListener('toggle', () => {
  if ($('history-actions').open) closeHistoryTools();
});
$('monitor-view-options').addEventListener('toggle', () => {
  if ($('monitor-view-options').open) {
    closeHistoryTools();
    $('history-actions').open = false;
  }
});
$('witness-back').addEventListener('click', backToWitnessPair);
$('return-results').addEventListener('click', returnFromMap);
$('drawer-close').addEventListener('click', () => closeAnalysisDrawer());
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (pickingPlace) finishPlacePick();
  else if (viewingMap) returnFromMap();
  else if (!$('analysis-drawer').hidden) closeAnalysisDrawer();
  else if ($('history-actions').open) {
    $('history-actions').open = false;
    $('history-interval-toggle').focus();
  } else if ($('monitor-view-options').open) {
    $('monitor-view-options').open = false;
    $('monitor-view-toggle').focus();
  } else if ($('history-tools-body').dataset.open === 'true') closeHistoryTools(true);
});
// Like a normal popover: clicking outside dismisses it without changing the query.
document.addEventListener('pointerdown', event => {
  const picker = $('history-actions');
  if (picker.open && !picker.contains(event.target)) picker.open = false;
  const monitor = $('monitor-view-options');
  if (monitor.open && !monitor.contains(event.target)) monitor.open = false;
  const tools = $('history-tools-body');
  if (tools.dataset.open === 'true' && !tools.contains(event.target)
      && event.target !== $('history-tools-toggle')) closeHistoryTools();
});
for (const [panel, toggle] of ANALYSIS_TOOLS)
  $(toggle).addEventListener('click', () => {
    closeHistoryTools();
    toggleAnalysisDrawer(panel);
  });
$('compare-time').addEventListener('change', () => loadOverlays());
$('live').addEventListener('click', () => setMode('live'));
$('history').addEventListener('click', () => setMode('history'));
$('apply').addEventListener('click', async () => {
  if (await loadHistory()) {
    $('history-interval-toggle').textContent = 'Time interval · filtered';
    $('history-actions').open = false;
    $('history-interval-toggle').focus();
  }
});
$('history-full').addEventListener('click', async () => {
  historyDefaults();
  if (await loadHistory()) {
    $('history-interval-toggle').textContent = 'Time interval';
    $('history-actions').open = false;
    $('history-interval-toggle').focus();
  }
});
for (const id of ['from', 'to'])
  $(id).addEventListener('input', () => { $('history-time-error').hidden = true; });
$('more').addEventListener('click', () => {if (cursor && points.length < MAX_DISPLAY) loadHistory(true);});
$('position').addEventListener('input', showInspection);
$('time-cursor').addEventListener('input', updateTimeCursor);
$('place-radius').addEventListener('change', () => {resetDatabasePlaceSearch(); updatePlaceInspector();});
for (const id of ['place-scope', 'place-from', 'place-to'])
  $(id).addEventListener('change', resetDatabasePlaceSearch);
$('place-search').addEventListener('click', () => searchRecordedPlace());
$('place-next').addEventListener('click', () => searchRecordedPlace(true));
$('place-proximity-window').addEventListener('change', renderPlaceProximity);
$('proximity-pick').addEventListener('change', () => {
  // Choosing a visible recording overrides any old exact-ID entry.
  $('proximity-other').value = '';
  $('proximity-advanced').open = false;
  resetRunProximity();
});
function changedExactComparisonRun() {
  if ($('proximity-other').value.trim()) $('proximity-pick').value = '';
  resetRunProximity();
}
$('proximity-other').addEventListener('change', changedExactComparisonRun);
$('proximity-other').addEventListener('input', changedExactComparisonRun);
for (const id of ['proximity-radius', 'proximity-window', 'proximity-interval', 'from', 'to'])
  $(id).addEventListener('change', resetRunProximity);
$('witness-annotation-load').addEventListener('click', () => loadWitnessAnnotations());
$('witness-annotation-next').addEventListener('click', () => loadWitnessAnnotations(true));
$('proximity-search').addEventListener('click', () => searchRunProximity());
$('proximity-next').addEventListener('click', () => searchRunProximity(true));
map.on('click', event => {
  if (mode !== 'history' || $('place-panel').hidden || viewingMap) return;
  placeSelection = {lat: event.latlng.lat, lon: event.latlng.lng};
  resetDatabasePlaceSearch();
  updatePlaceInspector();
  if (pickingPlace) finishPlacePick(true);
});
workspaceState('loading', 'Loading Cartochron…',
  'Checking the observation catalogue.');
refreshTracks();
setInterval(() => {
  ticks++;
  if (ticks % 3 === 0) refreshTracks();
  if (mode === 'live') refreshLive();
}, 2000);
