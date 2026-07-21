// applepie staging dashboard — plain JS, no build step, no framework.
// Renders /api/overview into the sections defined in index.html and
// re-fetches every 60s. Every chart here is hand-rolled inline SVG.

const REFRESH_MS = 60_000;
const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------- formatting helpers ----------

function fmtBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function fmtDuration(totalSeconds) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return 'n/a';
  const s = Math.round(totalSeconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function fmtAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function fmtClock(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtPct(p) {
  return p == null ? 'n/a' : `${p.toFixed(1)}%`;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null) node.append(c);
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** icon+word status chip — status is never conveyed by color alone. */
function statusChip(kind, word) {
  return `<span class="status-chip status-${kind}"><span class="status-dot"></span>${word}</span>`;
}

// ---------- tooltip (shared by both charts) ----------

function makeTooltip(container) {
  const tip = el('div', { class: 'tooltip' });
  container.style.position = 'relative';
  container.append(tip);
  return {
    show(x, y, html) {
      tip.innerHTML = html;
      tip.style.left = `${x}px`;
      tip.style.top = `${y - 8}px`;
      tip.classList.add('visible');
    },
    hide() {
      tip.classList.remove('visible');
    },
  };
}

// ---------- tile row ----------

function renderTiles(ov) {
  const tiles = document.getElementById('tiles');
  tiles.innerHTML = '';

  // overall status
  let overallKind = 'na';
  let overallWord = 'n/a';
  if (ov.aggregates.allServicesRunning === true) {
    overallKind = 'good';
    overallWord = 'all running';
  } else if (ov.aggregates.allServicesRunning === false) {
    overallKind = 'critical';
    overallWord = 'degraded';
  }

  const uptime = ov.aggregates.mainSiteUptimePct24h;
  let uptimeKind = 'na';
  if (uptime != null) uptimeKind = uptime >= 99.5 ? 'good' : uptime >= 95 ? 'warning' : 'critical';

  const deploy = ov.aggregates.lastDeploy;
  const tls = ov.tls;
  let tlsKind = 'na';
  if (tls) tlsKind = tls.daysRemaining > 21 ? 'good' : tls.daysRemaining > 7 ? 'warning' : 'critical';

  const disk = ov.storage.disk;
  const totalStorage = ov.storage.dirs.reduce((sum, d) => sum + d.bytes, 0);

  const rows = [
    {
      label: 'Overall status',
      value: statusChip(overallKind, overallWord),
      html: true,
    },
    {
      label: 'Uptime (24h)',
      value: fmtPct(uptime),
      sub: ov.health[0] ? ov.health[0].name : 'no health targets configured',
    },
    {
      label: 'Last deploy',
      value: deploy ? fmtAgo(Date.parse(deploy.ts)) : 'n/a',
      sub: deploy
        ? `${fmtDuration(deploy.durations.total_s)} · ${deploy.branch}@${deploy.gitSha.slice(0, 7)}`
        : 'DEPLOY_LOG not configured',
    },
    {
      label: 'Disk free',
      value: disk ? fmtBytes(disk.freeBytes) : 'n/a',
      sub: disk ? `of ${fmtBytes(disk.totalBytes)}` : '—',
    },
    {
      label: 'Session storage',
      value: ov.storage.dirs.length ? fmtBytes(totalStorage) : 'n/a',
      sub: ov.storage.dirs.map((d) => d.name).join(', ') || 'no STORAGE_DIRS configured',
    },
    {
      label: 'TLS expiry',
      value: tls ? `${tls.daysRemaining}d` : 'n/a',
      valueClass: tlsKind !== 'na' ? `status-${tlsKind}` : '',
      sub: tls ? `soonest: ${tls.path.split('/').pop()}` : 'CERT_DIR not configured',
    },
    {
      label: 'Host load / mem',
      value: ov.vitals ? ov.vitals.loadavg.map((v) => v.toFixed(2)).join(' ') : 'n/a',
      sub: ov.vitals
        ? `${fmtBytes(ov.vitals.memTotalBytes - ov.vitals.memFreeBytes)} / ${fmtBytes(ov.vitals.memTotalBytes)} · ${ov.vitals.cpuCount} cpu`
        : 'no /proc (macOS?)',
    },
  ];

  for (const r of rows) {
    const valueNode = el('div', { class: `value tabular ${r.valueClass || ''}` });
    if (r.html) valueNode.innerHTML = r.value;
    else valueNode.textContent = r.value;
    tiles.append(
      el('div', { class: 'tile' }, [
        valueNode,
        el('div', { class: 'label' }, r.label),
        r.sub ? el('div', { class: 'sub' }, r.sub) : null,
      ]),
    );
  }
}

// ---------- services table ----------

function renderServices(podman) {
  const body = document.getElementById('services-body');
  body.innerHTML = '';
  if (!podman) {
    body.append(
      el('tr', {}, [el('td', { colspan: '4', class: 'empty-note' }, 'podman socket not reachable (n/a)')]),
    );
    return;
  }
  for (const c of podman.containers) {
    const kind = c.state === 'running' ? 'good' : c.state === 'exited' ? 'critical' : 'warning';
    const stateCell = el('td', { html: statusChip(kind, c.state) });
    body.append(
      el('tr', {}, [
        el('td', {}, c.name),
        stateCell,
        el('td', { class: 'num tabular' }, c.uptimeS != null ? fmtDuration(c.uptimeS) : '—'),
        el('td', {}, c.image),
      ]),
    );
  }
  if (podman.containers.length === 0) {
    body.append(el('tr', {}, [el('td', { colspan: '4', class: 'empty-note' }, 'no containers reported')]));
  }
}

// ---------- deploys chart: stacked columns, time left→right ----------

const DEPLOY_PHASES = [
  { key: 'sync_s', label: 'sync', color: 'var(--cat-1)' },
  { key: 'build_s', label: 'build', color: 'var(--cat-2)' },
  { key: 'apply_s', label: 'apply', color: 'var(--cat-4)' },
];

function renderDeploysLegend() {
  const legend = document.getElementById('deploys-legend');
  legend.innerHTML = DEPLOY_PHASES.map(
    (p) => `<span><span class="legend-swatch" style="background:${p.color}"></span>${p.label}</span>`,
  ).join('');
}

function renderDeploysChart(deploys) {
  const box = document.getElementById('deploys-chart');
  box.innerHTML = '';
  if (deploys === null) {
    box.append(el('div', { class: 'empty-note' }, 'DEPLOY_LOG not configured (n/a)'));
    return;
  }
  if (deploys.length === 0) {
    box.append(el('div', { class: 'empty-note' }, 'no deploys recorded yet'));
    return;
  }

  const recent = deploys.slice(-20);
  const width = box.clientWidth || 800;
  const height = 190;
  const padTop = 26; // room for the direct label on the last bar
  const padBottom = 18;
  const padLeft = 4;
  const padRight = 4;
  const plotH = height - padTop - padBottom;
  const maxTotal = Math.max(...recent.map((d) => d.durations.total_s));
  const gap = 6;
  const barW = Math.max(6, (width - padLeft - padRight) / recent.length - gap);

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' });

  // baseline
  svg.append(
    svgEl('line', {
      x1: padLeft,
      x2: width - padRight,
      y1: height - padBottom,
      y2: height - padBottom,
      stroke: 'var(--axis)',
      'stroke-width': 1,
    }),
  );

  const tooltip = makeTooltip(box);

  recent.forEach((d, i) => {
    const x = padLeft + i * (barW + gap);
    let y = height - padBottom;
    const segRects = [];
    DEPLOY_PHASES.forEach((phase, pi) => {
      const s = d.durations[phase.key] ?? 0;
      const segH = (s / maxTotal) * plotH;
      const drawH = Math.max(0, segH - 2); // 2px surface gap between stacked fills
      y -= segH;
      const isTop = pi === DEPLOY_PHASES.length - 1;
      const rect = svgEl('rect', {
        x,
        y,
        width: barW,
        height: Math.max(1, drawH),
        rx: isTop ? 4 : 2,
        fill: phase.color,
      });
      segRects.push(rect);
      svg.append(rect);
    });

    // invisible full-height hit target for a single per-bar tooltip
    const hit = svgEl('rect', {
      x,
      y: padTop,
      width: barW + gap,
      height: plotH,
      fill: 'transparent',
    });
    hit.addEventListener('mousemove', (ev) => {
      const rect = box.getBoundingClientRect();
      const when = new Date(d.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      tooltip.show(
        ev.clientX - rect.left,
        ev.clientY - rect.top,
        `<div class="tt-title">${d.branch}@${d.gitSha.slice(0, 7)} · ${fmtDuration(d.durations.total_s)}</div>` +
          `<div>${when}</div>` +
          DEPLOY_PHASES.map((p) => `<div>${p.label}: ${d.durations[p.key]}s</div>`).join('') +
          `<div>stacks: ${d.stacks.join(', ') || '—'}</div>`,
      );
    });
    hit.addEventListener('mouseleave', () => tooltip.hide());
    svg.append(hit);

    if (i === recent.length - 1) {
      const label = svgEl('text', {
        x: x + barW / 2,
        y: y - 8 < 12 ? 12 : y - 8,
        'text-anchor': 'middle',
        fill: 'var(--ink-secondary)',
        'font-size': '11px',
        class: 'tabular',
      });
      label.textContent = `${Math.round(d.durations.total_s)}s`;
      svg.append(label);
    }
  });

  box.append(svg);
}

// ---------- latency chart: line per target, crosshair tooltip, fail dots ----------

const LATENCY_COLORS = ['var(--cat-1)', 'var(--cat-2)'];

function renderLatencyLegend(health) {
  const legend = document.getElementById('latency-legend');
  if (health.length < 2) {
    legend.innerHTML = ''; // single series — the section title already names it
    return;
  }
  legend.innerHTML = health
    .map((t, i) => `<span><span class="legend-swatch" style="background:${LATENCY_COLORS[i % 2]}"></span>${t.name}</span>`)
    .join('');
}

function renderLatencyChart(health) {
  const box = document.getElementById('latency-chart');
  box.innerHTML = '';
  if (health.length === 0) {
    box.append(el('div', { class: 'empty-note' }, 'no HEALTH_TARGETS configured (n/a)'));
    return;
  }

  const width = box.clientWidth || 800;
  const height = 190;
  const padTop = 10;
  const padBottom = 20;
  const padLeft = 4;
  const padRight = 4;
  const plotH = height - padTop - padBottom;
  const now = Date.now();
  const since = now - 24 * 60 * 60 * 1000;

  const allMs = health.flatMap((t) => t.series24h.map((p) => p.ms).filter((v) => v != null));
  const maxMs = Math.max(10, ...allMs) * 1.15;

  const xOf = (ts) => padLeft + ((ts - since) / (now - since)) * (width - padLeft - padRight);
  const yOf = (ms) => padTop + plotH - (ms / maxMs) * plotH;

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' });

  // hairline gridlines (recessive)
  for (let i = 0; i <= 3; i += 1) {
    const gy = padTop + (plotH / 3) * i;
    svg.append(
      svgEl('line', { x1: padLeft, x2: width - padRight, y1: gy, y2: gy, stroke: 'var(--gridline)', 'stroke-width': 1 }),
    );
  }
  // baseline (bottom axis) where fail dots live
  const baselineY = padTop + plotH;

  health.forEach((target, ti) => {
    const color = LATENCY_COLORS[ti % 2];
    const points = target.series24h;
    let path = '';
    let drawing = false;
    for (const p of points) {
      if (p.ms == null) {
        drawing = false; // gap — don't interpolate across a failed check
        continue;
      }
      const cmd = drawing ? 'L' : 'M';
      path += `${cmd}${xOf(p.ts).toFixed(1)},${yOf(p.ms).toFixed(1)} `;
      drawing = true;
    }
    if (path) svg.append(svgEl('path', { d: path.trim(), fill: 'none', stroke: color, 'stroke-width': 2 }));

    for (const p of points) {
      if (p.ok) continue;
      svg.append(
        svgEl('circle', { cx: xOf(p.ts), cy: baselineY, r: 3.5, fill: 'var(--status-critical)' }),
      );
    }
  });

  // crosshair + tooltip
  const crosshair = svgEl('line', {
    x1: 0,
    x2: 0,
    y1: padTop,
    y2: baselineY,
    stroke: 'var(--axis)',
    'stroke-width': 1,
    visibility: 'hidden',
  });
  svg.append(crosshair);

  const tooltip = makeTooltip(box);
  const overlay = svgEl('rect', { x: 0, y: 0, width, height, fill: 'transparent' });
  overlay.addEventListener('mousemove', (ev) => {
    const rect = box.getBoundingClientRect();
    const relX = ((ev.clientX - rect.left) / rect.width) * width;
    const ts = since + ((relX - padLeft) / (width - padLeft - padRight)) * (now - since);
    crosshair.setAttribute('x1', relX);
    crosshair.setAttribute('x2', relX);
    crosshair.setAttribute('visibility', 'visible');

    const lines = health.map((t) => {
      const nearest = t.series24h.reduce(
        (best, p) => (Math.abs(p.ts - ts) < Math.abs((best?.ts ?? Infinity) - ts) ? p : best),
        null,
      );
      const val = nearest ? (nearest.ms != null ? `${nearest.ms}ms` : 'fail') : 'n/a';
      return `<div>${t.name}: ${val}</div>`;
    });
    tooltip.show(ev.clientX - rect.left, ev.clientY - rect.top, `<div class="tt-title">${fmtClock(ts)}</div>${lines.join('')}`);
  });
  overlay.addEventListener('mouseleave', () => {
    tooltip.hide();
    crosshair.setAttribute('visibility', 'hidden');
  });
  svg.append(overlay);

  box.append(svg);
}

// ---------- uptime strips: 24h of 5-min cells per target ----------

function renderUptimeStrips(health) {
  const container = document.getElementById('uptime-strips');
  container.innerHTML = '';
  if (health.length === 0) {
    container.append(el('div', { class: 'empty-note' }, 'no HEALTH_TARGETS configured (n/a)'));
    return;
  }

  const BUCKET_MS = 5 * 60 * 1000;
  const BUCKETS = (24 * 60 * 60 * 1000) / BUCKET_MS; // 288
  const now = Date.now();
  const start = now - BUCKETS * BUCKET_MS;

  for (const target of health) {
    const buckets = new Array(BUCKETS).fill(null); // null = no data
    for (const p of target.series24h) {
      const idx = Math.floor((p.ts - start) / BUCKET_MS);
      if (idx < 0 || idx >= BUCKETS) continue;
      if (buckets[idx] == null) buckets[idx] = p.ok;
      else buckets[idx] = buckets[idx] && p.ok;
    }
    const strip = el('div', { class: 'strip' });
    for (const b of buckets) {
      strip.append(el('div', { class: `cell ${b == null ? 'cell-empty' : b ? 'cell-ok' : 'cell-fail'}` }));
    }
    container.append(
      el('div', {}, [
        el('div', { class: 'strip-label' }, [
          el('span', {}, target.name),
          el('span', { class: 'tabular' }, `24h: ${fmtPct(target.uptimePct['24h'])}`),
        ]),
        strip,
      ]),
    );
  }
}

// ---------- storage ----------

function barRow(name, bytes, maxBytes, extraLabel) {
  const pct = maxBytes > 0 ? Math.max(2, (bytes / maxBytes) * 100) : 0;
  return el('div', { class: 'bar-row' }, [
    el('div', { class: 'name' }, name),
    el('div', { class: 'bar-track' }, [el('div', { class: 'bar-fill', style: `width:${pct}%;background:var(--cat-1)` })]),
    el('div', { class: 'val tabular' }, extraLabel ?? fmtBytes(bytes)),
  ]);
}

function renderStorage(storage) {
  const panel = document.getElementById('storage-panel');
  panel.innerHTML = '';

  if (storage.disk) {
    const { totalBytes, freeBytes } = storage.disk;
    const usedBytes = totalBytes - freeBytes;
    const usedPct = (usedBytes / totalBytes) * 100;
    panel.append(
      el('div', { class: 'bar-row' }, [
        el('div', { class: 'name' }, 'Disk'),
        el('div', { class: 'bar-track' }, [
          el('div', { class: 'bar-fill', style: `width:${usedPct}%;background:var(--cat-1)` }),
        ]),
        el('div', { class: 'val tabular' }, `${fmtBytes(usedBytes)} / ${fmtBytes(totalBytes)}`),
      ]),
    );
  } else {
    panel.append(el('div', { class: 'empty-note' }, 'disk stats unavailable (n/a)'));
  }

  if (storage.dirs.length === 0) {
    panel.append(el('div', { class: 'empty-note' }, 'no STORAGE_DIRS configured (n/a)'));
    return;
  }

  const maxBytes = Math.max(...storage.dirs.map((d) => d.bytes));
  for (const d of storage.dirs) {
    if (d.error) {
      panel.append(barRow(d.name, 0, 1, 'n/a'));
      continue;
    }
    panel.append(
      barRow(d.name, d.bytes, maxBytes, `${fmtBytes(d.bytes)}${d.truncated ? ' (capped)' : ''}`),
    );
    if (d.topSubdirs.length > 0) {
      const list = el('div', { class: 'subdir-list' });
      for (const s of d.topSubdirs) list.append(el('span', {}, `${s.name}: ${fmtBytes(s.bytes)}`));
      panel.append(list);
    }
  }
}

// ---------- main refresh loop ----------

async function refresh() {
  try {
    const res = await fetch('/api/overview');
    const ov = await res.json();
    renderTiles(ov);
    renderServices(ov.podman);
    renderDeploysLegend();
    renderDeploysChart(ov.deploys);
    renderLatencyLegend(ov.health);
    renderLatencyChart(ov.health);
    renderUptimeStrips(ov.health);
    renderStorage(ov.storage);
    window.__lastUpdated = Date.now();
    document.getElementById('updated').textContent = 'updated just now';
  } catch (err) {
    document.getElementById('updated').textContent = `fetch failed: ${err.message}`;
  }
}

setInterval(() => {
  if (window.__lastUpdated) {
    document.getElementById('updated').textContent = `updated ${fmtAgo(window.__lastUpdated)}`;
  }
}, 1000);

refresh();
setInterval(refresh, REFRESH_MS);
