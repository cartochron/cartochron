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
  const map = {
    setView() { return this; }, fitBounds(bounds) { fitted.push(bounds.coords); },
    on(name, fn) {this.events = this.events || {}; this.events[name] = fn; return this;},
    panTo() {}, invalidateSize() {}, removeLayer() {},
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
    URLSearchParams, Date, Option: class {},
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
  return {render, exec, element, group: groups[0], groups, map, popup, context, fitted};
}

function point(i, minutes = i) {
  return {
    id: i + 1, lat: 47 + i * 0.001, lon: 28 + i * 0.001,
    time: new Date(Date.UTC(2026, 10, 2, 12, minutes)).toISOString(),
  };
}

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
