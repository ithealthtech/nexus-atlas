// The documentation site's script: theme, contents menu, search, copy buttons, the section you're reading, and the
// troubleshooting filter. Everything here is an extra; every page reads fine without it.
(function () {
  'use strict';

  const root = document.documentElement;

  // Theme: follows the system until someone picks one.
  const themeButton = document.querySelector('.theme');
  if (themeButton) {
    themeButton.addEventListener('click', function () {
      const dark =
        root.dataset.theme === 'dark' ||
        (!root.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
      root.dataset.theme = dark ? 'light' : 'dark';
      try {
        localStorage.setItem('atlas-docs-theme', root.dataset.theme);
      } catch {
        // Private windows may refuse storage; the choice lasts for this page.
      }
    });
  }

  // Contents menu on narrow screens.
  const toggle = document.querySelector('.menu-toggle');
  const sidebar = document.getElementById('sidebar');
  if (toggle && sidebar) {
    toggle.addEventListener('click', function () {
      const open = sidebar.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && sidebar.classList.contains('open')) {
        sidebar.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
      }
    });
  } else if (toggle) {
    toggle.hidden = true;
  }

  // Copy buttons on code blocks.
  document.querySelectorAll('.code .copy').forEach(function (button) {
    button.addEventListener('click', async function () {
      const code = button.parentElement.querySelector('code');
      try {
        await navigator.clipboard.writeText(code.textContent);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Select and copy';
      }
      window.setTimeout(function () {
        button.textContent = 'Copy';
      }, 1500);
    });
  });

  // Mark the section you're reading in "On this page".
  const tocLinks = Array.from(document.querySelectorAll('.toc a'));
  if (tocLinks.length && 'IntersectionObserver' in window) {
    const seen = new Map();
    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          seen.set(e.target.id, e.isIntersecting);
        });
        const current = tocLinks.find(function (a) {
          return seen.get(a.hash.slice(1));
        });
        if (!current) return;
        tocLinks.forEach(function (a) {
          if (a === current) a.setAttribute('aria-current', 'location');
          else a.removeAttribute('aria-current');
        });
      },
      { rootMargin: '-80px 0px -65% 0px' },
    );
    tocLinks.forEach(function (a) {
      const target = document.getElementById(a.hash.slice(1));
      if (target) observer.observe(target);
    });
  }

  // Search across the manual. The index is small, so it's fetched the first time someone types.
  const search = document.querySelector('.search');
  if (search) {
    const input = search.querySelector('input');
    const results = search.querySelector('.search-results');
    const base = search.dataset.root;
    let index = null;
    let selected = -1;

    const load = function () {
      if (!index)
        index = fetch(base + 'assets/search.json')
          .then(function (r) {
            return r.json();
          })
          .catch(function () {
            return [];
          });
      return index;
    };
    const escape = function (s) {
      return s.replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
      });
    };
    const snippet = function (text, words) {
      const lower = text.toLowerCase();
      const at = Math.max(0, lower.indexOf(words[0]) - 40);
      return (at ? '…' : '') + text.slice(at, at + 120) + (text.length > at + 120 ? '…' : '');
    };
    const show = async function () {
      const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) {
        results.hidden = true;
        return;
      }
      const all = await load();
      const scored = all
        .map(function (e) {
          const title = (e.p + ' ' + e.s).toLowerCase();
          const body = e.t.toLowerCase();
          let score = 0;
          for (const w of words) {
            if (title.includes(w)) score += 5;
            else if (body.includes(w)) score += 1;
            else return null;
          }
          return { e: e, score: score };
        })
        .filter(Boolean)
        .sort(function (a, b) {
          return b.score - a.score;
        })
        .slice(0, 8);
      selected = -1;
      results.innerHTML = scored.length
        ? scored
            .map(function (r) {
              return (
                '<a role="option" href="' +
                base +
                r.e.u +
                '#' +
                r.e.h +
                '"><strong>' +
                escape(r.e.s) +
                '</strong><span>' +
                escape(r.e.p) +
                ' · ' +
                escape(snippet(r.e.t, words)) +
                '</span></a>'
              );
            })
            .join('')
        : '<p>Nothing in the manual matches that.</p>';
      results.hidden = false;
    };
    const move = function (step) {
      const options = Array.from(results.querySelectorAll('a'));
      if (!options.length) return;
      selected = (selected + step + options.length) % options.length;
      options.forEach(function (o, i) {
        o.setAttribute('aria-selected', String(i === selected));
      });
      options[selected].scrollIntoView({ block: 'nearest' });
    };

    input.addEventListener('input', show);
    input.addEventListener('focus', load);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        move(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        move(-1);
      } else if (event.key === 'Enter') {
        const option = results.querySelectorAll('a')[selected] || results.querySelector('a');
        if (option) window.location.href = option.href;
      } else if (event.key === 'Escape') {
        input.value = '';
        results.hidden = true;
      }
    });
    document.addEventListener('click', function (event) {
      if (!search.contains(event.target)) results.hidden = true;
    });
    document.addEventListener('keydown', function (event) {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        input.focus();
      }
    });
  }

  // The troubleshooting page filters its own entries as you type.
  const filter = document.querySelector('[data-filter]');
  if (filter) {
    const sections = Array.from(document.querySelectorAll('.doc h3')).map(function (h) {
      const parts = [h];
      let n = h.nextElementSibling;
      while (n && !/^H[23]$/.test(n.tagName) && !n.classList.contains('pager')) {
        parts.push(n);
        n = n.nextElementSibling;
      }
      return parts;
    });
    const empty = document.querySelector('[data-filter-empty]');
    filter.addEventListener('input', function () {
      const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      sections.forEach(function (parts) {
        const text = parts
          .map(function (p) {
            return p.textContent;
          })
          .join(' ')
          .toLowerCase();
        const match = words.every(function (w) {
          return text.includes(w);
        });
        parts.forEach(function (p) {
          p.hidden = !match;
        });
        if (match) shown++;
      });
      if (empty) empty.hidden = shown > 0;
    });
  }
})();
