(() => {
  if (window.__STATISTIK_PLUS_BRIDGE_INSTALLED__) return;
  window.__STATISTIK_PLUS_BRIDGE_INSTALLED__ = true;

  const post = (payload) => {
    try {
      window.postMessage({
        type: 'STATISTIK_PLUS_BRIDGE_EVENT',
        payload
      }, '*');
    } catch (error) {
      console.warn('[Statistik+ bridge]', error);
    }
  };

  const tryParse = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      try {
        return JSON.parse(trimmed);
      } catch (_) {
        return null;
      }
    }
    if (typeof value === 'object') return value;
    return null;
  };

  const looksLikeJwt = (value) => typeof value === 'string'
    && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.trim());

  const decodeJwtPayload = (token) => {
    try {
      const payload = token.split('.')[1];
      if (!payload) return null;
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
      return JSON.parse(atob(padded));
    } catch (_) {
      return null;
    }
  };

  const normalizeToken = (value) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^Bearer\s+/i.test(trimmed)) return trimmed.replace(/^Bearer\s+/i, '').trim() || null;
    return trimmed;
  };

  const makeAuthState = (token, userId = null, preferredUsername = null) => {
    const safeToken = normalizeToken(token);
    const payload = looksLikeJwt(safeToken || '') ? decodeJwtPayload(safeToken) : null;
    return {
      accessToken: safeToken || null,
      userId: userId || payload?.sub || null,
      preferredUsername: preferredUsername || payload?.preferred_username || payload?.name || payload?.given_name || null,
      tokenPayload: payload || null
    };
  };

  let cachedAuthState = { accessToken: null, userId: null, preferredUsername: null, tokenPayload: null };
  let indexedDbScanPromise = null;

  const mergeAuthState = (nextState = null) => {
    if (!nextState?.accessToken) return cachedAuthState;
    cachedAuthState = {
      accessToken: nextState.accessToken || cachedAuthState.accessToken || null,
      userId: nextState.userId || cachedAuthState.userId || null,
      preferredUsername: nextState.preferredUsername || cachedAuthState.preferredUsername || null,
      tokenPayload: nextState.tokenPayload || cachedAuthState.tokenPayload || null
    };
    return cachedAuthState;
  };

  const inspectTokenContainer = (value, seen = new Set(), depth = 0) => {
    if (!value || depth > 5) return null;

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (looksLikeJwt(trimmed)) return makeAuthState(trimmed);
      const parsed = tryParse(trimmed);
      if (parsed && parsed !== value) return inspectTokenContainer(parsed, seen, depth + 1);
      return null;
    }

    if (typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);

    const directToken = value.access_token
      || value.accessToken
      || value.token
      || value.id_token
      || value.idToken
      || value.bearer
      || null;
    if (typeof directToken === 'string' && normalizeToken(directToken)) {
      return makeAuthState(
        directToken,
        value.sub || value.userId || value.user_id || value?.tokenParsed?.sub || value?.profile?.sub || null,
        value.preferred_username || value.preferredUsername || value.username || value.user?.name || value?.tokenParsed?.preferred_username || null
      );
    }

    const nestedKeys = [
      'keycloak', 'auth', 'authentication', 'oidc', 'tokenSet', 'tokens', 'user', 'profile', 'session', 'kc',
      'state', 'currentUser', 'account', 'credentials'
    ];
    for (const key of nestedKeys) {
      if (!(key in value)) continue;
      const nested = inspectTokenContainer(value[key], seen, depth + 1);
      if (nested?.accessToken) return nested;
    }

    const entries = Object.entries(value).slice(0, depth < 2 ? 100 : 30);
    for (const [, nestedValue] of entries) {
      const nested = inspectTokenContainer(nestedValue, seen, depth + 1);
      if (nested?.accessToken) return nested;
    }

    return null;
  };

  const inspectAuthPayload = (payload) => {
    const result = inspectTokenContainer(payload);
    if (result?.accessToken) mergeAuthState(result);
    return result;
  };

  const matchesAuthUrl = (url) => /openid-connect\/token|\/protocol\/openid-connect\/token/i.test(String(url || ''));

  const captureBearerFromHeaderValue = (value) => {
    const token = normalizeToken(value);
    if (!token || !looksLikeJwt(token)) return null;
    return mergeAuthState(makeAuthState(token));
  };

  const captureAuthorizationFromHeaders = (headers) => {
    try {
      if (!headers) return null;
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        return captureBearerFromHeaderValue(headers.get('authorization') || headers.get('Authorization'));
      }
      if (Array.isArray(headers)) {
        for (const entry of headers) {
          if (!Array.isArray(entry) || entry.length < 2) continue;
          if (String(entry[0]).toLowerCase() === 'authorization') {
            const result = captureBearerFromHeaderValue(entry[1]);
            if (result?.accessToken) return result;
          }
        }
        return null;
      }
      if (typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) {
          if (String(key).toLowerCase() !== 'authorization') continue;
          const result = captureBearerFromHeaderValue(value);
          if (result?.accessToken) return result;
        }
      }
    } catch (_) {
      return null;
    }
    return null;
  };

  const installLightweightAuthCapture = () => {
    if (window.__STATISTIK_PLUS_AUTH_CAPTURE_INSTALLED__) return;
    window.__STATISTIK_PLUS_AUTH_CAPTURE_INSTALLED__ = true;

    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = function statistikPlusFetchCapture(input, init) {
        try {
          if (typeof Request !== 'undefined' && input instanceof Request) {
            captureAuthorizationFromHeaders(input.headers);
          }
          captureAuthorizationFromHeaders(init?.headers);
        } catch (_) {
          // noop
        }

        const requestUrl = typeof input === 'string' ? input : input?.url;
        const promise = originalFetch.apply(this, arguments);
        if (!matchesAuthUrl(requestUrl)) return promise;

        return promise.then((response) => {
          try {
            response.clone().text().then((text) => {
              const parsed = tryParse(text);
              if (parsed) inspectAuthPayload(parsed);
            }).catch(() => {});
          } catch (_) {
            // noop
          }
          return response;
        });
      };
    }

    const XHROpen = window.XMLHttpRequest?.prototype?.open;
    const XHRSend = window.XMLHttpRequest?.prototype?.send;
    const XHRSetRequestHeader = window.XMLHttpRequest?.prototype?.setRequestHeader;

    if (typeof XHROpen === 'function' && typeof XHRSend === 'function') {
      window.XMLHttpRequest.prototype.open = function statistikPlusOpen(method, url) {
        try {
          this.__statistikPlusUrl = url;
        } catch (_) {
          // noop
        }
        return XHROpen.apply(this, arguments);
      };

      if (typeof XHRSetRequestHeader === 'function') {
        window.XMLHttpRequest.prototype.setRequestHeader = function statistikPlusSetRequestHeader(name, value) {
          try {
            if (String(name).toLowerCase() === 'authorization') {
              captureBearerFromHeaderValue(value);
            }
          } catch (_) {
            // noop
          }
          return XHRSetRequestHeader.apply(this, arguments);
        };
      }

      window.XMLHttpRequest.prototype.send = function statistikPlusSend() {
        try {
          this.addEventListener('readystatechange', function onReadyStateChange() {
            try {
              if (this.readyState !== 4) return;
              if (!matchesAuthUrl(this.__statistikPlusUrl)) return;
              const parsed = tryParse(this.responseText);
              if (parsed) inspectAuthPayload(parsed);
            } catch (_) {
              // noop
            }
          }, { once: true });
        } catch (_) {
          // noop
        }
        return XHRSend.apply(this, arguments);
      };
    }
  };

  const collectStorageCandidates = (storage) => {
    const candidates = [];
    if (!storage) return candidates;
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key) continue;
        const raw = storage.getItem(key);
        if (!raw) continue;
        candidates.push({ key, raw, parsed: tryParse(raw) });
      }
    } catch (_) {
      return candidates;
    }
    return candidates;
  };

  const readIdbStore = (db, storeName) => new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      request.onerror = () => resolve([]);
      tx.onabort = () => resolve([]);
    } catch (_) {
      resolve([]);
    }
  });

  const scanIndexedDbForAuth = async () => {
    if (cachedAuthState?.accessToken) return cachedAuthState;
    if (indexedDbScanPromise) return indexedDbScanPromise;

    indexedDbScanPromise = (async () => {
      try {
        if (!indexedDB || typeof indexedDB.databases !== 'function') return cachedAuthState;
        const dbs = await indexedDB.databases();
        for (const info of dbs || []) {
          if (!info?.name) continue;
          const db = await new Promise((resolve) => {
            try {
              const openRequest = indexedDB.open(info.name);
              openRequest.onsuccess = () => resolve(openRequest.result || null);
              openRequest.onerror = () => resolve(null);
              openRequest.onblocked = () => resolve(null);
            } catch (_) {
              resolve(null);
            }
          });
          if (!db) continue;
          try {
            const storeNames = Array.from(db.objectStoreNames || []).slice(0, 20);
            for (const storeName of storeNames) {
              const rows = await readIdbStore(db, storeName);
              for (const row of rows.slice(0, 200)) {
                const result = inspectTokenContainer(row);
                if (result?.accessToken) {
                  mergeAuthState(result);
                  db.close();
                  return cachedAuthState;
                }
              }
            }
          } finally {
            try { db.close(); } catch (_) { /* noop */ }
          }
        }
      } catch (_) {
        // noop
      } finally {
        indexedDbScanPromise = null;
      }
      return cachedAuthState;
    })();

    return indexedDbScanPromise;
  };

  const getAuthStateSync = () => {
    if (cachedAuthState?.accessToken) return cachedAuthState;

    const directCandidates = [
      window.keycloak,
      window.Keycloak,
      window.__keycloak,
      window.auth,
      window.__auth,
      window.__AUTH__,
      window.__oidc,
      window.__kc,
      window.kc
    ];
    for (const candidate of directCandidates) {
      const result = inspectTokenContainer(candidate);
      if (result?.accessToken) return mergeAuthState(result);
    }

    try {
      const windowKeys = Object.keys(window)
        .filter((key) => /keycloak|auth|oidc|token|session/i.test(key))
        .slice(0, 80);
      for (const key of windowKeys) {
        const result = inspectTokenContainer(window[key]);
        if (result?.accessToken) return mergeAuthState(result);
      }
    } catch (_) {
      // noop
    }

    const storageCandidates = [
      ...collectStorageCandidates(window.localStorage),
      ...collectStorageCandidates(window.sessionStorage)
    ];
    for (const entry of storageCandidates) {
      const result = inspectTokenContainer(entry.parsed || entry.raw);
      if (result?.accessToken) return mergeAuthState(result);
    }

    return cachedAuthState;
  };

  const getAuthState = async () => {
    const sync = getAuthStateSync();
    if (sync?.accessToken) return sync;
    return scanIndexedDbForAuth();
  };

  installLightweightAuthCapture();
  inspectAuthPayload(getAuthStateSync());
  window.setTimeout(() => { getAuthState().catch(() => {}); }, 0);

  window.addEventListener('message', (event) => {
    const payload = event?.data;
    if (!payload || payload.type !== 'STATISTIK_PLUS_BRIDGE_COMMAND') return;
    const { requestId, command, args = {} } = payload;
    if (!requestId || !command) return;

    const respond = (response) => {
      post({
        channel: 'bridge:response',
        requestId,
        ok: !response?.error,
        data: response?.data ?? null,
        error: response?.error || null,
        ts: new Date().toISOString()
      });
    };

    if (command === 'getAuthState') {
      getAuthState()
        .then((data) => respond({ data }))
        .catch((error) => respond({ error: error?.message || 'Auth lookup failed' }));
      return;
    }

    if (command === 'fetchJson') {
      const url = args?.url;
      const init = args?.init || {};
      if (!url) {
        respond({ error: 'Missing url' });
        return;
      }

      captureAuthorizationFromHeaders(init?.headers);
      window.fetch(url, init)
        .then(async (response) => {
          const text = await response.text();
          const parsed = tryParse(text);
          if (!response.ok) {
            respond({ error: `HTTP ${response.status}`, data: parsed });
            return;
          }
          respond({ data: parsed });
        })
        .catch((error) => respond({ error: error?.message || 'Fetch failed' }));
    }
  });
})();
