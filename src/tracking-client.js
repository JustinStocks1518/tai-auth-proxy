// Serialized as an inline function by the renderer. No template escaping layer.
export function trackingClient() {
  const config = JSON.parse(document.getElementById('journey-data').textContent);
  const root = document.getElementById('tracking-workspace');
  const mapbox = root.querySelector('.journey-mapbox');
  const svg = root.querySelector('.journey-map');
  const layer = root.querySelector('.journey-observations');
  const controls = root.querySelector('.journey-controls');
  const title = root.querySelector('.journey-location');
  const stamp = root.querySelector('.journey-stamp');
  const notice = root.querySelector('.journey-notice');
  const button = root.querySelector('.journey-refresh');
  const list = root.querySelector('.journey-history-list');
  const historyPanel = root.querySelector('.journey-history');
  const selected = root.querySelector('.journey-selected');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let data = null, resultState = 'saved', nextCheck = null, busy = false;
  let activeTab = 'journey', selectedIndex = null, shown = 30;
  let entrancePlayed = false, visible = false, animation = null, opened = false;
  let renderedMap = '';
  const fmt = value => value ? new Date(value).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : 'Report time unavailable';
  const latest = () => {
    const saved = config.fallback;
    const fetched = data?.latest;
    if (saved?.reportedAt && (!fetched?.reportedAt || saved.reportedAt > fetched.reportedAt)) return saved;
    return fetched || saved || data?.untimed || null;
  };
  const isStale = () => !latest()?.reportedAt || Date.now() - Date.parse(latest().reportedAt) > 2 * 60 * 60_000;
  // A delivered journey replays its recorded trail once, even when the final
  // report is old. It keeps the historical label and never implies live movement.
  const motionAllowed = () => (config.delivered || (config.active && !isStale())) && !reduced.matches && !['unavailable', 'limited', 'paused'].includes(resultState) && (data?.points.length || 0) > 1;
  function stopMotion() { animation?.cancel(); animation = null; mapbox.classList.remove('is-arriving'); }
  function animateArrival() {
    if (!visible || entrancePlayed || !motionAllowed()) return;
    const path = layer.querySelector('.journey-trail');
    if (!path || !path.getTotalLength()) return;
    entrancePlayed = true;
    const length = path.getTotalLength();
    animation = path.animate([{ strokeDasharray: length + ' ' + length, strokeDashoffset: length }, { strokeDasharray: length + ' ' + length, strokeDashoffset: 0 }], { duration: 850, easing: 'ease-out' });
    animation.onfinish = () => { if (motionAllowed()) mapbox.classList.add('is-arriving'); };
  }
  function node(tag, attrs = {}, value) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, val] of Object.entries(attrs)) el.setAttribute(key, val);
    if (value != null) el.textContent = value;
    return el;
  }
  function selectPoint(index) {
    selectedIndex = index;
    const p = data?.points[index];
    if (!p) return;
    selected.textContent = (p.location || 'Reported position') + ' · ' + fmt(p.reportedAt);
    layer.querySelector('.journey-selected-ring')?.remove();
    if (p.xy) {
      const unitsPerPixel = Number(svg.getAttribute('viewBox').split(' ')[2]) / (mapbox.clientWidth || 500);
      layer.append(node('circle', { cx: p.xy[0], cy: p.xy[1], r: 6 * unitsPerPixel, class: 'journey-selected-ring' }));
    }
    for (const el of root.querySelectorAll('[data-report]')) el.setAttribute('aria-pressed', String(Number(el.dataset.report) === index));
  }
  function renderHistory() {
    const points = data?.points || [];
    historyPanel.hidden = points.length === 0;
    root.querySelector('.journey-history-summary').textContent = 'Location history · ' + points.length + (data?.truncated ? ' most recent reports' : ' reports');
    list.replaceChildren();
    points.map((p, index) => ({ p, index })).reverse().slice(0, shown).forEach(({ p, index }) => {
      const li = document.createElement('li');
      const item = document.createElement('button');
      item.type = 'button'; item.dataset.report = index;
      const place = document.createElement('span'); place.textContent = p.location || 'Reported position';
      const time = document.createElement('time'); time.dateTime = p.reportedAt; time.textContent = fmt(p.reportedAt) + (!p.xy ? ' · No map position' : '');
      item.append(place, time); item.addEventListener('click', () => selectPoint(index)); li.append(item); list.append(li);
    });
    const more = root.querySelector('.journey-more');
    more.hidden = shown >= points.length;
    if (!points.length) selected.textContent = 'Location history will appear here when reports are available.';
    else if (selectedIndex == null) selected.textContent = 'Select a report on the map or in the history.';
    if (selectedIndex != null && points[selectedIndex]) selectPoint(selectedIndex);
  }
  function renderMap() {
    const current = latest();
    const points = data?.points || [];
    const signature = JSON.stringify([mapbox.clientWidth, mapbox.clientHeight, current, points]);
    // A saved-data read followed by a cooldown response must not cancel the
    // entrance halfway through or recreate the map on a same-data tab return.
    if (signature === renderedMap) { animateArrival(); return; }
    renderedMap = signature;
    stopMotion(); layer.replaceChildren(); controls.replaceChildren();
    const legend = root.querySelector('.journey-legend');
    const keys = legend.querySelectorAll('span');
    keys[0].hidden = !points.some(p => p.xy) && !current?.xy;
    if (keys[1]) keys[1].hidden = !current?.xy || !config.stops.some(p => p.kind === 'destination' && p.xy);
    const anchors = [...points, ...config.stops, current].filter(p => p?.xy);
    mapbox.hidden = anchors.length === 0;
    root.querySelector('.journey-no-map').hidden = anchors.length > 0;
    if (!anchors.length) return;
    const width = mapbox.clientWidth || 500, height = mapbox.clientHeight || 350;
    const xs = anchors.map(p => p.xy[0]), ys = anchors.map(p => p.xy[1]);
    let w = Math.max(100, Math.max(...xs) - Math.min(...xs) + 90);
    let h = Math.max(100, Math.max(...ys) - Math.min(...ys) + 60);
    if (w / h < width / height) w = h * width / height; else h = w * height / width;
    const x = (Math.min(...xs) + Math.max(...xs) - w) / 2;
    const y = (Math.min(...ys) + Math.max(...ys) - h) / 2;
    svg.setAttribute('viewBox', [x, y, w, h].join(' '));
    const pixel = w / width;
    const screen = p => [(p.xy[0] - x) / w * width, (p.xy[1] - y) / h * height];
    const occupied = [];
    const overlaps = box => occupied.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
    const label = (p, value, priority = false) => {
      const [sx, sy] = screen(p), size = Math.min(value.length * 6.1, 160);
      for (const dx of [12, -size - 12]) {
        const box = [sx + dx - 3, sy - 10, sx + dx + size + 3, sy + 9];
        if (box[0] < 5 || box[2] > width - 5 || box[1] < 5 || box[3] > height - 5 || overlaps(box)) continue;
        occupied.push(box);
        layer.append(node('text', { x: p.xy[0] + dx * pixel, y: p.xy[1] + 4 * pixel, 'font-size': 11 * pixel, class: priority ? 'journey-label primary' : 'journey-label' }, value));
        return;
      }
    };
    let path = '', previous = false;
    for (const p of points) {
      if (!p.xy) { previous = false; continue; }
      path += (previous ? 'L' : 'M') + p.xy.join(','); previous = true;
    }
    if (path) layer.append(node('path', { d: path, class: 'journey-trail' }));
    const dest = config.stops.find(p => p.kind === 'destination');
    if (config.active && current?.xy && dest?.xy) layer.append(node('path', { d: 'M' + current.xy.join(',') + 'L' + dest.xy.join(','), class: 'journey-direction' }));
    const hotspot = (p, cls, aria, index = null) => {
      const [sx, sy] = screen(p);
      const el = document.createElement(index == null ? 'span' : 'button');
      el.className = 'journey-hotspot ' + cls;
      el.style.left = sx / width * 100 + '%'; el.style.top = sy / height * 100 + '%';
      el.setAttribute('aria-label', aria); el.title = aria;
      const dot = document.createElement('i'); el.append(dot);
      if (index != null) { el.type = 'button'; el.dataset.report = index; el.addEventListener('click', () => selectPoint(index)); }
      controls.append(el);
    };
    // Reserve identifying labels before placing optional history controls.
    if (current?.xy) label(current, config.active ? 'Latest report' : 'Last report', true);
    for (const p of config.stops.filter(p => p.xy)) label(p, p.location, true);
    for (const p of config.cities) {
      const [sx, sy] = screen(p);
      if (sx > 15 && sx < width - 15 && sy > 15 && sy < height - 15) label(p, p.location);
    }
    points.forEach((p, index) => {
      if (!p.xy) return;
      layer.append(node('circle', { cx: p.xy[0], cy: p.xy[1], r: 2.3 * pixel, class: 'journey-dot' }));
      // Keep dense GPS series usable: every point remains in history, while
      // map controls have a minimum spacing and never overlay the latest pin.
      const [sx, sy] = screen(p);
      if (current?.xy && Math.hypot(...screen(current).map((v, i) => v - [sx, sy][i])) < 30) return;
      const hitbox = [sx - 22, sy - 22, sx + 22, sy + 22];
      if (!overlaps(hitbox)) { occupied.push(hitbox); hotspot(p, 'report', (p.location || 'Reported position') + ', ' + fmt(p.reportedAt), index); }
    });
    if (current?.xy) {
      const index = points.findIndex(p => p.reportedAt === current.reportedAt && p.latitude === current.latitude && p.longitude === current.longitude);
      hotspot(current, 'current', 'Latest report: ' + (current.location || 'Reported position'), index >= 0 ? index : null);
    }
    for (const p of config.stops.filter(p => p.xy)) {
      layer.append(node('rect', { x: p.xy[0] - 3.5 * pixel, y: p.xy[1] - 3.5 * pixel, width: 7 * pixel, height: 7 * pixel, rx: pixel, class: 'journey-stop' }));
    }
    if (selectedIndex != null) selectPoint(selectedIndex);
    animateArrival();
  }
  function freshness() {
    const current = latest();
    title.textContent = current?.location || (current ? 'Reported position' : 'Waiting for a location report');
    stamp.textContent = current?.reportedAt ? 'Reported ' + fmt(current.reportedAt) : 'Report time unavailable';
    const stale = isStale();
    root.classList.toggle('is-aged', stale);
    root.querySelector('.journey-age').textContent = !config.active ? 'Journey record' : stale ? 'Last known location' : 'Recent location report';
    // Keep the familiar Details row consistent with the map, without writing
    // the shared shipment record or substituting fetch time for report time.
    const detail = [...root.querySelectorAll('.drow')].find(el => el.querySelector('.k')?.textContent === 'Last location')?.querySelector('.v');
    if (detail && current) {
      detail.replaceChildren(document.createTextNode(current.location || 'Reported position'));
      if (typeof current.latitude === 'number' && typeof current.longitude === 'number') {
        detail.append(document.createTextNode(' · '));
        const link = document.createElement('a'); link.href = 'https://maps.google.com/?q=' + current.latitude + ',' + current.longitude; link.rel = 'noopener'; link.textContent = 'Map ↗'; detail.append(link);
      }
      const time = document.createElement('span'); time.className = 'sub'; time.textContent = current.reportedAt ? 'as of ' + fmt(current.reportedAt) : 'Report time unavailable';
      detail.append(document.createElement('br'), time);
    }
    if (!motionAllowed()) stopMotion();
  }
  function render() {
    freshness(); renderHistory(); renderMap();
    const messages = {
      saved: data?.checkedAt ? 'Last checked ' + fmt(data.checkedAt) + '.' : 'Showing saved tracking data.',
      refreshed: 'Location check complete · ' + fmt(data?.checkedAt) + '.',
      final: 'Final location history saved.',
      cooldown: 'Showing the latest saved reports. Another check is available ' + fmt(nextCheck) + '.',
      paused: 'Location refresh is not available yet. Saved tracking data is shown.',
      limited: 'Location checks are temporarily paused. Try again ' + fmt(nextCheck) + '.',
      unavailable: 'Could not check for newer reports. Your saved locations are still shown. Try again' + (nextCheck ? ' ' + fmt(nextCheck) : '') + '.',
    };
    notice.textContent = messages[resultState] || messages.saved;
    button.hidden = !config.refreshable;
    button.textContent = resultState === 'unavailable' ? 'Retry' : 'Check location';
  }
  async function load(refresh) {
    if (busy) return;
    busy = true; button.disabled = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    if (refresh) { button.textContent = 'Checking…'; notice.textContent = 'Checking for newer location reports…'; }
    try {
      const response = await fetch(config.endpoint, { method: refresh ? 'POST' : 'GET', cache: 'no-store', signal: controller.signal, headers: refresh ? { 'X-Tracking-Refresh': '1' } : {} });
      if (!response.ok) throw new Error('Unavailable');
      const payload = await response.json();
      if (payload.history) {
        const key = selectedIndex != null ? data?.points[selectedIndex]?.reportedAt : null;
        data = payload.history;
        selectedIndex = key ? data.points.findIndex(p => p.reportedAt === key) : null;
        if (selectedIndex === -1) selectedIndex = null;
      }
      resultState = payload.state; nextCheck = payload.nextCheckAt;
      render();
    } catch { resultState = 'unavailable'; render(); }
    finally { clearTimeout(timeout); busy = false; button.disabled = false; }
  }
  async function firstVisibleOpen() {
    if (opened || document.visibilityState !== 'visible') return;
    opened = true;
    await load(false);
    if (config.refreshable) await load(true);
  }
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  function layout() {
    const mobile = root.clientWidth < 760;
    root.classList.toggle('is-mobile', mobile);
    tabs.forEach(tab => {
      const active = tab.dataset.panel === activeTab;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    });
    root.querySelector('.journey-tabs').hidden = !mobile;
    for (const panel of root.querySelectorAll('[data-panel-content]')) {
      panel.hidden = mobile && panel.dataset.panelContent !== activeTab;
      if (mobile) panel.setAttribute('role', 'tabpanel'); else panel.removeAttribute('role');
    }
    if (!mobile || activeTab === 'journey') renderMap();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => { activeTab = tab.dataset.panel; layout(); });
    tab.addEventListener('keydown', event => {
      const target = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (target >= 0) { event.preventDefault(); activeTab = tabs[target].dataset.panel; layout(); tabs[target].focus(); }
    });
  });
  button.addEventListener('click', () => {
    if (nextCheck && Date.parse(nextCheck) > Date.now()) { notice.textContent = 'Saved locations are shown. Another check is available ' + fmt(nextCheck) + '.'; return; }
    load(true);
  });
  root.querySelector('.journey-more').addEventListener('click', () => { shown += 50; renderHistory(); });
  mapbox.addEventListener('animationend', () => mapbox.classList.remove('is-arriving'));
  reduced.addEventListener('change', () => { if (reduced.matches) stopMotion(); });
  new IntersectionObserver(entries => { visible = entries.some(e => e.isIntersecting); if (visible) animateArrival(); }, { threshold: .4 }).observe(mapbox);
  let priorWidth = 0;
  new ResizeObserver(() => { if (Math.abs(root.clientWidth - priorWidth) > 1) { priorWidth = root.clientWidth; layout(); } }).observe(root);
  document.addEventListener('visibilitychange', () => { freshness(); firstVisibleOpen(); });
  render(); layout(); firstVisibleOpen();
}
