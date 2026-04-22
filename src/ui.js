
(() => {
  const SP = window.__STATISTIK_PLUS__;
  if (!SP) return;

  const ui = {
    elements: {},
    lastStatusSummary: { progress: null },

    createRoot() {
      if (this.elements.root) return this.elements.root;

      const root = document.createElement('div');
      root.id = 'sp-root';
      root.innerHTML = `
        <button id="sp-floating-button" type="button" aria-label="Statistik Plus öffnen">
          <span>📊</span>
          <span>Statistik +</span>
        </button>
        <section id="sp-overlay" aria-hidden="true">
          <div id="sp-backdrop"></div>
          <div id="sp-panel" role="dialog" aria-modal="true" aria-labelledby="sp-title">
            <header id="sp-header">
              <div>
                <div class="sp-kicker">Eigenständige Erweiterung</div>
                <h1 id="sp-title">Statistik +</h1>
                <p id="sp-subtitle">Lokale Historie aus Spielhistorie · nur X01 · eigenes Statistik-Dashboard</p>
              </div>
              <div id="sp-header-actions">
                <div id="sp-filter-bar" class="sp-chip-row"></div>
                <div class="sp-chip-row sp-chip-row--actions">
                  <button class="sp-chip sp-secondary-action" data-action="history">Historie (X01)</button>
                  <button class="sp-chip sp-secondary-action" data-action="player">Spieler</button>
                  <button class="sp-chip sp-secondary-action" data-action="refresh">Aktualisieren</button>
                  <button class="sp-chip sp-secondary-action" data-action="export">Export</button>
                  <label class="sp-chip sp-secondary-action sp-file-chip">
                    Import
                    <input id="sp-import-input" type="file" accept="application/json" hidden />
                  </label>
                  <button class="sp-chip sp-secondary-action" data-action="demo">Demo-Daten</button>
                  <button class="sp-chip sp-secondary-action sp-danger" data-action="clear">Leeren</button>
                  <button class="sp-close-button" data-action="close" aria-label="Schließen">✕</button>
                </div>
              </div>
            </header>
            <div id="sp-status-bar"></div>
            <main id="sp-content">
              <section class="sp-section">
                <div class="sp-section-head">
                  <h2>Aktivität</h2>
                </div>
                <div id="sp-activity-kpis" class="sp-kpi-grid"></div>
                <div id="sp-activity-charts" class="sp-grid-2"></div>
              </section>

              <section class="sp-section">
                <div class="sp-section-head">
                  <h2>Performance</h2>
                </div>
                <div id="sp-performance-kpis" class="sp-kpi-grid"></div>
                <div id="sp-performance-layout">
                  <div id="sp-performance-left"></div>
                  <div id="sp-performance-right"></div>
                </div>
              </section>

              <section class="sp-section">
                <div class="sp-section-head">
                  <h2>Details</h2>
                </div>
                <div id="sp-field-hits"></div>
                <div id="sp-detail-extra" class="sp-grid-2"></div>
                <div id="sp-table-grid" class="sp-grid-2"></div>
              </section>
            </main>
          </div>
        </section>
      `;

      document.body.appendChild(root);

      this.elements.root = root;
      this.elements.overlay = root.querySelector('#sp-overlay');
      this.elements.panel = root.querySelector('#sp-panel');
      this.elements.floatingButton = root.querySelector('#sp-floating-button');
      this.elements.filterBar = root.querySelector('#sp-filter-bar');
      this.elements.statusBar = root.querySelector('#sp-status-bar');
      this.elements.importInput = root.querySelector('#sp-import-input');
      this.elements.activityKpis = root.querySelector('#sp-activity-kpis');
      this.elements.activityCharts = root.querySelector('#sp-activity-charts');
      this.elements.performanceKpis = root.querySelector('#sp-performance-kpis');
      this.elements.performanceLeft = root.querySelector('#sp-performance-left');
      this.elements.performanceRight = root.querySelector('#sp-performance-right');
      this.elements.fieldHits = root.querySelector('#sp-field-hits');
      this.elements.detailExtra = root.querySelector('#sp-detail-extra');
      this.elements.tableGrid = root.querySelector('#sp-table-grid');

      this.bindEvents();
      this.renderFilterBar();

      return root;
    },

    bindEvents() {
      this.elements.floatingButton.addEventListener('click', () => this.open());
      this.elements.overlay.addEventListener('click', (event) => {
        const action = event.target?.dataset?.action;
        if (event.target.id === 'sp-backdrop' || action === 'close') {
          this.close();
          return;
        }
        if (action === 'history') {
          SP.content?.importHistoryAndRefresh?.({ notify: true });
          return;
        }
        if (action === 'player') {
          SP.content?.configurePlayerName?.();
          return;
        }
        if (action === 'refresh') {
          SP.content?.refresh?.();
          return;
        }
        if (action === 'export') {
          this.exportData();
          return;
        }
        if (action === 'demo') {
          SP.content?.seedDemoData?.();
          return;
        }
        if (action === 'clear') {
          this.confirmClear();
        }
      });

      this.elements.importInput.addEventListener('change', async (event) => {
        const [file] = event.target.files || [];
        if (!file) return;
        try {
          const text = await file.text();
          const payload = JSON.parse(text);
          await SP.db.importAll(payload);
          await SP.content.refresh();
          this.toast('Import abgeschlossen.');
        } catch (error) {
          console.error('[Statistik+]', error);
          this.toast('Import fehlgeschlagen.', true);
        } finally {
          event.target.value = '';
        }
      });

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && SP.state.isOpen) {
          this.close();
        }
      });
    },

    renderFilterBar() {
      const filters = [
        { key: 'today', label: 'Heute' },
        { key: '7d', label: '7 Tage' },
        { key: '30d', label: '30 Tage' },
        { key: 'all', label: 'Alles' }
      ];
      const x01Modes = [301, 501];
      this.elements.filterBar.innerHTML = '';

      const dateGroup = document.createElement('div');
      dateGroup.className = 'sp-chip-row sp-chip-row--inline';
      filters.forEach((filter) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `sp-chip ${SP.state.filter === filter.key ? 'is-active' : ''}`;
        button.textContent = filter.label;
        button.addEventListener('click', async () => {
          SP.state.filter = filter.key;
          await SP.db.setMeta('selectedFilter', filter.key);
          this.renderFilterBar();
          await SP.content.refresh();
        });
        dateGroup.appendChild(button);
      });
      this.elements.filterBar.appendChild(dateGroup);

      const modeToggle = document.createElement('div');
      modeToggle.className = 'sp-segmented-toggle';

      const modeLabel = document.createElement('span');
      modeLabel.className = 'sp-segmented-toggle__label';
      modeLabel.textContent = 'X01';
      modeToggle.appendChild(modeLabel);

      x01Modes.forEach((mode) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `sp-segmented-toggle__button ${Number(SP.state.x01StartFilter) === mode ? 'is-active' : ''}`;
        button.textContent = String(mode);
        button.addEventListener('click', async () => {
          if (Number(SP.state.x01StartFilter) === mode) return;
          SP.state.x01StartFilter = mode;
          await SP.db.setMeta('selectedX01Start', mode);
          this.renderFilterBar();
          await SP.content.refresh();
        });
        modeToggle.appendChild(button);
      });

      this.elements.filterBar.appendChild(modeToggle);
    },

    open() {
      this.createRoot();
      SP.state.isOpen = true;
      this.elements.overlay.setAttribute('aria-hidden', 'false');
      this.elements.root.classList.add('is-open');
      document.documentElement.classList.add('sp-no-scroll');
    },

    close() {
      SP.state.isOpen = false;
      this.elements.overlay?.setAttribute('aria-hidden', 'true');
      this.elements.root?.classList.remove('is-open');
      document.documentElement.classList.remove('sp-no-scroll');
    },

    setFloatingButtonVisible(visible) {
      this.createRoot();
      if (!this.elements.floatingButton) return;
      this.elements.floatingButton.style.display = visible ? '' : 'none';
    },

    toast(message, isError = false) {
      const node = document.createElement('div');
      node.className = `sp-toast ${isError ? 'sp-toast--error' : ''}`;
      node.textContent = message;
      document.body.appendChild(node);
      requestAnimationFrame(() => node.classList.add('is-visible'));
      setTimeout(() => {
        node.classList.remove('is-visible');
        setTimeout(() => node.remove(), 220);
      }, 2500);
    },

    async exportData() {
      try {
        const data = await SP.db.exportAll();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `statistik-plus-export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        this.toast('Export erstellt.');
      } catch (error) {
        console.error('[Statistik+]', error);
        this.toast('Export fehlgeschlagen.', true);
      }
    },

    async confirmClear() {
      const confirmed = window.confirm('Alle lokal gespeicherten Statistik+-Daten löschen?');
      if (!confirmed) return;
      await SP.db.clearAll();
      await SP.content.refresh();
      this.toast('Alle Statistik+-Daten wurden gelöscht.');
    },

    renderStatus(summary = {}) {
      this.lastStatusSummary = { ...this.lastStatusSummary, ...summary };
      const current = this.lastStatusSummary || {};
      const progress = current.progress || null;
      const updatedAt = current.lastUpdatedAt ? SP.utils.formatDateTime(current.lastUpdatedAt) : '—';
      const legs = SP.utils.formatInt(current.totalLegs || 0);
      const checkouts = SP.utils.formatInt(current.totalCheckouts || 0);
      const darts = SP.utils.formatInt(current.totalDarts || 0);
      const parser = current.parserState || 'bereit';
      const player = current.playerName || 'unbekannt';
      const x01Start = [301, 501].includes(Number(current.x01StartFilter)) ? Number(current.x01StartFilter) : 501;

      this.elements.statusBar.innerHTML = `
        <div class="sp-status-pill"><strong>Spieler</strong><span>${player}</span></div>
        <div class="sp-status-pill"><strong>X01</strong><span>${x01Start}</span></div>
        <div class="sp-status-pill"><strong>Sync</strong><span>${parser}</span></div>
        <div class="sp-status-pill"><strong>Darts</strong><span>${darts}</span></div>
        <div class="sp-status-pill"><strong>Legs</strong><span>${legs}</span></div>
        <div class="sp-status-pill"><strong>Checkouts</strong><span>${checkouts}</span></div>
        <div class="sp-status-pill"><strong>Letztes Update</strong><span>${updatedAt}</span></div>
        ${this.buildHistoryProgressMarkup(progress)}
      `;
    },

    renderHistoryProgress(progress = null) {
      this.renderStatus({ progress, parserState: progress?.parserState || this.lastStatusSummary?.parserState || 'bereit' });
    },

    buildHistoryProgressMarkup(progress) {
      if (!progress || !progress.active) return '';

      const listTotal = Math.max(progress.listTotal || 0, progress.listScanned || 0);
      const matchTotal = Math.max(progress.matchTotal || 0, progress.matchScanned || 0);
      const phaseTotal = progress.phase === 'listing' ? listTotal : matchTotal;
      const phaseCurrent = progress.phase === 'listing' ? (progress.listScanned || 0) : (progress.matchScanned || 0);
      const percent = phaseTotal > 0 ? Math.max(0, Math.min(100, Math.round((phaseCurrent / phaseTotal) * 100))) : (progress.active ? 8 : 100);
      const phaseLabel = progress.phase === 'listing' ? 'Übersichten werden geladen' : 'Seiten werden geladen';
      const stateLabel = 'Lädt…';
      const currentLabel = progress.currentLabel || (progress.modeFilter ? `Filter: ${progress.modeFilter}` : '');

      return `
        <div class="sp-progress-block ${progress.active ? 'is-active' : 'is-complete'}">
          <div class="sp-progress-top">
            <div class="sp-progress-title-wrap">
              <strong>${phaseLabel}</strong>
              <span>${currentLabel || 'Spielhistorie'}</span>
            </div>
            <div class="sp-progress-state">${stateLabel}</div>
          </div>
          <div class="sp-progress-bar" aria-hidden="true">
            <span style="width:${percent}%;"></span>
          </div>
          <div class="sp-progress-meta">
            <span>Modus: ${progress.modeFilter || 'X01'}</span>
            <span>Übersichten ${progress.listScanned || 0}/${listTotal || 0}</span>
            <span>Seiten ${progress.matchScanned || 0}/${matchTotal || 0}</span>
            <span>Gefunden ${progress.foundMatches || 0} Matches</span>
            <span>Importiert ${progress.importedMatches || 0} Matches · ${progress.importedLegs || 0} Legs</span>
            <span>Übersprungen ${progress.skippedMatches || 0}</span>
          </div>
        </div>
      `;
    },

    renderDashboard(data) {
      this.renderActivityKpis(data.activityKpis);
      this.renderPerformanceKpis(data.performanceKpis);
      this.renderActivityCharts(data);
      this.renderPerformanceCharts(data);
      this.renderDetail(data);
    },

    renderActivityKpis(kpis) {
      const items = [
        {
          label: 'Total darts',
          value: SP.utils.formatInt(kpis.totalDarts || 0),
          meta: 'Geworfene Darts im Filter'
        },
        {
          label: 'Total legs',
          value: SP.utils.formatInt(kpis.totalLegs || 0),
          meta: 'Erfasste Legs'
        },
        {
          label: 'Total matches',
          value: SP.utils.formatInt(kpis.totalMatches || 0),
          meta: 'Eindeutige Matches'
        },
        {
          label: 'Spielzeit',
          value: SP.utils.formatDuration(kpis.playtimeSeconds),
          meta: 'Aus Legdauer bzw. Darts abgeleitet'
        }
      ];

      this.renderKpiGrid(this.elements.activityKpis, items);
    },

    renderPerformanceKpis(kpis) {
      const items = [
        {
          label: 'Best average',
          value: SP.utils.formatAverage(kpis.bestAverage),
          meta: 'Bester 3-Dart-Average'
        },
        {
          label: 'Best leg',
          value: Number.isFinite(kpis.bestLegDarts) ? `${SP.utils.formatInt(kpis.bestLegDarts)} Darts` : '—',
          meta: Number.isFinite(kpis.bestLegAverage) ? `Ø ${SP.utils.formatAverage(kpis.bestLegAverage)}` : 'Wenigste Darts'
        },
        {
          label: 'Best checkout',
          value: Number.isFinite(kpis.bestCheckout) ? SP.utils.formatInt(kpis.bestCheckout) : '—',
          meta: 'Höchster Finish-Wert'
        },
        {
          label: '180s',
          value: SP.utils.formatInt(kpis.total180s || 0),
          meta: 'Im ausgewählten Zeitraum'
        }
      ];

      this.renderKpiGrid(this.elements.performanceKpis, items);
    },

    renderKpiGrid(target, items) {
      target.innerHTML = items.map((item) => `
        <article class="sp-card sp-kpi-card">
          <div class="sp-card-label">${item.label}</div>
          <div class="sp-card-value">${item.value}</div>
          <div class="sp-card-meta">${item.meta}</div>
        </article>
      `).join('');
    },

    renderActivityCharts(data) {
      this.elements.activityCharts.innerHTML = '';
      this.elements.activityCharts.appendChild(this.renderActivityBarCard({
        title: 'Aktivität',
        subtitle: 'Darts pro Tag mit Datumsachse',
        items: data.activitySeries,
        emptyMessage: 'Noch keine Aktivitätsdaten vorhanden.'
      }));
      this.elements.activityCharts.appendChild(this.renderLineChartCard({
        title: 'Average-Verlauf',
        subtitle: 'Ø pro Tag mit Datumsachse',
        items: data.averageTrend.map((item) => ({ label: item.label, value: item.value })),
        emptyMessage: 'Noch keine Average-Daten vorhanden.'
      }));
    },

    renderPerformanceCharts(data) {
      this.elements.performanceLeft.innerHTML = '';
      this.elements.performanceRight.innerHTML = '';

      this.elements.performanceLeft.appendChild(this.renderHorizontalBarsCard({
        title: 'Average-Verteilung',
        subtitle: 'Legs nach Average-Bereichen',
        items: data.scoringDistribution,
        emptyMessage: 'Noch keine Verteilungsdaten vorhanden.'
      }));

      this.elements.performanceLeft.appendChild(this.renderHorizontalBarsCard({
        title: 'Finish-Profil',
        subtitle: 'Checkouts nach benötigten Darts',
        items: data.checkoutFinishBreakdown,
        emptyMessage: 'Noch keine Checkout-Daten vorhanden.',
        compact: true
      }));

      this.elements.performanceRight.appendChild(this.renderLineChartCard({
        title: 'Checkout-Quote',
        subtitle: 'Erfolgreiche Finishes mit Datumsachse',
        items: data.checkoutSeries.map((item) => ({ label: item.label, value: item.value, asPercent: true })),
        emptyMessage: 'Noch keine belastbare Checkout-Quote vorhanden.',
        compact: true
      }));

      this.elements.performanceRight.appendChild(this.renderRadarCard({
        title: 'Radar für Doubles',
        subtitle: 'Getroffene Doppel-Felder',
        items: data.doubleRadar,
        emptyMessage: data.hasHistoryOnlyData
          ? 'Aus der Spielhistorie kommen nur Leg-Zusammenfassungen. Double-Felder füllen sich erst mit Wurfdaten aus Live-Sync.'
          : 'Noch keine Double-Treffer erkannt.'
      }));
    },

    renderDetail(data) {
      this.elements.fieldHits.innerHTML = '';
      this.elements.detailExtra.innerHTML = '';
      this.elements.tableGrid.innerHTML = '';

      this.elements.fieldHits.appendChild(this.renderFieldHitsCard({
        title: 'Treffer je Feld',
        subtitle: 'Visuelle Übersicht der meistgetroffenen Felder',
        items: data.fieldHits,
        emptyMessage: data.hasHistoryOnlyData
          ? 'Der Historienimport liefert aktuell keine einzelnen Felder. Diese Ansicht füllt sich mit Live-Sync-Würfen.'
          : 'Noch keine Treffer je Feld vorhanden.'
      }));

      this.elements.detailExtra.appendChild(this.renderHorizontalBarsCard({
        title: 'Feldgruppen',
        subtitle: 'Singles, Doubles, Triples, Bull und Miss',
        items: data.fieldFamilies,
        emptyMessage: data.hasHistoryOnlyData
          ? 'Für Feldgruppen fehlen in der Historie die einzelnen Würfe. Das kommt mit Live-Sync.'
          : 'Noch keine Wurfdaten vorhanden.',
        compact: true
      }));

      this.elements.detailExtra.appendChild(this.renderHorizontalBarsCard({
        title: 'Zahlenschwerpunkte',
        subtitle: 'Treffer nach Grundzahl und Bull',
        items: data.numberHits,
        emptyMessage: data.hasHistoryOnlyData
          ? 'Auch Zahlenschwerpunkte brauchen Wurf-für-Wurf-Daten und bleiben bei reinem Historienimport leer.'
          : 'Noch keine Zahlentreffer vorhanden.',
        compact: true
      }));

      this.elements.tableGrid.appendChild(this.renderTopLegsTable(data.topLegs));
      this.elements.tableGrid.appendChild(this.renderTopCheckoutsTable(data.topCheckouts));
    },

    renderActivityBarCard({ title, subtitle, items, emptyMessage }) {
      const card = document.createElement('article');
      card.className = 'sp-card';
      card.innerHTML = `<div class="sp-card-head"><h3>${title}</h3><p>${subtitle}</p></div>`;

      if (!items.length) {
        card.appendChild(this.emptyState(emptyMessage));
        return card;
      }

      const max = Math.max(...items.map((item) => item.darts || 0), 1);
      const chart = document.createElement('div');
      chart.className = 'sp-bars';

      items.forEach((item) => {
        const bar = document.createElement('div');
        bar.className = 'sp-bar';
        const height = Math.max(8, Math.round(((item.darts || 0) / max) * 100));
        bar.innerHTML = `
          <div class="sp-bar-fill" style="height:${height}%"></div>
          <div class="sp-bar-label">${item.label}</div>
          <div class="sp-bar-value">${SP.utils.formatInt(item.darts || 0)} D</div>
          <div class="sp-bar-meta">${SP.utils.formatInt(item.legs || 0)} Legs</div>
        `;
        chart.appendChild(bar);
      });

      card.appendChild(chart);
      return card;
    },

    renderHorizontalBarsCard({ title, subtitle, items, emptyMessage, compact = false }) {
      const card = document.createElement('article');
      card.className = `sp-card ${compact ? 'sp-card--compact' : ''}`;
      card.innerHTML = `<div class="sp-card-head"><h3>${title}</h3><p>${subtitle}</p></div>`;

      if (!items.length || !items.some((item) => (item.value || 0) > 0)) {
        card.appendChild(this.emptyState(emptyMessage));
        return card;
      }

      const max = Math.max(...items.map((item) => item.value || 0), 1);
      const wrap = document.createElement('div');
      wrap.className = 'sp-horizontal-bars';

      items.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'sp-horizontal-bar-row';
        row.innerHTML = `
          <div class="sp-horizontal-bar-label">${item.label}</div>
          <div class="sp-horizontal-bar-track">
            <div class="sp-horizontal-bar-fill" style="width:${Math.max(4, ((item.value || 0) / max) * 100)}%"></div>
          </div>
          <div class="sp-horizontal-bar-value">${SP.utils.formatInt(item.value || 0)}</div>
        `;
        wrap.appendChild(row);
      });

      card.appendChild(wrap);
      return card;
    },

    renderLineChartCard({ title, subtitle, items, emptyMessage, compact = false }) {
      const card = document.createElement('article');
      card.className = `sp-card ${compact ? 'sp-card--compact' : ''}`;
      card.innerHTML = `<div class="sp-card-head"><h3>${title}</h3><p>${subtitle}</p></div>`;

      if (!items.length) {
        card.appendChild(this.emptyState(emptyMessage));
        return card;
      }

      const width = 560;
      const height = compact ? 170 : 220;
      const paddingX = 24;
      const paddingTop = 24;
      const paddingBottom = 28;
      const values = items.map((item) => item.value).filter(Number.isFinite);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const normalizedMax = max === min ? max + 1 : max;
      const normalizedMin = max === min ? min - 1 : min;
      const points = items.map((item, index) => {
        const x = paddingX + (index * (width - paddingX * 2)) / Math.max(items.length - 1, 1);
        const y = height - paddingBottom - (((item.value - normalizedMin) / (normalizedMax - normalizedMin)) * (height - paddingTop - paddingBottom));
        return [SP.utils.round(x, 2), SP.utils.round(y, 2)];
      });

      const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point[0]} ${point[1]}`).join(' ');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('class', 'sp-line-chart');

      const grid = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      [0.25, 0.5, 0.75].forEach((fraction) => {
        const y = paddingTop + (height - paddingTop - paddingBottom) * fraction;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', paddingX);
        line.setAttribute('x2', width - paddingX);
        line.setAttribute('y1', y);
        line.setAttribute('y2', y);
        line.setAttribute('class', 'sp-line-chart-grid');
        grid.appendChild(line);
      });
      svg.appendChild(grid);

      const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      polyline.setAttribute('d', path);
      polyline.setAttribute('class', 'sp-line-chart-path');
      svg.appendChild(polyline);

      points.forEach((point, index) => {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', point[0]);
        circle.setAttribute('cy', point[1]);
        circle.setAttribute('r', 3.5);
        circle.setAttribute('class', 'sp-line-chart-point');
        const titleNode = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        titleNode.textContent = `${items[index].label}: ${items[index].asPercent ? SP.utils.formatPercent(items[index].value) : SP.utils.formatAverage(items[index].value)}`;
        circle.appendChild(titleNode);
        svg.appendChild(circle);
      });

      card.appendChild(svg);
      card.appendChild(this.renderChartAxis(items));
      return card;
    },

    renderChartAxis(items) {
      const axis = document.createElement('div');
      axis.className = 'sp-chart-axis';
      const ticks = this.getAxisTicks(items);
      axis.innerHTML = ticks.map((tick) => `
        <span class="sp-chart-axis-tick" style="left:${tick.left}%">${tick.label}</span>
      `).join('');
      return axis;
    },

    getAxisTicks(items, maxTicks = 5) {
      if (!items.length) return [];
      if (items.length <= maxTicks) {
        return items.map((item, index) => ({
          label: item.label,
          left: items.length === 1 ? 0 : (index / Math.max(items.length - 1, 1)) * 100
        }));
      }

      const ticks = [];
      for (let index = 0; index < maxTicks; index += 1) {
        const itemIndex = Math.round((index * (items.length - 1)) / Math.max(maxTicks - 1, 1));
        const item = items[itemIndex];
        ticks.push({
          label: item.label,
          left: (itemIndex / Math.max(items.length - 1, 1)) * 100
        });
      }

      return ticks.filter((tick, index, all) => index === 0 || tick.label !== all[index - 1].label);
    },

    renderRadarCard({ title, subtitle, items, emptyMessage }) {
      const card = document.createElement('article');
      card.className = 'sp-card sp-card--compact';
      card.innerHTML = `<div class="sp-card-head"><h3>${title}</h3><p>${subtitle}</p></div>`;

      const hasValues = items.some((item) => (item.value || 0) > 0);
      if (!hasValues) {
        card.appendChild(this.emptyState(emptyMessage));
        return card;
      }

      const size = 300;
      const center = size / 2;
      const radius = 108;
      const maxValue = Math.max(...items.map((item) => item.value || 0), 1);
      const angleStep = (Math.PI * 2) / items.length;

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
      svg.setAttribute('class', 'sp-radar-chart');

      [0.25, 0.5, 0.75, 1].forEach((fraction) => {
        const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        ring.setAttribute('cx', center);
        ring.setAttribute('cy', center);
        ring.setAttribute('r', radius * fraction);
        ring.setAttribute('class', 'sp-radar-ring');
        svg.appendChild(ring);
      });

      const polygonPoints = [];
      items.forEach((item, index) => {
        const angle = -Math.PI / 2 + index * angleStep;
        const outerX = center + Math.cos(angle) * radius;
        const outerY = center + Math.sin(angle) * radius;

        const axis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        axis.setAttribute('x1', center);
        axis.setAttribute('y1', center);
        axis.setAttribute('x2', outerX);
        axis.setAttribute('y2', outerY);
        axis.setAttribute('class', 'sp-radar-axis');
        svg.appendChild(axis);

        const pointRadius = ((item.value || 0) / maxValue) * radius;
        const x = center + Math.cos(angle) * pointRadius;
        const y = center + Math.sin(angle) * pointRadius;
        polygonPoints.push(`${SP.utils.round(x, 2)},${SP.utils.round(y, 2)}`);

        const labelX = center + Math.cos(angle) * (radius + 18);
        const labelY = center + Math.sin(angle) * (radius + 18);
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', labelX);
        label.setAttribute('y', labelY);
        label.setAttribute('class', 'sp-radar-label');
        label.setAttribute('text-anchor', Math.cos(angle) > 0.2 ? 'start' : Math.cos(angle) < -0.2 ? 'end' : 'middle');
        label.textContent = item.label.replace('D', '');
        svg.appendChild(label);
      });

      const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      polygon.setAttribute('points', polygonPoints.join(' '));
      polygon.setAttribute('class', 'sp-radar-shape');
      svg.appendChild(polygon);

      const centerDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      centerDot.setAttribute('cx', center);
      centerDot.setAttribute('cy', center);
      centerDot.setAttribute('r', 5);
      centerDot.setAttribute('class', 'sp-radar-center');
      svg.appendChild(centerDot);

      card.appendChild(svg);
      return card;
    },

    renderFieldHitsCard({ title, subtitle, items, emptyMessage }) {
      const card = document.createElement('article');
      card.className = 'sp-card';
      card.innerHTML = `<div class="sp-card-head"><h3>${title}</h3><p>${subtitle}</p></div>`;

      if (!items.length) {
        card.appendChild(this.emptyState(emptyMessage));
        return card;
      }

      const max = Math.max(...items.map((item) => item.count || 0), 1);
      const grid = document.createElement('div');
      grid.className = 'sp-hit-grid';

      items.forEach((item) => {
        const tile = document.createElement('div');
        tile.className = 'sp-hit-tile';
        tile.style.setProperty('--sp-hit-strength', String((item.count || 0) / max));
        tile.innerHTML = `
          <span class="sp-hit-field">${item.field}</span>
          <span class="sp-hit-count">${SP.utils.formatInt(item.count)}</span>
        `;
        grid.appendChild(tile);
      });

      card.appendChild(grid);
      return card;
    },

    renderInfoCard({ title, subtitle, lines }) {
      const card = document.createElement('article');
      card.className = 'sp-card sp-card--compact';
      card.innerHTML = `
        <div class="sp-card-head">
          <h3>${title}</h3>
          <p>${subtitle}</p>
        </div>
        <ul class="sp-info-list">
          ${lines.map((line) => `<li>${line}</li>`).join('')}
        </ul>
      `;
      return card;
    },

    getMatchUrl(entry) {
      if (!entry) return null;
      if (entry.matchId) return `/history/matches/${entry.matchId}`;
      if (entry.id && typeof entry.id === 'string' && /^[0-9a-f-]{20,}$/i.test(entry.id)) {
        return `/history/matches/${entry.id}`;
      }
      const sourcePath = typeof entry.sourcePath === 'string' ? entry.sourcePath : '';
      const match = sourcePath.match(/\/history\/matches\/([0-9a-f-]+)/i);
      return match ? `/history/matches/${match[1]}` : null;
    },

    renderMatchActionCell(entry) {
      const url = this.getMatchUrl(entry);
      if (!url) return '—';
      return `<a class="sp-table-link" href="${url}" target="_blank" rel="noopener noreferrer">Zum Match</a>`;
    },

    renderTopLegsTable(legs) {
      const card = document.createElement('article');
      card.className = 'sp-card';
      card.innerHTML = `<div class="sp-card-head"><h3>Top 10 Legs</h3><p>Nur eigene Legs · sortiert nach Average, dann Darts</p></div>`;
      if (!legs.length) {
        card.appendChild(this.emptyState('Noch keine Legs gespeichert.'));
        return card;
      }
      const table = document.createElement('table');
      table.className = 'sp-table';
      table.innerHTML = `
        <thead>
          <tr>
            <th>#</th>
            <th>Datum</th>
            <th>Average</th>
            <th>Darts</th>
            <th>Checkout</th>
            <th>Aktion</th>
          </tr>
        </thead>
        <tbody>
          ${legs.map((leg, index) => `
            <tr>
              <td>${index + 1}</td>
              <td>${SP.utils.formatDate(leg.endedAt || leg.createdAt)}</td>
              <td>${SP.utils.formatAverage(leg.average)}</td>
              <td>${Number.isFinite(leg.dartsThrown) ? SP.utils.formatInt(leg.dartsThrown) : '—'}</td>
              <td>${Number.isFinite(leg.checkoutValue) && leg.checkoutValue > 0 ? SP.utils.formatInt(leg.checkoutValue) : '—'}</td>
              <td>${this.renderMatchActionCell(leg)}</td>
            </tr>
          `).join('')}
        </tbody>
      `;
      card.appendChild(table);
      return card;
    },

    renderTopCheckoutsTable(legs) {
      const card = document.createElement('article');
      card.className = 'sp-card';
      const usesMatchFallback = legs.some((leg) => leg?.sourceType === 'match-best');
      card.innerHTML = `<div class="sp-card-head"><h3>Top 10 Checkouts</h3><p>${usesMatchFallback ? 'Fallback aus Match-Bestwerten der Historie · kein exaktes Leg verfügbar' : 'Nur eigene erfolgreiche Finishes · sortiert nach Checkout, dann Finish in'}</p></div>`;
      if (!legs.length) {
        card.appendChild(this.emptyState('Noch keine Checkouts gespeichert.'));
        return card;
      }
      const table = document.createElement('table');
      table.className = 'sp-table';
      table.innerHTML = `
        <thead>
          <tr>
            <th>#</th>
            <th>Datum</th>
            <th>Checkout</th>
            <th>Finish in</th>
            <th>Average</th>
            <th>Aktion</th>
          </tr>
        </thead>
        <tbody>
          ${legs.map((leg, index) => `
            <tr>
              <td>${index + 1}</td>
              <td>${SP.utils.formatDate(leg.endedAt || leg.createdAt)}</td>
              <td>${SP.utils.formatInt(leg.checkoutValue)}</td>
              <td>${Number.isFinite(leg.checkoutDarts) ? SP.utils.formatInt(leg.checkoutDarts) : (leg.sourceType === 'match-best' ? 'Match' : '—')}</td>
              <td>${SP.utils.formatAverage(leg.average)}</td>
              <td>${this.renderMatchActionCell(leg)}</td>
            </tr>
          `).join('')}
        </tbody>
      `;
      card.appendChild(table);
      return card;
    },

    emptyState(message) {
      const node = document.createElement('div');
      node.className = 'sp-empty-state';
      node.innerHTML = `<div class="sp-empty-icon">📈</div><p>${message}</p>`;
      return node;
    }
  };

  SP.ui = ui;
})();
