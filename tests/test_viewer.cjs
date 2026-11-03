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
  const group = {
    layers: [], addTo() { return this; },
    clearLayers() { this.layers = []; },
    removeLayer(layer) { this.layers = this.layers.filter(item => item !== layer); },
  };
  const popup = {
    setLatLng(value) { this.position = value; return this; },
    setContent(value) { this.content = value; return this; },
    openOn() { return this; },
  };
  const map = {
    setView() { return this; }, fitBounds() {}, panTo() {}, invalidateSize() {},
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
      layerGroup: () => group,
      polyline: (coords, options) => shape('polyline', coords, options),
      circleMarker: (coords, options) => shape('circle', coords, options),
      latLngBounds: () => ({getCenter: () => [0, 0]}),
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
    return group.layers;
  }
  return {render, exec, element, group, popup};
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

test('a single recorded fix gets one interactive node but no invented route', () => {
  const ui = viewer();
  const layers = ui.render([point(0)]);
  assert.equal(layers.filter(layer => layer.type === 'polyline').length, 0);
  const nodes = layers.filter(layer => layer.type === 'circle');
  assert.equal(nodes.length, 2); // Fix and magenta inspection selection.
  nodes[0].events.click();
  assert.match(ui.element('detail').textContent, /1\/1/);
});
