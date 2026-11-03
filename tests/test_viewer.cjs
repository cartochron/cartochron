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
      value: '', max: '', hidden: false, textContent: '', disabled: false,
      events: {}, addEventListener(name, fn) { this.events[name] = fn; },
      setAttribute() {},
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
    panTo() {}, invalidateSize() {},
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
      createElement() { return {textContent: ''}; },
    },
    L: {
      map: () => map,
      tileLayer: () => ({addTo() {}}),
      layerGroup: newGroup,
      polyline: (coords, options) => shape('polyline', coords, options),
      circleMarker: (coords, options) => shape('circle', coords, options),
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
  return {render, exec, element, group: groups[0], comparison: groups[1], popup, context, fitted};
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

test('history overlay separates runs and labels their observations independently', async () => {
  const ui = viewer();
  const primary = [point(0), point(1), point(2)];
  ui.render(primary, 'history', 'run-A');
  const other = [point(0), point(1)];
  ui.context.fetch = async url => ({
    ok: true, json: async () => ({points: other, next_cursor: null}),
  });
  ui.exec('bounds = {from:"2026-11-02T00:00:00Z", to:"2026-11-03T00:00:00Z"}; compareTrack="run-B"');
  await ui.exec('loadComparison()');
  assert.equal(ui.group.layers.filter(layer => layer.type === 'polyline').length, 1);
  assert.equal(ui.comparison.layers.filter(layer => layer.type === 'polyline').length, 1);
  const overlayNode = ui.comparison.layers.find(layer => layer.type === 'circle');
  assert.ok(overlayNode.tooltip.textContent.includes('run-B'));
  overlayNode.events.click();
  assert.match(ui.popup.content.textContent, /run-B/);
  assert.equal(ui.element('position').value, '0'); // Overlay does not move primary slider.
  assert.equal(ui.element('compare-status').textContent, '2 overlay fixes');
});

test('a single recorded fix gets one interactive node but no invented route', () => {
  const ui = viewer();
  const layers = ui.render([point(0)]);
  assert.equal(layers.filter(layer => layer.type === 'polyline').length, 0);
  const nodes = layers.filter(layer => layer.type === 'circle');
  assert.equal(nodes.length, 2); // Fix and magenta inspection selection.
  nodes[0].events.click();
  assert.match(ui.element('detail').textContent, /1\/1/);
});

// Regression for an operator selecting a recently recorded run and overlaying
// a historical run whose timestamps fall outside the selected interval.
test('Entire run overlays old tracks and fits both tracks into the map', async () => {
  const ui = viewer();
  const recent = [
    {...point(0), lat: 50.075, lon: 14.414},
    {...point(1), lat: 50.076, lon: 14.415},
  ];
  ui.render(recent, 'history', 'demo-replay');
  const old = [
    {...point(0), lat: 48.850, lon: 2.335},
    {...point(1), lat: 48.851, lon: 2.336},
  ];
  const queries = [];
  ui.context.fetch = async url => {
    queries.push(url);
    return {ok: true, json: async () => ({points: old, next_cursor: null})};
  };
  ui.exec('bounds = {from:"2026-11-02T21:47:05Z", to:"2026-11-02T21:47:23Z"}; compareTrack="demo-long-history"');
  await ui.exec('loadComparison()');
  const query = new URL('http://localhost' + queries[0]);
  assert.equal(query.searchParams.get('track_id'), 'demo-long-history');
  assert.equal(query.searchParams.has('from'), false);
  assert.equal(query.searchParams.has('to'), false);
  assert.equal(ui.comparison.layers.filter(layer => layer.type === 'polyline').length, 1);
  assert.equal(ui.element('compare-time-control').hidden, false);
  assert.equal(ui.element('compare-status').textContent, '2 overlay fixes');
  assert.equal(ui.fitted.length, 2); // Primary on selection; union after overlay load.
  const fittedCoords = ui.fitted.at(-1);
  assert.equal(fittedCoords.length, 4);
  assert.ok(fittedCoords.some(([lat, lon]) => lat === 48.850 && lon === 2.335));
  assert.ok(fittedCoords.some(([lat, lon]) => lat === 50.075 && lon === 14.414));
});

test('Same interval filters the overlay and explains empty results', async () => {
  const ui = viewer();
  ui.render([point(0), point(1)], 'history', 'demo-replay');
  const requests = [];
  ui.element('compare-time').value = 'interval';
  ui.context.fetch = async url => {
    requests.push(url);
    return {ok: true, json: async () => ({points: [], next_cursor: null})};
  };
  ui.exec('bounds = {from:"2026-11-02T21:47:05Z", to:"2026-11-02T21:47:23Z"}; compareTrack="demo-long-history"');
  await ui.exec('loadComparison()');
  const params = new URL('http://localhost' + requests[0]).searchParams;
  assert.equal(params.get('from'), '2026-11-02T21:47:05Z');
  assert.equal(params.get('to'), '2026-11-02T21:47:23Z');
  assert.equal(ui.comparison.layers.length, 0);
  assert.match(ui.element('compare-status').textContent, /try Entire run/);
  assert.equal(ui.fitted.length, 1); // Empty overlay must not reset the viewport.
});

test('clearing the overlay hides its time control and removes its layers', async () => {
  const ui = viewer();
  ui.render([point(0), point(1)], 'history', 'run-A');
  ui.context.fetch = async () => ({ok: true, json: async () => ({points: [point(0), point(1)], next_cursor: null})});
  ui.exec('bounds = {from:"2026-11-02T00:00:00Z", to:"2026-11-03T00:00:00Z"}; compareTrack="run-B"');
  await ui.exec('loadComparison()');
  assert.ok(ui.comparison.layers.length);
  ui.exec('compareTrack = ""');
  await ui.exec('loadComparison()');
  assert.equal(ui.comparison.layers.length, 0);
  assert.equal(ui.element('compare-time-control').hidden, true);
});
