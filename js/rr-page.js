/* Page dédiée : navigation et traduction de l’habillage ; aucun accès aux fichiers ROM. */
(() => {
  const root = document.getElementById('rr-patcher');
  const pageLinks = { gamePage: 'https://www.retrorework.com/', release: 'https://github.com/retro-rework/' };
  function translate() {
    const lang = root.getAttribute('lang') === 'en' ? 'en' : 'fr';
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-fr]').forEach(n => { n.textContent = n.getAttribute('data-' + lang); });
    const back = document.querySelector('[data-return]');
    back.href = pageLinks.gamePage;
    back.textContent = lang === 'fr' ? '← Retour à la fiche du jeu' : '← Back to the game page';
    document.querySelector('[data-release]').href = pageLinks.release;
  }
  new MutationObserver(translate).observe(root, { attributes: true, attributeFilter: ['lang'] });
  const game = new URLSearchParams(location.search).get('game');
  if (/^[a-z0-9-]+$/.test(game || '')) {
    fetch(new URL('games/' + game + '.json', document.baseURI), { cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error('config unavailable'); return r.json(); })
      .then(cfg => {
        for (const key of ['gamePage', 'release']) {
          const value = cfg.links && cfg.links[key];
          if (value && new URL(value).protocol === 'https:') pageLinks[key] = value;
        }
        translate();
      }).catch(() => { /* Le moteur présente son propre message de configuration. */ });
  }
  translate();
})();
