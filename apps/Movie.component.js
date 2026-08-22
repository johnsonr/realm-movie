// Movie card — a Tier-2 component shipped in the pack, beside the Movie type.
// Loaded by /apps/entities.html when an entity's type is "Movie". Uses the shared
// fragment helper (config/apps/entity-card.js); no framework.
//
// Contract:
//   default — the visual (HTML fragment + scoped styles + bind hook).
//   actions(entity) -> EntityAction[] — Movie's OWN affordances. Movie is a
//       pack/JS type, so its actions live HERE, not in the JVM. They dispatch
//       through the same gateway the host already calls: navigate (a url), chat
//       (a question), or tool (POST /api/v1/tools/<name> — a pack gateway method).
//
// Movie.fields: title, year, genre, director, runtimeMinutes, imdbId.

import { cardComponent } from '/apps/world/entity-card.js';

const styles = `
  .movie{display:flex;flex-direction:column;gap:9px;font-family:'Inter',system-ui,sans-serif;}
  .movie-top{display:flex;gap:12px;align-items:flex-start;}
  .movie-poster{position:relative;width:46px;height:64px;flex:0 0 auto;border-radius:6px;display:flex;align-items:center;
    justify-content:center;font-size:16px;text-decoration:none;color:#d8b27a;overflow:hidden;
    border:1px solid rgba(216,178,122,.35);background:linear-gradient(160deg,rgba(216,178,122,.18),rgba(216,178,122,.04));}
  .movie-poster img{width:100%;height:100%;object-fit:cover;display:block;}
  .movie-play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    color:#fff;font-size:16px;background:rgba(0,0,0,.28);opacity:0;transition:opacity .15s;}
  .movie-poster:hover .movie-play{opacity:1;}
  .movie-title{font-size:16px;font-weight:600;color:#fff;line-height:1.15;}
  .movie-sub{font-family:'JetBrains Mono',monospace;font-size:11px;color:#d8b27a;margin-top:3px;letter-spacing:.04em;}
  .movie-genres{display:flex;flex-wrap:wrap;gap:5px;}
  .movie-genre{font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#d8b27a;
    background:rgba(216,178,122,.10);border:1px solid rgba(216,178,122,.28);border-radius:999px;padding:2px 7px;}
  .movie-meta{font-size:12.5px;color:#b9b3a3;}
  .movie-meta b{color:#f4f4f4;font-weight:500;}
  .mr-wrap{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px;}
  .mr-stars{display:inline-flex;gap:1px;}
  .mr-star{cursor:pointer;color:#3a3a44;font-size:16px;line-height:1;transition:color .1s;}
  .mr-star.mr-on{color:#d8b27a;}
  .mr-label{font-family:'JetBrains Mono',monospace;font-size:11px;color:#8b8b96;min-width:34px;}
  .mr-note-toggle{background:none;border:0;color:#63c0f5;font-size:11px;cursor:pointer;padding:0;}
  .mr-note{width:100%;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);
    border-radius:6px;color:#f4f4f4;font-size:12px;padding:5px 8px;margin-top:4px;font-family:inherit;}
`;

// A 1–10 star rating with a reveal-on-demand note. Recording a rating IS making
// the link: create_entry against MovieRating auto-emits (User)-[:RATED]->… and
// upserts by imdbId (a re-rate updates in place). Same gateway op the Movie.rate
// pack method uses.
function buildRating(host, imdbId, title, gw) {
  let current = 0, noteVal = '', me = null;
  const wrap = document.createElement('div'); wrap.className = 'mr-wrap';
  const stars = document.createElement('div'); stars.className = 'mr-stars';
  const label = document.createElement('span'); label.className = 'mr-label';
  const starEls = [];
  const paint = (n) => { starEls.forEach((s, i) => s.classList.toggle('mr-on', i < n)); label.textContent = n ? n + '/10' : 'Rate'; };
  // The current user's own Person id + name — the rater for a rating made from this card.
  const currentUser = async () => {
    if (me) return me;
    const res = await gw.kg.query({ cypher: 'MATCH (u:AssistantUser) RETURN u.id AS id, u.name AS name LIMIT 1', params: JSON.stringify({}) });
    const rows = (res && res.rows) ? res.rows : (res || []);
    me = rows[0] || {};
    return me;
  };
  const submit = async (n) => {
    current = n; paint(n); label.textContent = 'Saving…';
    try {
      const u = await currentUser();
      const raterId = u.id || '';
      await gw.repository.createEntry({
        type: 'MovieRating',
        data: {
          ratingKey: raterId + '::' + imdbId,
          raterId, raterName: u.name,
          imdbId, title, rating: n,
          watchedOn: new Date().toISOString().slice(0, 10), notes: noteVal || undefined,
        },
      });
      label.textContent = 'Rated ' + n + '/10 ✓';
    } catch (e) { label.textContent = 'Failed: ' + (e && e.message); }
  };
  for (let i = 1; i <= 10; i++) {
    const s = document.createElement('span'); s.className = 'mr-star'; s.textContent = '★';
    s.onmouseenter = () => paint(i);
    s.onclick = () => submit(i);
    stars.appendChild(s); starEls.push(s);
  }
  stars.onmouseleave = () => paint(current);
  wrap.appendChild(stars); wrap.appendChild(label);

  const noteToggle = document.createElement('button'); noteToggle.className = 'mr-note-toggle'; noteToggle.textContent = '+ note';
  const noteInput = document.createElement('input'); noteInput.className = 'mr-note'; noteInput.placeholder = 'one-line reaction'; noteInput.style.display = 'none';
  noteToggle.onclick = () => { const show = noteInput.style.display === 'none'; noteInput.style.display = show ? 'block' : 'none'; if (show) noteInput.focus(); };
  noteInput.oninput = () => { noteVal = noteInput.value; };
  wrap.appendChild(noteToggle); host.appendChild(wrap); host.appendChild(noteInput);
  paint(0);

  // Pre-fill the user's existing rating so re-rating starts where they left off.
  gw.kg.query({
    cypher: 'MATCH (au:AssistantUser)-[:RATED]->(r:MovieRating) WHERE r.imdbId = $id RETURN r.rating AS rating, r.notes AS notes LIMIT 1',
    params: JSON.stringify({ id: imdbId }),
  }).then((rows) => {
    const row = rows && rows[0];
    if (row && row.rating) {
      current = Number(row.rating); paint(current);
      if (row.notes) { noteVal = String(row.notes); noteInput.value = noteVal; }
    }
  }).catch(() => {});
}

export default await cardComponent({
  fragmentUrl: '/apps/movie/Movie.tpl',
  styles,
  bind(root, entity, f) {
    const title = f.title || f.Title || entity.name || 'Untitled';
    const imdbId = f.imdbId || f.imdbID;

    // The poster area links to the trailer and shows the real poster. Both come
    // from the gateway (the path vibe-coded apps use) — `gateway.omdb.getMovie`
    // for the poster, `gateway.streamingAvailability.getShow` for the trailer
    // videoLink. These are exactly what the Movie type's `details`/`streaming`
    // methods wrap. Starts as a ▶ → IMDb fallback; upgrades when the gateway answers.
    const poster = root.querySelector('[data-poster]');
    poster.textContent = '▶';
    if (imdbId) poster.setAttribute('href', `https://www.imdb.com/title/${imdbId}/`);
    poster.setAttribute('title', title);

    const gw = window.gateway;
    if (gw && imdbId) {
      gw.omdb.getMovie({ i: imdbId, plot: 'short' }).then((d) => {
        if (d && d.Poster && d.Poster !== 'N/A') {
          poster.textContent = '';
          const img = document.createElement('img'); img.src = d.Poster; img.alt = title; poster.appendChild(img);
          const play = document.createElement('span'); play.className = 'movie-play'; play.textContent = '▶'; poster.appendChild(play);
        }
      }).catch(() => {});
      gw.streamingAvailability.getShow({ id: imdbId, country: 'us' }).then((show) => {
        const opts = (show && show.streamingOptions) ? Object.values(show.streamingOptions).flat() : [];
        const trailer = opts.find((o) => o && o.videoLink);
        if (trailer) { poster.setAttribute('href', trailer.videoLink); poster.setAttribute('title', `Watch ${title} trailer`); }
      }).catch(() => {});
    }

    root.querySelector('[data-title]').textContent = title;

    const bits = [];
    if (f.year) bits.push(String(f.year));
    if (f.runtimeMinutes) bits.push(String(f.runtimeMinutes).replace(/\s*min$/i, '') + ' min');
    const sub = root.querySelector('[data-sub]');
    if (bits.length) sub.textContent = bits.join('  ·  '); else sub.remove();

    const genres = root.querySelector('[data-genres]');
    const list = f.genre ? String(f.genre).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 4) : [];
    if (list.length) {
      list.forEach((name) => { const c = document.createElement('span'); c.className = 'movie-genre'; c.textContent = name; genres.appendChild(c); });
    } else genres.remove();

    const dir = root.querySelector('[data-director]');
    if (f.director) {
      const label = document.createElement('span'); label.textContent = 'Director: ';
      const b = document.createElement('b'); b.textContent = String(f.director);
      dir.appendChild(label); dir.appendChild(b);
    } else dir.remove();

    const rateEl = root.querySelector('[data-rate]');
    if (rateEl && imdbId && window.gateway && window.gateway.repository) buildRating(rateEl, imdbId, title, window.gateway);
    else if (rateEl) rateEl.remove();
  },
});

// No `actions` export: Movie's affordances are the gateway-driven poster/trailer
// above (omdb / streamingAvailability) and any gateway methods on the type, which
// the host renders generically from methods.json. No bespoke action paths.
