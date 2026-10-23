(() => {
  const panel = document.getElementById('aisReplayControls');
  const status = document.getElementById('aisReplayStatus');
  const frameStatus = document.getElementById('aisFrameStatus');
  const slider = document.getElementById('aisTimeSlider');
  const timeReadout = document.getElementById('aisTimeReadout');
  const playButton = document.getElementById('aisPlayButton');
  const speedSelect = document.getElementById('aisPlaybackSpeed');
  const speedHint = document.getElementById('aisSpeedHint');
  const searchInput = document.getElementById('aisVesselSearch');
  const vesselList = document.getElementById('aisVesselList');
  const vesselDetail = document.getElementById('aisVesselDetail');

  const DATA_URL = 'data/ais-history-2024-07-15.json';
  const GAP_BREAK_SECONDS = 10 * 60;
  const MISSING = 'Not available in the sampled AIS records';
  let data = null;
  let periodStart = 0;
  let durationMinutes = 0;
  let minuteEvents = new Map();
  let vesselEvents = [];
  let observationLayer = null;
  let trajectoryLayer = null;
  let selectedVessel = null;
  let isPlaying = false;
  let timer = null;
  function broadcastState() {
    const state = {
      data,
      periodStart,
      durationMinutes,
      minute: Number(slider && slider.value || 0),
      selectedVessel,
      isPlaying,
      enabled: document.getElementById('vesselsToggle').checked
    };
    window.portAisReplayState = state;
    window.dispatchEvent(new CustomEvent('port-ais-state', { detail: state }));
  }
  window.portAisReplay = {
    getState: () => window.portAisReplayState || {
      data, periodStart, durationMinutes, minute: Number(slider && slider.value || 0),
      selectedVessel, isPlaying, enabled: document.getElementById('vesselsToggle').checked
    },
    setMinute: value => {
      if (!data) return false;
      const next = Math.max(0, Math.min(durationMinutes - 1, Math.floor(Number(value) || 0)));
      slider.value = String(next);
      if (document.getElementById('vesselsToggle').checked) showFrame();
      else broadcastState();
      return true;
    }
  };

  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
  const nullable = (value, suffix = '') => value === null || value === undefined || value === '' ? MISSING : `${value}${suffix}`;
  const utcLabel = seconds => new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
  const minuteLabel = seconds => new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const fmtNumber = (value, suffix = '') => value === null || value === undefined ? MISSING : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })}${suffix}`;

  function setStatus(message, state = 'info') {
    status.textContent = message;
    status.dataset.state = state;
  }

  function clearLayer(layer) {
    if (layer && map.hasLayer(layer)) map.removeLayer(layer);
  }

  function positionPopup(position) {
    const vessel = data.vessels[position[0]];
    return `<div class="popup-kicker">HISTORICAL NOAA AIS OBSERVATION</div>
      <div class="popup-title">${esc(vessel.name || 'Unnamed vessel')}</div>
      <div class="popup-status">${utcLabel(position[1])} · MMSI ${esc(vessel.mmsi)}</div>
      <div class="popup-attr"><b>Speed over ground:</b> ${esc(fmtNumber(position[4], ' kn'))}</div>
      <div class="popup-attr"><b>Course over ground:</b> ${esc(fmtNumber(position[5], '°'))}</div>
      <div class="popup-attr"><b>Heading:</b> ${esc(fmtNumber(position[6], '°'))}</div>
      <div class="popup-attr">Observed source point only; no position is interpolated.</div>`;
  }

  function showFrame() {
    if (!data || !slider) return;
    const minute = Number(slider.value);
    const frame = minuteEvents.get(minute) || [];
    clearLayer(observationLayer);
    observationLayer = L.layerGroup();
    frame.forEach(position => {
      const vessel = data.vessels[position[0]];
      const selected = position[0] === selectedVessel;
      const marker = L.circleMarker([position[3], position[2]], {
        radius: selected ? 5.4 : 3.4,
        color: selected ? '#fff0a8' : '#fff2df',
        weight: selected ? 2 : 1.1,
        fillColor: selected ? '#ffd478' : '#f27658',
        fillOpacity: 0.82,
        opacity: 0.96,
        interactive: true
      });
      marker.bindPopup(positionPopup(position), { maxWidth: 310 });
      marker.on('click', () => selectVessel(position[0], false, false));
      observationLayer.addLayer(marker);
    });
    observationLayer.addTo(map);
    const exactTime = periodStart + minute * 60;
    timeReadout.textContent = minuteLabel(exactTime);
    frameStatus.textContent = frame.length
      ? `${frame.length.toLocaleString()} observed AIS fixes in this minute bin · exact seconds in point details`
      : 'No AIS observation in this minute. The map shows no vessel location.';
    broadcastState();
  }

  function vesselDisplayName(vessel) {
    return vessel.name || `Unnamed vessel · MMSI ${vessel.mmsi}`;
  }

  function renderVesselList() {
    if (!data) return;
    const query = searchInput.value.trim().toLocaleLowerCase();
    const matches = data.vessels
      .map((vessel, index) => ({ vessel, index }))
      .filter(({ vessel }) => `${vessel.name || ''} ${vessel.mmsi} ${vessel.imo || ''} ${vessel.call_sign || ''}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => b.vessel.position_count - a.vessel.position_count || a.vessel.mmsi - b.vessel.mmsi);
    const visible = matches.slice(0, 40);
    vesselList.innerHTML = visible.map(({ vessel, index }) =>
      `<button type="button" class="ais-vessel-option${index === selectedVessel ? ' active' : ''}" data-vessel-index="${index}" role="option" aria-selected="${index === selectedVessel}">
        <span>${esc(vesselDisplayName(vessel))}</span><small>MMSI ${esc(vessel.mmsi)} · ${vessel.position_count.toLocaleString()} fixes</small>
      </button>`
    ).join('') || '<div class="ais-empty">No vessel matches that search.</div>';
    const omitted = matches.length - visible.length;
    document.getElementById('aisVesselListNote').textContent = omitted > 0
      ? `Showing 40 of ${matches.length} matches. Search to narrow the list.`
      : `${matches.length} vessel${matches.length === 1 ? '' : 's'} in this harbor time window.`;
  }

  function vesselDetailMarkup(vessel, index, gapCount, trajectoryPoints) {
    const fields = [
      ['MMSI', vessel.mmsi],
      ['IMO', vessel.imo],
      ['Call sign', vessel.call_sign],
      ['Vessel type code', vessel.vessel_type],
      ['Navigation status code', vessel.status],
      ['Length', fmtNumber(vessel.length_m, ' m')],
      ['Width', fmtNumber(vessel.width_m, ' m')],
      ['Draft', fmtNumber(vessel.draft_m, ' m')],
      ['Cargo code', vessel.cargo],
      ['Transceiver class', vessel.transceiver_class]
    ];
    return `<div class="ais-detail-title">${esc(vesselDisplayName(vessel))}</div>
      <div class="ais-detail-grid">${fields.map(([label, value]) => `<div><span>${esc(label)}</span><b>${esc(nullable(value))}</b></div>`).join('')}</div>
      <div class="ais-detail-meta">${vessel.position_count.toLocaleString()} source fixes · ${utcLabel(Date.parse(vessel.first_seen_utc) / 1000)} – ${utcLabel(Date.parse(vessel.last_seen_utc) / 1000)}</div>
      <div class="ais-detail-meta">${trajectoryPoints} points in displayed trajectory · ${gapCount} gap break${gapCount === 1 ? '' : 's'} at intervals over 10 minutes</div>
      <div class="ais-detail-note">Metadata is the first available AIS record in this time window. Missing values remain blank; no vessel state is inferred.</div>`;
  }

  function drawTrajectory(index, fitToTrack = true, redrawFrame = true) {
    clearLayer(trajectoryLayer);
    trajectoryLayer = L.featureGroup();
    const events = vesselEvents[index] || [];
    const byTimestamp = new Map();
    events.forEach(position => {
      // NOAA may contain more than one fix for an MMSI at the same minute.
      // Keep every fix in the replay, but do not connect ambiguous same-time fixes.
      if (!byTimestamp.has(position[1])) byTimestamp.set(position[1], position);
    });
    const unique = Array.from(byTimestamp.values()).sort((a, b) => a[1] - b[1]);
    let segment = [];
    let gaps = 0;
    let points = 0;
    const flush = () => {
      if (segment.length > 1) {
        trajectoryLayer.addLayer(L.polyline(segment.map(p => [p[3], p[2]]), {
          color: '#ffd67b', weight: 2.2, opacity: 0.84, dashArray: '5 4', interactive: false
        }));
        points += segment.length;
      }
      segment = [];
    };
    unique.forEach(position => {
      if (segment.length && position[1] - segment[segment.length - 1][1] > GAP_BREAK_SECONDS) {
        flush();
        gaps += 1;
      }
      segment.push(position);
    });
    flush();
    trajectoryLayer.addTo(map);
    const vessel = data.vessels[index];
    vesselDetail.innerHTML = vesselDetailMarkup(vessel, index, gaps, points);
    const bounds = trajectoryLayer.getBounds();
    if (fitToTrack && bounds.isValid()) map.fitBounds(bounds.pad(0.2), { maxZoom: 15 });
    renderVesselList();
    if (redrawFrame) showFrame();
  }

  function selectVessel(index, fit = true, redrawFrame = true) {
    selectedVessel = index;
    drawTrajectory(index, fit, redrawFrame);
    broadcastState();
  }

  function pauseReplay() {
    isPlaying = false;
    if (timer) window.clearInterval(timer);
    timer = null;
    playButton.textContent = '▶ Play';
    playButton.setAttribute('aria-label', 'Play historical AIS replay');
    broadcastState();
  }

  function playbackTick() {
    const step = Number(speedSelect.value);
    let next = Number(slider.value) + step;
    if (next >= durationMinutes) {
      next = durationMinutes - 1;
      slider.value = String(next);
      showFrame();
      pauseReplay();
      return;
    }
    slider.value = String(next);
    showFrame();
  }

  function playReplay() {
    if (!data || isPlaying) return;
    if (Number(slider.value) >= durationMinutes - 1) slider.value = '0';
    isPlaying = true;
    playButton.textContent = 'Ⅱ Pause';
    playButton.setAttribute('aria-label', 'Pause historical AIS replay');
    timer = window.setInterval(playbackTick, 1000);
    broadcastState();
  }

  function updateSpeedHint() {
    const speed = Number(speedSelect.value);
    speedHint.textContent = `${speed} data minute${speed === 1 ? '' : 's'} / second`;
  }

  function validateBundle(bundle) {
    if (!bundle || !Array.isArray(bundle.vessels) || !Array.isArray(bundle.positions)) throw new Error('The NOAA replay file has an unexpected structure.');
    const start = Date.parse(bundle.period_start_utc);
    const end = Date.parse(bundle.period_end_exclusive_utc);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('The NOAA replay time window is invalid.');
    if (!Array.isArray(bundle.bbox_wgs84) || bundle.bbox_wgs84.length !== 4) throw new Error('The NOAA replay study window is missing.');
    const [minLon, minLat, maxLon, maxLat] = bundle.bbox_wgs84;
    const vesselPositions = bundle.vessels.map(() => []);
    const frameMap = new Map();
    const periodStartSeconds = Math.floor(start / 1000);
    const minutes = Math.ceil((end - start) / 60000);
    let invalid = 0;
    for (const position of bundle.positions) {
      if (!Array.isArray(position) || position.length !== 7) { invalid += 1; continue; }
      const [index, seconds, lon, lat] = position;
      const vessel = bundle.vessels[index];
      const validMotion = (position[4] === null || (Number.isFinite(position[4]) && position[4] >= 0 && position[4] <= 102.2)) &&
        (position[5] === null || (Number.isFinite(position[5]) && position[5] >= 0 && position[5] < 360)) &&
        (position[6] === null || (Number.isInteger(position[6]) && position[6] >= 0 && position[6] <= 359));
      if (!Number.isInteger(index) || !bundle.vessels[index] || !Number.isInteger(seconds) ||
          seconds < periodStartSeconds || seconds >= end / 1000 ||
          !Number.isInteger(vessel.mmsi) || vessel.mmsi < 100000000 || vessel.mmsi > 999999999 ||
          !validMotion || !Number.isFinite(lon) || !Number.isFinite(lat) || lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) {
        invalid += 1;
        continue;
      }
      const minute = Math.floor((seconds - periodStartSeconds) / 60);
      if (minute < 0 || minute >= minutes) { invalid += 1; continue; }
      if (!frameMap.has(minute)) frameMap.set(minute, []);
      frameMap.get(minute).push(position);
      vesselPositions[index].push(position);
    }
    if (invalid) throw new Error(`${invalid} AIS rows failed coordinate, timestamp, or vessel checks.`);
    return { start: periodStartSeconds, minutes, frameMap, vesselPositions };
  }

  async function enableReplay() {
    panel.hidden = false;
    if (data) {
      setStatus(`${data.position_count.toLocaleString()} NOAA source fixes · ${data.vessel_count} MMSIs · 15 Jul 2024 UTC. Historical, not live.`, 'ready');
      if (selectedVessel !== null) drawTrajectory(selectedVessel, false, false);
      showFrame();
      return;
    }
    setStatus('Loading the local Port-area NOAA sample…', 'loading');
    frameStatus.textContent = 'Historical time selection is loading.';
    try {
      const response = await fetch(DATA_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bundle = await response.json();
      const validated = validateBundle(bundle);
      if (!bundle.positions.length) throw new Error('NOAA returned no observations for this harbor and time window.');
      data = bundle;
      periodStart = validated.start;
      durationMinutes = validated.minutes;
      minuteEvents = validated.frameMap;
      vesselEvents = validated.vesselPositions;
      slider.min = '0';
      slider.max = String(Math.max(0, durationMinutes - 1));
      slider.value = '0';
      slider.disabled = false;
      playButton.disabled = false;
      speedSelect.disabled = false;
      searchInput.disabled = false;
      const sourceStart = Date.parse(data.period_start_utc) / 1000;
      slider.value = String(Math.max(0, Math.floor((Math.min(...data.positions.map(p => p[1])) - sourceStart) / 60)));
      renderVesselList();
      updateSpeedHint();
      setStatus(`${data.position_count.toLocaleString()} NOAA source fixes · ${data.vessel_count} MMSIs · 15 Jul 2024 UTC. Historical, not live.`, 'ready');
      if (document.getElementById('vesselsToggle').checked) showFrame();
    } catch (error) {
      setStatus(`Historical AIS unavailable: ${error.message}`, 'error');
      frameStatus.textContent = 'No vessel locations were drawn. Check the connection and try the layer again.';
      window.dispatchEvent(new CustomEvent('port-ais-error', { detail: { message: error.message } }));
    }
  }

  function disableReplay() {
    pauseReplay();
    panel.hidden = true;
    clearLayer(observationLayer);
    clearLayer(trajectoryLayer);
    observationLayer = null;
    trajectoryLayer = null;
  }

  document.getElementById('vesselsToggle').addEventListener('change', event => {
    if (event.target.checked) enableReplay();
    else disableReplay();
  });
  slider.addEventListener('input', showFrame);
  playButton.addEventListener('click', () => isPlaying ? pauseReplay() : playReplay());
  speedSelect.addEventListener('change', updateSpeedHint);
  searchInput.addEventListener('input', renderVesselList);
  vesselList.addEventListener('click', event => {
    const button = event.target.closest('button[data-vessel-index]');
    if (button) selectVessel(Number(button.dataset.vesselIndex));
  });

  window.addEventListener('beforeunload', pauseReplay);
  broadcastState();
})();
