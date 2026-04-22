
(() => {
  const globalKey = '__STATISTIK_PLUS__';
  if (window[globalKey]) return;

  const SP = {
    version: '0.4.29',
    globalKey,
    appId: 'statistik-plus',
    bridgeMessageType: 'STATISTIK_PLUS_BRIDGE_EVENT',
    filters: {
      today: 'today',
      '7d': '7d',
      '30d': '30d',
      all: 'all'
    },
    state: {
      filter: '30d',
      isOpen: false,
      mounted: false,
      activePlayerName: null,
      configuredPlayerName: null,
      x01StartFilter: 501,
      debug: {
        lastCollectorMessage: null,
        rawEventsCaptured: 0
      }
    },
    utils: {}
  };

  SP.utils.uid = (prefix = 'sp') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

  SP.utils.toNumber = (value, fallback = null) => {
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  SP.utils.round = (value, digits = 2) => {
    if (!Number.isFinite(value)) return null;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  };

  SP.utils.clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  SP.utils.formatAverage = (value) => {
    if (!Number.isFinite(value)) return '—';
    return SP.utils.round(value, 2).toFixed(2);
  };

  SP.utils.formatPercent = (value) => {
    if (!Number.isFinite(value)) return '—';
    return `${SP.utils.round(value, 1).toFixed(1)}%`;
  };

  SP.utils.formatInt = (value) => {
    if (!Number.isFinite(value)) return '—';
    return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(value);
  };

  SP.utils.formatOneDecimal = (value) => {
    if (!Number.isFinite(value)) return '—';
    return new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
  };

  SP.utils.formatDateTime = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  };

  SP.utils.formatDate = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('de-DE', {
      day: '2-digit',
      month: '2-digit'
    }).format(date);
  };

  SP.utils.startOfToday = () => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now;
  };

  SP.utils.getFilterStart = (filterKey) => {
    const now = new Date();
    const date = new Date(now);
    if (filterKey === 'today') {
      return SP.utils.startOfToday();
    }
    if (filterKey === '7d') {
      date.setDate(date.getDate() - 6);
      date.setHours(0, 0, 0, 0);
      return date;
    }
    if (filterKey === '30d') {
      date.setDate(date.getDate() - 29);
      date.setHours(0, 0, 0, 0);
      return date;
    }
    return null;
  };

  SP.utils.hashString = (input) => {
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash |= 0;
    }
    return `h${Math.abs(hash)}`;
  };

  SP.utils.deepClone = (value) => {
    try {
      return structuredClone(value);
    } catch (_) {
      return JSON.parse(JSON.stringify(value));
    }
  };

  SP.utils.safeJsonParse = (value) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch (_) {
      return value;
    }
  };

  SP.utils.getPathValue = (obj, path) => {
    if (!obj || !path) return undefined;
    return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
  };

  SP.utils.findFirstKey = (obj, keys) => {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined && obj[key] !== null) {
        return obj[key];
      }
    }
    return undefined;
  };

  SP.utils.pickNumber = (obj, keys, fallback = null) => {
    const value = SP.utils.findFirstKey(obj, keys);
    return SP.utils.toNumber(value, fallback);
  };

  SP.utils.pickString = (obj, keys, fallback = null) => {
    const value = SP.utils.findFirstKey(obj, keys);
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  };

  SP.utils.flattenObjects = (root, limit = 2500) => {
    const results = [];
    const seen = new WeakSet();
    const walk = (value, path = '') => {
      if (results.length >= limit) return;
      if (!value || typeof value !== 'object') return;
      if (seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
        return;
      }
      results.push({ path, value });
      for (const [key, child] of Object.entries(value)) {
        walk(child, path ? `${path}.${key}` : key);
      }
    };
    walk(root, 'root');
    return results;
  };

  SP.utils.isGuestPlayer = (name) => {
    if (!name || typeof name !== 'string') return false;
    return /\b(guest|gast|spieler\s*\d+|player\s*\d+|opponent|gegner)\b/i.test(name.trim());
  };

  SP.utils.isSuspiciousPlayerName = (name) => {
    if (!name || typeof name !== 'string') return true;
    const value = name.trim();
    if (!value) return true;
    if (SP.utils.isGuestPlayer(value)) return true;

    const normalized = value.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) return true;
    if (/^[\d\W_]+$/.test(normalized)) return true;

    const blockedExact = new Set([
      'participated', 'participant', 'participants', 'history', 'historie', 'statistics', 'statistik',
      'average', 'durchschnitt', 'checkout', 'checkouts', 'match', 'matches', 'spiel', 'spiele',
      'leg', 'legs', 'set', 'sets', 'won', 'lost', 'result', 'finished', 'completed', 'live', 'summary',
      'false', 'true', 'null', 'undefined'
    ]);
    if (blockedExact.has(normalized)) return true;
    if (/^(won|lost|finished|completed|participated|summary|average|checkout|match|leg|set)s?$/.test(normalized)) return true;
    return false;
  };

  SP.utils.sanitizePlayerName = (name) => {
    if (typeof name !== 'string') return null;
    const value = name.replace(/\s+/g, ' ').trim();
    return SP.utils.isSuspiciousPlayerName(value) ? null : value;
  };

  SP.utils.getLoggedInPlayerName = (doc = document) => {
    const scopedDoc = doc && typeof doc.querySelector === 'function' ? doc : document;
    const selectors = [
      '.navigation button[aria-haspopup="menu"] .css-xl71ch',
      '.navigation [id^="menu-button"] .css-xl71ch',
      '.navigation button[aria-haspopup="menu"] img[alt]',
      '.navigation .chakra-menu__menu-button img[alt]',
      'button[aria-haspopup="menu"] .css-xl71ch',
      '[id^="menu-button"] .css-xl71ch',
      'button[aria-haspopup="menu"] img[alt]',
      '.chakra-menu__menu-button img[alt]'
    ];

    for (const selector of selectors) {
      const nodes = Array.from(scopedDoc.querySelectorAll(selector));
      for (const node of nodes) {
        const raw = selector.includes('img[alt]') ? node.getAttribute('alt') : node.textContent;
        const value = SP.utils.sanitizePlayerName((raw || '').replace(/\s+/g, ' ').trim());
        if (value) return value;
      }
    }

    const title = scopedDoc.querySelector('title')?.textContent || '';
    const titleMatch = title.match(/statistics\s*\([^)]*[-–—]\s*([^()]+)\)/i);
    const titleName = SP.utils.sanitizePlayerName(titleMatch?.[1] || '');
    if (titleName) return titleName;

    try {
      const values = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || !/(user|profile|account|auth|login|name)/i.test(key)) continue;
        const value = localStorage.getItem(key);
        if (!value) continue;
        values.push(value);
      }
      for (const raw of values) {
        const direct = SP.utils.sanitizePlayerName(raw);
        if (direct) return direct;
        const parsed = SP.utils.safeJsonParse(raw);
        if (typeof parsed === 'string') {
          const value = SP.utils.sanitizePlayerName(parsed);
          if (value) return value;
        }
        if (parsed && typeof parsed === 'object') {
          const nested = SP.utils.sanitizePlayerName(
            SP.utils.pickString(parsed, ['displayName', 'username', 'name', 'nick', 'nickname', 'preferred_username'], null)
          );
          if (nested) return nested;
          if (parsed.user && typeof parsed.user === 'object') {
            const fromUser = SP.utils.sanitizePlayerName(
              SP.utils.pickString(parsed.user, ['displayName', 'username', 'name', 'nick', 'nickname', 'preferred_username'], null)
            );
            if (fromUser) return fromUser;
          }
          if (parsed.profile && typeof parsed.profile === 'object') {
            const fromProfile = SP.utils.sanitizePlayerName(
              SP.utils.pickString(parsed.profile, ['displayName', 'username', 'name', 'nick', 'nickname', 'preferred_username'], null)
            );
            if (fromProfile) return fromProfile;
          }
        }
      }
    } catch (_) {
      // ignore
    }

    return null;
  };

  SP.utils.formatDuration = (seconds) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—';
    if (seconds >= 3600) {
      return `${SP.utils.round(seconds / 3600, 2).toFixed(2)}h`;
    }
    return `${SP.utils.formatInt(Math.round(seconds / 60))}m`;
  };

  SP.utils.getFieldValue = (field) => {
    const normalized = SP.utils.normalizeField(field);
    if (!normalized) return null;
    if (normalized === 'MISS') return 0;
    if (normalized === '25') return 25;
    if (normalized === '50') return 50;
    const multiplier = normalized[0];
    const base = Number(normalized.slice(1));
    if (!Number.isFinite(base)) return null;
    if (multiplier === 'S') return base;
    if (multiplier === 'D') return base * 2;
    if (multiplier === 'T') return base * 3;
    return null;
  };

  SP.utils.normalizeField = (input) => {
    if (input === null || input === undefined) return null;
    if (typeof input === 'number') {
      if (input === 0) return 'MISS';
      if (input === 25) return '25';
      if (input === 50) return '50';
      return null;
    }

    let text = String(input).trim().toUpperCase();
    if (!text) return null;
    text = text.replace(/\s+/g, '');

    if (['MISS', 'M', 'OUT', 'BUST'].includes(text)) return 'MISS';
    if (['25', 'SBULL', 'OUTERBULL', 'BULL25'].includes(text)) return '25';
    if (['50', 'BULL', 'DBULL', 'INNERBULL', 'BULLSEYE'].includes(text)) return '50';

    const direct = text.match(/^([SDT])(\d{1,2})$/);
    if (direct) {
      const num = Number(direct[2]);
      if (num >= 1 && num <= 20) return `${direct[1]}${num}`;
    }

    const verbose = text.match(/^(SINGLE|DOUBLE|TRIPLE)(\d{1,2})$/);
    if (verbose) {
      const map = { SINGLE: 'S', DOUBLE: 'D', TRIPLE: 'T' };
      const num = Number(verbose[2]);
      if (num >= 1 && num <= 20) return `${map[verbose[1]]}${num}`;
    }

    const xFormat = text.match(/^(\d{1,2})X([123])$/);
    if (xFormat) {
      const num = Number(xFormat[1]);
      const mult = Number(xFormat[2]);
      if (num >= 1 && num <= 20) return `${['', 'S', 'D', 'T'][mult]}${num}`;
    }

    return null;
  };

  window[globalKey] = SP;
})();
