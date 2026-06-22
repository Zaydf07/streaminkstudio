(function(){
  const STORAGE_KEY = 'StreamInk_AppTheme';
  const OLD_SOCIAL_KEY = 'StreamInk_SocialEditor_Theme';

  function getStoredTheme(){
    try {
      return localStorage.getItem(STORAGE_KEY) || localStorage.getItem(OLD_SOCIAL_KEY) || 'light';
    } catch (e) {
      return 'light';
    }
  }

  function setTheme(theme){
    const next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.uiTheme = next;
    if (document.body) document.body.dataset.uiTheme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
      localStorage.setItem(OLD_SOCIAL_KEY, next);
    } catch (e) {}
    document.querySelectorAll('[data-theme-choice]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.themeChoice === next);
      btn.setAttribute('aria-pressed', String(btn.dataset.themeChoice === next));
    });
  }

  function buildSwitch(inline){
    const wrap = document.createElement('div');
    wrap.className = inline ? 'app-theme-switch is-inline' : 'app-theme-switch';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'App theme');
    wrap.innerHTML = [
      '<button type="button" class="app-theme-option" data-theme-choice="light">Light</button>',
      '<button type="button" class="app-theme-option" data-theme-choice="dark">Dark</button>'
    ].join('');
    wrap.addEventListener('click', event => {
      const btn = event.target.closest('[data-theme-choice]');
      if (btn) setTheme(btn.dataset.themeChoice);
    });
    return wrap;
  }

  function init(){
    const existing = document.querySelector('.sp-theme-toggle,[data-app-theme-switch]');
    if (existing) {
      existing.querySelectorAll('[data-theme-choice]').forEach(btn => {
        btn.addEventListener('click', () => setTheme(btn.dataset.themeChoice));
      });
    } else {
      document.body.appendChild(buildSwitch(false));
    }
    setTheme(getStoredTheme());
  }

  setTheme(getStoredTheme());
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  window.StreamInkTheme = { set: setTheme, get: getStoredTheme };
})();
