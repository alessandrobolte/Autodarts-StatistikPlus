(() => {
  const SP = window.__STATISTIK_PLUS__;
  if (!SP) return;

  const RANGE = {
    average: [0, 200],
    dartsThrown: [1, 60],
    checkoutValue: [0, 170],
    checkoutDarts: [1, 9],
    score180s: [0, 50]
  };

  const MATCH_STALE_MS = 5 * 60 * 1000;

  const inRange = (value, [min, max]) => Number.isFinite(value) && value >= min && value <= max;

  class AutodartsCollector {
    constructor() {
      this.started = false;
      this.recentHashes = new Map();
      this.parserState = 'Sync pausiert · starte via Historie (X01)';
      this.refreshTimer = null;
      this.activeMatches = new Map();
      this.metaDebounceTimer = null;
      this.lastMetaPayload = null;
      this.bridgeInstalled = false;
      this.routeHooksInstalled = false;
      this.historyScanTimer = null;
      this.historyScanPromise = null;
      this.historyCache = new Map();
      this.historyPlayerNameLock = null;
      this.historyProgress = this.createEmptyHistoryProgress();
      this.bridgeRequests = new Map();
      this.latestAccessToken = null;
      this.latestUserId = null;
      this.bridgeReadyPromise = null;
      this.bridgeMessageListenerInstalled = false;
      this.syncSessionActive = false;
      this.syncPauseReason = 'waiting-manual-start';
      this.onWindowMessage = this.onWindowMessage.bind(this);
    }

    createEmptyHistoryProgress() {
      return {
        active: false,
        phase: 'idle',
        modeFilter: 'X01',
        listScanned: 0,
        listTotal: 0,
        matchScanned: 0,
        matchTotal: 0,
        importedLegs: 0,
        importedMatches: 0,
        skippedMatches: 0,
        foundMatches: 0,
        currentLabel: '',
        startedAt: null,
        finishedAt: null
      };
    }

    getHistoryProgress() {
      return { ...this.historyProgress };
    }

    notifyHistoryProgress() {
      SP.ui?.renderHistoryProgress?.({ ...this.historyProgress, parserState: this.parserState });
    }

    setHistoryProgress(patch = {}) {
      this.historyProgress = { ...this.historyProgress, ...patch };
      this.notifyHistoryProgress();
    }

    resetHistoryProgress() {
      this.historyProgress = this.createEmptyHistoryProgress();
      this.notifyHistoryProgress();
    }

    extractHistoryModeTitle(doc) {
      const direct = doc?.querySelector('h2, h1, .chakra-heading')?.textContent?.trim();
      if (direct) return direct;
      const title = doc?.querySelector('title')?.textContent || '';
      const match = title.match(/statistics\s*\(([^)]+)\)/i);
      return (match?.[1] || title || '').trim();
    }

    cleanHistoryMatchPath(matchId) {
      return matchId ? `/history/matches/${matchId}` : null;
    }

    buildExistingHistoryState(existingLegs = []) {
      const detailUrls = new Set();
      const legCountsByMatch = new Map();
      const legUrlsByMatch = new Map();

      existingLegs.forEach((entry) => {
        if (entry?.sourceChannel !== 'history-dom') return;
        const normalized = this.normalizeHistoryUrl(entry?.sourcePath || '');
        const matchId = entry?.matchId || this.extractMatchIdFromUrl(entry?.sourcePath || '');

        if (normalized) detailUrls.add(normalized);
        if (!matchId) return;

        legCountsByMatch.set(matchId, (legCountsByMatch.get(matchId) || 0) + 1);
        if (normalized) {
          if (!legUrlsByMatch.has(matchId)) {
            legUrlsByMatch.set(matchId, new Set());
          }
          legUrlsByMatch.get(matchId).add(normalized);
        }
      });

      return { detailUrls, legCountsByMatch, legUrlsByMatch };
    }

    extractKnownHistoryMeta(existingHistoryState, matchId) {
      if (!existingHistoryState || !matchId) {
        return { existingLegCount: 0, existingLegUrls: new Set() };
      }
      return {
        existingLegCount: Number(existingHistoryState.legCountsByMatch?.get(matchId) || 0),
        existingLegUrls: existingHistoryState.legUrlsByMatch?.get(matchId) || new Set()
      };
    }

    extractHistoryX01StartValue(doc) {
      if (!doc) return null;
      const containers = [
        doc.querySelector('.chakra-card'),
        doc.querySelector('[class*="chakra-card"]'),
        doc.body
      ].filter(Boolean);

      for (const container of containers) {
        const nodes = Array.from(container.querySelectorAll('span, p, div, td, th, button'));
        for (const node of nodes) {
          const value = (node.textContent || '').replace(/\s+/g, ' ').trim();
          if (!/^\d+01$/.test(value)) continue;
          const parsed = Number(value);
          if (Number.isFinite(parsed) && parsed >= 101 && parsed <= 1001) return parsed;
        }
      }
      return null;
    }

    isSupportedHistoryMode(title = '') {
      const value = String(title || '').replace(/\s+/g, ' ').trim();
      return /\bx01\b/i.test(value);
    }

    setSyncSessionActive(active, reason = null) {
      this.syncSessionActive = Boolean(active);
      this.syncPauseReason = reason || (this.syncSessionActive ? 'running' : 'waiting-manual-start');
      if (!this.syncSessionActive) {
        window.clearTimeout(this.historyScanTimer);
        this.historyScanTimer = null;
      }
      if (!this.historyScanPromise && !this.historyProgress.active) {
        this.parserState = this.syncSessionActive
          ? 'Historien-Sync aktiv'
          : 'Sync pausiert · starte via Historie (X01)';
      }
    }

    beginHistorySyncSession(reason = 'manual-history-import') {
      this.setSyncSessionActive(true, reason);
    }

    endHistorySyncSession(reason = 'waiting-manual-start') {
      this.setSyncSessionActive(false, reason);
    }

    isSyncSessionActive() {
      return Boolean(this.syncSessionActive || this.historyScanPromise || this.historyProgress?.active);
    }

    init() {
      if (this.started) return;
      this.started = true;
      this.parserState = 'Sync pausiert · starte via Historie (X01)';
      this.resetHistoryProgress();
    }

    injectBridge() {
      if (window.__STATISTIK_PLUS_BRIDGE_INSTALLED__) return Promise.resolve();
      if (this.bridgeReadyPromise) return this.bridgeReadyPromise;

      this.bridgeReadyPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('src/page-bridge.js');
        script.async = false;
        script.onload = () => {
          script.remove();
          window.setTimeout(resolve, 40);
        };
        script.onerror = () => {
          script.remove();
          this.bridgeReadyPromise = null;
          reject(new Error('Unable to inject page bridge'));
        };
        (document.head || document.documentElement).appendChild(script);
      });
      return this.bridgeReadyPromise;
    }

    async ensureBridge() {
      if (!this.bridgeMessageListenerInstalled) {
        window.addEventListener('message', this.onWindowMessage);
        this.bridgeMessageListenerInstalled = true;
      }
      await this.injectBridge();
    }


    async requestBridge(command, args = {}, timeoutMs = 20000) {
      await this.ensureBridge();
      return new Promise((resolve, reject) => {
        const requestId = SP.utils.uid('bridge');
        const timer = window.setTimeout(() => {
          this.bridgeRequests.delete(requestId);
          reject(new Error(`${command} timeout`));
        }, timeoutMs);
        this.bridgeRequests.set(requestId, {
          resolve: (data) => {
            window.clearTimeout(timer);
            resolve(data);
          },
          reject: (error) => {
            window.clearTimeout(timer);
            reject(error);
          }
        });
        window.postMessage({
          type: 'STATISTIK_PLUS_BRIDGE_COMMAND',
          requestId,
          command,
          args
        }, '*');
      });
    }

    async fetchJsonViaBridge(url, init = {}) {
      return this.requestBridge('fetchJson', { url, init });
    }

    async getAccessToken() {
      if (typeof this.latestAccessToken === 'string' && this.latestAccessToken.trim()) {
        return this.latestAccessToken.trim();
      }

      try {
        const authState = await this.requestBridge('getAuthState', {}, 8000);
        const bridgeToken = authState?.accessToken?.trim?.() || null;
        if (bridgeToken) {
          this.latestAccessToken = bridgeToken;
          if (authState?.userId) this.latestUserId = String(authState.userId).trim();
          return bridgeToken;
        }
      } catch (error) {
        console.warn('[Statistik+ auth bridge]', error);
      }

      const rawEvents = await SP.db.getAll(SP.dbStores.rawEvents);
      const tokenEvent = [...rawEvents].reverse().find((entry) => {
        const payload = entry?.payload;
        return /openid-connect\/token/i.test(entry?.url || '') && typeof payload?.access_token === 'string' && payload.access_token.trim();
      });
      const token = tokenEvent?.payload?.access_token?.trim() || null;
      if (token) this.latestAccessToken = token;
      return token;
    }

    detectCurrentPlayerIndex(players = [], preferredPlayerName = null) {
      const safePreferred = SP.utils.sanitizePlayerName(preferredPlayerName)?.toLowerCase?.() || null;
      const safeUserId = this.latestUserId || null;
      if (!Array.isArray(players)) return 0;

      let index = players.findIndex((player) => {
        const candidates = [
          player?.userId,
          player?.user?.id,
          player?.id
        ].filter(Boolean);
        return safeUserId && candidates.includes(safeUserId);
      });
      if (index >= 0) return index;

      index = players.findIndex((player) => {
        const names = [
          player?.name,
          player?.user?.name,
          player?.user?.preferred_username
        ].filter(Boolean).map((value) => String(value).trim().toLowerCase());
        return safePreferred && names.includes(safePreferred);
      });
      return index >= 0 ? index : 0;
    }

    matchContainsPlayer(item, preferredPlayerName = null) {
      const safePreferred = SP.utils.sanitizePlayerName(preferredPlayerName)?.toLowerCase?.() || null;
      const safeUserId = this.latestUserId || null;
      const players = Array.isArray(item?.players) ? item.players : [];
      if (!players.length) return false;

      return players.some((player) => {
        const ids = [
          player?.userId,
          player?.user?.id,
          player?.id
        ].filter(Boolean).map((value) => String(value).trim());

        if (safeUserId && ids.includes(safeUserId)) return true;

        const names = [
          player?.name,
          player?.user?.name,
          player?.user?.preferred_username
        ].filter(Boolean).map((value) => String(value).trim().toLowerCase());

        return safePreferred ? names.includes(safePreferred) : false;
      });
    }

    buildApiMatchRecord(item, preferredPlayerName = null) {
      const playerName = SP.utils.sanitizePlayerName(preferredPlayerName)
        || SP.utils.sanitizePlayerName(this.historyPlayerNameLock)
        || SP.utils.sanitizePlayerName(SP.utils.getLoggedInPlayerName(document))
        || SP.utils.sanitizePlayerName(SP.state.activePlayerName)
        || null;
      const playerIndex = this.detectCurrentPlayerIndex(item?.players || [], playerName);
      const score = Array.isArray(item?.scores) ? item.scores[playerIndex] : null;
      const totalLegs = Array.isArray(item?.scores)
        ? item.scores.reduce((sum, entry) => sum + (Number(entry?.legs) || 0), 0)
        : null;

      return {
        id: item?.id,
        playerName,
        title: item?.variant || 'X01',
        status: 'completed',
        completed: true,
        legsWon: Number.isFinite(Number(score?.legs)) ? Number(score.legs) : null,
        setsWon: Number.isFinite(Number(score?.sets)) ? Number(score.sets) : null,
        bestCheckout: null,
        totalLegs: Number.isFinite(Number(totalLegs)) ? Number(totalLegs) : null,
        createdAt: item?.createdAt || item?.finishedAt || new Date().toISOString(),
        startedAt: item?.createdAt || item?.finishedAt || new Date().toISOString(),
        endedAt: item?.finishedAt || item?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourcePath: `/history/matches/${item?.id}`,
        sourceChannel: 'history-api'
      };
    }

    async collectHistoryViaApi(existingHistoryState = null, options = {}) {
      const force = Boolean(options?.force);
      const token = await this.getAccessToken();
      if (!token) {
        this.parserState = 'Spielhistorie: kein API-Token gefunden';
        return null;
      }

      const matches = new Map();
      const detailUrls = [];
      const pageSize = 100;
      let page = 0;
      let totalPages = 1;
      let keepPagingWithoutTotal = true;
      let consecutiveKnownPages = 0;
      const EARLY_STOP_AFTER_KNOWN_PAGES = 2;

      while ((page < totalPages || keepPagingWithoutTotal) && page < 30) {
        this.parserState = `Spielhistorie: API-Seite ${page + 1}/${totalPages} laden`;
        this.setHistoryProgress({
          phase: 'listing',
          listScanned: page,
          listTotal: totalPages,
          foundMatches: matches.size,
          currentLabel: `API-Seite ${page + 1}/${totalPages}`
        });

        const payload = await this.fetchJsonViaBridge(`https://api.autodarts.io/as/v0/matches/filter?size=${pageSize}&page=${page}&sort=-finished_at`, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`
          }
        });

        const items = Array.isArray(payload?.items) ? payload.items : [];
        const reportedTotalPages = Number(payload?.total_pages || payload?.totalPages || payload?.pages || 0);
        if (Number.isFinite(reportedTotalPages) && reportedTotalPages > 0) {
          totalPages = Math.max(1, reportedTotalPages);
          keepPagingWithoutTotal = false;
        } else {
          keepPagingWithoutTotal = items.length >= pageSize;
          totalPages = Math.max(totalPages, page + 1 + (keepPagingWithoutTotal ? 1 : 0));
        }

        let relevantMatchesOnPage = 0;
        let knownMatchesOnPage = 0;
        items.forEach((item) => {
          if (String(item?.variant || '').toUpperCase() !== 'X01') return;
          if (!this.matchContainsPlayer(item, this.historyPlayerNameLock)) return;
          if (!item?.id) return;

          relevantMatchesOnPage += 1;
          const totalLegs = Array.isArray(item?.scores)
            ? item.scores.reduce((sum, entry) => sum + (Number(entry?.legs) || 0), 0)
            : 0;
          const { existingLegCount } = this.extractKnownHistoryMeta(existingHistoryState, item.id);
          const isCompleteMatch = !force
            && Number.isFinite(Number(totalLegs))
            && Number(totalLegs) > 0
            && existingLegCount >= Number(totalLegs);

          if (isCompleteMatch) {
            knownMatchesOnPage += 1;
            return;
          }

          if (matches.has(item.id)) return;
          matches.set(item.id, item);
        });

        if (!force && relevantMatchesOnPage > 0 && knownMatchesOnPage >= relevantMatchesOnPage) {
          consecutiveKnownPages += 1;
        } else if (relevantMatchesOnPage > 0) {
          consecutiveKnownPages = 0;
        }

        page += 1;
        this.setHistoryProgress({
          phase: 'listing',
          listScanned: page,
          listTotal: totalPages,
          foundMatches: matches.size,
          currentLabel: `API-Seite ${page}/${totalPages}`
        });

        if (!force && consecutiveKnownPages >= EARLY_STOP_AFTER_KNOWN_PAGES) {
          keepPagingWithoutTotal = false;
          break;
        }
      }

      const matchRecords = [];
      matches.forEach((item) => {
        const record = this.buildApiMatchRecord(item, this.historyPlayerNameLock);
        if (record?.id) matchRecords.push(record);
        const totalLegs = Array.isArray(item?.scores)
          ? item.scores.reduce((sum, entry) => sum + (Number(entry?.legs) || 0), 0)
          : 0;
        const { existingLegUrls } = this.extractKnownHistoryMeta(existingHistoryState, item.id);
        for (let legIndex = 0; legIndex < totalLegs; legIndex += 1) {
          const detailUrl = `/history/matches/${item.id}?leg=${legIndex}`;
          if (!force && existingLegUrls.has(detailUrl)) continue;
          detailUrls.push(detailUrl);
        }
      });

      return {
        listScanned: page,
        listTotal: totalPages,
        foundMatches: matches.size,
        detailUrls,
        matchRecords
      };
    }


    onWindowMessage(event) {
      if (event.source !== window) return;
      const envelope = event.data?.type === SP.bridgeMessageType ? event.data.payload : null;
      if (!envelope) return;
      if (envelope.channel === 'bridge:response' && envelope.requestId) {
        const pending = this.bridgeRequests.get(envelope.requestId);
        if (pending) {
          this.bridgeRequests.delete(envelope.requestId);
          if (envelope.ok) pending.resolve(envelope.data);
          else pending.reject(new Error(envelope.error || 'Bridge request failed'));
        }
        return;
      }

      if (!this.isSyncSessionActive()) {
        const envelopeUrl = envelope?.url || null;
        const envelopePayload = envelope?.data || null;
        if (/openid-connect\/token/i.test(envelopeUrl || '')) {
          if (typeof envelopePayload?.access_token === 'string' && envelopePayload.access_token.trim()) {
            this.latestAccessToken = envelopePayload.access_token.trim();
          }
          if (typeof envelopePayload?.sub === 'string' && envelopePayload.sub.trim()) {
            this.latestUserId = envelopePayload.sub.trim();
          }
        }
        return;
      }

      this.handleBridgeEvent(envelope).catch((error) => console.warn('[Statistik+ bridge]', error));
      if (/\/history\/matches\//i.test(envelope?.url || '')) {
        this.scheduleHistoryScan(900, { force: false });
      }
    }

    installRouteHooks() {
      if (this.routeHooksInstalled) return;
      this.routeHooksInstalled = true;
      const schedule = () => this.scheduleHistoryScan(1200, { force: false });
      window.addEventListener('popstate', schedule);
      window.addEventListener('hashchange', schedule);
      ['pushState', 'replaceState'].forEach((method) => {
        const original = window.history?.[method];
        if (typeof original !== 'function') return;
        window.history[method] = (...args) => {
          const result = original.apply(window.history, args);
          window.setTimeout(schedule, 150);
          return result;
        };
      });
    }

    scheduleHistoryScan(delay = 1000, options = {}) {
      if (!this.isSyncSessionActive() && !options.force) return;
      window.clearTimeout(this.historyScanTimer);
      this.historyScanTimer = window.setTimeout(() => {
        this.importHistoryFromCurrentContext({ ...options, notify: false }).catch((error) => {
          console.warn('[Statistik+ history scan]', error);
        });
      }, delay);
    }

    async importHistoryFromCurrentContext(options = {}) {
      if (this.historyScanPromise) return this.historyScanPromise;
      this.beginHistorySyncSession(options.reason || 'history-import');
      this.historyScanPromise = this._importHistoryFromCurrentContext(options)
        .catch((error) => {
          this.parserState = 'Spielhistorie: Import fehlgeschlagen';
          this.setHistoryProgress({ active: false, currentLabel: 'Import fehlgeschlagen', finishedAt: new Date().toISOString() });
          throw error;
        })
        .finally(() => {
          this.historyScanPromise = null;
          this.endHistorySyncSession('waiting-manual-start');
        });
      return this.historyScanPromise;
    }


    async _importHistoryFromCurrentContext({ force = false, notify = false } = {}) {
      this.historyPlayerNameLock = SP.utils.sanitizePlayerName(SP.state.configuredPlayerName)
        || SP.utils.sanitizePlayerName(SP.utils.getLoggedInPlayerName(document))
        || SP.utils.sanitizePlayerName(SP.state.activePlayerName)
        || null;
      this.parserState = 'Spielhistorie: X01-Crawl startet';
      this.setHistoryProgress({
        active: true,
        phase: 'listing',
        modeFilter: 'X01',
        listScanned: 0,
        listTotal: 0,
        matchScanned: 0,
        matchTotal: 0,
        importedLegs: 0,
        importedMatches: 0,
        skippedMatches: 0,
        foundMatches: 0,
        currentLabel: 'Starte Scan der Spielhistorie',
        startedAt: new Date().toISOString(),
        finishedAt: null
      });

      let existingHistoryState = {
        detailUrls: new Set(),
        legCountsByMatch: new Map(),
        legUrlsByMatch: new Map()
      };
      if (!force) {
        try {
          const existingLegs = await SP.db.getAll(SP.dbStores.legs);
          existingHistoryState = this.buildExistingHistoryState(existingLegs);
        } catch (error) {
          console.warn('[Statistik+ existing-history]', error);
        }
      }

      let apiResult = null;
      try {
        apiResult = await this.collectHistoryViaApi(existingHistoryState, { force });
      } catch (error) {
        console.warn('[Statistik+ api history]', error);
        apiResult = null;
      }

      const importedMatchIds = new Set();
      let importedLegs = 0;
      let skippedMatches = 0;
      let scanned = 0;
      let listScanned = 0;
      let foundMatches = 0;

      let queue = [];
      if (apiResult?.matchRecords?.length) {
        await SP.db.bulkPut(SP.dbStores.matches, apiResult.matchRecords);
        apiResult.matchRecords.forEach((entry) => entry?.id && importedMatchIds.add(entry.id));
        queue = [...apiResult.detailUrls];
        listScanned = apiResult.listScanned || 0;
        foundMatches = apiResult.foundMatches || importedMatchIds.size;
        this.setHistoryProgress({
          phase: 'details',
          listScanned,
          listTotal: apiResult.listTotal || listScanned,
          foundMatches,
          importedMatches: importedMatchIds.size,
          matchTotal: queue.length,
          currentLabel: `Gefundene X01-Matches: ${foundMatches}`
        });
      } else {
        const fallbackQueue = this.getHistoryCandidateUrls(document, window.location.href);
        const listQueue = this.getHistoryListCandidateUrls(document, window.location.href);
        if (!fallbackQueue.length && !listQueue.length) {
          this.parserState = 'Sync pausiert · starte via Historie (X01)';
          this.setHistoryProgress({ active: false, finishedAt: new Date().toISOString(), currentLabel: 'Keine Historienseiten gefunden' });
          this.historyPlayerNameLock = null;
          return { importedLegs: 0, importedMatches: 0, scanned: 0, skipped: true };
        }

        const seen = new Set(fallbackQueue);
        const listSeen = new Set(listQueue);
        const MAX_LIST_PAGES = 18;
        this.setHistoryProgress({
          phase: 'listing',
          listTotal: Math.min(Math.max(listQueue.length, 1), MAX_LIST_PAGES),
          currentLabel: 'Suche Match-Links in der Historie'
        });

        while (listQueue.length && listScanned < MAX_LIST_PAGES) {
          const listUrl = listQueue.shift();
          const now = Date.now();
          if (!force) {
            const lastSeenAt = this.historyCache.get(`list:${listUrl}`) || 0;
            if ((now - lastSeenAt) < 15_000) continue;
          }
          this.historyCache.set(`list:${listUrl}`, now);

          this.parserState = `Spielhistorie: Übersicht laden (${listScanned + 1}/${MAX_LIST_PAGES})`;
          this.setHistoryProgress({
            phase: 'listing',
            listScanned,
            listTotal: Math.min(Math.max(listSeen.size, 1), MAX_LIST_PAGES),
            currentLabel: `Übersicht ${listScanned + 1}/${MAX_LIST_PAGES}`
          });

          let result = null;
          const currentListUrl = this.normalizeHistoryListUrl(window.location.href);
          if (currentListUrl && currentListUrl === listUrl) {
            result = await this.processHistoryListDocument(document, listUrl);
          } else {
            result = await this.processHistoryListUrl(listUrl);
          }

          listScanned += 1;
          (result.detailUrls || []).forEach((nextUrl) => {
            if (seen.has(nextUrl)) return;
            seen.add(nextUrl);
            queue.push(nextUrl);
          });
          (result.listUrls || []).forEach((nextUrl) => {
            if (listSeen.has(nextUrl)) return;
            listSeen.add(nextUrl);
            listQueue.push(nextUrl);
          });

          this.setHistoryProgress({
            phase: 'listing',
            listScanned,
            listTotal: Math.min(Math.max(listSeen.size, listScanned), MAX_LIST_PAGES),
            foundMatches: seen.size,
            currentLabel: `Übersicht ${listScanned}/${Math.min(Math.max(listSeen.size, listScanned), MAX_LIST_PAGES)}`
          });
        }

        if (!queue.length) {
          this.historyPlayerNameLock = null;
          this.parserState = 'Spielhistorie: keine X01-Match-Links gefunden';
          this.setHistoryProgress({ active: false, finishedAt: new Date().toISOString(), currentLabel: 'Keine X01-Match-Links gefunden' });
          return { importedLegs: 0, importedMatches: 0, scanned: 0, skipped: true };
        }
      }

      const existingHistoryDetailUrls = existingHistoryState.detailUrls || new Set();

      const MAX_DOCUMENTS = 500;
      const allDiscoveredQueue = [...new Set(queue)];
      const groupedQueue = new Map();
      allDiscoveredQueue.forEach((entryUrl) => {
        const matchId = this.extractMatchIdFromUrl(entryUrl) || entryUrl;
        const bucket = groupedQueue.get(matchId) || [];
        bucket.push(entryUrl);
        groupedQueue.set(matchId, bucket);
      });

      const filteredQueue = [];
      groupedQueue.forEach((urls, matchId) => {
        const nextUrls = urls.filter((entryUrl) => {
          if (force) return true;
          const normalized = this.normalizeHistoryUrl(entryUrl);
          return normalized ? !existingHistoryDetailUrls.has(normalized) : true;
        });

        if (!nextUrls.length) {
          skippedMatches += 1;
          return;
        }

        filteredQueue.push(...nextUrls);
      });

      const dedupedQueue = filteredQueue.slice(0, MAX_DOCUMENTS);

      this.setHistoryProgress({
        phase: 'details',
        matchScanned: 0,
        matchTotal: dedupedQueue.length,
        importedLegs: 0,
        importedMatches: importedMatchIds.size,
        skippedMatches,
        foundMatches: foundMatches || importedMatchIds.size,
        currentLabel: dedupedQueue.length ? `Starte X01-Leg-Import (${dedupedQueue.length} neu)` : 'Keine neuen X01-Legs gefunden'
      });

      while (dedupedQueue.length && scanned < MAX_DOCUMENTS) {
        const url = dedupedQueue.shift();
        const now = Date.now();
        if (!force) {
          const lastSeenAt = this.historyCache.get(url) || 0;
          if ((now - lastSeenAt) < 15_000) continue;
        }
        this.historyCache.set(url, now);

        this.parserState = `Spielhistorie: Seite ${scanned + 1}/${Math.max(scanned + dedupedQueue.length + 1, scanned + 1)} laden`;
        this.setHistoryProgress({
          phase: 'details',
          matchScanned: scanned,
          matchTotal: scanned + dedupedQueue.length + 1,
          importedLegs,
          importedMatches: importedMatchIds.size,
          skippedMatches,
          foundMatches: foundMatches || importedMatchIds.size,
          currentLabel: `Seite ${scanned + 1}/${scanned + dedupedQueue.length + 1}`
        });

        let result = null;
        const currentNormalized = this.normalizeHistoryUrl(window.location.href);
        if (currentNormalized && currentNormalized === url) {
          result = await this.processHistoryDocument(document, url, { source: 'current', preferredPlayerName: this.historyPlayerNameLock });
        } else {
          result = await this.processHistoryUrl(url);
        }

        scanned += 1;
        importedLegs += result.importedLegs || 0;
        if (result.matchId) importedMatchIds.add(result.matchId);
        skippedMatches += result.skippedMode ? 1 : 0;

        this.setHistoryProgress({
          phase: 'details',
          matchScanned: scanned,
          matchTotal: Math.max(scanned + dedupedQueue.length, scanned),
          importedLegs,
          importedMatches: importedMatchIds.size,
          skippedMatches,
          foundMatches: foundMatches || importedMatchIds.size,
          currentLabel: result.skippedMode
            ? `Übersprungen (${result.modeTitle || 'kein X01'})`
            : `Importiert ${importedMatchIds.size} Matches · ${importedLegs} Legs`
        });
      }

      const nowIso = new Date().toISOString();
      this.queueMetaUpdate({
        spLastHistoryImportAt: nowIso,
        spHistoryImportedLegs: importedLegs,
        spHistoryImportedMatches: importedMatchIds.size,
        spSyncState: importedLegs > 0 ? 'history-imported' : 'history-ready'
      });

      if (importedLegs > 0) {
        this.parserState = 'Spielhistorie importiert · Sync pausiert bis Historie (X01)';
      } else if (importedMatchIds.size > 0) {
        this.parserState = 'Spielhistorie gelesen · Sync pausiert bis Historie (X01)';
      } else {
        this.parserState = 'Kein neuer X01-Import · Sync pausiert bis Historie (X01)';
      }

      this.setHistoryProgress({
        active: false,
        phase: 'details',
        matchScanned: scanned,
        matchTotal: Math.max(scanned, 0),
        importedLegs,
        importedMatches: importedMatchIds.size,
        skippedMatches,
        foundMatches: foundMatches || importedMatchIds.size,
        currentLabel: importedLegs > 0
          ? `Import abgeschlossen: ${importedLegs} X01-Legs`
          : 'Kein neuer X01-Import',
        finishedAt: new Date().toISOString()
      });

      if (notify && SP.ui?.toast) {
        const message = importedLegs > 0
          ? `X01-Historie importiert: ${importedLegs} Legs · ${importedMatchIds.size} Matches`
          : importedMatchIds.size > 0
            ? `X01-Historie gelesen: ${importedMatchIds.size} Matches erkannt.`
            : 'Keine passenden X01-Daten in der Spielhistorie gefunden.';
        SP.ui.toast(message, false);
      }

      this.historyPlayerNameLock = null;
      return { importedLegs, importedMatches: importedMatchIds.size, scanned, listScanned, skipped: false };
    }

    getHistoryCandidateUrls(doc, currentUrl) {
      const urls = new Set();
      const current = this.normalizeHistoryUrl(currentUrl);
      if (current) urls.add(current);
      this.collectHistoryUrlsFromDocument(doc).forEach((url) => urls.add(url));
      return Array.from(urls).sort((a, b) => this.compareHistoryUrls(a, b));
    }

    getHistoryListCandidateUrls(doc, currentUrl) {
      const urls = new Set();
      const overview = this.normalizeHistoryListUrl('/history/matches');
      if (overview) urls.add(overview);
      const current = this.normalizeHistoryListUrl(currentUrl);
      if (current) urls.add(current);
      this.collectHistoryListUrlsFromDocument(doc).forEach((url) => urls.add(url));
      return Array.from(urls);
    }

    collectHistoryUrlsFromDocument(doc) {
      const urls = new Set();
      Array.from(doc.querySelectorAll('a[href]')).forEach((anchor) => {
        const normalized = this.normalizeHistoryUrl(anchor.getAttribute('href'));
        if (!normalized) return;
        urls.add(normalized);
        const summaryUrl = this.toSummaryHistoryUrl(normalized);
        if (summaryUrl) urls.add(summaryUrl);
      });
      return Array.from(urls);
    }

    collectHistoryListUrlsFromDocument(doc) {
      const urls = new Set();
      Array.from(doc.querySelectorAll('a[href]')).forEach((anchor) => {
        const normalized = this.normalizeHistoryListUrl(anchor.getAttribute('href'));
        if (!normalized) return;
        urls.add(normalized);
      });
      return Array.from(urls);
    }

    compareHistoryUrls(a, b) {
      const aLeg = this.extractLegIndexFromUrl(a);
      const bLeg = this.extractLegIndexFromUrl(b);
      if (aLeg === null && bLeg !== null) return -1;
      if (aLeg !== null && bLeg === null) return 1;
      if (aLeg !== null && bLeg !== null && aLeg !== bLeg) return aLeg - bLeg;
      return a.localeCompare(b);
    }

    normalizeHistoryUrl(rawUrl) {
      if (!rawUrl) return null;
      try {
        const url = new URL(rawUrl, window.location.origin);
        if (url.origin !== window.location.origin) return null;
        if (!/\/history\/matches\//i.test(url.pathname)) return null;
        return `${url.pathname}${url.search || ''}`;
      } catch (_) {
        return null;
      }
    }

    normalizeHistoryListUrl(rawUrl) {
      if (!rawUrl) return null;
      try {
        const url = new URL(rawUrl, window.location.origin);
        if (url.origin !== window.location.origin) return null;
        if (!/\/history\/matches(?:\/)?$/i.test(url.pathname)) return null;
        return `${url.pathname}${url.search || ''}`;
      } catch (_) {
        return null;
      }
    }

    toSummaryHistoryUrl(rawUrl) {
      try {
        const url = new URL(rawUrl, window.location.origin);
        if (!/\/history\/matches\//i.test(url.pathname)) return null;
        return url.pathname;
      } catch (_) {
        return null;
      }
    }

    extractMatchIdFromUrl(rawUrl) {
      try {
        const url = new URL(rawUrl, window.location.origin);
        const match = url.pathname.match(/\/history\/matches\/([^/?#]+)/i);
        return match ? match[1] : null;
      } catch (_) {
        return null;
      }
    }

    extractLegIndexFromUrl(rawUrl) {
      try {
        const url = new URL(rawUrl, window.location.origin);
        const raw = url.searchParams.get('leg');
        if (raw === null || raw === undefined || raw === '') return null;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed + 1 : null;
      } catch (_) {
        return null;
      }
    }

    async processHistoryUrl(url) {
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1280px;height:900px;opacity:0;pointer-events:none;border:0;';
      document.body.appendChild(frame);

      try {
        const doc = await this.loadHistoryFrame(frame, url, { type: 'detail' });
        return await this.processHistoryDocument(doc, url, { source: 'frame', preferredPlayerName: this.historyPlayerNameLock });
      } finally {
        frame.remove();
      }
    }

    async processHistoryListUrl(url) {
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1280px;height:900px;opacity:0;pointer-events:none;border:0;';
      document.body.appendChild(frame);

      try {
        const doc = await this.loadHistoryFrame(frame, url, { type: 'list' });
        return this.processHistoryListDocument(doc, url);
      } finally {
        frame.remove();
      }
    }

    async loadHistoryFrame(frame, url, options = {}) {
      const loadPromise = new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error(`Timeout while loading ${url}`)), 25000);
        frame.onload = () => {
          window.clearTimeout(timeout);
          resolve();
        };
        frame.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error(`Unable to load ${url}`));
        };
      });

      frame.src = new URL(url, window.location.origin).href;
      await loadPromise;

      const startedAt = Date.now();
      while ((Date.now() - startedAt) < 25000) {
        let doc = null;
        try {
          doc = frame.contentDocument;
        } catch (_) {
          doc = null;
        }
        if (doc?.body) {
          const hasUsefulContent = Boolean(
            this.findHistoryStatsTable(doc)
            || doc.querySelector('a[href*="/history/matches/"]')
            || (doc.body.textContent || '').length > 1500
          );
          if (hasUsefulContent) {
            if (options.type === 'list') {
              await this.stabilizeHistoryListFrame(frame);
            }
            return doc;
          }
        }
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }

      return frame.contentDocument;
    }

    async stabilizeHistoryListFrame(frame) {
      let previousLinkCount = -1;
      let stablePasses = 0;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const doc = frame?.contentDocument;
        const win = frame?.contentWindow;
        if (!doc?.body || !win) break;
        const currentCount = doc.querySelectorAll('a[href*="/history/matches/"]').length;
        if (currentCount === previousLinkCount) {
          stablePasses += 1;
        } else {
          stablePasses = 0;
        }
        if (stablePasses >= 3 && currentCount > 0) break;
        previousLinkCount = currentCount;

        const maxScroll = Math.max(doc.body.scrollHeight || 0, doc.documentElement?.scrollHeight || 0, 0);
        const nextTop = Math.min(maxScroll, (attempt + 1) * 1600);
        try {
          win.scrollTo({ top: nextTop, left: 0, behavior: 'instant' });
        } catch (_) {
          try {
            win.scrollTo(0, nextTop);
          } catch (_) {
            // noop
          }
        }
        await new Promise((resolve) => window.setTimeout(resolve, 700));
      }
    }

    processHistoryListDocument(doc, url) {
      return {
        detailUrls: this.getHistoryCandidateUrls(doc, url),
        listUrls: this.collectHistoryListUrlsFromDocument(doc).filter((entry) => entry !== this.normalizeHistoryListUrl(url))
      };
    }

    async processHistoryDocument(doc, url, options = {}) {
      const preferredPlayerName = SP.utils.sanitizePlayerName(options.preferredPlayerName)
        || SP.utils.sanitizePlayerName(this.historyPlayerNameLock)
        || SP.utils.sanitizePlayerName(SP.utils.getLoggedInPlayerName(document))
        || SP.utils.sanitizePlayerName(SP.state.activePlayerName)
        || null;
      const discoveredUrls = this.collectHistoryUrlsFromDocument(doc).filter(Boolean);
      const modeTitle = this.extractHistoryModeTitle(doc);
      if (!this.isSupportedHistoryMode(modeTitle)) {
        return { importedMatches: 0, importedLegs: 0, discoveredUrls, skippedMode: true, modeTitle };
      }
      let match = this.extractHistoryMatch(doc, url, preferredPlayerName);
      const leg = this.extractHistoryLeg(doc, url, match, preferredPlayerName);
      if (match?.id && leg?.playerName) {
        match.playerName = leg.playerName;
      }
      if (match?.id && Number.isFinite(leg?.x01Start) && !Number.isFinite(match.x01Start)) {
        match.x01Start = leg.x01Start;
      }
      if (match?.id && Number.isFinite(leg?.checkoutValue) && leg.checkoutValue > 0) {
        const legCheckoutTrusted = leg.checkoutSource === 'summary'
          || leg.checkoutSource === 'derived-visits'
          || leg.historyVisitCaptureReliable === true;
        if (legCheckoutTrusted) {
          match.bestCheckout = Math.max(match.bestCheckout || 0, leg.checkoutValue || 0);
        }
      }
      if (match?.id) {
        try {
          const existingMatch = await SP.db.get(SP.dbStores.matches, match.id);
          if (existingMatch) {
            const existingBestCheckout = Number(existingMatch.bestCheckout);
            const nextBestCheckout = Number(match.bestCheckout);
            const legCheckoutTrusted = leg?.checkoutSource === 'summary'
              || leg?.checkoutSource === 'derived-visits'
              || leg?.historyVisitCaptureReliable === true;
            const legBestCheckout = legCheckoutTrusted ? Number(leg?.checkoutValue) : NaN;
            const mergedBestCheckout = Math.max(
              Number.isFinite(existingBestCheckout) ? existingBestCheckout : 0,
              Number.isFinite(nextBestCheckout) ? nextBestCheckout : 0,
              Number.isFinite(legBestCheckout) ? legBestCheckout : 0
            );

            match = {
              ...existingMatch,
              ...match,
              playerName: match.playerName || existingMatch.playerName || leg?.playerName || null,
              x01Start: Number.isFinite(match.x01Start) ? match.x01Start : (Number.isFinite(existingMatch.x01Start) ? existingMatch.x01Start : null),
              totalLegs: Number.isFinite(match.totalLegs) ? match.totalLegs : (Number.isFinite(existingMatch.totalLegs) ? existingMatch.totalLegs : null),
              bestCheckout: mergedBestCheckout > 0 ? mergedBestCheckout : null
            };
          }
        } catch (error) {
          console.warn('[Statistik+ match merge]', error);
        }
      }
      const puts = [];
      let importedMatches = 0;
      let importedLegs = 0;

      if (match?.id) {
        importedMatches = 1;
        puts.push(SP.db.put(SP.dbStores.matches, match));
      }

      if (leg?.id) {
        importedLegs = 1;
        puts.push(SP.db.put(SP.dbStores.legs, leg));
        if (Array.isArray(leg.historyDarts) && leg.historyDarts.length) {
          puts.push(SP.db.bulkPut(SP.dbStores.darts, leg.historyDarts));
        }
        if (Number.isFinite(leg.checkoutValue) && leg.checkoutValue > 0) {
          puts.push(SP.db.put(SP.dbStores.checkouts, {
            id: `history_checkout_${leg.id}`,
            legId: leg.id,
            matchId: leg.matchId,
            playerName: leg.playerName,
            value: leg.checkoutValue,
            darts: leg.checkoutDarts || null,
            endedAt: leg.endedAt || leg.updatedAt,
            createdAt: leg.createdAt || leg.updatedAt,
            sourcePath: leg.sourcePath,
            sourceChannel: leg.sourceChannel
          }));
        }
      }

      if (puts.length) await Promise.all(puts);

      return { importedMatches, importedLegs, discoveredUrls, skippedMode: false, modeTitle, matchId: match?.id || null };
    }

    extractHistoryMatch(doc, url, preferredPlayerName = null) {
      const matchId = this.extractMatchIdFromUrl(url);
      if (!matchId) return null;

      const playerName = SP.utils.sanitizePlayerName(preferredPlayerName)
        || SP.utils.sanitizePlayerName(this.extractPlayerNameFromDocument(doc, preferredPlayerName))
        || SP.utils.sanitizePlayerName(SP.utils.getLoggedInPlayerName(document))
        || SP.utils.sanitizePlayerName(SP.state.activePlayerName)
        || null;
      const statsInfo = this.parseHistoryPlayerStats(doc, playerName);
      if (!statsInfo.playerFound) return null;
      const stats = statsInfo.stats;
      const createdAt = this.deriveIsoFromMatchId(matchId) || new Date().toISOString();
      const updatedAt = new Date().toISOString();
      const title = this.extractHistoryModeTitle(doc) || 'X01';
      const legLinks = this.collectHistoryUrlsFromDocument(doc).filter((entry) => this.extractLegIndexFromUrl(entry) !== null);
      const x01Start = this.extractHistoryX01StartValue(doc);

      return {
        id: matchId,
        playerName,
        title,
        x01Start: Number.isFinite(x01Start) ? x01Start : null,
        status: 'completed',
        completed: true,
        legsWon: Number.isFinite(stats.legsWon) ? stats.legsWon : null,
        setsWon: Number.isFinite(stats.setsWon) ? stats.setsWon : null,
        bestCheckout: Number.isFinite(stats.checkoutValue) ? stats.checkoutValue : null,
        totalLegs: legLinks.length || null,
        createdAt,
        startedAt: createdAt,
        endedAt: createdAt,
        updatedAt,
        sourcePath: this.cleanHistoryMatchPath(matchId),
        sourceChannel: 'history-dom'
      };
    }

    extractHistoryLeg(doc, url, matchRecord = null, preferredPlayerName = null) {
      const legIndex = this.extractLegIndexFromUrl(url);
      if (legIndex === null) return null;
      const matchId = this.extractMatchIdFromUrl(url);
      if (!matchId) return null;

      const playerName = SP.utils.sanitizePlayerName(preferredPlayerName)
        || SP.utils.sanitizePlayerName(this.extractPlayerNameFromDocument(doc, preferredPlayerName))
        || SP.utils.sanitizePlayerName(matchRecord?.playerName)
        || SP.utils.sanitizePlayerName(SP.utils.getLoggedInPlayerName(document))
        || SP.utils.sanitizePlayerName(SP.state.activePlayerName)
        || null;
      const statsInfo = this.parseHistoryPlayerStats(doc, playerName);
      const stats = statsInfo.stats;
      if (!statsInfo.playerFound || !Object.keys(stats).length) return null;

      const baseIso = this.deriveIsoFromMatchId(matchId) || new Date().toISOString();
      const createdAtDate = new Date(baseIso);
      if (!Number.isNaN(createdAtDate.getTime())) {
        createdAtDate.setMinutes(createdAtDate.getMinutes() + ((legIndex - 1) * 3));
      }
      const endedAtDate = new Date(createdAtDate.getTime());
      endedAtDate.setSeconds(endedAtDate.getSeconds() + Math.max(90, (stats.durationSeconds || 0)));
      const createdAt = !Number.isNaN(createdAtDate.getTime()) ? createdAtDate.toISOString() : baseIso;
      const endedAt = !Number.isNaN(endedAtDate.getTime()) ? endedAtDate.toISOString() : baseIso;
      const playerSlug = (playerName || 'player').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const legId = `history_${matchId}_leg_${legIndex}_${playerSlug}`;
      const checkoutAttempts = Number.isFinite(stats.checkoutAttempts) ? stats.checkoutAttempts : null;
      const checkoutHits = Number.isFinite(stats.checkoutHits) ? stats.checkoutHits : null;
      const x01Start = this.extractHistoryX01StartValue(doc) || matchRecord?.x01Start || null;
      const visitInfo = this.parseHistoryLegVisits(doc, statsInfo.columnIndex >= 0 ? statsInfo.columnIndex : 0, {
        legId,
        matchId,
        playerName,
        createdAt,
        sourcePath: url
      });
      const derivedCheckoutValue = Number.isFinite(visitInfo.checkoutValue) ? visitInfo.checkoutValue : null;
      const derivedCheckoutDarts = Number.isFinite(visitInfo.checkoutDarts) ? visitInfo.checkoutDarts : null;
      const summaryCheckoutValue = Number.isFinite(stats.checkoutValue) ? stats.checkoutValue : null;
      const visitCaptureReliable = this.isHistoryVisitCaptureReliable(visitInfo, stats.dartsThrown);
      const canUseDerivedCheckout = visitCaptureReliable
        && Number.isFinite(derivedCheckoutValue)
        && derivedCheckoutValue > 0;
      const checkoutSource = Number.isFinite(summaryCheckoutValue) && summaryCheckoutValue > 0
        ? 'summary'
        : (canUseDerivedCheckout ? 'derived-visits' : null);
      const checkoutValue = Number.isFinite(summaryCheckoutValue) && summaryCheckoutValue > 0
        ? summaryCheckoutValue
        : (canUseDerivedCheckout ? derivedCheckoutValue : null);
      const won = canUseDerivedCheckout
        || (Number.isFinite(summaryCheckoutValue) && summaryCheckoutValue > 0)
        || checkoutHits > 0;

      return {
        id: legId,
        matchId,
        legIndex,
        playerName,
        x01Start: Number.isFinite(x01Start) ? x01Start : null,
        average: Number.isFinite(stats.average) ? stats.average : null,
        averageUntil170: Number.isFinite(stats.averageUntil170) ? stats.averageUntil170 : null,
        first9: Number.isFinite(stats.first9) ? stats.first9 : null,
        dartsThrown: Number.isFinite(stats.dartsThrown) ? stats.dartsThrown : null,
        checkoutValue,
        checkoutDarts: won && canUseDerivedCheckout ? derivedCheckoutDarts : null,
        checkoutSource,
        historyVisitCaptureReliable: visitCaptureReliable,
        checkoutAttempts,
        doubleAttempts: checkoutAttempts,
        doubleHits: checkoutHits,
        score60s: Number.isFinite(stats.score60s) ? stats.score60s : 0,
        score100s: Number.isFinite(stats.score100s) ? stats.score100s : 0,
        score140s: Number.isFinite(stats.score140s) ? stats.score140s : 0,
        score170s: Number.isFinite(stats.score170s) ? stats.score170s : 0,
        score180s: Number.isFinite(stats.score180s) ? stats.score180s : 0,
        won,
        completed: true,
        sourcePath: url,
        sourceChannel: 'history-dom',
        createdAt,
        endedAt,
        updatedAt: new Date().toISOString(),
        historyDarts: visitInfo.darts || []
      };
    }


    findHistoryStatsTable(doc) {
      if (!doc) return null;
      const tables = Array.from(doc.querySelectorAll('table'));
      let best = null;
      let bestScore = 0;
      tables.forEach((table) => {
        const labels = Array.from(table.querySelectorAll('tbody tr')).map((row) => this.normalizeStatLabel(row.children?.[0]?.textContent || ''));
        const score = labels.filter((label) => ['average', 'dartsThrown', 'checkout', 'checkoutValue', 'score180s', 'first9', 'averageUntil170'].includes(label)).length;
        if (score > bestScore) {
          best = table;
          bestScore = score;
        }
      });
      return bestScore >= 2 ? best : null;
    }

    extractHistoryPlayerNameFromNode(node) {
      if (!node || typeof node.querySelector !== 'function') return null;
      const selectors = [
        '.ad-ext-player-name p',
        '.ad-ext-player-name',
        '.chakra-avatar__img[alt]',
        'img[alt]'
      ];
      for (const selector of selectors) {
        const candidate = node.querySelector(selector);
        if (!candidate) continue;
        const raw = selector.includes('img[alt]') ? candidate.getAttribute('alt') : candidate.textContent;
        const value = SP.utils.sanitizePlayerName((raw || '').replace(/\s+/g, ' ').trim());
        if (value) return value;
      }
      return null;
    }

    extractHistorySelectedTabPlayerName(doc) {
      if (!doc) return null;
      const activeTab = doc.querySelector('[role="tab"][aria-selected="true"]');
      return this.extractHistoryPlayerNameFromNode(activeTab);
    }

    getHistoryStatsPlayerColumns(table, doc = null) {
      if (!table) return [];
      const headerRow = table.querySelector('thead tr');
      const names = headerRow
        ? Array.from(headerRow.children || []).slice(1).map((cell) => this.extractHistoryPlayerNameFromNode(cell))
        : [];
      const sanitized = names.filter(Boolean);
      if (sanitized.length) return sanitized;
      const activeTabName = this.extractHistorySelectedTabPlayerName(doc || document);
      if (activeTabName) return [activeTabName];
      const sampleRow = table.querySelector('tbody tr');
      const dataColumnCount = sampleRow ? Math.max(0, (sampleRow.children?.length || 0) - 1) : 0;
      if (dataColumnCount === 1) return [null];
      return [];
    }

    findHistoryStatsPlayerColumn(table, preferredPlayerName = null, doc = null) {
      const players = this.getHistoryStatsPlayerColumns(table, doc);
      const preferred = SP.utils.sanitizePlayerName(preferredPlayerName)?.toLowerCase?.() || null;
      if (!players.length) return { index: -1, players: [] };
      if (!preferred) return { index: 0, players };
      const exactIndex = players.findIndex((name) => typeof name === 'string' && name.toLowerCase() === preferred);
      if (exactIndex >= 0) return { index: exactIndex, players };
      if (players.length === 1 && !players[0]) return { index: 0, players };
      return { index: -1, players };
    }

    cleanHistoryText(value) {
      return String(value || '').replace(/[\u00A0\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    getElementRect(node) {
      if (!node || typeof node.getBoundingClientRect !== 'function') return null;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      return rect;
    }

    extractHistoryFieldTokens(value) {
      const text = this.cleanHistoryText(value).toUpperCase();
      if (!text) return [];
      const matches = text.match(/\b(?:S\d{1,2}|D\d{1,2}|T\d{1,2}|SB|DB|25|50|MISS|M)\b/g) || [];
      return matches
        .map((entry) => SP.utils.normalizeField(entry))
        .filter(Boolean);
    }

    extractHistoryStandaloneNumbers(value) {
      const stripped = this.cleanHistoryText(value)
        .replace(/\b(?:S\d{1,2}|D\d{1,2}|T\d{1,2}|SB|DB|25|50|MISS|M)\b/gi, ' ')
        .replace(/[→➜➝]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!stripped) return [];
      return (stripped.match(/\b\d{1,3}(?:[.,]\d+)?\b/g) || [])
        .map((entry) => Number(String(entry).replace(',', '.')))
        .filter((entry) => Number.isFinite(entry));
    }

    findHistoryHeading(doc) {
      const elements = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, p, div, span, strong'));
      return elements.find((node) => /^history$/i.test(this.cleanHistoryText(node.textContent || '')))
        || null;
    }

    collectHistoryRoundLabels(doc) {
      const headingRect = this.getElementRect(this.findHistoryHeading(doc));
      const minTop = headingRect ? headingRect.top - 4 : 0;
      const labels = [];
      const seen = new Set();
      const nodes = Array.from(doc.querySelectorAll('div, p, span, td, th, strong'));
      nodes.forEach((node) => {
        const text = this.cleanHistoryText(node.textContent || '');
        const match = text.match(/^(round|runde)\s*(\d+)$/i);
        if (!match) return;
        const rect = this.getElementRect(node);
        if (!rect || rect.top < minTop) return;
        const key = `${match[2]}_${Math.round(rect.top)}`;
        if (seen.has(key)) return;
        seen.add(key);
        labels.push({ node, roundNumber: Number(match[2]), rect });
      });
      return labels.sort((a, b) => a.rect.top - b.rect.top);
    }

    findHistoryVisitContainer(node, rowTop, rowBottom) {
      let current = node;
      let best = null;
      let bestScore = -Infinity;
      let depth = 0;
      while (current && current !== current.ownerDocument.body && depth < 8) {
        const rect = this.getElementRect(current);
        if (rect) {
          const withinRow = rect.top >= rowTop - 28 && rect.bottom <= rowBottom + 28;
          const withinSize = rect.width >= 40 && rect.width <= 360 && rect.height >= 16 && rect.height <= 220;
          if (withinRow && withinSize) {
            const blockText = this.cleanHistoryText(current.textContent || '');
            const fields = this.extractHistoryFieldTokens(blockText);
            if (fields.length) {
              const nums = this.extractHistoryStandaloneNumbers(blockText);
              const candidateScore = (fields.length * 5) + (Math.min(nums.length, 3) * 2) - (rect.width / 300) - (rect.height / 160);
              if (candidateScore > bestScore) {
                best = current;
                bestScore = candidateScore;
              }
            }
          }
        }
        current = current.parentElement;
        depth += 1;
      }
      return best;
    }

    parseHistoryVisitBlock(node) {
      if (!node) return null;
      const blockText = this.cleanHistoryText(node.textContent || '');
      const fields = this.extractHistoryFieldTokens(blockText);
      if (!fields.length) return null;
      const numbers = this.extractHistoryStandaloneNumbers(blockText);
      const score = fields.reduce((sum, field) => sum + (SP.utils.getFieldValue(field) || 0), 0);
      const remaining = numbers.length ? numbers[numbers.length - 1] : null;
      const rect = this.getElementRect(node);
      return {
        score: Number.isFinite(score) ? score : null,
        remaining: Number.isFinite(remaining) ? remaining : null,
        fields,
        rect,
        text: blockText
      };
    }

    parseHistoryLegVisits(doc, playerColumnIndex = 0, legMeta = {}) {
      const roundLabels = this.collectHistoryRoundLabels(doc);
      if (!roundLabels.length) return { darts: [], checkoutValue: null, checkoutDarts: null, visits: [] };

      const visits = [];
      for (let index = 0; index < roundLabels.length; index += 1) {
        const current = roundLabels[index];
        const next = roundLabels[index + 1];
        const rowTop = current.rect.top - 18;
        const rowBottom = next ? next.rect.top - 6 : current.rect.bottom + 130;
        const tokenNodes = Array.from(doc.querySelectorAll('div, p, span, td, button'))
          .filter((node) => {
            const rect = this.getElementRect(node);
            if (!rect) return false;
            const centerY = rect.top + (rect.height / 2);
            if (centerY < rowTop || centerY > rowBottom) return false;
            return this.extractHistoryFieldTokens(node.textContent || '').length > 0;
          });
        const containers = [];
        const containerSeen = new Set();
        tokenNodes.forEach((node) => {
          const container = this.findHistoryVisitContainer(node, rowTop, rowBottom);
          if (!container || containerSeen.has(container)) return;
          containerSeen.add(container);
          const parsed = this.parseHistoryVisitBlock(container);
          if (!parsed) return;
          containers.push(parsed);
        });
        if (!containers.length) continue;
        containers.sort((a, b) => (a.rect?.left || 0) - (b.rect?.left || 0));
        const visit = containers[playerColumnIndex] || null;
        if (!visit) continue;
        visits.push({ roundNumber: current.roundNumber, ...visit });
      }

      const darts = [];
      const createdBase = new Date(legMeta.createdAt || Date.now()).getTime();
      visits.forEach((visit, visitIndex) => {
        visit.fields.forEach((field, dartIndex) => {
          const createdAt = new Date(createdBase + (visitIndex * 30000) + (dartIndex * 5000)).toISOString();
          darts.push({
            id: `history_dart_${legMeta.legId}_${visit.roundNumber}_${dartIndex + 1}`,
            legId: legMeta.legId,
            matchId: legMeta.matchId,
            playerName: legMeta.playerName,
            field,
            value: SP.utils.getFieldValue(field),
            createdAt,
            updatedAt: createdAt,
            sourcePath: legMeta.sourcePath,
            sourceChannel: 'history-dom'
          });
        });
      });

      const checkoutVisit = [...visits].reverse().find((visit) => Number(visit.remaining) === 0 && Number(visit.score) > 0);
      const checkoutValue = checkoutVisit && Number.isFinite(Number(checkoutVisit.score)) ? Number(checkoutVisit.score) : null;
      const checkoutDarts = checkoutVisit ? Math.min(3, checkoutVisit.fields.length || 0) || null : null;
      return { darts, checkoutValue, checkoutDarts, visits };
    }

    isHistoryVisitCaptureReliable(visitInfo = {}, dartsThrown = null) {
      const visits = Array.isArray(visitInfo?.visits) ? visitInfo.visits : [];
      const darts = Array.isArray(visitInfo?.darts) ? visitInfo.darts : [];
      if (!visits.length || !darts.length) return false;

      const visitCount = visits.length;
      const singleFieldVisits = visits.filter((visit) => Array.isArray(visit?.fields) && visit.fields.length === 1).length;
      const allVisitsSingleField = visitCount > 0 && singleFieldVisits === visitCount;

      if (allVisitsSingleField && Number.isFinite(dartsThrown) && dartsThrown >= (visitCount * 2)) {
        return false;
      }

      if (Number.isFinite(dartsThrown) && dartsThrown > 0) {
        if (darts.length > dartsThrown) return false;
        if (darts.length <= Math.max(3, Math.floor(dartsThrown / 2)) && visitCount >= 6) {
          return false;
        }
      }

      return true;
    }

    parseHistoryPlayerStats(doc, preferredPlayerName = null) {
      const table = this.findHistoryStatsTable(doc);
      if (!table) return { stats: {}, playerFound: false, players: [], columnIndex: -1 };
      const playerColumn = this.findHistoryStatsPlayerColumn(table, preferredPlayerName, doc);
      if (playerColumn.index < 0) {
        return { stats: {}, playerFound: false, players: playerColumn.players, columnIndex: -1 };
      }
      return {
        stats: this.parseStatsTable(table, playerColumn.index),
        playerFound: true,
        players: playerColumn.players,
        columnIndex: playerColumn.index
      };
    }

    parseStatsTable(table, playerColumnIndex = 0) {
      if (!table) return {};
      const stats = {};
      Array.from(table.querySelectorAll('tbody tr')).forEach((row) => {
        const cells = Array.from(row.children || []);
        if (cells.length < 2) return;
        const label = this.normalizeStatLabel(cells[0].textContent || '');
        const valueCell = cells[playerColumnIndex + 1] || null;
        const valueText = (valueCell?.textContent || '').replace(/\s+/g, ' ').trim();
        if (!label || !valueText) return;

        if (label === 'checkout') {
          const tuple = this.parseCheckoutTuple(valueText);
          if (tuple) {
            stats.checkoutPercent = tuple.percent;
            stats.checkoutHits = tuple.hits;
            stats.checkoutAttempts = tuple.attempts;
          }
          return;
        }

        const parsed = this.parseLocalizedNumber(valueText);
        if (parsed === null) return;
        stats[label] = parsed;
      });
      return stats;
    }

    normalizeStatLabel(label) {
      const text = (label || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!text) return null;
      if (/gewonnene sets|won sets/.test(text)) return 'setsWon';
      if (/gewonnene legs|won legs/.test(text)) return 'legsWon';
      if (/durchschnitt bis 170|average to 170|average until 170/.test(text)) return 'averageUntil170';
      if (/durchschnitt der ersten 9|average of first 9|first 9/.test(text)) return 'first9';
      if (/^durchschnitt$|^average$/.test(text)) return 'average';
      if (/geworfene pfeile|thrown darts|darts thrown/.test(text)) return 'dartsThrown';
      if (/^checkout ?%$|checkout percentage/.test(text)) return 'checkout';
      if (/beste checkout-punkte|checkout-punkte|best checkout score|highest checkout/.test(text)) return 'checkoutValue';
      if (/^60\+/.test(text)) return 'score60s';
      if (/^100\+/.test(text)) return 'score100s';
      if (/^140\+/.test(text)) return 'score140s';
      if (/^170\+/.test(text)) return 'score170s';
      if (/^180$/.test(text)) return 'score180s';
      return null;
    }

    parseCheckoutTuple(valueText) {
      const cleaned = (valueText || '').replace(/\s+/g, ' ').trim();
      const percent = this.parseLocalizedNumber(cleaned);
      const match = cleaned.match(/\((\d+)\s*\/\s*(\d+)\)/);
      if (!match) {
        return Number.isFinite(percent) ? { percent, hits: null, attempts: null } : null;
      }
      return {
        percent: Number.isFinite(percent) ? percent : null,
        hits: Number(match[1]),
        attempts: Number(match[2])
      };
    }

    parseLocalizedNumber(value) {
      if (value === null || value === undefined) return null;
      const text = String(value).replace(/ /g, ' ').trim();
      if (!text) return null;
      const match = text.match(/-?\d+(?:[.,]\d+)?/);
      if (!match) return null;
      return Number(match[0].replace(',', '.'));
    }

    extractPlayerNameFromDocument(doc, preferredPlayerName = null) {
      const preferred = SP.utils.sanitizePlayerName(preferredPlayerName)
        || SP.utils.sanitizePlayerName(this.historyPlayerNameLock)
        || SP.utils.sanitizePlayerName(SP.utils.getLoggedInPlayerName(doc))
        || SP.utils.sanitizePlayerName(SP.utils.getLoggedInPlayerName(document))
        || SP.utils.sanitizePlayerName(SP.state.activePlayerName)
        || null;
      if (preferred) return preferred;

      const selectors = [
        '[id^="menu-button"] .css-xl71ch',
        'button[aria-haspopup="menu"] .css-xl71ch',
        '[id^="menu-button"] .chakra-avatar__img[alt]',
        'button[aria-haspopup="menu"] .chakra-avatar__img[alt]',
        '.chakra-tabs [role="tab"][aria-selected="true"] .ad-ext-player-name p',
        'thead .ad-ext-player-name p',
        '.ad-ext-player-name p',
        '.chakra-avatar__img[alt]'
      ];

      for (const selector of selectors) {
        const node = doc.querySelector(selector);
        const text = selector.includes('[alt]') ? node?.getAttribute?.('alt') : node?.textContent;
        const value = (text || '').replace(/\s+/g, ' ').trim();
        const safeName = SP.utils.sanitizePlayerName(value);
        if (safeName) return safeName;
      }

      return SP.utils.sanitizePlayerName(SP.content?.detectPlayerNameFromPage?.()) || null;
    }

    deriveIsoFromMatchId(matchId) {
      const timestamp = this.decodeUuidV7Timestamp(matchId);
      return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
    }

    decodeUuidV7Timestamp(matchId) {
      if (!matchId || typeof matchId !== 'string') return null;
      const hex = matchId.replace(/-/g, '').slice(0, 12);
      if (!/^[0-9a-fA-F]{12}$/.test(hex)) return null;
      const parsed = Number.parseInt(hex, 16);
      return Number.isFinite(parsed) ? parsed : null;
    }

    cleanupRecentHashes() {
      const now = Date.now();
      for (const [hash, ts] of this.recentHashes.entries()) {
        if (now - ts > 120000) this.recentHashes.delete(hash);
      }
    }

    scheduleRefresh(delay = 1200) {
      if (!SP.content?.refresh) return;
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = window.setTimeout(() => {
        SP.content.refresh().catch((error) => console.error('[Statistik+ refresh]', error));
      }, delay);
    }

    queueMetaUpdate(payload) {
      const cleaned = Object.fromEntries(Object.entries(payload || {}).filter(([, value]) => value !== undefined));
      this.lastMetaPayload = { ...(this.lastMetaPayload || {}), ...cleaned };
      window.clearTimeout(this.metaDebounceTimer);
      this.metaDebounceTimer = window.setTimeout(async () => {
        const current = { ...(this.lastMetaPayload || {}) };
        this.lastMetaPayload = null;
        try {
          await Promise.all(Object.entries(current).map(([key, value]) => SP.db.setMeta(key, value)));
        } catch (error) {
          console.warn('[Statistik+ meta]', error);
        }
      }, 250);
    }

    async handleBridgeEvent(envelope) {
      this.cleanupRecentHashes();
      const ts = envelope?.ts || new Date().toISOString();
      const hash = SP.utils.hashString(envelope);
      if (this.recentHashes.has(hash)) return;
      this.recentHashes.set(hash, Date.now());
      SP.state.debug.lastCollectorMessage = envelope?.channel || null;
      SP.state.debug.rawEventsCaptured += 1;

      const envelopeUrl = envelope?.url || null;
      const envelopePayload = envelope?.data || null;

      if (/openid-connect\/token/i.test(envelopeUrl || '')) {
        if (typeof envelopePayload?.access_token === 'string' && envelopePayload.access_token.trim()) {
          this.latestAccessToken = envelopePayload.access_token.trim();
        }
        if (typeof envelopePayload?.sub === 'string' && envelopePayload.sub.trim()) {
          this.latestUserId = envelopePayload.sub.trim();
        }
      }

      await SP.db.put(SP.dbStores.rawEvents, {
        id: SP.utils.uid('raw'),
        hash,
        channel: envelope?.channel || 'unknown',
        url: envelopeUrl,
        payload: envelopePayload,
        createdAt: ts
      });

      const normalized = this.normalizePayload(envelope?.data, { channel: envelope?.channel, ts, url: envelope?.url });
      const hasAnyData = normalized.legs.length || normalized.checkouts.length || normalized.darts.length || normalized.matches.length;

      if (!hasAnyData) {
        this.parserState = 'Auto-Sync aktiv';
        this.queueMetaUpdate({ spLastSeenAt: ts, spSyncState: 'idle' });
        return;
      }

      if (normalized.matches.length) {
        await SP.db.bulkPut(SP.dbStores.matches, normalized.matches);
      }
      if (normalized.legs.length) {
        await SP.db.bulkPut(SP.dbStores.legs, normalized.legs);
      }
      if (normalized.checkouts.length) {
        await SP.db.bulkPut(SP.dbStores.checkouts, normalized.checkouts);
      }
      if (normalized.darts.length) {
        await SP.db.bulkPut(SP.dbStores.darts, normalized.darts);
      }

      const syncSummary = await this.updateAutoSyncState(normalized, contextFromEnvelope(envelope, ts));
      this.updateParserState(syncSummary, normalized);
      this.scheduleRefresh(syncSummary.urgent ? 180 : 1200);
    }

    updateParserState(syncSummary, normalized) {
      if (syncSummary.matchesCompleted > 0) {
        this.parserState = `Auto-Sync: Match gespeichert (${syncSummary.matchesCompleted})`;
        return;
      }
      if (syncSummary.legsCompleted > 0) {
        this.parserState = `Auto-Sync: Leg gespeichert (${syncSummary.legsCompleted})`;
        return;
      }
      if (normalized.darts.length > 0) {
        this.parserState = `Auto-Sync aktiv · ${normalized.darts.length} Live-Darts erkannt`;
        return;
      }
      if (normalized.legs.length > 0) {
        this.parserState = `Auto-Sync aktiv · ${normalized.legs.length} Leg-Updates erkannt`;
        return;
      }
      this.parserState = 'Auto-Sync aktiv';
    }

    async updateAutoSyncState(normalized, context) {
      const nowIso = context.ts || new Date().toISOString();
      const nowMs = Date.parse(nowIso) || Date.now();
      let legsCompleted = 0;
      let matchesCompleted = 0;

      const observedMatchIds = new Set();

      for (const match of normalized.matches) {
        observedMatchIds.add(match.id);
        const previous = this.activeMatches.get(match.id) || {};
        const merged = {
          ...previous,
          ...match,
          completed: Boolean(previous.completed || match.completed),
          lastSeenAt: nowIso,
          updatedAt: nowIso,
          sourceChannel: match.sourceChannel || context.channel || null
        };
        this.activeMatches.set(match.id, merged);
        if (match.completed) {
          matchesCompleted += 1;
          await SP.db.put(SP.dbStores.matches, {
            ...merged,
            status: 'completed',
            completed: true,
            endedAt: match.endedAt || nowIso,
            updatedAt: nowIso
          });
        }
      }

      for (const leg of normalized.legs) {
        if (!leg.matchId) continue;
        observedMatchIds.add(leg.matchId);
        const previous = this.activeMatches.get(leg.matchId) || {
          id: leg.matchId,
          playerName: leg.playerName || SP.state.activePlayerName || null,
          createdAt: leg.createdAt || nowIso,
          startedAt: leg.createdAt || nowIso,
          status: 'live',
          completed: false
        };

        const merged = {
          ...previous,
          id: leg.matchId,
          playerName: previous.playerName || leg.playerName || SP.state.activePlayerName || null,
          updatedAt: nowIso,
          lastSeenAt: nowIso,
          latestLegId: leg.id,
          latestLegIndex: leg.legIndex ?? previous.latestLegIndex ?? null,
          bestCheckout: Math.max(previous.bestCheckout || 0, leg.checkoutValue || 0),
          status: previous.completed ? 'completed' : 'live',
          completed: Boolean(previous.completed),
          sourceChannel: leg.sourceChannel || context.channel || null
        };

        this.activeMatches.set(leg.matchId, merged);
        await SP.db.put(SP.dbStores.matches, merged);

        if (leg.completed) {
          legsCompleted += 1;
          this.queueMetaUpdate({ spLastLegSyncAt: leg.endedAt || nowIso });
        }
      }

      matchesCompleted += await this.finalizeStaleMatches(nowMs, observedMatchIds);

      this.queueMetaUpdate({
        spLastSeenAt: nowIso,
        spAutoSyncAt: nowIso,
        spSyncState: matchesCompleted > 0 ? 'match-saved' : legsCompleted > 0 ? 'leg-saved' : normalized.darts.length > 0 ? 'live' : 'idle',
        spLastMatchSyncAt: matchesCompleted > 0 ? nowIso : undefined
      });

      return {
        legsCompleted,
        matchesCompleted,
        urgent: matchesCompleted > 0 || legsCompleted > 0
      };
    }

    async finalizeStaleMatches(nowMs = Date.now(), observedMatchIds = new Set()) {
      const finalized = [];
      for (const [matchId, match] of this.activeMatches.entries()) {
        if (!matchId || match.completed) continue;
        if (observedMatchIds.has(matchId)) continue;
        const lastSeenMs = Date.parse(match.lastSeenAt || match.updatedAt || match.startedAt || match.createdAt || '') || 0;
        if (!lastSeenMs) continue;
        if ((nowMs - lastSeenMs) < MATCH_STALE_MS) continue;
        finalized.push({
          ...match,
          completed: true,
          status: 'completed',
          endedAt: match.endedAt || new Date(lastSeenMs).toISOString(),
          updatedAt: new Date(nowMs).toISOString()
        });
      }

      if (!finalized.length) return 0;
      await SP.db.bulkPut(SP.dbStores.matches, finalized);
      finalized.forEach((match) => this.activeMatches.set(match.id, match));
      return finalized.length;
    }

    normalizePayload(payload, context = {}) {
      const objects = SP.utils.flattenObjects(payload, 3500);
      const legMap = new Map();
      const checkoutMap = new Map();
      const dartMap = new Map();
      const matchMap = new Map();

      objects.forEach(({ path, value }) => {
        const leg = this.extractLegCandidate(value, path, context);
        if (leg) {
          const current = legMap.get(leg.id);
          legMap.set(leg.id, this.mergeLeg(current, leg));
        }

        const checkout = this.extractCheckoutCandidate(value, path, context);
        if (checkout) {
          checkoutMap.set(checkout.id, checkout);
        }

        const dart = this.extractDartCandidate(value, path, context);
        if (dart) {
          dartMap.set(dart.id, dart);
        }

        const match = this.extractMatchCandidate(value, path, context);
        if (match) {
          const current = matchMap.get(match.id);
          matchMap.set(match.id, this.mergeMatch(current, match));
        }
      });

      const legs = Array.from(legMap.values()).filter((leg) => this.isUsefulLeg(leg));
      const checkouts = Array.from(checkoutMap.values()).filter((checkout) => Number.isFinite(checkout.value) && checkout.value > 0);
      const darts = Array.from(dartMap.values()).filter((dart) => SP.utils.normalizeField(dart.field));
      const matches = Array.from(matchMap.values()).filter((match) => match?.id);

      return { legs, checkouts, darts, matches };
    }

    mergeLeg(current, next) {
      if (!current) return next;
      const merged = { ...current };
      for (const [key, value] of Object.entries(next)) {
        if (value === null || value === undefined || value === '') continue;
        if (typeof value === 'number' && !Number.isFinite(value)) continue;
        merged[key] = value;
      }
      merged.completed = Boolean(current.completed || next.completed);
      merged.updatedAt = next.updatedAt || new Date().toISOString();
      return merged;
    }

    mergeMatch(current, next) {
      if (!current) return next;
      const merged = { ...current };
      for (const [key, value] of Object.entries(next)) {
        if (value === null || value === undefined || value === '') continue;
        if (typeof value === 'number' && !Number.isFinite(value)) continue;
        merged[key] = value;
      }
      merged.completed = Boolean(current.completed || next.completed);
      merged.status = merged.completed ? 'completed' : (next.status || current.status || 'live');
      merged.updatedAt = next.updatedAt || new Date().toISOString();
      return merged;
    }

    isUsefulLeg(leg) {
      if (!leg || typeof leg !== 'object') return false;
      const average = Number(leg.average);
      const dartsThrown = Number(leg.dartsThrown);
      const checkoutValue = Number(leg.checkoutValue);
      const score180s = Number(leg.score180s);
      const checkoutAttempts = Number(leg.checkoutAttempts);
      const doubleHits = Number(leg.doubleHits);

      return (Number.isFinite(average) && average > 0)
        || (Number.isFinite(dartsThrown) && dartsThrown > 0)
        || (Number.isFinite(checkoutValue) && checkoutValue > 0)
        || (Number.isFinite(score180s) && score180s > 0)
        || (Number.isFinite(checkoutAttempts) && checkoutAttempts > 0)
        || (Number.isFinite(doubleHits) && doubleHits > 0);
    }

    extractLegCandidate(obj, path, context) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

      const pathLower = String(path || '').toLowerCase();
      const pathHasLegContext = /(^|[.\[])(leg|legs|currentleg|legswon)([.\]0-9_]|$)/i.test(pathLower) || /history\/matches\/[^?]+\?leg=/i.test(pathLower);
      const pathLooksLikeThrow = /(dart|throw|shot|turn|visit|round|hit)/i.test(pathLower);
      const pathLooksLikeRoster = /(opponents|opponent|players|participants|friends|host|user|profile|filter-options)/i.test(pathLower);
      if (pathLooksLikeRoster && !pathHasLegContext) return null;
      if (pathLooksLikeThrow && !pathHasLegContext) return null;

      const average = this.pickAverage(obj);
      const dartsThrown = this.pickDartsThrown(obj);
      const checkoutValue = this.pickCheckoutValue(obj);
      const checkoutDarts = this.pickCheckoutDarts(obj);
      const score180s = this.pick180s(obj);
      const checkoutAttempts = this.pickCheckoutAttempts(obj);
      const doubleAttempts = this.pickDoubleAttempts(obj);
      const doubleHits = this.pickDoubleHits(obj);
      const legIndex = SP.utils.pickNumber(obj, ['legIndex', 'legNumber', 'currentLeg', 'leg', 'number'], null);
      const matchId = SP.utils.pickString(obj, ['matchId', 'gameId', 'game_id', 'match', 'game'], null);
      const legId = SP.utils.pickString(obj, ['legId', 'leg_id', 'uuid'], null);
      const playerName = SP.utils.sanitizePlayerName(SP.utils.pickString(obj, ['playerName', 'player', 'name', 'username', 'displayName', 'user'], null));
      const createdAt = this.pickIsoDate(obj) || context.ts || new Date().toISOString();
      const endedAt = this.pickIsoDate(obj, ['endedAt', 'finishedAt', 'completedAt', 'closedAt']) || createdAt;
      const won = this.pickWon(obj, playerName);
      const completed = this.isLegCompleted(obj, path, { average, dartsThrown, checkoutValue, won, endedAt, createdAt });
      const hasCoreFacts = Number.isFinite(average)
        || Number.isFinite(dartsThrown)
        || Number.isFinite(checkoutValue)
        || Number.isFinite(score180s)
        || Number.isFinite(checkoutAttempts)
        || Number.isFinite(doubleHits);
      if (!hasCoreFacts) return null;

      let confidence = 0;
      if (path.toLowerCase().includes('leg')) confidence += 2;
      if (Number.isFinite(average)) confidence += 2;
      if (Number.isFinite(dartsThrown)) confidence += 2;
      if (Number.isFinite(checkoutValue) && checkoutValue > 0) confidence += 2;
      if (playerName) confidence += 1;
      if (legIndex !== null) confidence += 1;
      if (Number.isFinite(score180s)) confidence += 1;

      if (confidence < 3) return null;

      const id = legId || `${matchId || 'match-unknown'}__${playerName || 'player-unknown'}__${legIndex ?? 'leg-unknown'}__${SP.utils.hashString(path)}`;
      const safeAverage = inRange(average, RANGE.average) ? average : null;
      const safeDartsThrown = inRange(dartsThrown, RANGE.dartsThrown) ? dartsThrown : null;
      const safeCheckoutValue = inRange(checkoutValue, RANGE.checkoutValue) ? checkoutValue : null;
      const safeCheckoutDarts = inRange(checkoutDarts, RANGE.checkoutDarts) ? checkoutDarts : null;

      return {
        id,
        matchId,
        legIndex,
        playerName,
        average: safeAverage,
        dartsThrown: safeDartsThrown,
        checkoutValue: safeCheckoutValue,
        checkoutDarts: safeCheckoutDarts,
        score180s: inRange(score180s, RANGE.score180s) ? score180s : 0,
        checkoutAttempts,
        doubleAttempts,
        doubleHits,
        won,
        completed,
        sourcePath: path,
        sourceChannel: context.channel || null,
        createdAt,
        endedAt,
        updatedAt: context.ts || new Date().toISOString()
      };
    }

    isLegCompleted(obj, path, facts = {}) {
      const textStatus = this.pickStatus(obj) || '';
      if (/(finished|completed|closed|ended|result|won)/i.test(textStatus)) return true;
      if (SP.utils.findFirstKey(obj, ['endedAt', 'finishedAt', 'completedAt', 'closedAt'])) return true;
      if (typeof obj.won === 'boolean' || typeof obj.isWinner === 'boolean' || typeof obj.victory === 'boolean') return true;
      if (/result|finished|completed|summary|winner/i.test(path) && (Number.isFinite(facts.average) || Number.isFinite(facts.dartsThrown))) return true;
      if (Number.isFinite(facts.checkoutValue) && facts.checkoutValue > 0) return true;
      return false;
    }

    extractMatchCandidate(obj, path, context) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
      const pathRelevant = /(match|game)/i.test(path);
      const status = this.pickStatus(obj);
      const rawId = SP.utils.pickString(obj, ['matchId', 'gameId', 'game_id', 'match', 'game'], null)
        || (pathRelevant ? SP.utils.pickString(obj, ['id', 'uuid'], null) : null);
      if (!rawId) return null;

      const playerCandidates = this.pickPlayers(obj);
      const activeName = SP.utils.sanitizePlayerName(SP.state.activePlayerName);
      let playerName = activeName || playerCandidates.find((name) => !SP.utils.isSuspiciousPlayerName(name)) || null;
      let opponentName = null;
      if (playerCandidates.length >= 2) {
        if (activeName && playerCandidates.some((entry) => entry.toLowerCase() === activeName.toLowerCase())) {
          playerName = activeName;
          opponentName = playerCandidates.find((entry) => entry.toLowerCase() !== activeName.toLowerCase()) || null;
        } else {
          [playerName, opponentName] = playerCandidates;
        }
      }

      const winnerName = this.pickWinnerName(obj);
      const startedAt = this.pickIsoDate(obj, ['startedAt', 'createdAt', 'openedAt', 'beginAt']) || context.ts || new Date().toISOString();
      const endedAt = this.pickIsoDate(obj, ['endedAt', 'finishedAt', 'completedAt', 'closedAt']) || null;
      const legsWon = SP.utils.pickNumber(obj, ['legsWon', 'wonLegs', 'score', 'wins'], null);
      const legsLost = SP.utils.pickNumber(obj, ['legsLost', 'lostLegs', 'losses'], null);

      let confidence = 0;
      if (pathRelevant) confidence += 2;
      if (rawId) confidence += 2;
      if (status) confidence += 1;
      if (playerCandidates.length) confidence += 1;
      if (winnerName || endedAt) confidence += 1;
      if (Number.isFinite(legsWon) || Number.isFinite(legsLost)) confidence += 1;
      if (confidence < 3) return null;

      const completed = Boolean(endedAt || winnerName || /(finished|completed|closed|ended|result)/i.test(status || ''));

      return {
        id: rawId,
        playerName,
        opponentName,
        winnerName,
        status: completed ? 'completed' : (status || 'live'),
        legsWon,
        legsLost,
        completed,
        createdAt: startedAt,
        startedAt,
        endedAt,
        updatedAt: context.ts || new Date().toISOString(),
        sourcePath: path,
        sourceChannel: context.channel || null
      };
    }

    pickPlayers(obj) {
      const direct = [];
      ['playerName', 'player', 'username', 'displayName', 'opponent', 'opponentName', 'guestName'].forEach((key) => {
        const value = obj?.[key];
        const safeName = SP.utils.sanitizePlayerName(value);
        if (safeName) direct.push(safeName);
      });
      ['players', 'participants', 'competitors'].forEach((key) => {
        const value = obj?.[key];
        if (!Array.isArray(value)) return;
        value.forEach((entry) => {
          const directName = SP.utils.sanitizePlayerName(entry);
          if (directName) direct.push(directName);
          if (entry && typeof entry === 'object') {
            const name = SP.utils.sanitizePlayerName(SP.utils.pickString(entry, ['name', 'username', 'displayName', 'playerName', 'user'], null));
            if (name) direct.push(name);
          }
        });
      });
      return Array.from(new Set(direct.filter(Boolean)));
    }

    pickWinnerName(obj) {
      const direct = SP.utils.sanitizePlayerName(SP.utils.pickString(obj, ['winner', 'winnerName', 'winningPlayer', 'victor'], null));
      if (direct) return direct;
      if (obj?.winner && typeof obj.winner === 'object') {
        return SP.utils.sanitizePlayerName(SP.utils.pickString(obj.winner, ['name', 'username', 'displayName', 'playerName'], null));
      }
      return null;
    }

    extractCheckoutCandidate(obj, path, context) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
      const value = this.pickCheckoutValue(obj);
      if (!inRange(value, RANGE.checkoutValue) || value <= 0) return null;
      const playerName = SP.utils.sanitizePlayerName(SP.utils.pickString(obj, ['playerName', 'player', 'name', 'username', 'displayName', 'user'], null));
      const matchId = SP.utils.pickString(obj, ['matchId', 'gameId', 'game_id', 'match', 'game'], null);
      const legId = SP.utils.pickString(obj, ['legId', 'leg_id', 'uuid'], null) || `${matchId || 'm'}__${playerName || 'p'}__${SP.utils.hashString(path)}`;
      const endedAt = this.pickIsoDate(obj) || context.ts || new Date().toISOString();
      const darts = this.pickCheckoutDarts(obj);
      const id = `${legId}__${value}__${SP.utils.hashString(path)}`;
      return {
        id,
        legId,
        matchId,
        playerName,
        value,
        darts: inRange(darts, RANGE.checkoutDarts) ? darts : null,
        sourcePath: path,
        endedAt,
        createdAt: context.ts || new Date().toISOString()
      };
    }

    extractDartCandidate(obj, path, context) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

      const directField = SP.utils.pickString(obj, ['field', 'hit', 'segment', 'target', 'notation', 'bed'], null);
      const normalized = SP.utils.normalizeField(directField);
      const pathLooksRelevant = /(dart|throw|shot|turn|visit|round|hit)/i.test(path);
      const points = SP.utils.pickNumber(obj, ['score', 'points', 'value', 'segmentScore'], null);

      if (!normalized && !pathLooksRelevant) return null;
      if (!normalized && ![0, 25, 50].includes(points)) return null;

      const playerName = SP.utils.sanitizePlayerName(SP.utils.pickString(obj, ['playerName', 'player', 'name', 'username', 'displayName', 'user'], null));
      const matchId = SP.utils.pickString(obj, ['matchId', 'gameId', 'game_id', 'match', 'game'], null);
      const legId = SP.utils.pickString(obj, ['legId', 'leg_id', 'uuid'], null) || `${matchId || 'm'}__${playerName || 'p'}__${SP.utils.hashString(path)}`;
      const dartIndex = SP.utils.pickNumber(obj, ['dartIndex', 'index', 'position', 'number'], null);
      const field = normalized || SP.utils.normalizeField(points);
      if (!field) return null;

      return {
        id: `${legId}__${field}__${dartIndex ?? 'x'}__${SP.utils.hashString(path)}`,
        legId,
        matchId,
        playerName,
        dartIndex: Number.isFinite(dartIndex) ? dartIndex : null,
        field,
        points: SP.utils.getFieldValue(field),
        createdAt: this.pickIsoDate(obj) || context.ts || new Date().toISOString(),
        sourceChannel: context.channel || null
      };
    }

    pickAverage(obj) {
      const raw = SP.utils.pickNumber(obj, ['average', 'avg', 'legAverage', 'threeDartAverage', 'three_dart_average', 'currentAverage', 'avgScore'], null);
      return inRange(raw, RANGE.average) ? raw : null;
    }

    pickDartsThrown(obj) {
      const raw = SP.utils.pickNumber(obj, ['dartsThrown', 'darts_thrown', 'darts', 'dartCount', 'numDarts', 'thrownDarts'], null);
      return inRange(raw, RANGE.dartsThrown) ? raw : null;
    }

    pickCheckoutValue(obj) {
      const raw = SP.utils.pickNumber(obj, ['checkoutValue', 'checkout', 'takeout', 'finish', 'finishingScore', 'checkout_score'], null);
      return inRange(raw, RANGE.checkoutValue) ? raw : null;
    }

    pickCheckoutDarts(obj) {
      const raw = SP.utils.pickNumber(obj, ['checkoutDarts', 'finishDarts', 'takeoutDarts', 'finishDartCount'], null);
      return inRange(raw, RANGE.checkoutDarts) ? raw : null;
    }

    pick180s(obj) {
      const direct = SP.utils.pickNumber(obj, ['score180s', 'oneEighties', 'hits180', 'maxScores180', 'max180'], null);
      if (inRange(direct, RANGE.score180s)) return direct;
      const score = SP.utils.pickNumber(obj, ['score', 'visitScore', 'roundScore', 'total', 'points'], null);
      if (score === 180) return 1;
      return 0;
    }

    pickCheckoutAttempts(obj) {
      const raw = SP.utils.pickNumber(obj, ['checkoutAttempts', 'finishAttempts', 'attemptsOnCheckout', 'attemptsOnDouble'], null);
      return Number.isFinite(raw) && raw >= 0 ? raw : null;
    }

    pickDoubleAttempts(obj) {
      const raw = SP.utils.pickNumber(obj, ['doubleAttempts', 'doublesAttempted', 'attemptsOnDouble'], null);
      return Number.isFinite(raw) && raw >= 0 ? raw : null;
    }

    pickDoubleHits(obj) {
      const raw = SP.utils.pickNumber(obj, ['doubleHits', 'doublesHit', 'successfulDoubles'], null);
      return Number.isFinite(raw) && raw >= 0 ? raw : null;
    }

    pickWon(obj, playerName) {
      if (typeof obj.won === 'boolean') return obj.won;
      if (typeof obj.isWinner === 'boolean') return obj.isWinner;
      if (typeof obj.victory === 'boolean') return obj.victory;
      if (typeof obj.winner === 'string' && playerName) {
        return obj.winner.toLowerCase() === playerName.toLowerCase();
      }
      return false;
    }

    pickStatus(obj) {
      return SP.utils.pickString(obj, ['status', 'state', 'phase', 'matchStatus', 'gameStatus', 'legStatus'], null);
    }

    pickIsoDate(obj, keys = ['endedAt', 'finishedAt', 'completedAt', 'updatedAt', 'createdAt', 'timestamp', 'ts']) {
      const value = SP.utils.findFirstKey(obj, keys);
      if (value === null || value === undefined || value === '') return null;
      const date = typeof value === 'number'
        ? new Date(value > 10_000_000_000 ? value : value * 1000)
        : new Date(value);
      if (Number.isNaN(date.getTime())) return null;
      return date.toISOString();
    }
  }

  function contextFromEnvelope(envelope, fallbackTs) {
    return {
      channel: envelope?.channel || null,
      url: envelope?.url || null,
      ts: envelope?.ts || fallbackTs || new Date().toISOString()
    };
  }

  SP.collector = new AutodartsCollector();
})();
