(() => {
  if (window.__STATISTIK_PLUS_BOOTSTRAPPED__) return;
  window.__STATISTIK_PLUS_BOOTSTRAPPED__ = true;

  const inject = () => {
    if (window.__STATISTIK_PLUS_BRIDGE_INSTALLED__ || document.querySelector('script[data-sp-boot-bridge="true"]')) {
      return;
    }
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('src/page-bridge.js');
      script.async = false;
      script.dataset.spBootBridge = 'true';
      script.onload = () => script.remove();
      script.onerror = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch (error) {
      console.warn('[Statistik+ boot]', error);
    }
  };

  if (document.readyState === 'loading') {
    inject();
    document.addEventListener('readystatechange', () => {
      if (document.readyState !== 'loading') inject();
    }, { once: true });
  } else {
    inject();
  }
})();
