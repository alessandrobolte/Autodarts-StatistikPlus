
(() => {
  const SP = window.__STATISTIK_PLUS__;
  if (!SP) return;

  const content = {
    navObserver: null,

    async init() {
      await SP.db.open();
      const savedFilter = await SP.db.getMeta('selectedFilter', '30d');
      SP.state.filter = ['today', '7d', '30d', 'all'].includes(savedFilter) ? savedFilter : '30d';
      const savedX01Start = Number(await SP.db.getMeta('selectedX01Start', 501));
      SP.state.x01StartFilter = [301, 501].includes(savedX01Start) ? savedX01Start : 501;
      SP.state.configuredPlayerName = SP.utils.sanitizePlayerName(await SP.db.getMeta('configuredPlayerName', null));
      SP.state.activePlayerName = SP.state.configuredPlayerName || SP.utils.sanitizePlayerName(await SP.db.getMeta('currentPlayerName', null));
      SP.collector.parserState = 'Sync pausiert · starte via Historie (X01)';
      SP.ui.createRoot();
      this.attachMenuEntry();
      this.observePageForMenu();
      await this.refresh();
      SP.state.mounted = true;
      console.info('[Statistik+] gestartet (manueller Historien-Import)');
    },


    async importHistoryAndRefresh(options = {}) {
      try {
        if (!SP.collector.started) {
          SP.collector.init();
        }
        await SP.collector.importHistoryFromCurrentContext({
          force: options.force === true,
          notify: options.notify !== false,
          reason: options.reason || 'manual-history-button'
        });
      } catch (error) {
        console.warn('[Statistik+ history import]', error);
      }
      await this.refresh();
    },

    async refresh() {
      const [legs, checkouts, darts, matches] = await Promise.all([
        SP.db.getAll(SP.dbStores.legs),
        SP.db.getAll(SP.dbStores.checkouts),
        SP.db.getAll(SP.dbStores.darts),
        SP.db.getAll(SP.dbStores.matches)
      ]);

      const configuredPlayer = SP.state.configuredPlayerName
        || SP.utils.sanitizePlayerName(await SP.db.getMeta('configuredPlayerName', null));
      if (configuredPlayer && configuredPlayer !== SP.state.configuredPlayerName) {
        SP.state.configuredPlayerName = configuredPlayer;
      }

      const resolvedPlayer = configuredPlayer
        || SP.utils.sanitizePlayerName(await this.resolveActivePlayerName(legs, darts));
      if (resolvedPlayer && resolvedPlayer !== SP.state.activePlayerName) {
        SP.state.activePlayerName = resolvedPlayer;
        if (!configuredPlayer) {
          await SP.db.setMeta('currentPlayerName', resolvedPlayer);
        }
      }

      const data = SP.stats.buildDashboardData(legs, darts, {
        filter: SP.state.filter,
        x01StartFilter: SP.state.x01StartFilter,
        playerName: configuredPlayer || SP.state.activePlayerName,
        matches
      });

      if (!configuredPlayer && data.activePlayerName && data.activePlayerName !== SP.state.activePlayerName) {
        SP.state.activePlayerName = data.activePlayerName;
        await SP.db.setMeta('currentPlayerName', data.activePlayerName);
      }

      SP.ui.renderDashboard(data);
      SP.ui.renderFilterBar();
      SP.ui.renderStatus({
        playerName: configuredPlayer || SP.state.activePlayerName,
        x01StartFilter: SP.state.x01StartFilter,
        totalLegs: data.filteredLegs.length,
        totalCheckouts: data.filteredLegs.filter((leg) => Number.isFinite(leg.checkoutValue) && leg.checkoutValue > 0).length,
        totalDarts: data.filteredDarts.length || data.activityKpis.totalDarts,
        lastUpdatedAt: this.findLastUpdatedAt(legs, darts, matches),
        parserState: SP.collector.parserState,
        progress: typeof SP.collector.getHistoryProgress === 'function' ? SP.collector.getHistoryProgress() : null
      });
    },

    findLastUpdatedAt(legs, darts, matches = []) {
      const timestamps = [
        ...legs.map((entry) => entry.updatedAt || entry.endedAt || entry.createdAt),
        ...darts.map((entry) => entry.createdAt),
        ...matches.map((entry) => entry.updatedAt || entry.endedAt || entry.createdAt)
      ].filter(Boolean);
      if (!timestamps.length) return null;
      return timestamps.sort().at(-1);
    },

    async resolveActivePlayerName(legs, darts) {
      const configured = SP.state.configuredPlayerName
        || SP.utils.sanitizePlayerName(await SP.db.getMeta('configuredPlayerName', null));
      if (configured) return configured;

      const loggedInName = SP.utils.sanitizePlayerName(SP.utils.getLoggedInPlayerName(document));
      if (loggedInName) return loggedInName;

      const domName = SP.utils.sanitizePlayerName(this.detectPlayerNameFromPage());
      if (domName) return domName;

      const saved = SP.utils.sanitizePlayerName(await SP.db.getMeta('currentPlayerName', null));
      if (saved) return saved;

      return SP.utils.sanitizePlayerName(SP.stats.inferPlayerName(legs, darts, null));
    },


    async configurePlayerName() {
      const current = SP.state.configuredPlayerName
        || SP.state.activePlayerName
        || SP.utils.sanitizePlayerName(this.detectPlayerNameFromPage())
        || '';
      const raw = window.prompt('Spielername für Statistik + festlegen', current || '');
      if (raw === null) return;

      const next = SP.utils.sanitizePlayerName(raw);
      if (!next) {
        window.alert('Bitte einen gültigen Spielernamen eingeben.');
        return;
      }

      SP.state.configuredPlayerName = next;
      SP.state.activePlayerName = next;
      await SP.db.setMeta('configuredPlayerName', next);
      await SP.db.setMeta('currentPlayerName', next);
      SP.collector.historyPlayerNameLock = next;
      await this.refresh();
      SP.ui.toast(`Spieler gesetzt: ${next}`);
    },

    detectPlayerNameFromPage() {
      const loggedInName = SP.utils.sanitizePlayerName(SP.utils.getLoggedInPlayerName(document));
      if (loggedInName) return loggedInName;

      const selectors = [
        '.navigation button[aria-haspopup="menu"] .css-xl71ch',
        '.navigation [id^="menu-button"] .css-xl71ch',
        '[class*="user"][class*="name"]',
        '[class*="profile"] [class*="name"]',
        '[class*="account"] [class*="name"]',
        '[class*="player"][class*="name"]'
      ];

      for (const selector of selectors) {
        const node = document.querySelector(selector);
        const text = node?.textContent?.trim();
        const value = SP.utils.sanitizePlayerName(text);
        if (value) return value;
      }

      return SP.utils.sanitizePlayerName(SP.utils.getLoggedInPlayerName(document));
    },

    observePageForMenu() {
      if (this.navObserver) return;
      this.navObserver = new MutationObserver(() => this.attachMenuEntry());
      this.navObserver.observe(document.body, { childList: true, subtree: true });
    },

    attachMenuEntry() {
      const statisticsAnchor = this.findPrimaryStatisticsAnchor();
      const existingEntry = document.querySelector('#sp-nav-entry');

      if (!statisticsAnchor) {
        existingEntry?.remove();
        SP.ui.setFloatingButtonVisible(true);
        return;
      }

      const navigationRoot = this.findPreferredNavigationRoot(statisticsAnchor);
      if (!navigationRoot) {
        existingEntry?.remove();
        SP.ui.setFloatingButtonVisible(true);
        return;
      }

      const statisticsItem = this.findMenuItemContainer(statisticsAnchor, navigationRoot) || statisticsAnchor;
      const expectedPrevious = statisticsItem;
      const isExistingValid = existingEntry
        && !this.isUtilityMenuEntry(existingEntry)
        && existingEntry.parentElement === navigationRoot
        && existingEntry.previousElementSibling === expectedPrevious;

      if (existingEntry && !isExistingValid) {
        existingEntry.remove();
      }

      if (!isExistingValid) {
        const entry = this.buildMenuEntryFromTemplate(statisticsItem, statisticsAnchor);
        if (!entry) {
          SP.ui.setFloatingButtonVisible(true);
          return;
        }
        expectedPrevious.insertAdjacentElement('afterend', entry);
      }

      SP.ui.setFloatingButtonVisible(false);
    },

    findPrimaryStatisticsAnchor() {
      const preferredSelectors = [
        '.navigation .chakra-stack.css-1kwqbwj > a[href="/statistics"]',
        '.navigation .chakra-stack > a[href="/statistics"]',
        '.navigation a.chakra-button[href="/statistics"]',
        '.navigation a[href="/statistics"]'
      ];

      for (const selector of preferredSelectors) {
        const match = Array.from(document.querySelectorAll(selector)).find((node) => !this.isUtilityMenuEntry(node));
        if (match) return match;
      }

      const navigation = document.querySelector('.navigation');
      if (!navigation) return null;

      const allStatisticsLinks = Array.from(navigation.querySelectorAll('a[href="/statistics"], a[href$="/statistics"], a[href*="/statistics"]'));
      const filtered = allStatisticsLinks.filter((node) => !this.isUtilityMenuEntry(node));
      if (!filtered.length) return null;

      filtered.sort((a, b) => this.scoreStatisticsAnchor(b) - this.scoreStatisticsAnchor(a));
      return filtered[0] || null;
    },

    scoreStatisticsAnchor(node) {
      if (!node) return 0;
      let score = 0;
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^statistiken$/i.test(text) || /^statistics$/i.test(text)) score += 100;
      if (node.closest('.navigation')) score += 300;
      if (node.closest('[role="menu"], .chakra-menu__menu-list, [id^="menu-list-"]')) score -= 500;
      if (node.classList?.contains('chakra-button')) score += 50;
      if (node.parentElement?.classList?.contains('chakra-stack')) score += 20;
      return score;
    },

    isUtilityMenuEntry(node) {
      return Boolean(node?.closest('[role="menu"], .chakra-menu__menu-list, [id^="menu-list-"], [aria-haspopup="menu"], .chakra-menu__menu-button'));
    },

    findPreferredNavigationRoot(statisticsAnchor) {
      if (!statisticsAnchor) return null;
      return statisticsAnchor.closest('.chakra-stack, nav, aside, [role="navigation"]') || statisticsAnchor.parentElement || null;
    },

    findNavigationRoot() {
      const candidates = [
        '.navigation .chakra-stack',
        '.navigation',
        'aside nav',
        'nav',
        'aside',
        '[role="navigation"]',
        '[class*="sidebar"]'
      ];

      const roots = candidates.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
      if (!roots.length) return null;

      const score = (node) => {
        if (this.isUtilityMenuEntry(node)) return -9999;
        const clickable = node.querySelectorAll('a, button, [role="button"], [role="link"]').length;
        const text = (node.textContent || '').trim().length;
        const bonus = node.matches('.navigation, .navigation .chakra-stack') ? 500 : 0;
        return bonus + (clickable * 10) + Math.min(text, 200);
      };

      return roots.sort((a, b) => score(b) - score(a))[0] || null;
    },

    findStatisticsAnchor(root) {
      if (!root) return null;

      const candidates = Array.from(root.querySelectorAll('a, button, [role="button"], [role="link"], li, div'))
        .filter((node) => !this.isUtilityMenuEntry(node));
      const labels = /(^|)(statistiken|statistik|statistics|stats)(|$)/i;
      const hrefMatch = /stat/i;

      const scored = candidates
        .map((node) => {
          const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
          const href = typeof node.getAttribute === 'function' ? (node.getAttribute('href') || '') : '';
          if (!text && !href) return null;
          if (text.length > 120) return null;
          let value = 0;
          if (labels.test(text)) value += 100;
          else if (/stat/i.test(text)) value += 60;
          if (hrefMatch.test(href)) value += 40;
          if (/^statistiken$/i.test(text) || /^statistics$/i.test(text)) value += 80;
          if (/a|button/i.test(node.tagName)) value += 20;
          return value > 0 ? { node, value } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.value - a.value);

      return scored[0]?.node || null;
    },

    findMenuItemContainer(node, root) {
      if (!node) return null;
      if (node.matches?.('a.chakra-button, a[href], button')) return node;
      const container = node.closest('li, [role="menuitem"], [class*="menu-item"], [class*="nav-item"], [class*="list-item"], [class*="item"]');
      if (container && root.contains(container)) return container;
      return node;
    },

    buildMenuEntryFromTemplate(templateItem, statisticsAnchor) {
      const entry = templateItem.cloneNode(true);
      this.sanitizeClonedMenuEntry(entry);
      entry.id = 'sp-nav-entry';
      entry.dataset.spNavEntry = 'true';

      const interactive = this.findInteractiveElement(entry) || entry;
      if (interactive.tagName === 'A') {
        interactive.setAttribute('href', '#');
      }
      entry.classList.add('sp-native-menu-entry');
      if (interactive.tagName === 'BUTTON') {
        interactive.type = 'button';
      }
      interactive.setAttribute('aria-label', 'Statistik +');
      interactive.style.cursor = 'pointer';
      this.replaceMenuLabel(interactive, 'Statistik +');

      const sourceClasses = (statisticsAnchor?.className || '').toString();
      if (interactive !== entry && sourceClasses) {
        interactive.className = sourceClasses;
      }

      interactive.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        SP.ui.open();
      });

      return entry;
    },

    buildFallbackMenuEntry() {
      const button = document.createElement('button');
      button.id = 'sp-nav-entry';
      button.type = 'button';
      button.textContent = 'Statistik +';
      button.style.cssText = [
        'display:block',
        'width:100%',
        'margin-top:8px',
        'padding:10px 12px',
        'border-radius:12px',
        'border:1px solid rgba(56,189,248,.25)',
        'background:rgba(17,24,39,.8)',
        'color:#e5e7eb',
        'font-weight:700',
        'cursor:pointer',
        'text-align:left'
      ].join(';');
      button.addEventListener('click', () => SP.ui.open());
      return button;
    },

    sanitizeClonedMenuEntry(node) {
      if (node.id) node.removeAttribute('id');
      Array.from(node.querySelectorAll('[id]')).forEach((child) => child.removeAttribute('id'));
      Array.from(node.querySelectorAll('[data-active], [aria-current="page"]')).forEach((child) => {
        child.removeAttribute('data-active');
        child.removeAttribute('aria-current');
      });
    },

    findInteractiveElement(node) {
      if (!node) return null;
      if (node.matches?.('a, button, [role="button"], [role="link"]')) return node;
      return node.querySelector('a, button, [role="button"], [role="link"]');
    },

    replaceMenuLabel(root, nextLabel) {
      if (!root) return;
      const labelNodes = Array.from(root.querySelectorAll('span, div, p')).filter((child) => {
        const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
        return text && text.length <= 40 && /stat/i.test(text);
      });

      if (labelNodes.length) {
        labelNodes[0].textContent = nextLabel;
        labelNodes.slice(1).forEach((node) => { node.textContent = ''; });
        return;
      }

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(textNode) {
          const text = (textNode.nodeValue || '').replace(/\s+/g, ' ').trim();
          return text && /stat/i.test(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
      });
      const textNode = walker.nextNode();
      if (textNode) {
        textNode.nodeValue = nextLabel;
        return;
      }

      root.textContent = nextLabel;
    },

    randomWeightedField(strengthFactor = 1) {
      const pool = [
        ['T20', 18 * strengthFactor],
        ['S20', 12],
        ['T19', 10 * strengthFactor],
        ['S19', 8],
        ['T18', 7 * strengthFactor],
        ['S18', 7],
        ['T17', 5 * strengthFactor],
        ['S17', 6],
        ['S16', 5],
        ['D16', 2],
        ['S15', 4],
        ['D20', 2],
        ['25', 1],
        ['MISS', Math.max(1, 4 - strengthFactor)]
      ];
      const total = pool.reduce((acc, [, weight]) => acc + weight, 0);
      let roll = Math.random() * total;
      for (const [field, weight] of pool) {
        roll -= weight;
        if (roll <= 0) return field;
      }
      return 'S20';
    },

    buildCheckoutField(remaining = 40) {
      const doubles = [20, 16, 10, 12, 8, 4, 18, 14, 6, 2];
      if (remaining === 50) return '50';
      if (remaining % 2 === 0 && remaining >= 2 && remaining <= 40) return `D${remaining / 2}`;
      return `D${doubles[Math.floor(Math.random() * doubles.length)]}`;
    },

    getFinishScores() {
      if (this._finishScores) return this._finishScores;
      const scores = new Set([50]);
      for (let value = 2; value <= 40; value += 2) scores.add(value);
      this._finishScores = scores;
      return scores;
    },

    getSetupScores() {
      if (this._setupScores) return this._setupScores;
      const scores = new Set([25, 50]);
      for (let number = 1; number <= 20; number += 1) {
        scores.add(number);
        scores.add(number * 2);
        scores.add(number * 3);
      }
      this._setupScores = Array.from(scores);
      return this._setupScores;
    },

    canCheckoutInDarts(total, darts) {
      const finishScores = this.getFinishScores();
      const setupScores = this.getSetupScores();
      if (!Number.isFinite(total) || total < 2 || total > 170) return false;
      if (darts === 1) return finishScores.has(total);
      if (darts === 2) return setupScores.some((first) => finishScores.has(total - first));
      if (darts === 3) {
        return setupScores.some((first) => setupScores.some((second) => finishScores.has(total - first - second)));
      }
      return false;
    },

    getMinimumCheckoutDarts(total) {
      for (let darts = 1; darts <= 3; darts += 1) {
        if (this.canCheckoutInDarts(total, darts)) return darts;
      }
      return null;
    },

    getDemoCheckoutPool() {
      if (this._demoCheckoutPool) return this._demoCheckoutPool;
      const values = [];
      for (let value = 2; value <= 170; value += 1) {
        const darts = this.getMinimumCheckoutDarts(value);
        if (darts) values.push({ value, darts });
      }
      this._demoCheckoutPool = values.filter((entry) => entry.value >= 40);
      return this._demoCheckoutPool;
    },

    async seedDemoData() {
      const playerName = 'Boltotelli';
      const today = new Date();
      const demoLegs = [];
      const demoCheckouts = [];
      const demoDarts = [];
      const demoMatches = [];

      for (let dayOffset = 0; dayOffset < 42; dayOffset += 1) {
        if (dayOffset % 6 === 0) continue;
        const date = new Date(today);
        date.setDate(date.getDate() - dayOffset);

        const matchesToday = 1 + (dayOffset % 2);
        for (let matchIndex = 0; matchIndex < matchesToday; matchIndex += 1) {
          const matchId = `demo_match_${dayOffset}_${matchIndex}`;
          const legsInMatch = 2 + ((dayOffset + matchIndex) % 4);
          const matchStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 18 + (matchIndex % 4), 0).toISOString();
          let matchEnd = matchStart;

          for (let legIndex = 0; legIndex < legsInMatch; legIndex += 1) {
            const endedAtDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 18 + (matchIndex % 4), 5 + legIndex * 9);
            const endedAt = endedAtDate.toISOString();
            matchEnd = endedAt;
            const createdAt = new Date(endedAtDate.getTime() - (240 + ((legIndex + dayOffset) % 8) * 25) * 1000).toISOString();

            const dartsThrown = 12 + ((dayOffset * 3 + legIndex * 2 + matchIndex) % 16);
            const average = SP.utils.round((1503 / dartsThrown) + (((dayOffset + legIndex) % 5) * 0.37), 2);
            const checkoutPool = this.getDemoCheckoutPool();
            const shouldHaveCheckout = (legIndex + dayOffset + matchIndex) % 2 === 0;
            const checkoutEntry = shouldHaveCheckout ? checkoutPool[(dayOffset * 5 + legIndex * 7 + matchIndex * 3) % checkoutPool.length] : null;
            const checkoutValue = checkoutEntry?.value || 0;
            const checkoutDarts = checkoutEntry?.darts || null;
            const durationSeconds = Math.max(180, dartsThrown * 18 + ((dayOffset + legIndex) % 30));
            const legId = `demo_leg_${dayOffset}_${matchIndex}_${legIndex}`;

            const leg = {
              id: legId,
              matchId,
              legIndex: legIndex + 1,
              playerName,
              average,
              dartsThrown,
              checkoutValue,
              checkoutDarts,
              score180s: average >= 90 && legIndex % 2 === 0 ? 1 : 0,
              checkoutAttempts: checkoutValue > 0 ? 1 + (legIndex % 2) : 2 + (legIndex % 3),
              doubleAttempts: checkoutValue > 0 ? 1 + (legIndex % 2) : 2 + (legIndex % 2),
              doubleHits: checkoutValue > 0 ? 1 : (legIndex % 2),
              won: checkoutValue > 0,
              durationSeconds,
              sourcePath: 'demo.seed',
              sourceChannel: 'demo',
              createdAt,
              endedAt,
              updatedAt: endedAt
            };

            demoLegs.push(leg);

            const strength = average >= 95 ? 3 : average >= 80 ? 2 : 1;
            for (let dartIndex = 0; dartIndex < dartsThrown; dartIndex += 1) {
              let field = this.randomWeightedField(strength);
              if (dartIndex === dartsThrown - 1 && checkoutValue > 0) {
                field = this.buildCheckoutField(checkoutValue);
              }

              demoDarts.push({
                id: `demo_dart_${dayOffset}_${matchIndex}_${legIndex}_${dartIndex}`,
                legId,
                matchId,
                playerName,
                dartIndex: dartIndex + 1,
                field,
                points: SP.utils.getFieldValue(field),
                createdAt: new Date(new Date(createdAt).getTime() + dartIndex * 18000).toISOString(),
                sourceChannel: 'demo'
              });
            }

            if (checkoutValue > 0) {
              demoCheckouts.push({
                id: `${legId}_co`,
                legId,
                matchId,
                playerName,
                value: checkoutValue,
                darts: checkoutDarts,
                sourcePath: 'demo.seed',
                endedAt,
                createdAt: endedAt
              });
            }
          }

          demoMatches.push({
            id: matchId,
            playerName,
            opponentName: 'Training Board',
            status: 'completed',
            completed: true,
            createdAt: matchStart,
            startedAt: matchStart,
            endedAt: matchEnd,
            updatedAt: matchEnd,
            sourceChannel: 'demo'
          });
        }
      }

      const rawEvents = demoLegs.slice(0, 18).map((leg) => ({
        id: SP.utils.uid('demo_raw'),
        hash: SP.utils.hashString(leg.id),
        channel: 'demo',
        url: 'demo://seed',
        payload: { legId: leg.id, playerName: leg.playerName, average: leg.average, dartsThrown: leg.dartsThrown },
        createdAt: leg.createdAt
      }));

      await SP.db.bulkPut(SP.dbStores.legs, demoLegs);
      await SP.db.bulkPut(SP.dbStores.checkouts, demoCheckouts);
      await SP.db.bulkPut(SP.dbStores.darts, demoDarts);
      await SP.db.bulkPut(SP.dbStores.rawEvents, rawEvents);
      await SP.db.bulkPut(SP.dbStores.matches, demoMatches);
      await SP.db.setMeta('currentPlayerName', playerName);
      if (!SP.state.configuredPlayerName) {
        SP.state.configuredPlayerName = playerName;
        await SP.db.setMeta('configuredPlayerName', playerName);
      }

      SP.state.activePlayerName = SP.state.configuredPlayerName || playerName;
      SP.collector.parserState = 'Demo-Daten aktiv';
      await this.refresh();
      SP.ui.toast('Demo-Daten für Boltotelli wurden ergänzt.');
      SP.ui.open();
    }
  };

  SP.content = content;
  content.init().catch((error) => console.error('[Statistik+ init]', error));
})();
