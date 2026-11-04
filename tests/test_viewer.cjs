/* Browser interaction tests using Node's built-in runner and fake Leaflet objects.
 * These test map behavior, not tile rendering. No npm packages are needed.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'viewer.js'), 'utf8');

function viewer() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', max: '', hidden: false, textContent: '', disabled: false, children: [],
      events: {}, addEventListener(name, fn) { this.events[name] = fn; },
      setAttribute() {},
      appendChild(child) { this.children.push(child); return child; },
      add(option) { this.children.push(option); },
      replaceChildren(...children) { this.children = [...children]; },
    });
    return elements.get(id);
  }
  const groups = [];
  function newGroup() {
    const group = {
      layers: [], addTo() { return this; },
      clearLayers() { this.layers = []; },
      removeLayer(layer) { this.layers = this.layers.filter(item => item !== layer); },
    };
    groups.push(group);
    return group;
  }
  const popup = {
    setLatLng(value) { this.position = value; return this; },
    setContent(value) { this.content = value; return this; },
    openOn() { return this; },
  };
  const fitted = [];
  const pans = [];
  const viewport = {contains: () => false, pad() {return this;}};
  const map = {
    setView() { return this; },
    fitBounds(bounds) { fitted.push(bounds.coords); },
    getBounds() { return viewport; }, getZoom() { return 14; },
    on(name, fn) {this.events = this.events || {}; this.events[name] = fn; return this;},
    panTo(value) { pans.push(value); }, closePopup() {}, invalidateSize() {}, removeLayer() {},
    latLngToLayerPoint(value) {
      const lat = Array.isArray(value) ? value[0] : value.lat;
      const lon = Array.isArray(value) ? value[1] : value.lng;
      return {x: lon * 10000, y: lat * 10000};
    },
  };
  function shape(type, positions, options) {
    return {
      type, positions, options, events: {},
      addTo(layer) { layer.layers.push(this); return this; },
      on(name, fn) { this.events[name] = fn; return this; },
      bindTooltip(tooltip) { this.tooltip = tooltip; return this; },
    };
  }
  const context = vm.createContext({
    document: {
      getElementById: element,
      createElement() { return {textContent: '', events: {}, children: [],
        appendChild(child) { this.children.push(child); },
        addEventListener(name, fn) { this.events[name] = fn; }}; },
    },
    L: {
      map: () => map,
      tileLayer: () => ({addTo() {}}),
      layerGroup: newGroup,
      polyline: (coords, options) => shape('polyline', coords, options),
      circleMarker: (coords, options) => shape('circle', coords, options),
      circle: (coords, options) => shape('area', coords, options),
      latLngBounds: coords => ({coords, getCenter: () => coords[0]}),
      popup: () => popup,
    },
    // The viewer starts polling on load. Keep it pending for these local tests.
    fetch: () => new Promise(() => {}),
    setInterval: () => {},
    requestAnimationFrame: fn => fn(),
    URLSearchParams, Date, Option: class {
      constructor(text, value) { this.text = text; this.value = value; }
    },
  });
  vm.runInContext(source, context);
  function exec(script) { return vm.runInContext(script, context); }
  function render(points, mode = 'history', track = 'lab-run') {
    context.fixture = points;
    context.fixtureMode = mode;
    context.fixtureTrack = track;
    exec('points = fixture; mode = fixtureMode; selectedTrack = fixtureTrack; lastSignature = ""; lastIndex = 0; render(true)');
    return groups[0].layers;
  }
  return {render, exec, element, group: groups[0], groups, map, popup, context, fitted, pans, viewport};
}

function point(i, minutes = i) {
  return {
    id: i + 1, lat: 47 + i * 0.001, lon: 28 + i * 0.001,
    time: new Date(Date.UTC(2026, 10, 2, 12, minutes)).toISOString(),
  };
}

test('live receipt status distinguishes recent data from stale history without claiming online', () => {
  const ui = viewer();
  const now = Date.now();
  const current = {...point(0), time: new Date(now - 15_000).toISOString()};
  const old = {...point(0), time: new Date(now - 3_600_000).toISOString()};
  ui.render([current], 'live');
  assert.match(ui.element('feed-state').textContent, /Recent receipts/);
  assert.match(ui.element('status').textContent, /connection not verified/);
  assert.equal(ui.group.layers.find(l => l.type === 'circle').options.fillColor, '#39b86f');
  ui.render([old], 'live');
  assert.match(ui.element('feed-state').textContent, /No recent receipts/);
  assert.match(ui.element('status').textContent, /position is not current/);
  assert.equal(ui.group.layers.find(l => l.type === 'circle').options.fillColor, '#748391');
  ui.render([old], 'history');
  assert.equal(ui.element('feed-state').textContent, 'Historical interval');
  assert.match(ui.element('status').textContent, /History/);
});

test('live view ages unchanged observations without a new server point', () => {
  const ui = viewer();
  const start = Date.now();
  ui.context.Date = class extends Date {static now() {return start;}};
  const latest = {...point(0), time: new Date(start - 15_000).toISOString()};
  ui.render([latest], 'live');
  assert.match(ui.element('feed-state').textContent, /Recent receipts/);
  const originalLayers = ui.group.layers;
  ui.exec('render(false)');
  assert.equal(ui.group.layers, originalLayers); // Only the text is refreshed.
  ui.context.Date = class extends Date {static now() {return start + 3 * 60_000;}};
  ui.exec('render(false)');
  assert.equal(ui.element('feed-state').textContent, 'No recent receipts');
  assert.match(ui.element('status').textContent, /position is not current/);
  assert.equal(ui.group.layers.find(l => l.type === 'circle').options.fillColor, '#748391');
  assert.equal(ui.exec('points.length'), 1); // Nothing discarded or invented.
});

test('empty live run has a final, explicit status', () => {
  const ui = viewer();
  ui.render([], 'live');
  assert.equal(ui.element('feed-state').textContent, 'No observations');
  assert.match(ui.element('status').textContent, /No recorded observations/);
});

test('receipt classification handles future clocks and keeps provenance separate', () => {
  const ui = viewer();
  const now = 1_800_000_000_000;
  assert.equal(ui.exec(`receiptState("2026-11-03T10:00:00Z", ${now}).kind`), 'stale');
  assert.equal(ui.exec(`receiptState("not a timestamp", ${now}).kind`), 'unknown');
  assert.equal(ui.exec(`receiptState("2026-11-03T10:00:00Z", ${now}).label`).includes('ago'), true);
});

test('dots show safe labels and select a historical point without moving the slider by hand', () => {
  const ui = viewer();
  const layers = ui.render([point(0), point(1), point(2)]);
  const dots = layers.filter(layer => layer.type === 'circle');
  assert.equal(dots.length, 4); // Three nodes and the selected-point highlight.
  assert.match(dots[1].tooltip.textContent, /lab-run/);
  assert.match(dots[1].tooltip.textContent, /47\.001000, 28\.001000/);
  dots[2].events.click();
  assert.equal(ui.element('position').value, '2');
  assert.match(ui.element('detail').textContent, /3\/3/);
});

test('gap boundaries are visible and route lines never cross a recording gap', () => {
  const ui = viewer();
  const layers = ui.render([point(0, 0), point(1, 1), point(2, 30), point(3, 31)]);
  const lines = layers.filter(layer => layer.type === 'polyline');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].positions.length, 2);
  assert.equal(lines[1].positions.length, 2);
  lines[1].events.click({latlng: {lat: 47.003, lng: 28.003}});
  assert.equal(ui.element('position').value, '3');
  assert.match(ui.element('detail').textContent, /4\/4/);
});

test('gap markers explain time loss without inventing motion', () => {
  const ui = viewer();
  const layers = ui.render([point(0, 0), point(1, 1), point(2, 30), point(3, 31)]);
  const warnings = layers.filter(layer => layer.type === 'circle' && layer.options.radius === 8
    && layer.options.fillColor === '#f2d6ff');
  assert.equal(warnings.length, 2);
  assert.match(warnings[0].tooltip.textContent, /29m.*Movement unknown/);
  assert.match(ui.element('gap-status').textContent, /1 recording gap.*movement unknown/);
  warnings[1].events.click();
  assert.match(ui.element('detail').textContent, /Gap before: 29m.*movement unknown/);
});

test('short receipt-time positioning jump is marked but never interpolated', () => {
  const ui = viewer();
  const first = point(0, 0);
  const second = {...point(1, 0), lat: first.lat + 0.005,
                  time: new Date(Date.parse(first.time) + 10_000).toISOString()};
  const layers = ui.render([first, second]);
  assert.equal(layers.filter(l => l.type === 'polyline').length, 0);
  assert.match(ui.element('gap-status').textContent, /possible positioning jump/);
  const rings = layers.filter(l => l.type === 'circle' && l.options.fillColor === '#ffc56b');
  assert.equal(rings.length, 2);
  assert.match(rings[0].tooltip.textContent, /Movement unverified/);
  rings[1].events.click();
  assert.match(ui.element('detail').textContent, /Possible positioning jump/);
  const live = viewer();
  live.render([first, second], 'live');
  assert.match(live.element('status').textContent, /possible positioning jump/);
});

test('different locations with identical receipt timestamps do not form a route', () => {
  const ui = viewer();
  const first = point(0, 0);
  const second = {...point(1, 0), lat: first.lat + 0.005, time: first.time};
  const layers = ui.render([first, second]);
  assert.equal(layers.filter(l => l.type === 'polyline').length, 0);
  assert.match(ui.element('gap-status').textContent, /possible positioning jump/);
});

test('fix provenance is displayed without fabricating measurement age or accuracy', () => {
  const ui = viewer();
  let layers = ui.render([point(0)]);
  assert.match(layers[0].tooltip.textContent, /Fix acquisition time unknown/);
  assert.match(layers[0].tooltip.textContent, /Accuracy unknown/);
  const reported = {...point(1), measured_time: '2026-11-02T10:00:00.000+00:00',
                    provider: 'network', accuracy_m: 50};
  layers = ui.render([reported]);
  assert.match(layers[0].tooltip.textContent, /Reported fix time/);
  assert.match(layers[0].tooltip.textContent, /Reported provider network/);
  assert.match(layers[0].tooltip.textContent, /Reported accuracy 50 m/);
});

test('many discontinuities do not create unbounded map layers', () => {
  const ui = viewer();
  const start = Date.UTC(2026, 10, 2, 12);
  const noisy = Array.from({length: 1000}, (_, i) => ({
    id: i, lat: 47 + (i % 2) * 0.005, lon: 28,
    time: new Date(start + i * 10_000).toISOString(),
  }));
  const layers = ui.render(noisy);
  assert.ok(layers.length < 450, `created ${layers.length} map layers`);
  assert.match(ui.element('gap-status').textContent, /999 possible positioning jumps/);
});

test('long histories render bounded dots, but line clicks inspect points between dots', () => {
  const ui = viewer();
  const layers = ui.render(Array.from({length: 5000}, (_, i) => point(i, i)));
  const nodes = layers.filter(layer => layer.type === 'circle');
  assert.ok(nodes.length <= 145, `rendered ${nodes.length} circle layers`);
  const line = layers.find(layer => layer.type === 'polyline');
  assert.ok(line);
  line.events.click({latlng: {lat: 47.173, lng: 28.173}});
  assert.equal(ui.element('position').value, '173');
});

test('live view has clickable point details and never inserts track IDs as HTML', () => {
  const ui = viewer();
  const dangerous = '<img src=x onerror=alert(1)>';
  const dots = ui.render([point(0), point(1)], 'live', dangerous)
    .filter(layer => layer.type === 'circle');
  assert.ok(dots[0].tooltip.textContent.includes(dangerous));
  assert.equal(dots[0].tooltip.innerHTML, undefined);
  dots[0].events.click();
  assert.equal(ui.popup.content.textContent.includes(dangerous), true);
  assert.equal(ui.element('inspect').hidden, true);
});

test('a single recorded fix gets one interactive node but no invented route', () => {
  const ui = viewer();
  const layers = ui.render([point(0)]);
  assert.equal(layers.filter(layer => layer.type === 'polyline').length, 0);
  const nodes = layers.filter(layer => layer.type === 'circle');
  assert.equal(nodes.length, 2);
  nodes[0].events.click();
  assert.match(ui.element('detail').textContent, /1\/1/);
});

function choose(ui, name, selected = true) {
  const rows = ui.element('layers-list').children;
  const row = rows.find(row => row.children[1].textContent.startsWith(name));
  assert.ok(row, `missing ${name} in layer chooser`);
  const input = row.children[0];
  input.checked = selected;
  input.events.change();
}

function setupTracks(ui, names = ['run-A', 'run-B', 'run-C', 'run-D', 'run-E']) {
  ui.context.fixtureCatalogue = names.map(track_id => ({track_id}));
  ui.exec('catalogue=fixtureCatalogue; selectedTrack="run-A"; renderLayerPanel()');
}

test('up to four tracks can be enabled and a fifth is rejected', () => {
  const ui = viewer();
  setupTracks(ui);
  choose(ui, 'run-B'); choose(ui, 'run-C'); choose(ui, 'run-D');
  assert.equal(ui.exec('visibleOverlays.size'), 3);
  assert.equal(ui.element('layer-count').textContent, '4 visible');
  choose(ui, 'run-E');
  assert.equal(ui.exec('visibleOverlays.size'), 3);
  assert.match(ui.element('compare-status').textContent, /Up to 4/);
});

test('multi-track overlays are independent, colored and clickable', async () => {
  const ui = viewer();
  ui.render([point(0), point(1)], 'history', 'run-A');
  setupTracks(ui);
  ui.exec('bounds={from:"2026-11-02T00:00:00Z",to:"2026-11-03T00:00:00Z"}; visibleOverlays.clear();');
  // visibleOverlays is declared const; work through the exposed Set.
  ui.exec('visibleOverlays.add("run-B"); visibleOverlays.add("run-C")');
  const queries = [];
  ui.context.fetch = async url => {
    queries.push(url);
    return {ok: true, json: async () => ({points: [point(0), point(1)], next_cursor: null})};
  };
  await ui.exec('loadOverlays()');
  assert.equal(ui.exec('overlayLayers.size'), 2);
  const b = ui.exec('overlayLayers.get("run-B")').layers, c = ui.exec('overlayLayers.get("run-C")').layers;
  assert.equal(b.filter(x => x.type === 'polyline')[1].options.color, '#8724d5');
  assert.equal(c.filter(x => x.type === 'polyline')[1].options.color, '#007c78');
  b.find(x => x.type === 'circle').events.click();
  assert.match(ui.popup.content.textContent, /run-B/);
  assert.equal(ui.element('position').value, '0');
  assert.equal(queries.length, 2);
  assert.equal(ui.fitted.at(-1).length, 6);
});

test('comparison overlays also stop at suspected positioning jumps', () => {
  const ui = viewer();
  const first = point(0, 0);
  const second = {...point(1, 0), lat: first.lat + 0.005,
                  time: new Date(Date.parse(first.time) + 10_000).toISOString()};
  ui.context.fixtureOverlay = [first, second];
  ui.exec('renderOverlay(fixtureOverlay, "run-Z", "#8724d5")');
  const overlays = ui.exec('overlayLayers.get("run-Z")').layers;
  assert.equal(overlays.filter(l => l.type === 'polyline').length, 0);
  assert.equal(overlays.filter(l => l.type === 'circle').length, 2);
});

test('comparison time scope filters every overlay', async () => {
  const ui = viewer();
  ui.render([point(0), point(1)], 'history', 'run-A');
  ui.element('compare-time').value = 'interval';
  ui.exec('bounds={from:"2026-11-02T21:47:05Z",to:"2026-11-02T21:47:23Z"}; visibleOverlays.add("run-B"); visibleOverlays.add("run-C");');
  const queries = [];
  ui.context.fetch = async url => {
    queries.push(url);
    return {ok: true, json: async () => ({points: [], next_cursor: null})};
  };
  await ui.exec('loadOverlays()');
  for (const url of queries) {
    const params = new URL('http://localhost' + url).searchParams;
    assert.equal(params.get('from'), '2026-11-02T21:47:05Z');
    assert.equal(params.get('to'), '2026-11-02T21:47:23Z');
  }
  assert.match(ui.element('compare-status').textContent, /try Entire run/);
});

test('focus switches cannot leave the focused track as its own overlay', () => {
  const ui = viewer();
  setupTracks(ui);
  ui.exec('visibleOverlays.add("run-B"); selectedTrack="run-B"; visibleOverlays.delete(selectedTrack); renderLayerPanel()');
  assert.equal(ui.exec('visibleOverlays.size'), 0);
  assert.equal(ui.element('layers-list').children[1].children[0].disabled, true);
});

test('shared time cursor only draws fresh, observed fixes for each selected run', () => {
  const ui = viewer();
  ui.render([point(0, 0), point(1, 10)], 'history', 'run-A');
  ui.context.fixtureB = [point(0, 0), point(1, 3)];
  ui.exec('overlayPoints.set("run-B", fixtureB); visibleOverlays.add("run-B");');
  // 0% of the loaded 10-minute span: both have a fix.
  ui.element('time-cursor').value = '0';
  ui.exec('updateTimeCursor()');
  assert.equal(ui.exec('timeLayer.layers.length'), 2);
  // End: A has a fresh fix; B last reported seven minutes ago.
  ui.element('time-cursor').value = '1000';
  ui.exec('updateTimeCursor()');
  assert.equal(ui.exec('timeLayer.layers.length'), 1);
  assert.match(ui.element('time-results').children[1].textContent, /no recent fix/);
  assert.match(ui.element('time-value').textContent, /fixes older than 5 minutes/);
});

test('place inspector lists only loaded fixes within radius in chronological order', () => {
  const ui = viewer();
  ui.render([point(0, 0), point(1, 1), point(2, 2)], 'history', 'run-A');
  ui.context.fixtureExtra = [{...point(0, 3), lat: 47.0001, lon: 28.0001}];
  ui.exec('overlayPoints.set("run-B", fixtureExtra)');
  ui.element('place-panel').hidden = false;
  ui.element('place-radius').value = '100';
  ui.map.events.click({latlng: {lat: 47, lng: 28}});
  assert.equal(ui.element('place-results').children.length, 2);
  assert.match(ui.element('place-results').children[0].textContent, /run-A/);
  assert.match(ui.element('place-results').children[1].textContent, /run-B/);
  assert.match(ui.element('place-status').textContent, /not a complete database search/);
  assert.equal(ui.exec('placeLayer.layers.length'), 1);
});

test('source association is visible as text and never inserted as HTML', () => {
  const ui = viewer();
  const hostile = '<img src=x onerror=alert(1)>';
  ui.context.fixtureCatalogue = [
    {track_id: 'run-1', source_id: 'src_' + 'a'.repeat(24), source_label: hostile},
    {track_id: 'old-run', source_id: null, source_label: null},
  ];
  ui.exec('catalogue=fixtureCatalogue; selectedTrack="run-1"; renderLayerPanel()');
  const rows = ui.element('layers-list').children;
  assert.match(rows[0].children[1].textContent, /run-1/);
  assert.ok(rows[0].children[1].textContent.includes(hostile));
  assert.equal(rows[0].children[1].innerHTML, undefined);
  assert.match(rows[1].children[1].textContent, /unassigned/);
});

function monitorFixtures(ui) {
  const latest = new Date(Date.now() - 15_000).toISOString();
  const prior = new Date(Date.now() - 3600_000).toISOString();
  ui.context.monitorFixture = [
    {kind: 'channel', id: 'oneplus', channel_id: 'oneplus', source_label: null,
      source_id: null, track_id: 'oneplus-new', last: latest, runs: 5, mixed_sources: false},
    {kind: 'channel', id: 'lg', channel_id: 'lg', source_label: null,
      source_id: null, track_id: 'lg-old', last: prior, runs: 2, mixed_sources: false},
    {kind: 'unattributed', id: 'legacy-new', source_label: null,
      source_id: null, track_id: 'legacy-new', last: prior, runs: 20, mixed_sources: false},
  ];
  ui.context.runFixture = [
    {track_id: 'oneplus-new', last: latest}, {track_id: 'oneplus-old', last: prior},
    {track_id: 'lg-old', last: prior}, {track_id: 'legacy-new', last: prior},
  ];
  ui.context.fetch = async url => {
    if (url === '/api/monitor') return {ok: true, json: async () => ({entries: ui.context.monitorFixture})};
    if (url === '/api/tracks') return {ok: true, json: async () => ({tracks: ui.context.runFixture})};
    if (url === '/api/sources') return {ok: true, json: async () => ({sources: []})};
    if (url.startsWith('/api/runs?')) return {ok: true, json: async () =>
      ({tracks: ui.context.runFixture, next_cursor: null})};
    if (url.startsWith('/api/points/recent')) return {ok: true, json: async () => ({points: []})};
    if (url.startsWith('/api/points?')) return {ok: true, json: async () => ({points: [], next_cursor: null})};
    throw new Error('unexpected URL: ' + url);
  };
  ui.exec('tracksBusy = false'); // Initial onload poll used an intentionally suspended fetch.
}

test('Monitor lists stable channel identities, not a growing menu of recording runs', async () => {
  const ui = viewer();
  monitorFixtures(ui);
  await ui.exec('refreshTracks()');
  const select = ui.element('track');
  assert.equal(ui.element('selection-label').textContent, 'Source / channel');
  assert.equal(select.children.length, 3);
  assert.equal(select.value, 'channel:oneplus');
  assert.equal(ui.exec('selectedTrack'), 'oneplus-new');
  assert.ok(select.children[0].text.includes('oneplus'));
  assert.match(select.children[0].text, /recent receipts/);
  assert.match(select.children[1].text, /no recent receipts/);
  assert.doesNotMatch(select.children[0].text, /ago/);
  assert.match(select.children[2].text, /20 unassigned runs/);
  assert.doesNotMatch(select.children[0].text, /oneplus-old/);
});

test('Monitor follows the next run for the selected channel without joining route data', async () => {
  const ui = viewer();
  monitorFixtures(ui);
  await ui.exec('refreshTracks()');
  ui.context.monitorFixture[0] = {...ui.context.monitorFixture[0], track_id: 'oneplus-fresh', runs: 6};
  ui.context.runFixture.unshift({track_id: 'oneplus-fresh', last: new Date().toISOString()});
  await ui.exec('refreshTracks()');
  assert.equal(ui.element('track').value, 'channel:oneplus');
  assert.equal(ui.exec('selectedTrack'), 'oneplus-fresh');
  assert.equal(ui.exec('points.length'), 0); // Old run's points cleared.
});

test('History keeps independent runs and remembers its choice when returning from Monitor', async () => {
  const ui = viewer();
  monitorFixtures(ui);
  await ui.exec('refreshTracks()');
  ui.exec('setMode("history")');
  assert.equal(ui.element('selection-label').textContent, 'Recording run');
  assert.equal(ui.element('track').children.length, 4);
  ui.element('track').value = 'oneplus-old';
  ui.element('track').events.change();
  assert.equal(ui.exec('selectedTrack'), 'oneplus-old');
  ui.exec('setMode("live")');
  assert.equal(ui.exec('selectedTrack'), 'oneplus-new');
  ui.exec('setMode("history")');
  assert.equal(ui.exec('selectedTrack'), 'oneplus-old');
});

test('Monitor labels mixed source assertions without treating the latest label as universal', () => {
  const ui = viewer();
  const injected = '<img src=x onerror=alert(1)>';
  ui.context.injected = injected;
  ui.exec('monitorCatalogue = [{kind:"channel",id:"lab",track_id:"x",source_label:injected,mixed_sources:true,last:new Date().toISOString()}]');
  assert.match(ui.exec('monitorLabel(monitorCatalogue[0])'), /mixed source assertions/);
  assert.doesNotMatch(ui.exec('monitorLabel(monitorCatalogue[0])'), /<img/);
  ui.exec('monitorCatalogue[0].mixed_sources=false; updateSelector()');
  const item = ui.element('track').children[0];
  assert.ok(item.text.includes(injected));
  assert.equal(item.innerHTML, undefined);
});

test('Monitor displays current locations from two distant channels without joining their tracks', async () => {
  const ui = viewer();
  monitorFixtures(ui);
  const now = new Date(Date.now() - 10_000).toISOString();
  ui.context.monitorFixture[0] = {...ui.context.monitorFixture[0], lat: 47.75, lon: 27.88, last: now};
  ui.context.monitorFixture[1] = {...ui.context.monitorFixture[1], lat: 50.08, lon: 14.41, last: now};
  await ui.exec('refreshTracks()');
  const markers = ui.exec('monitorLayer.layers');
  assert.equal(markers.length, 2);
  assert.equal(ui.exec('monitorPositions().length'), 2);
  assert.equal(markers[0].positions[0], 47.75);
  assert.equal(markers[1].positions[0], 50.08);
  assert.equal(ui.exec('overlayLayers.size'), 0); // Not joined as one route.
  assert.equal(ui.element('monitor-count').textContent.includes('2 positions shown'), true);
  ui.element('camera').value = 'visible';
  ui.element('camera').events.change();
  assert.equal(JSON.stringify(ui.fitted.at(-1)), JSON.stringify([[47.75, 27.88], [50.08, 14.41]]));
  assert.equal(ui.exec('cameraMode'), 'visible');
});

test('Free camera never pans on new GPS observations; manual pan disables follow', async () => {
  const ui = viewer();
  monitorFixtures(ui);
  ui.context.monitorFixture[0] = {...ui.context.monitorFixture[0], lat: 47.75, lon: 27.88};
  await ui.exec('refreshTracks()');
  ui.exec('initialMonitorFit = false');
  ui.element('camera').value = 'free';
  ui.element('camera').events.change();
  const first = {...point(0), time: new Date().toISOString()};
  ui.context.fixturePoints = [first];
  ui.exec('points=fixturePoints; selectedTrack="oneplus-new"; render(false)');
  ui.context.fixturePoints = [first, {...first, id: 2, lat: 47.751, time: new Date().toISOString()}];
  ui.exec('points=fixturePoints; render(false)');
  assert.equal(ui.pans.length, 0);
  assert.equal(ui.fitted.length, 0);
  ui.element('camera').value = 'selected';
  ui.element('camera').events.change();
  assert.equal(ui.pans.length, 1);
  ui.map.events.dragstart();
  assert.equal(ui.exec('cameraMode'), 'free');
  assert.equal(ui.element('camera').value, 'free');
  ui.exec('render(false)');
  assert.equal(ui.pans.length, 1);
});

test('Follow visible only reframes when a selected location moves outside the inner viewport', async () => {
  const ui = viewer();
  monitorFixtures(ui);
  const now = new Date().toISOString();
  ui.context.monitorFixture[0] = {...ui.context.monitorFixture[0], lat: 47.75, lon: 27.88, last: now};
  ui.context.monitorFixture[1] = {...ui.context.monitorFixture[1], lat: 50.08, lon: 14.41, last: now};
  await ui.exec('refreshTracks()');
  ui.element('camera').value = 'visible';
  ui.element('camera').events.change();
  const initial = ui.fitted.length;
  ui.viewport.contains = () => true;
  ui.exec('updateMonitorCamera()');
  assert.equal(ui.fitted.length, initial);
  ui.viewport.contains = () => false;
  ui.exec('updateMonitorCamera()');
  assert.equal(ui.fitted.length, initial + 1);
  ui.map.events.zoomstart();
  assert.equal(ui.exec('cameraMode'), 'free');
});

test('Inactive positions stay hidden unless selected or explicitly enabled', async () => {
  const ui = viewer();
  monitorFixtures(ui);
  ui.context.monitorFixture[0] = {...ui.context.monitorFixture[0], lat: 47.75, lon: 27.88};
  ui.context.monitorFixture[1] = {...ui.context.monitorFixture[1], lat: 50.08, lon: 14.41};
  await ui.exec('refreshTracks()');
  assert.equal(ui.exec('monitorLayer.layers.length'), 1); // Stale LG omitted.
  ui.element('show-inactive').checked = true;
  ui.element('show-inactive').events.change();
  assert.equal(ui.exec('monitorLayer.layers.length'), 2);
  ui.exec('monitorLayer.layers[1]').events.click();
  assert.equal(ui.exec('selectedMonitorKey'), 'channel:lg');
  assert.equal(ui.exec('selectedTrack'), 'lg-old');
  assert.equal(ui.exec('points.length'), 0); // New run data will load separately.
});

test('History pages past the catalogue limit and filters by exact channel', async () => {
  const ui = viewer();
  monitorFixtures(ui);
  await ui.exec('refreshTracks()');
  ui.exec('setMode("history")');
  // Older run pages are not limited to the latest 100-run selector.
  ui.context.fetch = async url => {
    if (url.startsWith('/api/runs?')) {
      const before = new URL('http://localhost' + url).searchParams.get('before');
      return {ok: true, json: async () => before
        ? {tracks: [{track_id: 'old-page-run', first: new Date().toISOString(), last: new Date().toISOString(), count: 1}], next_cursor: null}
        : {tracks: [{track_id: 'new-page-run', first: new Date().toISOString(), last: new Date().toISOString(), count: 2}], next_cursor: '123'}};
    }
    if (url.startsWith('/api/points?')) return {ok: true, json: async () => ({points: [], next_cursor: null})};
    return {ok: true, json: async () => ({points: []})};
  };
  await ui.exec('loadRunPage(true)');
  assert.equal(ui.element('older-runs').hidden, false);
  assert.equal(ui.exec('historyRunList.length'), 1);
  await ui.exec('loadRunPage(false)');
  assert.equal(ui.exec('historyRunList.length'), 2);
  assert.equal(ui.element('older-runs').hidden, true);
  assert.equal(ui.element('track').children.length >= 2, true);
  ui.element('history-filter').value = 'channel:oneplus';
  ui.element('history-filter').events.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.exec('historyFilter'), 'channel:oneplus');
  assert.equal(ui.exec('historyRunList.length'), 1);
});

test('Monitor and History use operator display labels as text, not as HTML', async () => {
  const ui = viewer();
  monitorFixtures(ui);
  const hostile = '<img src=x onerror=alert(1)>';
  ui.context.monitorFixture[0] = {...ui.context.monitorFixture[0], channel_label: hostile, lat: 47.75, lon: 27.88};
  await ui.exec('refreshTracks()');
  assert.equal(ui.element('track').children[0].text.includes(hostile), true);
  assert.equal(ui.exec('monitorLayer.layers[0].tooltip.textContent').includes(hostile), true);
  assert.equal(ui.exec('monitorLayer.layers[0].tooltip.innerHTML'), undefined);
});

test('Identical coordinates show one marker with separate source choices, not a merged run', async () => {
  const ui = viewer();
  monitorFixtures(ui);
  const now = new Date().toISOString();
  ui.context.monitorFixture[0] = {...ui.context.monitorFixture[0], lat: 47.75, lon: 27.88, last: now};
  ui.context.monitorFixture[1] = {...ui.context.monitorFixture[1], lat: 47.75, lon: 27.88, last: now};
  await ui.exec('refreshTracks()');
  assert.equal(ui.exec('monitorPositions().length'), 2);
  assert.equal(ui.exec('monitorLayer.layers.length'), 1);
  const pin = ui.exec('monitorLayer.layers[0]');
  assert.match(pin.tooltip.textContent, /2 sources at identical reported coordinates/);
  pin.events.click();
  assert.equal(ui.popup.content.children.length, 2);
  assert.match(ui.popup.content.children[0].textContent, /oneplus/);
  assert.match(ui.popup.content.children[1].textContent, /lg/);
  ui.popup.content.children[1].events.click();
  assert.equal(ui.exec('selectedMonitorKey'), 'channel:lg');
  assert.equal(ui.exec('selectedTrack'), 'lg-old');
  assert.equal(ui.exec('overlayLayers.size'), 0);
});

test('Explicit selection focuses a different city once, without future free-camera jumps', async () => {
  const ui = viewer();
  monitorFixtures(ui);
  const now = new Date().toISOString();
  ui.context.monitorFixture[0] = {...ui.context.monitorFixture[0], lat: 47.75, lon: 27.88, last: now};
  ui.context.monitorFixture[1] = {...ui.context.monitorFixture[1], lat: 50.08, lon: 14.41, last: now};
  await ui.exec('refreshTracks()');
  ui.element('track').value = 'channel:lg';
  ui.element('track').events.change();
  // Loading the new run uses an explicit one-shot focus, rather than fitting all.
  ui.exec('updateMonitorCamera()');
  assert.equal(ui.pans.length, 1);
  assert.equal(ui.pans[0][0], 50.08);
  ui.exec('updateMonitorCamera()');
  assert.equal(ui.pans.length, 1);
});

test('recorded place search is explicit, paged and independent of loaded fixes', async () => {
  const ui = viewer();
  ui.render([point(0)], 'history', 'selected-run');
  ui.element('place-panel').hidden = false;
  ui.element('place-radius').value = '100';
  ui.map.events.click({latlng: {lat: 47, lng: 28}});
  assert.equal(ui.element('place-search').disabled, false);
  assert.equal(ui.element('place-results').children.length, 1); // Loaded view remains intact.
  const urls = [];
  ui.context.fetch = async url => {
    urls.push(url);
    return {ok: true, json: async () => urls.length === 1 ? {
      points: [{...point(0), track_id: 'run-elsewhere',
        channel_id: 'gpsd.a', channel_label: '<img src=x onerror=alert(1)>',
        distance_m: 10, accuracy_m: 15}], next_cursor: '123'
    } : {
      points: [{...point(0), track_id: 'older-run', distance_m: 20}], next_cursor: null
    }};
  };
  await ui.exec('searchRecordedPlace()');
  assert.equal(ui.element('place-db-results').children.length, 1);
  assert.match(ui.element('place-db-results').children[0].textContent, /run-elsewhere/);
  assert.match(ui.element('place-db-results').children[0].textContent, /Reported accuracy 15 m/);
  assert.equal(ui.element('place-db-results').children[0].innerHTML, undefined);
  assert.equal(ui.element('place-next').hidden, false);
  await ui.exec('searchRecordedPlace(true)');
  assert.match(urls[1], /before=123/);
  assert.equal(ui.element('place-db-results').children.length, 2);
  assert.equal(ui.element('place-next').hidden, true);
  assert.match(ui.element('place-db-status').textContent, /Search complete/);
  assert.equal(ui.element('place-results').children.length, 1);
  assert.match(urls[0], /^\/api\/place\/observations\?/);
});

test('place search does not mistake an empty page for complete coverage', async () => {
  const ui = viewer();
  ui.render([], 'history');
  ui.element('place-panel').hidden = false;
  ui.element('place-radius').value = '250';
  ui.map.events.click({latlng: {lat: 47, lng: 28}});
  ui.context.fetch = async () => ({ok: true, json: async () => ({
    points: [], scanned: 2000, next_cursor: '19'
  })});
  await ui.exec('searchRecordedPlace()');
  assert.equal(ui.element('place-db-results').children.length, 0);
  assert.equal(ui.element('place-next').hidden, false);
  assert.match(ui.element('place-db-status').textContent, /Older candidates remain/);
});

test('changing the selected place invalidates a pending database response', async () => {
  const ui = viewer();
  ui.render([], 'history');
  ui.element('place-panel').hidden = false;
  ui.element('place-radius').value = '50';
  ui.map.events.click({latlng: {lat: 47, lng: 28}});
  let finish;
  ui.context.fetch = () => new Promise(resolve => {finish = resolve;});
  const pending = ui.exec('searchRecordedPlace()');
  ui.map.events.click({latlng: {lat: 48, lng: 29}});
  finish({ok: true, json: async () => ({points: [{...point(0), track_id: 'old'}], next_cursor: null})});
  await pending;
  assert.equal(ui.element('place-db-results').children.length, 0);
  assert.match(ui.element('place-db-status').textContent, /Search recorded history/);
  assert.equal(ui.element('place-search').disabled, false);
});


test('place query converts local receipt bounds, filters source and resets on changes', async () => {
  const ui = viewer();
  ui.render([], 'history');
  ui.element('place-panel').hidden = false;
  ui.map.events.click({latlng: {lat: 47, lng: 28}});
  ui.element('place-scope').value = 'source:src_' + 'a'.repeat(24);
  ui.element('place-from').value = '2026-11-03T10:00:00';
  ui.element('place-to').value = '2026-11-03T11:00:00';
  const urls = [];
  ui.context.fetch = async url => {
    urls.push(url);
    return {ok: true, json: async () => ({points: [], next_cursor: '40'})};
  };
  await ui.exec('searchRecordedPlace()');
  const query = new URL(urls[0], 'http://localhost').searchParams;
  assert.equal(query.get('source_id'), 'src_' + 'a'.repeat(24));
  assert.equal(query.get('channel_id'), null);
  assert.equal(query.get('from'), new Date(2026, 10, 3, 10, 0, 0).toISOString());
  assert.equal(query.get('to'), new Date(2026, 10, 3, 11, 0, 0).toISOString());
  assert.equal(ui.element('place-next').hidden, false);
  ui.element('place-scope').value = 'channel:gpsd.oneplus';
  ui.element('place-scope').events.change();
  assert.equal(ui.element('place-next').hidden, true);
  assert.match(ui.element('place-db-status').textContent, /Search recorded history/);
  await ui.exec('searchRecordedPlace()');
  const second = new URL(urls[1], 'http://localhost').searchParams;
  assert.equal(second.get('channel_id'), 'gpsd.oneplus');
  assert.equal(second.get('source_id'), null);
  assert.equal(second.has('before'), false);
});

test('invalid receipt-time interval sends no request or stale results', async () => {
  const ui = viewer();
  ui.render([], 'history');
  ui.element('place-panel').hidden = false;
  ui.map.events.click({latlng: {lat: 47, lng: 28}});
  ui.element('place-from').value = '2026-11-03T11:00:00';
  ui.element('place-to').value = '2026-11-03T10:00:00';
  let count = 0;
  ui.context.fetch = () => {count++; return Promise.reject(new Error('fetch must not run'));};
  await ui.exec('searchRecordedPlace()');
  assert.equal(count, 0);
  assert.match(ui.element('place-db-status').textContent, /From must precede To/);
  assert.equal(ui.element('place-search').disabled, false);
});

test('matching-fix groups stay within each run, expose gaps and remain partial', async () => {
  const ui = viewer();
  ui.render([], 'history');
  ui.element('place-panel').hidden = false;
  ui.map.events.click({latlng: {lat: 47, lng: 28}});
  const fix = (id, run, minute, label) => ({
    id, track_id: run, time: new Date(Date.UTC(2026, 10, 3, 10, minute)).toISOString(),
    channel_label: label, distance_m: 30, lat: 47, lon: 28,
  });
  const pages = [
    {points: [fix(6,'run-a',9,'<svg onload=attack()>'), fix(5,'run-b',8,'B'),
      fix(4,'run-a',7,'A')], next_cursor: '3'},
    {points: [fix(3,'run-a',0,'A'), fix(2,'run-b',1,'B')], next_cursor: null},
  ];
  let calls = 0;
  ui.context.fetch = async () => ({ok: true, json: async () => pages[calls++]});
  await ui.exec('searchRecordedPlace()');
  assert.equal(ui.element('place-clusters').children.length, 2);
  await ui.exec('searchRecordedPlace(true)');
  assert.equal(ui.element('place-clusters').children.length, 4);
  assert.equal(ui.element('place-db-results').children.length, 5);
  assert.match(ui.element('place-cluster-status').textContent, /not visits/);
  assert.match(ui.element('place-clusters').children.map(x => x.textContent).join(' '), /2 matching fixes/);
  assert.equal(ui.element('place-clusters').children[0].innerHTML, undefined); // textContent only
  ui.element('place-from').events.change();
  assert.equal(ui.element('place-clusters').children.length, 0);
});

test('place scope choices reuse known identities without selecting a History run', () => {
  const ui = viewer();
  ui.context.fixtureMonitor = [{kind:'channel', id:'gpsd.a', channel_id:'gpsd.a',
    channel_label:'GPSD receiver A'}];
  ui.context.fixtureSources = [{source_id:'src_' + 'b'.repeat(24), label:'Phone B'}];
  ui.exec('monitorCatalogue = fixtureMonitor; sourceCatalogue = fixtureSources; historyFilter = ""; updateHistoryFilter()');
  const scopes = ui.element('place-scope').children;
  assert.equal(scopes.length, 3);
  assert.equal(scopes[1].value, 'channel:gpsd.a');
  assert.equal(scopes[2].value, 'source:src_' + 'b'.repeat(24));
  assert.equal(ui.exec('historyFilter'), '');
});

function placeEvidence(id, track, minute, {source = null, channel = null,
  accuracy = null, reportedAt = null, lat = 47, lon = 28} = {}) {
  return {id, track_id: track, source_id: source, channel_id: channel,
    lat, lon, accuracy_m: accuracy,
    measured_time: reportedAt,
    time: new Date(Date.UTC(2026, 10, 3, 10, 0) + minute * 60_000).toISOString(),
    distance_m: 10};
}

test('temporal proximity keeps source claims separate and excludes same-source channels', () => {
  const ui = viewer();
  const sourceA = 'src_' + 'a'.repeat(24);
  const sourceB = 'src_' + 'b'.repeat(24);
  const fixes = [
    placeEvidence(1, 'a-gpsd', 0, {source: sourceA, channel: 'gpsd.a'}),
    placeEvidence(2, 'a-msf', 0.5, {source: sourceA, channel: 'msf.a'}),
    placeEvidence(3, 'b-gpsd', 1, {source: sourceB, channel: 'gpsd.b'}),
    placeEvidence(4, 'different-source-same-input', 1, {source: sourceB, channel: 'gpsd.a'}),
    placeEvidence(5, 'anonymous', 1),
  ];
  ui.context.fixtureProximity = fixes;
  const pairs = ui.exec('temporalProximityWitnesses(fixtureProximity, 60000)');
  assert.equal(pairs.length, 1); // Only a-msf/b-gpsd survives mixed-channel exclusion
  assert(pairs.every(p => p.identity.kind === 'source'));
  assert(pairs.every(p => ![p.a, p.b].some(v => v.track_id === 'anonymous')));
  assert(pairs.every(p => ![p.a, p.b].some(v => v.track_id === 'different-source-same-input')));
  assert.equal(ui.exec('mixedSourceChannels(fixtureProximity).has("gpsd.a")'), true);
});

test('different unassigned channels are comparison candidates, not verified sources', () => {
  const ui = viewer();
  ui.context.fixtureProximity = [
    placeEvidence(1, 'oneplus-1', 0, {channel: 'gpsd.oneplus', accuracy: 8}),
    placeEvidence(2, 'lg-1', 3, {channel: 'gpsd.lg', accuracy: 15}),
    placeEvidence(3, 'lg-2', 3.5, {channel: 'gpsd.lg'}),
  ];
  const pairs = ui.exec('temporalProximityWitnesses(fixtureProximity, 300000)');
  assert.equal(pairs.length, 2);
  assert(pairs.every(p => p.identity.kind === 'channel'));
  assert(pairs.every(p => p.separation === 0));
  assert.equal(ui.exec('temporalProximityWitnesses(fixtureProximity, 60000).length'), 0);
});

test('proximity follows receiver receipt clock, not reported GPS acquisition clock', () => {
  const ui = viewer();
  ui.context.fixtureProximity = [
    placeEvidence(1, 'a', 0, {channel: 'gpsd.a', reportedAt: '2026-05-01T01:00:00Z'}),
    placeEvidence(2, 'b', 3, {channel: 'gpsd.b', reportedAt: '2026-05-01T01:00:00Z'}),
  ];
  assert.equal(ui.exec('temporalProximityWitnesses(fixtureProximity, 60000).length'), 0);
  assert.equal(ui.exec('temporalProximityWitnesses(fixtureProximity, 300000)[0].difference'), 180000);
});

test('place witness comparisons update across pages, windows and changed locations', async () => {
  const ui = viewer();
  ui.render([], 'history');
  ui.element('place-panel').hidden = false;
  ui.element('place-radius').value = '100';
  ui.element('place-proximity-window').value = '5';
  ui.map.events.click({latlng: {lat: 47, lng: 28}});
  const pages = [
    {points: [placeEvidence(3, 'b', 3, {channel: 'gpsd.b', accuracy: 7})], next_cursor: '2'},
    {points: [placeEvidence(2, 'a', 1, {channel: 'gpsd.a', accuracy: 12})], next_cursor: null},
  ];
  let requests = 0;
  ui.context.fetch = async () => ({ok: true, json: async () => pages[requests++]});
  await ui.exec('searchRecordedPlace()');
  assert.equal(ui.element('place-proximity-results').children.length, 0);
  assert.match(ui.element('place-proximity-status').textContent, /incomplete retrieved coverage/);
  await ui.exec('searchRecordedPlace(true)');
  const entries = ui.element('place-proximity-results').children;
  assert.equal(entries.length, 1);
  assert.match(entries[0].textContent, /Different channel claims only/);
  assert.match(entries[0].textContent, /Δt 120s/);
  assert.match(entries[0].textContent, /reported accuracy 12 m \/ 7 m/);
  assert.equal(entries[0].innerHTML, undefined); // No operator-controlled HTML interpolation.
  assert.match(ui.element('place-proximity-status').textContent, /retrieved search complete/);
  ui.element('place-proximity-window').value = '1';
  ui.element('place-proximity-window').events.change();
  assert.equal(ui.element('place-proximity-results').children.length, 0);
  ui.element('place-proximity-window').value = '5';
  ui.element('place-proximity-window').events.change();
  assert.equal(ui.element('place-proximity-results').children.length, 1);
  ui.map.events.click({latlng: {lat: 48, lng: 29}});
  assert.equal(ui.element('place-proximity-results').children.length, 0);
  assert.match(ui.element('place-proximity-status').textContent, /Search recorded history/);
});

test('proximity output counts repeated observation pairs, not encounters, and caps display', () => {
  const ui = viewer();
  const fixes = [];
  for (let i = 0; i < 20; i++) {
    fixes.push(placeEvidence(i * 2 + 1, 'a', i / 100, {channel: 'gpsd.a'}));
    fixes.push(placeEvidence(i * 2 + 2, 'b', i / 100, {channel: 'gpsd.b'}));
  }
  ui.context.fixtureProximity = fixes;
  ui.exec('placeSearchMatches = fixtureProximity; placeSearchCount = fixtureProximity.length; placeSearchCursor = null; renderPlaceProximity()');
  assert.equal(ui.element('place-proximity-results').children.length, 40);
  assert.match(ui.element('place-proximity-status').textContent, /400 qualifying observation pairs/);
  assert.match(ui.element('place-proximity-status').textContent, /not meetings/);
});

test('cross-run search finds witnesses from the database, not just loaded History points', async () => {
  const ui = viewer();
  ui.render([point(0)], 'history', 'run-a');
  ui.element('proximity-panel').hidden = false;
  ui.element('proximity-other').value = 'run-b';
  ui.element('proximity-radius').value = '100';
  ui.element('proximity-window').value = '300';
  const requests = [];
  const a = {...point(0), track_id: 'run-a', channel_id: 'gpsd.a', source_label: '<b>unsafe</b>'};
  const b = {...point(1), track_id: 'run-b', channel_id: 'gpsd.b', accuracy_m: 7};
  ui.context.fetch = async url => {
    requests.push(url);
    return {ok: true, json: async () => requests.length === 1
      ? {pairs: [{a, b, identity_kind: 'channel', distance_m: 18, receipt_delta_ms: 5000}],
         scanned: 20, next_cursor: '1800000000000:77', candidate_limited: false}
      : {pairs: [], scanned: 5, next_cursor: null, candidate_limited: true}};
  };
  await ui.exec('searchRunProximity()');
  assert.match(requests[0], /^\/api\/proximity\?/);
  assert.match(requests[0], /other_track_id=run-b/);
  assert.equal(ui.element('proximity-results').children.length, 1);
  assert.match(ui.element('proximity-results').children[0].children[0].textContent,
    /Different channel claims only/);
  assert.match(ui.element('proximity-results').children[0].children[0].textContent, /unsafe/);
  assert.equal(ui.element('proximity-results').children[0].children[0].innerHTML, undefined);
  assert.equal(ui.exec('proximityLayer.layers.length'), 0); // Results never move map automatically.
  ui.element('proximity-results').children[0].children[1].events.click();
  assert.equal(ui.exec('proximityLayer.layers.length'), 2);
  assert.equal(ui.fitted.length, 1);
  assert.equal(ui.exec('overlayLayers.size'), 0); // No fake joined path.
  await ui.exec('searchRunProximity(true)');
  assert.match(requests[1], /before=1800000000000%3A77/);
  assert.match(ui.element('proximity-status').textContent, /candidate.*may be missing/);
  assert.equal(ui.element('proximity-next').hidden, true);
  assert.equal(ui.element('proximity-results').children.length, 1);
});

test('cross-run search refuses same run and invalidates stale replies on selection changes', async () => {
  const ui = viewer();
  ui.render([], 'history', 'run-a');
  ui.element('proximity-panel').hidden = false;
  ui.element('proximity-other').value = 'run-a';
  let calls = 0;
  ui.context.fetch = () => {calls++; return new Promise(() => {});};
  await ui.exec('searchRunProximity()');
  assert.equal(calls, 0);
  assert.match(ui.element('proximity-status').textContent, /different recording runs/);
  ui.element('proximity-other').value = 'run-b';
  let reply;
  ui.context.fetch = () => new Promise(resolve => {reply = resolve;});
  const pending = ui.exec('searchRunProximity()');
  ui.element('proximity-other').value = 'run-c';
  ui.element('proximity-other').events.change();
  reply({ok: true, json: async () => ({pairs: [{a: point(0), b: point(1)}], scanned: 1,
    next_cursor: null, candidate_limited: false})});
  await pending;
  assert.equal(ui.element('proximity-results').children.length, 0);
  assert.match(ui.element('proximity-status').textContent, /Choose two recording runs/);
});

test('cross-run query uses History bounds only when explicitly enabled', async () => {
  const ui = viewer();
  ui.render([], 'history', 'run-a');
  ui.element('proximity-panel').hidden = false;
  ui.element('proximity-other').value = 'run-b';
  ui.element('proximity-radius').value = '50';
  ui.element('proximity-window').value = '60';
  const requests = [];
  ui.context.fetch = async url => {
    requests.push(url);
    return {ok: true, json: async () => ({pairs: [], scanned: 0, next_cursor: null,
      candidate_limited: false})};
  };
  await ui.exec('searchRunProximity()');
  assert.equal(requests[0].includes('from='), false);
  ui.element('proximity-interval').checked = true;
  ui.element('from').value = '2026-11-04T10:00:00';
  ui.element('to').value = '2026-11-04T09:00:00';
  await ui.exec('searchRunProximity()');
  assert.equal(requests.length, 1);
  assert.match(ui.element('proximity-status').textContent, /From must precede To/);
  ui.element('to').value = '2026-11-04T12:00:00';
  await ui.exec('searchRunProximity()');
  assert.match(requests[1], /from=/);
  assert.match(requests[1], /to=/);
});

test('exactly coincident cross-run fixes are displayed as one labeled map symbol', () => {
  const ui = viewer();
  const a = {...point(0), track_id: 'run-a'};
  const b = {...point(0), track_id: 'run-b'};
  ui.context.fixturePair = {a, b};
  ui.exec('showRunWitness(fixturePair)');
  assert.equal(ui.exec('proximityLayer.layers.length'), 1);
  const pin = ui.exec('proximityLayer.layers[0]');
  assert.match(pin.tooltip.textContent, /run-a.*run-b/);
  assert.equal(pin.type, 'circle');
});


test('comparison suggestions include unfiltered runs and allow explicit older run IDs', () => {
  const ui = viewer();
  ui.render([], 'history', 'focused');
  ui.context.browseSuggestions = [
    {track_id: 'focused', first: point(0).time, last: point(0).time},
    {track_id: 'same-filter', first: point(0).time, last: point(1).time}
  ];
  ui.context.otherSuggestions = [
    {track_id: 'other-source', first: point(0).time, last: point(1).time}
  ];
  ui.exec('historyRunList = browseSuggestions; historyLoaded = true; catalogue = otherSuggestions; updateProximityChoices()');
  assert.equal(ui.element('proximity-known-runs').children.length, 2);
  ui.element('proximity-other').value = 'old-run-not-in-catalogue';
  ui.exec('updateProximityChoices()');
  assert.equal(ui.element('proximity-other').value, 'old-run-not-in-catalogue');
  ui.exec('selectedTrack = "old-run-not-in-catalogue"; updateProximityChoices()');
  assert.notEqual(ui.element('proximity-other').value, 'old-run-not-in-catalogue');
});

test('older comparison pages respect the cumulative display limit', async () => {
  const ui = viewer();
  ui.render([], 'history', 'run-a');
  ui.element('proximity-panel').hidden = false;
  ui.element('proximity-other').value = 'run-b';
  ui.exec('proximityCount = 95; proximityCursor = "1800000000000:100"');
  let request;
  ui.context.fetch = async url => {
    request = url;
    return {ok: true, json: async () => ({pairs: Array.from({length: 5}, () => ({
      a: {...point(0), track_id: 'run-a'}, b: {...point(1), track_id: 'run-b'},
      identity_kind: 'channel', distance_m: 20, receipt_delta_ms: 1000
    })), scanned: 5, next_cursor: '1800000000000:90', candidate_limited: false})};
  };
  await ui.exec('searchRunProximity(true)');
  assert.equal(new URL('http://localhost' + request).searchParams.get('limit'), '5');
  assert.equal(ui.exec('proximityCount'), 100);
  assert.equal(ui.element('proximity-next').hidden, true);
});
