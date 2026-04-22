
(() => {
  const SP = window.__STATISTIK_PLUS__;
  if (!SP) return;

  const getReferenceDate = (entry) => entry.endedAt || entry.updatedAt || entry.createdAt;

  const safeDate = (value) => {
    const date = new Date(value || 0);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  const sum = (items, accessor) => items.reduce((acc, item) => acc + (accessor(item) || 0), 0);

  const normalizeName = (name) => {
    const value = SP.utils.sanitizePlayerName(name);
    return value ? value.toLowerCase() : '';
  };

  const DOUBLE_BOARD_ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];

  const getMinimumDartsForX01Start = (value) => {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.ceil(value / 180) * 3;
  };

  const isPlausibleCheckoutValue = (checkoutValue, checkoutDarts = null) => {
    const value = Number(checkoutValue);
    const darts = Number(checkoutDarts);
    if (!Number.isFinite(value) || value <= 0) return false;
    if (Number.isFinite(darts) && darts >= 1 && darts <= 3) {
      return value <= (darts * 60);
    }
    return value <= 170;
  };

  const getHistoryVisitIndexFromDart = (dart) => {
    const id = String(dart?.id || '');
    const match = id.match(/_(\d+)_(\d+)$/);
    return match ? Number(match[1]) : null;
  };

  const buildHistoryVisitMap = (legDarts = []) => {
    const visitMap = new Map();
    (legDarts || []).forEach((dart) => {
      const visitIndex = getHistoryVisitIndexFromDart(dart);
      if (!Number.isFinite(visitIndex)) return;
      if (!visitMap.has(visitIndex)) visitMap.set(visitIndex, []);
      visitMap.get(visitIndex).push(dart);
    });
    return visitMap;
  };

  const isLikelyIncompleteHistoryCapture = (leg, legDarts = []) => {
    if (leg?.sourceChannel !== 'history-dom' || !Array.isArray(legDarts) || !legDarts.length) return false;
    if (leg?.historyVisitCaptureReliable === false) return true;

    const visitMap = buildHistoryVisitMap(legDarts);
    const visitCount = visitMap.size;
    if (!visitCount) return false;
    const allVisitsSingleField = Array.from(visitMap.values()).every((visit) => Array.isArray(visit) && visit.length === 1);
    const dartsThrown = Number(leg?.dartsThrown);

    if (allVisitsSingleField && Number.isFinite(dartsThrown) && dartsThrown >= (visitCount * 2)) {
      return true;
    }

    if (Number.isFinite(dartsThrown) && dartsThrown > 0) {
      if (legDarts.length <= Math.max(3, Math.floor(dartsThrown / 2)) && visitCount >= 6) {
        return true;
      }
    }

    return false;
  };

  const isLegCheckoutImplausible = (leg, legDarts = []) => {
    if (!Number.isFinite(leg?.checkoutValue) || leg.checkoutValue <= 0) return true;
    if (!isPlausibleCheckoutValue(leg.checkoutValue, leg.checkoutDarts)) return true;
    return isLikelyIncompleteHistoryCapture(leg, legDarts) && Number.isFinite(leg?.checkoutDarts);
  };

  const deriveCheckoutFromHistoryDarts = (leg, legDarts = []) => {
    if (leg?.sourceChannel !== 'history-dom' || !leg?.won || !Array.isArray(legDarts) || !legDarts.length) return null;

    const visitMap = buildHistoryVisitMap(legDarts);

    if (!visitMap.size) return null;
    const finalVisitIndex = Math.max(...visitMap.keys());
    const finalVisit = (visitMap.get(finalVisitIndex) || []).slice().sort((a, b) => {
      const aId = String(a?.id || '');
      const bId = String(b?.id || '');
      return aId.localeCompare(bId, 'de-DE', { numeric: true });
    });
    if (!finalVisit.length) return null;

    const checkoutValue = finalVisit.reduce((acc, dart) => {
      const field = SP.utils.normalizeField(dart?.field);
      return acc + (SP.utils.getFieldValue(field) || 0);
    }, 0);
    const checkoutDarts = finalVisit.length;

    if (!Number.isFinite(checkoutValue) || checkoutValue <= 0 || !Number.isFinite(checkoutDarts) || checkoutDarts <= 0) {
      return null;
    }

    return { checkoutValue, checkoutDarts };
  };

  const enrichLegsWithHistoryCheckoutFallback = (legs, darts) => {
    const dartsByLegId = new Map();
    (darts || []).forEach((dart) => {
      if (!dart?.legId) return;
      if (!dartsByLegId.has(dart.legId)) dartsByLegId.set(dart.legId, []);
      dartsByLegId.get(dart.legId).push(dart);
    });

    return (legs || []).map((leg) => {
      if (!leg?.id) return leg;
      const legDarts = dartsByLegId.get(leg.id) || [];
      if (Number.isFinite(leg.checkoutValue) && leg.checkoutValue > 0 && !isLegCheckoutImplausible(leg, legDarts)) return leg;
      const derivedCheckout = deriveCheckoutFromHistoryDarts(leg, legDarts);
      if (!derivedCheckout) return leg;
      return {
        ...leg,
        checkoutValue: derivedCheckout.checkoutValue,
        checkoutDarts: derivedCheckout.checkoutDarts,
        won: true
      };
    });
  };

  const mergeMatchBestCheckoutFromLegs = (matches, legs) => {
    const bestByMatchId = new Map();
    const dartsByLegId = new Map();
    (legs || []).forEach((leg) => {
      if (leg?.id && Array.isArray(leg.historyDarts) && leg.historyDarts.length) {
        dartsByLegId.set(leg.id, leg.historyDarts);
      }
    });

    (legs || []).forEach((leg) => {
      const legDarts = dartsByLegId.get(leg?.id) || [];
      if (!leg?.matchId || isLegCheckoutImplausible(leg, legDarts)) return;
      const current = bestByMatchId.get(leg.matchId) || 0;
      bestByMatchId.set(leg.matchId, Math.max(current, Number(leg.checkoutValue) || 0));
    });

    return (matches || []).map((match) => {
      const existingBest = Number(match?.bestCheckout);
      const derivedBest = bestByMatchId.get(match?.id) || 0;
      const nextBest = Math.max(Number.isFinite(existingBest) ? existingBest : 0, derivedBest);
      return nextBest > 0 ? { ...match, bestCheckout: nextBest } : match;
    });
  };

  const applyDateFilter = (items, filter) => {
    const start = SP.utils.getFilterStart(filter);
    if (!start) return items.slice();
    return items.filter((item) => {
      const date = safeDate(getReferenceDate(item));
      return date && date >= start;
    });
  };

  const filterByPlayer = (items, playerName) => {
    const wanted = normalizeName(playerName);
    if (!wanted) return items.slice();
    return items.filter((item) => normalizeName(item.playerName) === wanted);
  };

  const matchesX01StartFilter = (item, x01StartFilter) => {
    const wanted = Number(x01StartFilter);
    if (![301, 501].includes(wanted)) return true;
    return Number(item?.x01Start) === wanted;
  };

  const applyX01StartFilter = (items, x01StartFilter) => {
    const wanted = Number(x01StartFilter);
    if (![301, 501].includes(wanted)) return items.slice();
    return items.filter((item) => matchesX01StartFilter(item, wanted));
  };

  const inferPlayerName = (legs, darts, preferred = null) => {
    if (preferred) return preferred;
    const counts = new Map();
    [...legs, ...darts].forEach((entry) => {
      const name = SP.utils.sanitizePlayerName(entry.playerName);
      if (!name) return;
      counts.set(name, (counts.get(name) || 0) + 1);
    });
    if (!counts.size) return null;
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
  };

  const normalizeMatchRecords = (matches, legs, playerName) => {
    const wanted = normalizeName(playerName);
    const legMatchIds = new Set(
      legs
        .filter((leg) => !wanted || normalizeName(leg.playerName) === wanted)
        .map((leg) => leg.matchId)
        .filter(Boolean)
    );

    return (matches || []).map((match) => {
      const safePlayer = SP.utils.sanitizePlayerName(match?.playerName || null);
      if (safePlayer) return match;
      if (match?.matchId && legMatchIds.has(match.matchId)) return { ...match, playerName };
      if (match?.id && legMatchIds.has(match.id)) return { ...match, playerName };
      return match;
    });
  };

  const groupByDay = (entries) => {
    const map = new Map();
    entries.forEach((entry) => {
      const date = safeDate(getReferenceDate(entry));
      if (!date) return;
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          label: new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' }).format(date),
          date,
          legs: [],
          darts: [],
          matches: new Set()
        });
      }
      const bucket = map.get(key);
      if (entry.id?.includes?.('dart') || entry.field) {
        bucket.darts.push(entry);
      } else {
        bucket.legs.push(entry);
        if (entry.matchId) bucket.matches.add(entry.matchId);
      }
    });
    return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
  };

  const deriveLegDurationSeconds = (leg) => {
    if (Number.isFinite(leg.durationSeconds) && leg.durationSeconds > 0) return leg.durationSeconds;
    const start = safeDate(leg.createdAt);
    const end = safeDate(leg.endedAt || leg.updatedAt);
    if (start && end) {
      const seconds = (end.getTime() - start.getTime()) / 1000;
      if (seconds > 0 && seconds <= 1800) return seconds;
    }
    if (Number.isFinite(leg.dartsThrown) && leg.dartsThrown > 0) {
      return leg.dartsThrown * 18;
    }
    return 0;
  };

  const buildActivityKpis = (legs, darts) => {
    const matchIds = new Set(legs.map((leg) => leg.matchId).filter(Boolean));
    const totalDarts = darts.length || sum(legs, (leg) => leg.dartsThrown);
    const totalLegs = legs.length;
    const totalMatches = matchIds.size || new Set(legs.map((leg) => `${SP.utils.formatDate(leg.endedAt || leg.createdAt)}-${leg.matchId || leg.id.split('__')[0]}`)).size;
    const playtimeSeconds = sum(legs, deriveLegDurationSeconds);

    return {
      totalDarts,
      totalLegs,
      totalMatches,
      playtimeSeconds
    };
  };

  const isLegUsableForDashboard = (leg) => {
    if (!leg || typeof leg !== 'object') return false;
    const average = Number(leg.average);
    const dartsThrown = Number(leg.dartsThrown);
    const checkoutValue = Number(leg.checkoutValue);
    const score180s = Number(leg.score180s);
    const checkoutAttempts = Number(leg.checkoutAttempts);
    const doubleHits = Number(leg.doubleHits);
    const x01Start = Number(leg.x01Start);

    const hasMeaningfulData = (Number.isFinite(average) && average > 0)
      || (Number.isFinite(dartsThrown) && dartsThrown > 0)
      || (Number.isFinite(checkoutValue) && checkoutValue > 0)
      || (Number.isFinite(score180s) && score180s > 0)
      || (Number.isFinite(checkoutAttempts) && checkoutAttempts > 0)
      || (Number.isFinite(doubleHits) && doubleHits > 0);
    if (!hasMeaningfulData) return false;

    const minimumDarts = getMinimumDartsForX01Start(x01Start);
    if (Number.isFinite(dartsThrown) && Number.isFinite(minimumDarts) && dartsThrown > 0 && dartsThrown < minimumDarts) {
      return false;
    }

    if (leg.sourceChannel === 'history-dom') return true;
    if (Number.isFinite(dartsThrown) && dartsThrown > 0 && dartsThrown < 9 && !(Number.isFinite(checkoutValue) && checkoutValue > 0)) return false;
    return true;
  };

  const buildPerformanceKpis = (legs, matches = []) => {
    const bestAverage = legs.reduce((max, leg) => (Number.isFinite(leg.average) && leg.average > max ? leg.average : max), -Infinity);
    const bestLeg = legs.reduce((best, leg) => {
      if (!Number.isFinite(leg.dartsThrown)) return best;
      if (!best) return leg;
      if (leg.dartsThrown < best.dartsThrown) return leg;
      if (leg.dartsThrown === best.dartsThrown && (leg.average || 0) > (best.average || 0)) return leg;
      return best;
    }, null);
    const bestCheckoutFromLegs = legs.reduce((max, leg) => (Number.isFinite(leg.checkoutValue) && leg.checkoutValue > max ? leg.checkoutValue : max), 0);
    const bestCheckoutFromMatches = matches.reduce((max, match) => (Number.isFinite(match.bestCheckout) && match.bestCheckout > max ? match.bestCheckout : max), 0);
    const bestCheckout = Math.max(bestCheckoutFromLegs, bestCheckoutFromMatches, 0);
    const count180s = sum(legs, (leg) => leg.score180s);

    return {
      bestAverage: Number.isFinite(bestAverage) && bestAverage > -Infinity ? bestAverage : null,
      bestLegDarts: bestLeg?.dartsThrown ?? null,
      bestLegAverage: bestLeg?.average ?? null,
      bestCheckout: bestCheckout > 0 ? bestCheckout : null,
      total180s: count180s || 0
    };
  };

  const buildActivitySeries = (legs, darts) => {
    const bucketMap = new Map();
    groupByDay(legs).forEach((day) => bucketMap.set(day.key, { ...day, darts: [] }));
    groupByDay(darts).forEach((day) => {
      const existing = bucketMap.get(day.key);
      if (existing) {
        existing.darts = day.darts;
      } else {
        bucketMap.set(day.key, day);
      }
    });

    return Array.from(bucketMap.values())
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((day) => ({
        label: day.label,
        darts: day.darts.length || sum(day.legs, (leg) => leg.dartsThrown),
        legs: day.legs.length,
        matches: day.matches?.size || new Set(day.legs.map((leg) => leg.matchId).filter(Boolean)).size
      }));
  };

  const buildAverageTrend = (legs) => {
    return groupByDay(legs).map((day) => {
      const averages = day.legs.map((leg) => leg.average).filter(Number.isFinite);
      return {
        label: day.label,
        value: averages.length ? sum(averages, (value) => value) / averages.length : null
      };
    }).filter((entry) => Number.isFinite(entry.value));
  };

  const buildCheckoutSeries = (legs) => {
    return groupByDay(legs).map((day) => {
      const made = day.legs.filter((leg) => Number.isFinite(leg.checkoutValue) && leg.checkoutValue > 0).length;
      const attempts = sum(day.legs, (leg) => leg.checkoutAttempts);
      return {
        label: day.label,
        value: attempts > 0 ? (made / attempts) * 100 : null,
        secondary: made
      };
    });
  };

  const buildScoringDistribution = (legs) => {
    const bands = [
      { label: '< 60', min: -Infinity, max: 60 },
      { label: '60+', min: 60, max: 80 },
      { label: '80+', min: 80, max: 100 },
      { label: '100+', min: 100, max: 120 },
      { label: '120+', min: 120, max: Infinity }
    ];

    return bands.map((band) => ({
      label: band.label,
      value: legs.filter((leg) => Number.isFinite(leg.average) && leg.average >= band.min && leg.average < band.max).length
    }));
  };

  const buildDoubleRadar = (darts) => {
    const labels = DOUBLE_BOARD_ORDER.map((value) => `D${value}`);
    const countMap = new Map(labels.map((label) => [label, 0]));
    darts.forEach((dart) => {
      const field = SP.utils.normalizeField(dart.field);
      if (!field || !field.startsWith('D')) return;
      countMap.set(field, (countMap.get(field) || 0) + 1);
    });
    return labels.map((label) => ({ label, value: countMap.get(label) || 0 }));
  };

  const buildFieldHits = (darts) => {
    const countMap = new Map();
    darts.forEach((dart) => {
      const field = SP.utils.normalizeField(dart.field);
      if (!field) return;
      countMap.set(field, (countMap.get(field) || 0) + 1);
    });
    return Array.from(countMap.entries())
      .map(([field, count]) => ({ field, count, value: SP.utils.getFieldValue(field) }))
      .sort((a, b) => b.count - a.count || (b.value || 0) - (a.value || 0) || a.field.localeCompare(b.field))
      .slice(0, 30);
  };

  const buildCheckoutFinishBreakdown = (legs) => {
    const counts = new Map([
      ['1 Dart', 0],
      ['2 Darts', 0],
      ['3 Darts', 0]
    ]);

    legs.forEach((leg) => {
      const dartsNeeded = Number(leg.checkoutDarts);
      if (!Number.isFinite(dartsNeeded) || dartsNeeded < 1 || dartsNeeded > 3) return;
      const key = dartsNeeded === 1 ? '1 Dart' : `${dartsNeeded} Darts`;
      counts.set(key, (counts.get(key) || 0) + 1);
    });

    return Array.from(counts.entries()).map(([label, value]) => ({ label, value }));
  };

  const buildFieldFamilies = (darts) => {
    const families = new Map([
      ['Singles', 0],
      ['Doubles', 0],
      ['Triples', 0],
      ['Bull', 0],
      ['Miss', 0]
    ]);

    darts.forEach((dart) => {
      const field = SP.utils.normalizeField(dart.field);
      if (!field) return;
      if (field === 'MISS') families.set('Miss', families.get('Miss') + 1);
      else if (field === '25' || field === '50') families.set('Bull', families.get('Bull') + 1);
      else if (field.startsWith('S')) families.set('Singles', families.get('Singles') + 1);
      else if (field.startsWith('D')) families.set('Doubles', families.get('Doubles') + 1);
      else if (field.startsWith('T')) families.set('Triples', families.get('Triples') + 1);
    });

    return Array.from(families.entries()).map(([label, value]) => ({ label, value }));
  };

  const buildNumberHits = (darts) => {
    const counts = new Map();

    darts.forEach((dart) => {
      const field = SP.utils.normalizeField(dart.field);
      if (!field) return;
      if (field === 'MISS') {
        counts.set('Miss', (counts.get('Miss') || 0) + 1);
        return;
      }
      if (field === '25' || field === '50') {
        counts.set('Bull', (counts.get('Bull') || 0) + 1);
        return;
      }
      const base = String(Number(field.slice(1)));
      if (!base || base === 'NaN') return;
      counts.set(base, (counts.get(base) || 0) + 1);
    });

    return Array.from(counts.entries())
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'de-DE', { numeric: true }))
      .slice(0, 10);
  };

  const topLegs = (legs) => legs
    .filter((leg) => isLegUsableForDashboard(leg) && (Number.isFinite(leg.average) || Number.isFinite(leg.dartsThrown)))
    .slice()
    .sort((a, b) => {
      const avgDelta = (b.average || -Infinity) - (a.average || -Infinity);
      if (avgDelta !== 0) return avgDelta;
      return (a.dartsThrown || Infinity) - (b.dartsThrown || Infinity);
    })
    .slice(0, 10);

  const topCheckouts = (legs, matches = []) => {
    const matchById = new Map((matches || []).map((match) => [match.id, match]));
    const legsByMatchId = new Map();

    (legs || []).forEach((leg) => {
      if (!leg?.matchId || !Number.isFinite(leg.checkoutValue) || leg.checkoutValue <= 0) return;
      if (!legsByMatchId.has(leg.matchId)) legsByMatchId.set(leg.matchId, []);
      legsByMatchId.get(leg.matchId).push(leg);
    });

    const result = [];
    const allMatchIds = new Set([
      ...Array.from(matchById.keys()).filter(Boolean),
      ...Array.from(legsByMatchId.keys()).filter(Boolean)
    ]);

    allMatchIds.forEach((matchId) => {
      const match = matchById.get(matchId) || null;
      const matchLegs = (legsByMatchId.get(matchId) || []).slice();
      const reliableLegs = matchLegs.filter((leg) => !isLegCheckoutImplausible(leg, leg.historyDarts || []));
      reliableLegs.sort((a, b) => {
        const valueDelta = (b.checkoutValue || 0) - (a.checkoutValue || 0);
        if (valueDelta !== 0) return valueDelta;
        return (a.checkoutDarts || Infinity) - (b.checkoutDarts || Infinity);
      });

      const bestLeg = reliableLegs[0] || null;
      const matchBestCheckout = Number(match?.bestCheckout);
      const hasMatchBest = Number.isFinite(matchBestCheckout) && matchBestCheckout > 0;

      if (bestLeg && (!hasMatchBest || bestLeg.checkoutValue >= matchBestCheckout)) {
        result.push({ ...bestLeg, sourceType: 'leg' });
        return;
      }

      if (hasMatchBest) {
        result.push({
          ...(match || {}),
          matchId: match?.id || matchId,
          checkoutValue: matchBestCheckout,
          checkoutDarts: null,
          average: null,
          sourceType: 'match-best'
        });
      }
    });

    return result
      .sort((a, b) => {
        const valueDelta = (b.checkoutValue || 0) - (a.checkoutValue || 0);
        if (valueDelta !== 0) return valueDelta;
        return (a.checkoutDarts || Infinity) - (b.checkoutDarts || Infinity);
      })
      .slice(0, 10);
  };

  SP.stats = {
    inferPlayerName,
    buildDashboardData(legs, darts, options = {}) {
      const matches = Array.isArray(options.matches) ? options.matches : [];
      const inferredPlayer = inferPlayerName(legs, darts, SP.utils.sanitizePlayerName(options.playerName || null));
      const normalizedMatches = normalizeMatchRecords(matches, legs, inferredPlayer);
      const matchById = new Map(normalizedMatches.map((match) => [match.id, match]));
      const enrichedLegs = enrichLegsWithHistoryCheckoutFallback((legs || []).map((leg) => {
        const match = matchById.get(leg.matchId);
        if (!match) return leg;
        return {
          ...leg,
          x01Start: Number.isFinite(leg.x01Start) ? leg.x01Start : (Number.isFinite(match.x01Start) ? match.x01Start : null)
        };
      }), darts || []);
      const normalizedMatchesWithCheckout = mergeMatchBestCheckoutFromLegs(normalizedMatches, enrichedLegs);
      const selectedX01Start = Number(options.x01StartFilter ?? SP.state.x01StartFilter);
      const dateFilteredLegs = applyDateFilter(enrichedLegs, options.filter || SP.state.filter);
      const dateFilteredDarts = applyDateFilter(darts, options.filter || SP.state.filter);
      const dateFilteredMatches = applyDateFilter(normalizedMatchesWithCheckout, options.filter || SP.state.filter);
      const modeFilteredLegs = applyX01StartFilter(dateFilteredLegs, selectedX01Start);
      const playerFilteredLegs = filterByPlayer(modeFilteredLegs, inferredPlayer);
      const filteredLegs = playerFilteredLegs.filter(isLegUsableForDashboard);
      const allowedLegIds = new Set(filteredLegs.map((leg) => leg.id).filter(Boolean));
      const allowedMatchIds = new Set(filteredLegs.map((leg) => leg.matchId).filter(Boolean));
      const filteredDarts = filterByPlayer(dateFilteredDarts, inferredPlayer).filter((dart) => {
        if (dart?.legId && allowedLegIds.has(dart.legId)) return true;
        if (dart?.matchId && allowedMatchIds.has(dart.matchId)) return true;
        return false;
      });
      const filteredMatches = filterByPlayer(dateFilteredMatches, inferredPlayer).filter((match) => {
        const matchId = match?.id || match?.matchId || null;
        if (matchId && allowedMatchIds.has(matchId)) return true;
        return matchesX01StartFilter(match, selectedX01Start);
      });

      return {
        activePlayerName: inferredPlayer,
        allLegs: legs,
        filteredLegs,
        filteredDarts,
        filteredMatches,
        activityKpis: buildActivityKpis(filteredLegs, filteredDarts),
        performanceKpis: buildPerformanceKpis(filteredLegs, filteredMatches),
        activitySeries: buildActivitySeries(filteredLegs, filteredDarts),
        averageTrend: buildAverageTrend(filteredLegs),
        checkoutSeries: buildCheckoutSeries(filteredLegs).filter((item) => Number.isFinite(item.value)),
        scoringDistribution: buildScoringDistribution(filteredLegs),
        checkoutFinishBreakdown: buildCheckoutFinishBreakdown(filteredLegs),
        doubleRadar: buildDoubleRadar(filteredDarts),
        fieldHits: buildFieldHits(filteredDarts),
        fieldFamilies: buildFieldFamilies(filteredDarts),
        numberHits: buildNumberHits(filteredDarts),
        topLegs: topLegs(filteredLegs),
        topCheckouts: topCheckouts(filteredLegs, filteredMatches),
        hasHistoryOnlyData: filteredLegs.some((leg) => leg.sourceChannel === 'history-dom') && !filteredDarts.length
      };
    }
  };
})();
