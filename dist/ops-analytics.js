(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const DATA = {
    berths: 'data/port-berths.geojson',
    registry: 'data/container-terminal-registry.json',
    throughput: 'data/container-throughput-2024.json',
    manifest: 'data/dataset-manifest.json'
  };
  const R = 6371008.8;
  const DEG = Math.PI / 180;
  const ORIGIN_LAT = 33.73;
  const ORIGIN_LON = -118.26;
  const COS_LAT = Math.cos(ORIGIN_LAT * DEG);
  const PROXIMITY_M = 100;
  const DENSITY_CELL = 0.005;
  let ais = null;
  let points = [];
  let minuteBins = [];
  let hourBins = [];
  let pointTerminal = [];
  let segments = [];
  let geometry = null;
  let registry = null;
  let throughput = null;
  let datasetManifest = null;
  let state = null;
  let selectedHour = 0;
  let activeTerminal = null;
  let proximityReady = false;
  let proximityDone = 0;
  let proximityFailed = false;
  let terminalHighlight = null;
  let densityLayer = null;
  let densityKey = '';
  let selectedMonth = '2024-07';
  let currentBundle = null;
  let renderedHourKey = '';
  let renderedTerminalKey = '';
  let simulationResult = null;

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[ch]);
  }
  function number(value, digits) {
    return Number(value || 0).toLocaleString('en-US', {
      maximumFractionDigits: digits === undefined ? 0 : digits,
      minimumFractionDigits: digits === undefined ? 0 : digits
    });
  }
  function iso(seconds) {
    return new Date(seconds * 1000).toISOString();
  }
  function timeRange(start, end) {
    return iso(start).slice(0, 16).replace('T', ' ') + ' to ' + iso(end).slice(0, 16).replace('T', ' ') + ' UTC';
  }
  function vesselName(index) {
    if (!ais || index === null || index === undefined || !ais.vessels[index]) return '';
    const v = ais.vessels[index];
    return v.name || ('Unnamed vessel · MMSI ' + v.mmsi);
  }
  function mmsi(index) {
    return ais && ais.vessels[index] ? String(ais.vessels[index].mmsi) : '';
  }
  function geometryStatus(message, bad) {
    $('opsProximityStatus').textContent = message;
    $('opsProximityStatus').classList.toggle('ops-error', !!bad);
  }
  function setDataStatus(message, kind) {
    $('opsAisStatus').textContent = message;
    $('opsAisStatus').className = 'ops-data-status' + (kind ? ' ' + kind : '');
  }
  function project(lon, lat) {
    return {
      x: R * COS_LAT * ((lon - ORIGIN_LON) * DEG),
      y: R * ((lat - ORIGIN_LAT) * DEG)
    };
  }
  function addLine(coordinates, properties) {
    if (!Array.isArray(coordinates)) return;
    for (let i = 1; i < coordinates.length; i += 1) {
      const a = coordinates[i - 1];
      const b = coordinates[i];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      const pa = project(Number(a[0]), Number(a[1]));
      const pb = project(Number(b[0]), Number(b[1]));
      if (![pa.x, pa.y, pb.x, pb.y].every(Number.isFinite)) continue;
      segments.push({
        ax: pa.x, ay: pa.y, bx: pb.x, by: pb.y,
        terminalId: properties.terminal_id,
        terminalName: properties.terminal_name,
        berth: properties.berth_num || 'Unlabeled berth'
      });
    }
  }
  function readGeometry() {
    if (!geometry || !Array.isArray(geometry.features)) throw new Error('Berth-line GeoJSON has no feature array.');
    segments = [];
    geometry.features.forEach(feature => {
      const p = feature.properties || {};
      if (!p.terminal_id || !feature.geometry) return;
      if (feature.geometry.type === 'LineString') addLine(feature.geometry.coordinates, p);
      if (feature.geometry.type === 'MultiLineString') feature.geometry.coordinates.forEach(path => addLine(path, p));
    });
    if (!segments.length) throw new Error('No terminal-matched berth-line segments are available.');
  }
  function distanceToSegment(point, segment) {
    const dx = segment.bx - segment.ax;
    const dy = segment.by - segment.ay;
    const length2 = dx * dx + dy * dy;
    const t = length2 ? Math.max(0, Math.min(1, ((point.x - segment.ax) * dx + (point.y - segment.ay) * dy) / length2)) : 0;
    const x = segment.ax + t * dx;
    const y = segment.ay + t * dy;
    const ox = point.x - x;
    const oy = point.y - y;
    return Math.sqrt(ox * ox + oy * oy);
  }
  function beginProximity() {
    pointTerminal = new Array(points.length).fill(null);
    proximityReady = false;
    proximityFailed = false;
    proximityDone = 0;
    geometryStatus('Measuring observations against ' + segments.length.toLocaleString() + ' existing terminal-matched berth-line segments…', false);
    const chunkSize = 650;
    function processChunk() {
      const end = Math.min(points.length, proximityDone + chunkSize);
      for (let i = proximityDone; i < end; i += 1) {
        const p = points[i];
        const xy = project(p[2], p[3]);
        let best = null;
        for (let j = 0; j < segments.length; j += 1) {
          const segment = segments[j];
          const distance = distanceToSegment(xy, segment);
          if (distance <= PROXIMITY_M && (!best || distance < best.distance ||
              (distance === best.distance && String(segment.terminalId) < String(best.terminalId)))) {
            best = {
              terminalId: segment.terminalId,
              terminalName: segment.terminalName,
              berth: segment.berth,
              distance: distance
            };
          }
        }
        pointTerminal[i] = best;
      }
      proximityDone = end;
      if (end < points.length) {
        if (proximityDone % 5200 < chunkSize) geometryStatus('Measuring berth-line proximity… ' + number(proximityDone) + ' / ' + number(points.length) + ' fixes', false);
        window.setTimeout(processChunk, 0);
      } else {
        proximityReady = true;
        geometryStatus('Calculated from ' + number(points.length) + ' AIS fixes and ' + number(segments.length) +
          ' existing berth-line segments. Within ' + PROXIMITY_M + ' m means observed proximity only; it is not a berthing event.', false);
        updatePanels();
      }
    }
    window.setTimeout(processChunk, 0);
  }
  function initBundle(bundle) {
    if (!bundle || !Array.isArray(bundle.positions) || !Array.isArray(bundle.vessels)) throw new Error('Historical AIS sample has an unexpected structure.');
    ais = bundle;
    currentBundle = bundle;
    points = bundle.positions;
    const start = Date.parse(bundle.period_start_utc) / 1000;
    const end = Date.parse(bundle.period_end_exclusive_utc) / 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('AIS sample time window is invalid.');
    const minutes = Math.ceil((end - start) / 60);
    minuteBins = Array.from({ length: minutes }, () => []);
    const hours = Math.ceil((end - start) / 3600);
    hourBins = Array.from({ length: hours }, () => []);
    points.forEach((p, index) => {
      const minute = Math.floor((p[1] - start) / 60);
      const hour = Math.floor((p[1] - start) / 3600);
      if (minute >= 0 && minute < minuteBins.length) minuteBins[minute].push(index);
      if (hour >= 0 && hour < hourBins.length) hourBins[hour].push(index);
    });
    state = window.portAisReplay && window.portAisReplay.getState();
    selectedHour = Math.max(0, Math.min(hourBins.length - 1, Math.floor((state ? state.minute : 0) / 60)));
    qualityCheck();
    try {
      readGeometry();
      beginProximity();
    } catch (error) {
      proximityFailed = true;
      geometryStatus('Terminal proximity unavailable: ' + error.message, true);
    }
    setDataStatus(number(points.length) + ' source fixes · ' + number(bundle.vessels.length) +
      ' MMSIs · ' + timeRange(start, end) + ' · historical, not live.', 'ready');
    $('opsLoadAis').hidden = true;
    $('opsExport').disabled = false;
    $('opsExportActivityJson').disabled = false;
    $('opsExportTracks').disabled = false;
    updatePanels();
  }
  function qualityCheck() {
    const nulls = { sog: 0, cog: 0, heading: 0 };
    const uniqueTimes = new Map();
    const duplicates = new Map();
    let invalidCoordinates = 0;
    const bbox = ais.bbox_wgs84 || [];
    points.forEach(p => {
      if (p[4] === null || p[4] === undefined) nulls.sog += 1;
      if (p[5] === null || p[5] === undefined) nulls.cog += 1;
      if (p[6] === null || p[6] === undefined) nulls.heading += 1;
      const key = String(p[0]) + ':' + String(p[1]);
      duplicates.set(key, (duplicates.get(key) || 0) + 1);
      if (!Number.isFinite(p[2]) || !Number.isFinite(p[3]) ||
          (bbox.length === 4 && (p[2] < bbox[0] || p[2] > bbox[2] || p[3] < bbox[1] || p[3] > bbox[3]))) invalidCoordinates += 1;
      if (!uniqueTimes.has(p[0])) uniqueTimes.set(p[0], new Set());
      uniqueTimes.get(p[0]).add(p[1]);
    });
    const extraDuplicates = Array.from(duplicates.values()).reduce((sum, n) => sum + Math.max(0, n - 1), 0);
    let longGaps = 0;
    let maxGap = 0;
    uniqueTimes.forEach(times => {
      const sorted = Array.from(times).sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i += 1) {
        const gap = sorted[i] - sorted[i - 1];
        if (gap > 600) { longGaps += 1; maxGap = Math.max(maxGap, gap); }
      }
    });
    const pct = field => number((nulls[field] / Math.max(1, points.length)) * 100, 2) + '%';
    const maxGapText = Math.floor(maxGap / 3600) + 'h ' + Math.floor((maxGap % 3600) / 60) +
      'm ' + (maxGap % 60) + 's';
    $('opsQuality').innerHTML =
      '<div class="ops-quality-block"><b>NOAA AIS sample</b><br>' + number(points.length) + ' point records from ' +
      number(ais.vessels.length) + ' MMSIs. UTC period: ' + escapeHtml(timeRange(Date.parse(ais.period_start_utc) / 1000, Date.parse(ais.period_end_exclusive_utc) / 1000)) + '.</div>' +
      '<div class="ops-quality-block"><b>Missing motion fields</b><br>SOG: ' + number(nulls.sog) + ' (' + pct('sog') + ') · COG: ' +
      number(nulls.cog) + ' (' + pct('cog') + ') · Heading: ' + number(nulls.heading) + ' (' + pct('heading') +
      '). Missing values are excluded from the speed distribution; they are not filled.</div>' +
      '<div class="ops-quality-block"><b>Time gaps and duplicates</b><br>' + number(longGaps) +
      ' consecutive same-vessel gaps exceed 10 minutes; maximum observed gap ' + maxGapText +
      '. Trajectory lines break over 10 minutes. ' + number(extraDuplicates) +
      ' repeated same-MMSI / timestamp rows are retained as source fixes and can affect fix counts.</div>' +
      '<div class="ops-quality-block"><b>Calculation windows</b><br>Source seconds are preserved. Charts group by UTC minute and UTC hour using half-open intervals. Distinct vessel counts use MMSI. Speed uses non-null SOG in knots: 0–&lt;2, 2–&lt;5, 5–&lt;10, 10–&lt;15, and ≥15.</div>' +
      '<div class="ops-quality-block"><b>Terminal proximity</b><br>Nearest point-to-segment distance in a local WGS 84 equirectangular projection. The displayed threshold is ' +
      PROXIMITY_M + ' m from an existing terminal-associated berth line; each fix is assigned to its nearest matched line once. Proximity is not a berthing event or berth occupancy. Existing terminal boundary status remains incomplete.</div>' +
      '<div class="ops-quality-block"><b>Spatial density</b><br>Counts of observed source fixes per 0.005° × 0.005° grid cell (about 460 m at this latitude), for the selected UTC hour. Counts are reports, not unique vessels or occupancy. Study area is a rectangular source clip.</div>' +
      '<div class="ops-quality-block"><b>Container throughput</b><br>Port-reported monthly TEUs for calendar 2024, reported as published and retrieved ' +
      escapeHtml(throughput ? throughput.retrieved_on : 'not available in this runtime') +
      '. This monthly series is separate from the six-hour July AIS sample and is not an operational rate estimate.</div>' +
      '<div class="ops-quality-block"><b>Validation</b><br>Coordinates outside the dataset clip or non-finite: ' + number(invalidCoordinates) +
      '. No locations are interpolated. No live AIS or berth-event feed is included.</div>';
  }
  function indicesForMinute(minute, vesselFilter) {
    const list = minuteBins[minute] || [];
    return vesselFilter === null || vesselFilter === undefined ? list : list.filter(i => points[i][0] === vesselFilter);
  }
  function indicesForHour(hour, vesselFilter) {
    const list = hourBins[hour] || [];
    return vesselFilter === null || vesselFilter === undefined ? list : list.filter(i => points[i][0] === vesselFilter);
  }
  function uniqueVessels(indices) {
    const found = new Set();
    indices.forEach(i => found.add(ais.vessels[points[i][0]].mmsi));
    return found.size;
  }
  function activityRows(filter) {
    const maximum = Math.max(1, ...hourBins.map((_, h) => indicesForHour(h, filter).length));
    return hourBins.map((_, h) => {
      const ids = indicesForHour(h, filter);
      const start = Date.parse(ais.period_start_utc) / 1000 + h * 3600;
      const end = Math.min(Date.parse(ais.period_end_exclusive_utc) / 1000, start + 3600);
      const label = new Date(start * 1000).toISOString().slice(11, 16) + '–' + new Date(end * 1000).toISOString().slice(11, 16);
      return '<button type="button" class="ops-hour-row' + (h === selectedHour ? ' active' : '') + '" data-hour="' + h +
        '" aria-pressed="' + (h === selectedHour) + '" aria-label="Select UTC hour ' + label + '">' +
        '<span class="ops-hour-label">' + label + ' UTC</span><span class="ops-bar-wrap"><i style="width:' +
        ((ids.length / maximum) * 100).toFixed(1) + '%"></i></span><span class="ops-hour-value">' +
        number(ids.length) + ' fixes · ' + number(uniqueVessels(ids)) + ' MMSIs</span></button>';
    }).join('');
  }
  function renderHourly() {
    const filter = state ? state.selectedVessel : null;
    $('opsHourlyChart').innerHTML = activityRows(filter);
    $('opsFilterHint').textContent = filter === null || filter === undefined
      ? 'All vessels · select a bar to move the replay timeline'
      : 'Filtered to ' + vesselName(filter) + ' · MMSI ' + mmsi(filter) + ' · select a bar to move the replay timeline';
  }
  function renderSpeed() {
    const filter = state ? state.selectedVessel : null;
    const ids = indicesForHour(selectedHour, filter);
    const buckets = [
      { label: '0–<2 kn', test: x => x >= 0 && x < 2 },
      { label: '2–<5 kn', test: x => x >= 2 && x < 5 },
      { label: '5–<10 kn', test: x => x >= 5 && x < 10 },
      { label: '10–<15 kn', test: x => x >= 10 && x < 15 },
      { label: '≥15 kn', test: x => x >= 15 }
    ];
    const values = ids.map(i => points[i][4]).filter(x => x !== null && x !== undefined && Number.isFinite(x));
    const counts = buckets.map(bin => values.filter(bin.test).length);
    const maximum = Math.max(1, ...counts);
    $('opsSpeedChart').innerHTML = buckets.map((bin, i) =>
      '<div class="ops-speed-row"><span>' + bin.label + '</span><span class="ops-bar-wrap"><i style="width:' +
      ((counts[i] / maximum) * 100).toFixed(1) + '%"></i></span><b>' + number(counts[i]) + '</b></div>'
    ).join('') + '<div class="ops-chart-note">' + number(values.length) + ' non-null SOG reports; ' +
      number(ids.length - values.length) + ' selected-hour fixes lack SOG. Values are source reports, not a deduplicated vessel average.</div>';
  }
  function currentHourBounds() {
    const start = Date.parse(ais.period_start_utc) / 1000 + selectedHour * 3600;
    return [start, Math.min(Date.parse(ais.period_end_exclusive_utc) / 1000, start + 3600)];
  }
  function minuteBounds() {
    const start = Date.parse(ais.period_start_utc) / 1000 + (state ? state.minute : 0) * 60;
    return [start, Math.min(Date.parse(ais.period_end_exclusive_utc) / 1000, start + 60)];
  }
  function selectedVesselCard() {
    const selected = state ? state.selectedVessel : null;
    if (selected === null || selected === undefined || !ais.vessels[selected]) {
      $('opsSelectedVessel').innerHTML = '<b>Vessel focus</b><span>No vessel selected. Dashboard filters show the full observed sample.</span>';
      return;
    }
    const frame = indicesForMinute(state.minute, selected);
    const v = ais.vessels[selected];
    const sourceStatus = frame.length
      ? number(frame.length) + ' observed source fix(es) in this minute bin.'
      : 'No source observation for this MMSI in this minute bin; no location is interpolated.';
    $('opsSelectedVessel').innerHTML = '<b>Selected · ' + escapeHtml(vesselName(selected)) + '</b><span>MMSI ' +
      escapeHtml(v.mmsi) + ' · ' + number(v.position_count) + ' sample fixes · ' + sourceStatus + '</span>';
  }
  function renderTerminalCounts() {
    if (!registry || !proximityReady) return;
    const filter = state ? state.selectedVessel : null;
    const ids = indicesForHour(selectedHour, filter);
    const counts = new Map();
    ids.forEach(index => {
      const match = pointTerminal[index];
      if (!match) return;
      if (!counts.has(match.terminalId)) counts.set(match.terminalId, { fixes: 0, mmsis: new Set() });
      const entry = counts.get(match.terminalId);
      entry.fixes += 1;
      entry.mmsis.add(ais.vessels[points[index][0]].mmsi);
    });
    const terminals = (registry.terminals || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    $('opsTerminalList').innerHTML = terminals.map(t => {
      const c = counts.get(t.id) || { fixes: 0, mmsis: new Set() };
      return '<button type="button" class="ops-terminal-row' + (activeTerminal === t.id ? ' active' : '') +
        '" data-terminal="' + escapeHtml(t.id) + '" aria-pressed="' + (activeTerminal === t.id) + '">' +
        '<span>' + escapeHtml(t.name) + '<small>' + escapeHtml(t.directory_range || 'Berth range unavailable') + '</small></span>' +
        '<b>' + number(c.fixes) + '<small>fixes · ' + number(c.mmsis.size) + ' MMSIs</small></b></button>';
    }).join('');
    $('opsTerminalWindow').textContent = timeRange(currentHourBounds()[0], currentHourBounds()[1]) +
      (filter === null || filter === undefined ? ' · all vessels' : ' · selected MMSI ' + mmsi(filter));
    renderTerminalDetail(activeTerminal || (terminals[0] && terminals[0].id));
  }
  function renderTerminalDetail(id) {
    const terminal = registry && (registry.terminals || []).find(t => t.id === id);
    if (!terminal) {
      $('opsTerminalDetail').textContent = 'Select a terminal to inspect source and match status.';
      return;
    }
    const matches = (geometry.features || []).filter(f => f.properties && f.properties.terminal_id === id);
    const labels = Array.from(new Set(matches.map(f => f.properties.berth_num).filter(Boolean))).sort();
    const lineSource = matches[0] && matches[0].properties;
    const attrs = [terminal.operator, terminal.address, terminal.phone].filter(Boolean).map(v => escapeHtml(v)).join(' · ');
    const names = labels.length ? labels.join(', ') : (terminal.matched_berth_labels || []).join(', ') || 'No matched line label';
    $('opsTerminalDetail').innerHTML = '<b>' + escapeHtml(terminal.profile_name || terminal.name) + '</b>' +
      '<span>Directory range ' + escapeHtml(terminal.directory_range || 'not reported') + ' · existing berth-line labels: ' + escapeHtml(names) + '</span>' +
      (attrs ? '<span>' + attrs + '</span>' : '') +
      '<span class="ops-boundary">Boundary: INCOMPLETE — no Port-certified terminal polygon is integrated.</span>' +
      '<span>Match status: numeric berth-label association to published range. The line is berth infrastructure, not a terminal boundary.</span>' +
      '<span>Berth data verification: ' + escapeHtml(lineSource ? lineSource.verification_status : 'No matched berth line') +
      (lineSource && lineSource.source_updated ? ' · updated ' + escapeHtml(lineSource.source_updated) : '') + '.</span>' +
      '<span><a href="' + escapeHtml(terminal.profile_url || registry.directory_source_url) + '" target="_blank" rel="noreferrer">Official Port terminal source ↗</a> · ' +
      '<a href="' + escapeHtml(registry.berth_geometry_source_url) + '" target="_blank" rel="noreferrer">Berth-line source ↗</a></span>';
  }
  function highlightTerminal(id) {
    const Lref = window.L;
    let mapRef = null;
    try { mapRef = map; } catch (_) {}
    if (!Lref || !mapRef || !geometry) return;
    if (terminalHighlight) mapRef.removeLayer(terminalHighlight);
    const features = geometry.features.filter(f => f.properties && f.properties.terminal_id === id);
    if (!features.length) { terminalHighlight = null; return; }
    terminalHighlight = Lref.geoJSON({ type: 'FeatureCollection', features: features }, {
      style: { color: '#ffe18d', weight: 5, opacity: 0.98 }
    }).addTo(mapRef);
    if (terminalHighlight.getBounds().isValid()) mapRef.fitBounds(terminalHighlight.getBounds().pad(0.16), { maxZoom: 15 });
    if (terminalHighlight.bringToFront) terminalHighlight.bringToFront();
  }
  function makeDensity(hour) {
    const filter = state ? state.selectedVessel : null;
    const ids = indicesForHour(hour, filter);
    const cells = new Map();
    ids.forEach(index => {
      const p = points[index];
      const lon0 = Math.floor(p[2] / DENSITY_CELL) * DENSITY_CELL;
      const lat0 = Math.floor(p[3] / DENSITY_CELL) * DENSITY_CELL;
      const key = lon0.toFixed(3) + ',' + lat0.toFixed(3);
      if (!cells.has(key)) cells.set(key, {
        lon0, lat0, fixes: 0, mmsis: new Set()
      });
      const cell = cells.get(key);
      cell.fixes += 1;
      cell.mmsis.add(ais.vessels[p[0]].mmsi);
    });
    return Array.from(cells.values());
  }
  function renderDensity(force) {
    if (!$('opsDensityToggle').checked) {
      if (densityLayer && densityLayer.clearLayers) densityLayer.clearLayers();
      $('opsDensityStatus').textContent = 'Map density layer is off.';
      densityKey = '';
      return;
    }
    if (!ais) { $('opsDensityStatus').textContent = 'Load the historical AIS sample to calculate density.'; return; }
    let mapRef = null;
    try { mapRef = map; } catch (_) {}
    const Lref = window.L;
    if (!mapRef || !Lref) { $('opsDensityStatus').textContent = 'Map engine is unavailable; density was not drawn.'; return; }
    const filter = state ? state.selectedVessel : null;
    const key = selectedHour + ':' + String(filter);
    if (!force && key === densityKey) return;
    densityKey = key;
    if (!densityLayer) densityLayer = Lref.layerGroup();
    densityLayer.clearLayers();
    const cells = makeDensity(selectedHour);
    const maximum = Math.max(1, ...cells.map(c => c.fixes));
    cells.forEach(cell => {
      const ratio = cell.fixes / maximum;
      const color = ratio >= 0.72 ? '#f07658' : ratio >= 0.42 ? '#edbd70' : ratio >= 0.18 ? '#65d9d1' : '#65a9fa';
      const box = Lref.rectangle([[cell.lat0, cell.lon0], [cell.lat0 + DENSITY_CELL, cell.lon0 + DENSITY_CELL]], {
        color: color, weight: 0.7, opacity: 0.8, fillColor: color, fillOpacity: 0.26 + ratio * 0.4
      });
      const filterText = filter === null || filter === undefined ? 'all vessels' : 'selected MMSI ' + mmsi(filter);
      box.bindPopup('<b>Historical AIS report density</b><br>' + number(cell.fixes) + ' source fixes · ' +
        number(cell.mmsis.size) + ' distinct MMSIs<br>' + escapeHtml(timeRange(currentHourBounds()[0], currentHourBounds()[1])) +
        '<br>' + escapeHtml(filterText) + '<br>Grid cell 0.005° × 0.005°; report counts do not establish occupancy.');
      densityLayer.addLayer(box);
    });
    densityLayer.addTo(mapRef);
    if (densityLayer.bringToFront) densityLayer.bringToFront();
    $('opsDensityStatus').textContent = number(cells.length) + ' occupied report cells · ' +
      timeRange(currentHourBounds()[0], currentHourBounds()[1]) +
      (filter === null || filter === undefined ? '' : ' · filtered to selected vessel');
  }
  function renderThroughput() {
    if (!throughput || !Array.isArray(throughput.monthly)) {
      $('opsThroughputStatus').textContent = 'Official Port monthly throughput file unavailable.';
      $('opsThroughputChart').innerHTML = '';
      return;
    }
    const field = $('opsThroughputMetric').value;
    const title = field === 'total_teus' ? 'Total TEUs' :
      field === 'loaded_imports_teu' ? 'Loaded imports' : 'Loaded exports';
    const max = Math.max(1, ...throughput.monthly.map(row => row[field]));
    $('opsThroughputChart').innerHTML = throughput.monthly.map(row => {
      const month = row.month;
      const short = new Date(month + '-01T00:00:00Z').toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
      return '<button type="button" class="ops-month-row' + (month === selectedMonth ? ' active' : '') +
        '" data-month="' + month + '" aria-pressed="' + (month === selectedMonth) + '">' +
        '<span>' + short + '</span><i><b style="width:' + ((row[field] / max) * 100).toFixed(1) + '%"></b></i>' +
        '<strong>' + number(row[field], 2) + '</strong></button>';
    }).join('');
    const selected = throughput.monthly.find(row => row.month === selectedMonth) || throughput.monthly[0];
    $('opsThroughputDetail').textContent = selected.month + ' · Total ' + number(selected.total_teus, 2) +
      ' TEUs · loaded imports ' + number(selected.loaded_imports_teu, 2) +
      ' · loaded exports ' + number(selected.loaded_exports_teu, 2) +
      ' · prior-year change ' + number(selected.prior_year_change_pct, 2) + '%';
    $('opsThroughputStatus').innerHTML = 'Reporting unit: ' + escapeHtml(throughput.reporting_unit) +
      ' · Port archive snapshot ' + escapeHtml(throughput.retrieved_on) +
      ' · <a href="' + escapeHtml(throughput.source_url) + '" target="_blank" rel="noreferrer">Official monthly source ↗</a>';
  }
  function updatePanels() {
    if (!ais) return;
    state = window.portAisReplay ? window.portAisReplay.getState() : state;
    const minute = Math.max(0, Math.min(minuteBins.length - 1, Number(state ? state.minute : 0)));
    selectedHour = Math.max(0, Math.min(hourBins.length - 1, Math.floor(minute / 60)));
    const atMinute = minuteBins[minute] || [];
    const start = Date.parse(ais.period_start_utc) / 1000;
    const currentStart = start + minute * 60;
    const currentEnd = Math.min(Date.parse(ais.period_end_exclusive_utc) / 1000, currentStart + 60);
    $('opsMetricFixes').textContent = number(atMinute.length);
    $('opsMetricVessels').textContent = number(uniqueVessels(atMinute));
    $('opsTimeWindow').textContent = timeRange(currentStart, currentEnd) +
      ' · selected UTC hour ' + new Date(currentHourBounds()[0] * 1000).toISOString().slice(11, 16) + '–' +
      new Date(currentHourBounds()[1] * 1000).toISOString().slice(11, 16);
    $('opsHistoricalLabel').textContent = 'HISTORICAL · ' + new Date(currentStart * 1000).toISOString().slice(0, 10) + ' · NOT LIVE';
    selectedVesselCard();
    const chartKey = String(selectedHour) + ':' + String(state ? state.selectedVessel : null);
    if (chartKey !== renderedHourKey) {
      renderHourly();
      renderSpeed();
      renderedHourKey = chartKey;
    }
    if (registry && proximityReady && chartKey !== renderedTerminalKey) {
      renderTerminalCounts();
      renderedTerminalKey = chartKey;
    }
    renderDensity(false);
  }
  function csvEscape(value) {
    const string = String(value === null || value === undefined ? '' : value);
    return '"' + string.replace(/"/g, '""') + '"';
  }
  function buildExportData() {
    const headers = ['dataset','metric','category','value','unit','window_start_utc','window_end_exclusive_utc',
      'reporting_period_start','reporting_period_end_exclusive','time_basis','filters','method','source_url','notes'];
    const rows = [];
    const source = ais.source_url || 'https://github.com/ocm-marinecadastre/ais-vessel-traffic';
    const start = Date.parse(ais.period_start_utc) / 1000;
    const fullEnd = Date.parse(ais.period_end_exclusive_utc) / 1000;
    const filter = state && state.selectedVessel !== null && state.selectedVessel !== undefined
      ? 'selected vessel MMSI ' + mmsi(state.selectedVessel) : 'all observed MMSIs';
    function add(dataset, metric, category, value, unit, windowStart, windowEnd, periodStart, periodEnd, basis, filters, method, url, notes) {
      rows.push([dataset,metric,category,value,unit,windowStart,windowEnd,periodStart,periodEnd,basis,filters,method,url,notes]);
    }
    add('NOAA historical AIS','sample_source_fixes','full sample',points.length,'source fixes',iso(start),iso(fullEnd),'','',
      'UTC','all source records','Count of point records in the clipped six-hour sample; duplicate vessel/timestamp rows retained.',source,
      'Historical snapshot; not live or a complete harbor census.');
    const minute = Math.max(0, Math.min(minuteBins.length - 1, Number(state ? state.minute : 0)));
    const minuteIds = minuteBins[minute] || [];
    const mb = minuteBounds();
    add('NOAA historical AIS','observed_fixes_current_minute','all vessels',minuteIds.length,'source fixes',iso(mb[0]),iso(mb[1]),'','',
      'UTC','all observed MMSIs','Count of source fixes whose timestamps fall in this half-open UTC minute bin.',source,
      'Zero observed fixes does not establish vessel absence.');
    add('NOAA historical AIS','distinct_vessels_current_minute','all vessels',uniqueVessels(minuteIds),'MMSIs',iso(mb[0]),iso(mb[1]),'',
      '','UTC','all observed MMSIs','Distinct MMSI among source fixes in the current UTC minute bin.',source,'No interpolation.');
    const hourFilter = state ? state.selectedVessel : null;
    hourBins.forEach((_, h) => {
      const ids = indicesForHour(h, hourFilter);
      const ws = start + h * 3600;
      const we = Math.min(fullEnd, ws + 3600);
      add('NOAA historical AIS','observed_fixes_per_hour','hour ' + h,ids.length,'source fixes',iso(ws),iso(we),'','',
        'UTC',filter,'Count of source fixes in the half-open UTC hour bin.',source,'Report counts; repeated same-timestamp rows retained.');
      add('NOAA historical AIS','distinct_vessels_per_hour','hour ' + h,uniqueVessels(ids),'MMSIs',iso(ws),iso(we),'','',
        'UTC',filter,'Distinct MMSI among source fixes in the half-open UTC hour bin.',source,'No interpolation.');
    });
    const bounds = currentHourBounds();
    const speedIds = indicesForHour(selectedHour, hourFilter);
    const speedBuckets = [
      {label:'0–<2 kn',test:x=>x>=0&&x<2},
      {label:'2–<5 kn',test:x=>x>=2&&x<5},
      {label:'5–<10 kn',test:x=>x>=5&&x<10},
      {label:'10–<15 kn',test:x=>x>=10&&x<15},
      {label:'≥15 kn',test:x=>x>=15}
    ];
    speedBuckets.forEach(bucket => {
      const count = speedIds.filter(i => points[i][4] !== null && points[i][4] !== undefined && bucket.test(points[i][4])).length;
      add('NOAA historical AIS','SOG_distribution',bucket.label,count,'source fixes',iso(bounds[0]),iso(bounds[1]),'','',
        'UTC',filter,'Non-null source speed-over-ground values binned as [0,2), [2,5), [5,10), [10,15), and [15,infinity) knots.',source,
        'Missing SOG excluded; rows are reports, not unique vessels.');
    });
    if (proximityReady && registry) {
      const terminalCounts = new Map();
      speedIds.forEach(i => {
        const match = pointTerminal[i];
        if (!match) return;
        if (!terminalCounts.has(match.terminalId)) terminalCounts.set(match.terminalId, { fixes:0, mmsis:new Set() });
        const c = terminalCounts.get(match.terminalId);
        c.fixes += 1;
        c.mmsis.add(ais.vessels[points[i][0]].mmsi);
      });
      registry.terminals.forEach(t => {
        const c = terminalCounts.get(t.id) || {fixes:0,mmsis:new Set()};
        add('NOAA AIS × Port berth lines','observed_proximity_fixes_100m',t.name,c.fixes,'source fixes',iso(bounds[0]),iso(bounds[1]),'',
          '','UTC',filter,'Each AIS fix assigned once to its nearest terminal-associated existing berth-line segment when local projected distance is ≤100 m.',
          registry.berth_geometry_source_url,'Observed proximity only; not a berthing event or occupancy. Boundary incomplete.');
        add('NOAA AIS × Port berth lines','distinct_MMSI_with_proximity_100m',t.name,c.mmsis.size,'MMSIs',iso(bounds[0]),iso(bounds[1]),'',
          '','UTC',filter,'Distinct MMSI among AIS fixes assigned to the terminal line by nearest distance ≤100 m.',
          registry.berth_geometry_source_url,'A vessel may pass within 100 m; this is not verified berth occupancy.');
      });
    }
    makeDensity(selectedHour).forEach(cell => {
      const ws = bounds[0];
      const we = bounds[1];
      add('NOAA historical AIS','fix_density_cell_0.005deg',
        'lon[' + cell.lon0.toFixed(3) + ',' + (cell.lon0 + DENSITY_CELL).toFixed(3) + ') lat[' +
        cell.lat0.toFixed(3) + ',' + (cell.lat0 + DENSITY_CELL).toFixed(3) + ')',
        cell.fixes,'source fixes',iso(ws),iso(we),'','', 'UTC',filter,
        'Counts of source fixes by 0.005 degree geographic grid cell; coordinates are WGS 84 and cell boundaries are half-open.',source,
        'Reports only; not unique vessels, route intensity, berth occupancy, or a live density.');
    });
    if (throughput) throughput.monthly.forEach(row => {
      const next = new Date(Date.parse(row.month + '-01T00:00:00Z'));
      next.setUTCMonth(next.getUTCMonth() + 1);
      const endMonth = next.toISOString().slice(0,10);
      ['total_teus','loaded_imports_teu','loaded_exports_teu'].forEach(metric => {
        add('Port of Los Angeles official container statistics',metric,row.month,row[metric],'TEUs','','',row.month + '-01',endMonth,
          'Port calendar reporting month','not filtered','Port-reported monthly figure copied from official 2024 archive; no interpolation or derivation.',
          throughput.source_url,'Monthly throughput series is separate from the six-hour AIS sample.');
      });
    });
    return { headers, rows };
  }
  function downloadBlob(blob, filename) {
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
  function downloadJson(data, filename) {
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }), filename);
  }
  function exportCsv() {
    if (!ais) return;
    const { headers, rows } = buildExportData();
    const csv = [headers].concat(rows).map(row => row.map(csvEscape).join(',')).join('\r\n');
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'port-la-historical-activity-2024-07-15.csv');
    $('opsExportStatus').textContent = number(rows.length) + ' CSV calculation rows exported with periods, units, filters, methods and source URLs.';
  }
  function exportActivityJson() {
    if (!ais) return;
    const { headers, rows } = buildExportData();
    const records = rows.map(row => Object.fromEntries(headers.map((key, index) => [key, row[index]])));
    downloadJson({
      format: 'port-la-activity-statistics/v1',
      status: 'HISTORICAL — NOT LIVE',
      generated_at_utc: new Date().toISOString(),
      sources: {
        ais: ais.source_url || 'https://github.com/ocm-marinecadastre/ais-vessel-traffic',
        berth_geometry: registry && registry.berth_geometry_source_url || null,
        throughput: throughput && throughput.source_url || null
      },
      methods_note: 'Each record carries its own UTC window, units, filters, calculation method, source URL and caveat. AIS report counts are not a harbor census; berth proximity is not berth occupancy; Port TEUs are separate official monthly reports.',
      calculations: records
    }, 'port-la-historical-activity-2024-07-15.json');
    $('opsExportStatus').textContent = number(records.length) + ' JSON calculation records exported with source and method metadata.';
  }
  function exportVesselTracks() {
    if (!ais) return;
    const gapSeconds = Math.max(1, Number(ais.gap_break_minutes || 10)) * 60;
    const selected = state && state.selectedVessel !== null && state.selectedVessel !== undefined ? state.selectedVessel : null;
    const groups = new Map();
    points.forEach((point, sourceOrder) => {
      if (selected !== null && point[0] !== selected) return;
      if (!groups.has(point[0])) groups.set(point[0], []);
      groups.get(point[0]).push({ point, sourceOrder });
    });
    const vessels = Array.from(groups.entries()).sort((a, b) => Number(ais.vessels[a[0]].mmsi) - Number(ais.vessels[b[0]].mmsi)).map(([index, entries]) => {
      entries.sort((a, b) => a.point[1] - b.point[1] || a.sourceOrder - b.sourceOrder);
      const observations = entries.map(({ point }) => ({
        timestamp_utc: new Date(point[1] * 1000).toISOString().replace(/\.000Z$/, 'Z'),
        source_timestamp_unix_seconds: point[1],
        longitude: point[2], latitude: point[3],
        speed_over_ground_knots: point[4], course_over_ground_degrees: point[5], heading_degrees: point[6]
      }));
      const byTimestamp = new Map();
      entries.forEach(({ point }) => { if (!byTimestamp.has(point[1])) byTimestamp.set(point[1], point); });
      const unique = Array.from(byTimestamp.values()).sort((a, b) => a[1] - b[1]);
      const trackSegments = [];
      let segment = [];
      let gapBreaks = 0;
      unique.forEach(point => {
        if (segment.length && point[1] - segment[segment.length - 1][1] > gapSeconds) {
          if (segment.length > 1) trackSegments.push(segment.map(p => [p[2], p[3]]));
          segment = [];
          gapBreaks += 1;
        }
        segment.push(point);
      });
      if (segment.length > 1) trackSegments.push(segment.map(p => [p[2], p[3]]));
      const v = ais.vessels[index];
      return {
        metadata: {
          mmsi: v.mmsi, name: v.name ?? null, imo: v.imo ?? null, call_sign: v.call_sign ?? null,
          vessel_type: v.vessel_type ?? null, navigation_status: v.status ?? null,
          length_m: v.length_m ?? null, width_m: v.width_m ?? null, draft_m: v.draft_m ?? null,
          cargo: v.cargo ?? null, transceiver_class: v.transceiver_class ?? null,
          first_seen_utc: v.first_seen_utc ?? null, last_seen_utc: v.last_seen_utc ?? null
        },
        source_fix_count: observations.length,
        duplicate_timestamp_fix_count: observations.length - unique.length,
        trajectory_gap_break_count: gapBreaks,
        observations,
        observed_coordinate_segments: trackSegments
      };
    });
    downloadJson({
      format: 'port-la-observed-ais-trajectories/v1',
      status: 'HISTORICAL — NOT LIVE',
      source_dataset: ais.dataset || 'NOAA Marine Cadastre AIS broadcast point data for U.S. waters 2024',
      source_url: ais.source_repository || ais.source_url || 'https://github.com/ocm-marinecadastre/ais-vessel-traffic',
      citation: ais.citation || null,
      coordinate_reference_system: 'WGS 84 / EPSG:4326; longitude, latitude',
      period_start_utc: ais.period_start_utc,
      period_end_exclusive_utc: ais.period_end_exclusive_utc,
      study_bbox_wgs84: ais.bbox_wgs84,
      filter: selected === null ? 'all sampled MMSIs' : 'selected MMSI ' + mmsi(selected),
      trajectory_method: 'Observations preserve exact source Unix UTC seconds. All source fixes, including duplicate MMSI/timestamp records, remain in observations. Display segments use the first source fix at each duplicate timestamp and break when the next unique observation is more than ' + gapSeconds + ' seconds later. No positions are interpolated.',
      gap_break_threshold_seconds: gapSeconds,
      vessels
    }, 'port-la-observed-vessel-trajectories-2024-07-15.json');
    $('opsExportStatus').textContent = number(vessels.length) + ' vessel track record(s) exported; source fixes and UTC timestamps are retained, with segments broken at gaps over ' + number(gapSeconds) + ' seconds.';
  }
  async function exportInfrastructureGeoJson() {
    if (!datasetManifest || !Array.isArray(datasetManifest.datasets)) {
      $('opsExportStatus').textContent = 'Infrastructure GeoJSON export unavailable: dataset manifest not loaded.';
      return;
    }
    const button = $('opsExportGeoJson');
    button.disabled = true;
    $('opsExportStatus').textContent = 'Preparing local geographic layers…';
    try {
      const datasets = datasetManifest.datasets.filter(item => typeof item.file === 'string' && item.file.endsWith('.geojson'));
      const loaded = await Promise.all(datasets.map(async item => {
        const response = await fetch('data/' + encodeURIComponent(item.file));
        if (!response.ok) throw new Error(item.file + ' returned HTTP ' + response.status);
        const geo = await response.json();
        if (geo.type !== 'FeatureCollection' || !Array.isArray(geo.features)) throw new Error(item.file + ' is not a valid FeatureCollection.');
        return { item, geo };
      }));
      const features = loaded.flatMap(({ item, geo }) => geo.features.map(feature => ({
        ...feature,
        properties: { ...(feature.properties || {}), source_layer_id: item.id, source_file: item.file }
      })));
      downloadJson({
        type: 'FeatureCollection',
        coordinate_reference_system: datasetManifest.coordinate_reference || 'WGS 84 / EPSG:4326',
        metadata: {
          title: 'Port of Los Angeles digital twin — integrated geographic layers',
          status: 'Mixed source status; inspect each feature property and dataset entry.',
          snapshot_date: datasetManifest.snapshot_date,
          dataset_count: loaded.length,
          feature_count: features.length,
          datasets: loaded.map(({ item }) => ({ id: item.id, file: item.file, feature_count: item.feature_count, source: item.source, source_url: item.source_url, status: item.status, limitations: item.limitations || [] })),
          terminal_boundary_status: 'INCOMPLETE for all seven Port-listed terminal records; no Port-certified terminal polygons are included.',
          remote_rasters: 'USGS elevation and NOAA bathymetry are remote image services and are not exported as vector features.'
        },
        terminal_registry: (registry && registry.terminals || []).map(terminal => ({
          terminal_id: terminal.id, official_name: terminal.name, profile_name: terminal.profile_name,
          operator: terminal.operator, berth_range: terminal.directory_range,
          matched_berth_labels: terminal.matched_berth_labels || [],
          facility_attributes: terminal.facility_attributes || {},
          boundary_verification_status: 'INCOMPLETE',
          source_url: terminal.profile_url || registry.directory_source_url
        })),
        features
      }, 'port-la-integrated-geographic-layers.geojson');
      $('opsExportStatus').textContent = number(features.length) + ' geographic features from ' + number(loaded.length) + ' local GeoJSON datasets exported in WGS 84; terminal boundaries remain incomplete.';
    } catch (error) {
      $('opsExportStatus').textContent = 'Infrastructure GeoJSON export failed: ' + error.message;
    } finally {
      button.disabled = false;
    }
  }

  function readSimulationInputs() {
    return {
      scenario: {
        arrivalRatePerHour: Number($('simArrivalRate').value),
        berths: Number($('simBerths').value),
        meanServiceHours: Number($('simServiceHours').value),
        serviceDistribution: $('simDistribution').value,
        capacityFactor: Number($('simCapacity').value) / 100,
        closureBerths: Number($('simClosureBerths').value),
        closureStartHour: Number($('simClosureStart').value),
        closureDurationHours: Number($('simClosureDuration').value),
        horizonHours: Number($('simHorizon').value)
      },
      seed: Number($('simSeed').value)
    };
  }
  function updateSimulationInputLimits() {
    const berths = Math.max(1, Math.min(10, Number($('simBerths').value) || 1));
    const horizon = Math.max(24, Math.min(336, Number($('simHorizon').value) || 168));
    $('simClosureBerths').max = String(berths);
    $('simClosureStart').max = String(horizon);
    $('simClosureDuration').max = String(Math.max(0, horizon - (Number($('simClosureStart').value) || 0)));
    $('simClosureBerths').value = String(Math.min(berths, Math.max(0, Number($('simClosureBerths').value) || 0)));
    if (Number($('simClosureStart').value) > horizon) $('simClosureStart').value = String(horizon);
    const remaining = Math.max(0, horizon - Number($('simClosureStart').value || 0));
    $('simClosureDuration').value = String(Math.min(remaining, Math.max(0, Number($('simClosureDuration').value) || 0)));
    $('simClosureDuration').max = String(remaining);
  }
  function metricText(metric, digits) {
    return number(metric.mean, digits) + ' · ' + number(metric.min, digits) + '–' + number(metric.max, digits);
  }
  function renderSimulationResults(results) {
    const rows = [
      ['Arrivals in measurement window', r => metricText(r.metrics.arrivals, 1)],
      ['Mean wait · hours per arrival', r => metricText(r.metrics.averageWaitHours, 2)],
      ['95th percentile wait · hours', r => metricText(r.metrics.p95WaitHours, 2)],
      ['Time-weighted average queue · vessels', r => metricText(r.metrics.averageQueue, 2)],
      ['Peak queue · vessels', r => metricText(r.metrics.maximumQueue, 1)],
      ['Berth utilization · percent', r => metricText(r.metrics.utilizationPercent, 1) + '%'],
      ['Completed services · vessels/day', r => metricText(r.metrics.completionsPerDay, 2)]
    ];
    $('simResults').innerHTML = '<table class="sim-table"><thead><tr><th>SIMULATED · mean / run range</th><th>Baseline</th><th>Scenario</th></tr></thead><tbody>' +
      rows.map(([label, value]) => '<tr><td>' + escapeHtml(label) + '</td><td>' + escapeHtml(value(results.baseline)) + '</td><td>' + escapeHtml(value(results.scenario)) + '</td></tr>').join('') +
      '</tbody></table><p class="sim-method">Twenty deterministic replications per case. Each cell shows mean · minimum–maximum among individual runs; all values are simulated estimates.</p>';
  }
  function runSimulation() {
    const button = $('simRun');
    button.disabled = true;
    $('simStatus').textContent = 'Running 40 discrete-event replications…';
    window.setTimeout(() => {
      try {
        updateSimulationInputLimits();
        const { scenario: rawScenario, seed } = readSimulationInputs();
        const scenario = window.PortBerthSimulation.normalizeScenario(rawScenario);
        if (!Number.isInteger(seed) || seed < 1 || seed > 4294967295) throw new RangeError('Seed must be an integer from 1 to 4,294,967,295.');
        const baseline = window.PortBerthSimulation.normalizeScenario({ ...window.PortBerthSimulation.BASELINE, horizonHours: scenario.horizonHours });
        const baselineRun = window.PortBerthSimulation.runReplications(baseline, seed, window.PortBerthSimulation.DEFAULT_REPLICATIONS);
        const scenarioRun = window.PortBerthSimulation.runReplications(scenario, seed, window.PortBerthSimulation.DEFAULT_REPLICATIONS);
        simulationResult = { seed, replications: window.PortBerthSimulation.DEFAULT_REPLICATIONS, baseline: baselineRun, scenario: scenarioRun };
        renderSimulationResults(simulationResult);
        $('simStatus').textContent = 'Completed ' + simulationResult.replications + ' replications per case · 24-hour warm-up · ' + number(scenario.horizonHours) + '-hour measurement window · seed ' + number(seed) + '. Outputs are SIMULATED and use no Port operating records.';
      } catch (error) {
        $('simResults').innerHTML = '<p class="sim-caveat">Simulation unavailable: ' + escapeHtml(error.message) + '</p>';
        $('simStatus').textContent = 'Check scenario inputs and run again.';
      } finally {
        button.disabled = false;
      }
    }, 0);
  }
  function exportSimulationConfig() {
    try {
      updateSimulationInputLimits();
      const { scenario, seed } = readSimulationInputs();
      const normalized = window.PortBerthSimulation.normalizeScenario(scenario);
      if (!Number.isInteger(seed) || seed < 1 || seed > 4294967295) throw new RangeError('Seed must be an integer from 1 to 4,294,967,295.');
      downloadJson({
        format: 'port-la-berth-simulation/v1',
        classification: 'SIMULATED',
        generated_at_utc: new Date().toISOString(),
        source_data_used: false,
        baseline: { ...window.PortBerthSimulation.BASELINE, label: 'Illustrative baseline, not a Port operating benchmark', horizonHours: normalized.horizonHours },
        configured_scenario: normalized,
        seed,
        replications: window.PortBerthSimulation.DEFAULT_REPLICATIONS,
        warmup_hours: window.PortBerthSimulation.WARMUP_HOURS,
        method: 'Poisson arrivals; one FIFO queue; exponential or Erlang-2 service durations scaled by productive capacity; closure pauses in-progress service at selected berths; after arrivals stop, queued work drains for complete waiting-time observations.',
        metrics_definition: {
          average_wait_hours: 'Mean wait of arrivals inside the measurement window, including service starts during post-window drain.',
          average_queue: 'Time-weighted mean number of queued vessels during the measurement window.',
          utilization_percent: 'Active service berth-hours divided by open scheduled berth-hours in the measurement window.',
          completions_per_day: 'Completed services ending within the measurement window, divided by its days.'
        },
        results: simulationResult ? { baseline: simulationResult.baseline.metrics, configured_scenario: simulationResult.scenario.metrics } : null,
        limitations: ['User assumptions are not observations.', 'The model is not calibrated or validated against Port of Los Angeles operations.', 'No vessel classes, tides, weather, labor shifts, crane constraints, priority rules or real arrival schedules are modeled.']
      }, 'port-la-berth-simulation-config.json');
      $('simStatus').textContent = 'SIMULATED scenario configuration' + (simulationResult ? ' and last run summary' : '') + ' exported as JSON.';
    } catch (error) {
      $('simStatus').textContent = 'Scenario JSON export unavailable: ' + error.message;
    }
  }
  function bindEvents() {
    $('opsLoadAis').addEventListener('click', () => {
      const toggle = $('vesselsToggle');
      if (toggle && !toggle.checked) {
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        setDataStatus('Loading and validating the local historical AIS sample…', 'loading');
      } else if (window.portAisReplay) {
        const current = window.portAisReplay.getState();
        if (current && current.data) initBundle(current.data);
        else setDataStatus('AIS is loading. Keep this panel open while the local sample is checked…', 'loading');
      }
    });
    $('opsHourlyChart').addEventListener('click', event => {
      const button = event.target.closest('button[data-hour]');
      if (!button || !window.portAisReplay) return;
      window.portAisReplay.setMinute(Number(button.dataset.hour) * 60);
    });
    $('opsTerminalList').addEventListener('click', event => {
      const button = event.target.closest('button[data-terminal]');
      if (!button) return;
      activeTerminal = button.dataset.terminal;
      renderTerminalCounts();
      highlightTerminal(activeTerminal);
    });
    $('opsDensityToggle').addEventListener('change', () => renderDensity(true));
    $('opsThroughputMetric').addEventListener('change', renderThroughput);
    $('opsThroughputChart').addEventListener('click', event => {
      const button = event.target.closest('button[data-month]');
      if (!button) return;
      selectedMonth = button.dataset.month;
      renderThroughput();
    });
    $('opsExport').addEventListener('click', exportCsv);
    $('opsExportActivityJson').addEventListener('click', exportActivityJson);
    $('opsExportTracks').addEventListener('click', exportVesselTracks);
    $('opsExportGeoJson').addEventListener('click', exportInfrastructureGeoJson);
    $('simRun').addEventListener('click', runSimulation);
    $('simExportConfig').addEventListener('click', exportSimulationConfig);
    ['simBerths', 'simHorizon', 'simClosureStart'].forEach(id => $(id).addEventListener('change', updateSimulationInputLimits));
    $('opsSimJump').addEventListener('click', () => {
      const workspace = $('simulationWorkspace');
      workspace.open = true;
      workspace.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    const opsButton = $('opsBtn');
    if (opsButton) opsButton.addEventListener('click', () => {
      const panel = document.querySelector('.right');
      if (window.matchMedia('(max-width:1180px)').matches) panel.classList.add('mobile-open');
      opsButton.setAttribute('aria-expanded', 'true');
      panel.scrollTo({ top: $('opsDashboard').offsetTop, behavior: 'smooth' });
      $('opsDashboard').scrollIntoView({ block: 'start' });
    });
    updateSimulationInputLimits();
    window.addEventListener('port-ais-state', event => {
      const incoming = event.detail || {};
      if (incoming.data && incoming.data !== currentBundle) {
        try { initBundle(incoming.data); }
        catch (error) { setDataStatus('Historical AIS unavailable: ' + error.message, 'error'); }
      } else if (incoming.data) {
        state = incoming;
        updatePanels();
      } else if (incoming.enabled) {
        setDataStatus('Loading and validating the local historical AIS sample…', 'loading');
      }
    });
    window.addEventListener('port-ais-error', event => {
      $('opsLoadAis').hidden = false;
      setDataStatus('Historical AIS unavailable: ' + ((event.detail || {}).message || 'unknown error') +
        '. Retry with the load button.', 'error');
    });
  }
  async function loadStaticData() {
    const results = await Promise.allSettled([
      fetch(DATA.berths).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      fetch(DATA.registry).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      fetch(DATA.throughput).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      fetch(DATA.manifest).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    ]);
    if (results[0].status === 'fulfilled') geometry = results[0].value;
    if (results[1].status === 'fulfilled') registry = results[1].value;
    if (results[2].status === 'fulfilled') throughput = results[2].value;
    if (results[3].status === 'fulfilled') datasetManifest = results[3].value;
    if (datasetManifest) $('opsExportGeoJson').disabled = false;
    if (throughput) {
      renderThroughput();
      if (ais) qualityCheck();
    }
    else $('opsThroughputStatus').textContent = 'Official container statistics are unavailable. AIS analytics remain usable.';
    if (!geometry || !registry) {
      proximityFailed = true;
      geometryStatus('Terminal activity unavailable because Port berth geometry or the existing terminal registry failed to load.', true);
    }
    if (ais && geometry && !proximityReady && !segments.length) {
      try { readGeometry(); beginProximity(); }
      catch (error) { proximityFailed = true; geometryStatus('Terminal proximity unavailable: ' + error.message, true); }
    }
    if (ais && registry) renderTerminalCounts();
  }
  function start() {
    bindEvents();
    $('opsLoadAis').hidden = false;
    setDataStatus('Historical AIS sample not loaded. Load the NOAA snapshot to calculate activity.', 'info');
    const current = window.portAisReplay && window.portAisReplay.getState();
    if (current && current.data) {
      try { initBundle(current.data); } catch (error) { setDataStatus('Historical AIS unavailable: ' + error.message, 'error'); }
    }
    loadStaticData().catch(error => {
      $('opsThroughputStatus').textContent = 'Operations data could not be loaded: ' + error.message;
      geometryStatus('Berth or registry request failed: ' + error.message, true);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
