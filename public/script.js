(function () {
  const countEl = document.getElementById('count');
  const panelEl = document.getElementById('panel');
  const twitchWrap = document.getElementById('twitchWrap');
  const kickWrap = document.getElementById('kickWrap');

  const REFRESH_INTERVAL_MS = 5000;
  const ANIMATION_DURATION_MS = 700;

  let currentValue = 0;
  let animationFrame = null;
  let glowTimeout = null;
  let isOffline = false;

  function formatNumber(n) {
    return Math.round(n).toLocaleString('en-US');
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function setIconVisibility(wrapEl, visible) {
    if (visible) {
      wrapEl.classList.remove('hidden');
    } else {
      wrapEl.classList.add('hidden');
    }
  }

  function showOffline() {
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
    isOffline = true;
    currentValue = 0;
    panelEl.classList.remove('glow-up', 'glow-down');
    countEl.classList.remove('glow-up', 'glow-down');
    countEl.classList.add('offline');
    countEl.textContent = 'OFFLINE';
  }

  function clearOfflineState() {
    if (isOffline) {
      isOffline = false;
      countEl.classList.remove('offline');
    }
  }

  function animateTo(targetValue) {
    if (targetValue === currentValue) {
      countEl.textContent = formatNumber(currentValue);
      return;
    }

    const startValue = currentValue;
    const delta = targetValue - startValue;
    const startTime = performance.now();

    const direction = delta > 0 ? 'up' : 'down';
    triggerGlow(direction);

    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
    }

    function step(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / ANIMATION_DURATION_MS, 1);
      const eased = easeOutCubic(progress);
      const value = startValue + delta * eased;

      countEl.textContent = formatNumber(value);

      if (progress < 1) {
        animationFrame = requestAnimationFrame(step);
      } else {
        countEl.textContent = formatNumber(targetValue);
        currentValue = targetValue;
        animationFrame = null;
      }
    }

    animationFrame = requestAnimationFrame(step);
  }

  function triggerGlow(direction) {
    const glowClass = direction === 'up' ? 'glow-up' : 'glow-down';
    const otherClass = direction === 'up' ? 'glow-down' : 'glow-up';

    panelEl.classList.remove(otherClass);
    countEl.classList.remove(otherClass);

    panelEl.classList.add(glowClass);
    countEl.classList.add(glowClass);

    if (glowTimeout) {
      clearTimeout(glowTimeout);
    }

    glowTimeout = setTimeout(() => {
      panelEl.classList.remove('glow-up', 'glow-down');
      countEl.classList.remove('glow-up', 'glow-down');
    }, 1200);
  }

  async function fetchViewers() {
    try {
      const res = await fetch('/api/viewers', { cache: 'no-store' });
      if (!res.ok) return;

      const data = await res.json();

      const twitchLive = Boolean(data.twitchLive);
      const kickLive = Boolean(data.kickLive);
      const total = typeof data.total === 'number' ? data.total : 0;

      setIconVisibility(twitchWrap, twitchLive);
      setIconVisibility(kickWrap, kickLive);

      if (!twitchLive && !kickLive) {
        showOffline();
        return;
      }

      clearOfflineState();
      animateTo(total);
    } catch (err) {
      // Fail silently to avoid disrupting the overlay in OBS
    }
  }

  // Initial load
  fetchViewers();

  // Poll every 5 seconds
  setInterval(fetchViewers, REFRESH_INTERVAL_MS);
})();
