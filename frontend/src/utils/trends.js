// "What's moving": this week's headlines against the eight weeks before.
// Two lenses: the names that surge in titles (people, places, firms, acronyms) and the
// topics (the map's clusters) that rise or fade.

const WEEK = 7;
const BASE_WEEKS = 8;
const SPARK_WEEKS = 12;
const DAY = 86400000;
const ELISION = /^(?:l|d|j|s|n|qu|m|c)['’]/i;
// Capitalised words that open a phrase rather than name something
const STOP = new Set(`le la les un une des du de au aux et en pour par sur dans avec ce cette ces son sa ses
  qui que quand comment pourquoi après avant face vers entre plus où il elle ils nous vous on lors selon
  contre sous chez depuis ne pas non oui quel quelle quels quelles tout tous toute toutes voici voilà
  gabon libreville état etat gabonais gabonaise gabonaises fcfa cfa`.split(/\s+/));
const GENERIC_TOPICS = new Set(['Divers / Non-classé', 'Autres', 'Non classé']);

const day = (iso) => Date.parse(`${iso}T12:00:00Z`);
const words = (title) => title.replace(/’/g, "'").split(/[\s,;:!?.«»"()[\]/|–—]+/).filter(Boolean);
const clean = (w) => w.replace(ELISION, '').replace(/^[-']+|[-']+$/g, '');
const isCap = (w) => /^[A-ZÀ-Ý]/.test(w);

// A word is a name when the corpus rarely writes it in lower case
function nameTest(points) {
  const caps = new Map();
  const lower = new Map();
  for (const p of points) {
    for (const raw of words(p.title || '')) {
      const w = clean(raw);
      if (!w) continue;
      const k = w.toLowerCase();
      const m = isCap(w) ? caps : lower;
      m.set(k, (m.get(k) || 0) + 1);
    }
  }
  return (w) => {
    const k = w.toLowerCase();
    return (caps.get(k) || 0) > (lower.get(k) || 0);
  };
}

// Runs of capitalised words, trimmed of stop words: "Oligui Nguema", "Octobre Rose", "SEEG"
function namesIn(title, isName) {
  const out = new Map();
  let run = [];
  let ext = null;
  const flush = () => {
    while (run.length && (STOP.has(run[0].toLowerCase()) || run[0].length < 3)) run.shift();
    while (run.length && (STOP.has(run.at(-1).toLowerCase()) || run.at(-1).length < 3)) run.pop();
    if (run.length && (run.length > 1 || isName(run[0]))) {
      const label = run.join(' ');
      out.set(label.toUpperCase(), run.length === 1 && ext ? `${label} ${ext}` : label);
    }
    run = [];
    ext = null;
  };
  const ws = words(title);
  ws.forEach((raw, i) => {
    const w = clean(raw);
    if (w && isCap(w)) run.push(w);
    else {
      if (run.length === 1 && /^(de|des|du)$/i.test(raw) && ws[i + 1]) ext = `${raw} ${ws[i + 1]}`;
      else if (run.length === 1 && raw.length > 4 && !STOP.has(raw.toLowerCase())) ext = raw;
      flush();
    }
  });
  flush();
  return out;
}

const top = (m) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
// A lone word ("Cour") reads better with its usual complement ("Cour des comptes") when most titles use it
const labelOf = (t) => {
  const best = top(t.labels);
  const total = [...t.labels.values()].reduce((a, b) => a + b, 0);
  const longer = [...t.labels].filter(([l]) => l.startsWith(`${best} `)).sort((a, b) => b[1] - a[1])[0];
  return longer && longer[1] * 2.5 >= total ? longer[0] : best;
};

const byDateDesc = (a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0);

export function computeMoving(points) {
  const dated = points.filter(p => p.date && p.title);
  if (!dated.length) return null;
  const end = dated.reduce((m, p) => (p.date > m ? p.date : m), dated[0].date);
  const endT = day(end);
  const age = (p) => Math.round((endT - day(p.date)) / DAY);
  const isName = nameTest(dated);

  const recent = dated.filter(p => age(p) < WEEK).sort(byDateDesc);
  // Weeks the scrapers were down would drag "usual" towards zero: the baseline uses collected weeks only
  const perWeek = Array(SPARK_WEEKS).fill(0);
  for (const p of dated) { const w = Math.floor(age(p) / WEEK); if (w < SPARK_WEEKS) perWeek[w] += 1; }
  const covered = new Set(perWeek.map((n, w) => (w > 0 && w <= BASE_WEEKS && n >= perWeek[0] * 0.3 ? w : -1)).filter(w => w > 0));
  const baseWeeks = Math.max(covered.size, 1);
  const baseCount = [...covered].reduce((a, w) => a + perWeek[w], 0);

  // Names: weekly count now vs the average week before, with a floor so one-off mentions don't win
  const terms = new Map();
  for (const p of dated) {
    const a = age(p);
    if (a >= WEEK * (BASE_WEEKS + 1)) continue;
    for (const [key, label] of namesIn(p.title, isName)) {
      let t = terms.get(key);
      if (!t) terms.set(key, (t = { key, labels: new Map(), now: [], before: 0 }));
      if (a < WEEK) { t.now.push(p); t.labels.set(label, (t.labels.get(label) || 0) + 1); } else if (covered.has(Math.floor(a / WEEK))) t.before += 1;
    }
  }
  let names = [...terms.values()]
    .filter(t => t.now.length >= 3)
    .map(t => {
      const usual = t.before / baseWeeks;
      const sources = [...new Set(t.now.map(p => p.source))];
      return {
        label: labelOf(t),
        count: t.now.length, usual, sources,
        lift: (t.now.length + 1) / (usual + 1),
        isNew: t.before === 0,
        articles: t.now,
        ids: new Set(t.now.map(p => p.id)),
      };
    })
    .filter(t => t.lift >= 2)
    .sort((a, b) => b.lift * Math.sqrt(b.count) - a.lift * Math.sqrt(a.count));
  // "Fly" and "Fly Gabon", or a minister and their ministry, are the same story: keep the stronger
  const kept = [];
  for (const t of names) {
    const twin = kept.find(k => [...t.ids].filter(id => k.ids.has(id)).length / Math.min(t.ids.size, k.ids.size) > 0.6);
    if (twin) twin.also = [...(twin.also || []), t.label];
    else kept.push(t);
  }
  names = kept.slice(0, 9);

  // The stories every newspaper picked up this week
  const widely = [...terms.values()]
    .map(t => ({ label: labelOf(t), count: t.now.length, sources: [...new Set(t.now.map(p => p.source))], articles: t.now }))
    .filter(t => t.label && t.sources.length >= 4)
    .sort((a, b) => b.sources.length - a.sources.length || b.count - a.count)
    .slice(0, 6);

  // Topics: weekly series over twelve weeks, newest last
  const series = new Map();
  for (const p of dated) {
    const w = Math.floor(age(p) / WEEK);
    if (w >= SPARK_WEEKS || GENERIC_TOPICS.has(p.cluster_name) || !p.cluster_name) continue;
    if (!series.has(p.cluster_name)) series.set(p.cluster_name, { name: p.cluster_name, weeks: Array(SPARK_WEEKS).fill(0), articles: [] });
    const s = series.get(p.cluster_name);
    s.weeks[SPARK_WEEKS - 1 - w] += 1;
    if (w === 0) s.articles.push(p);
  }
  const topics = [...series.values()].map(s => {
    const now = s.weeks.at(-1);
    const usual = [...covered].reduce((a, w) => a + s.weeks[SPARK_WEEKS - 1 - w], 0) / baseWeeks;
    return { ...s, now, usual, change: usual ? (now - usual) / usual : null, gaps: s.weeks.map((_, i) => !covered.has(SPARK_WEEKS - 1 - i) && i < SPARK_WEEKS - 1) };
  }).filter(s => s.usual >= 2 || s.now >= 4);
  const rising = topics.filter(s => s.now >= 4 && s.change > 0.25).sort((a, b) => (b.now - b.usual) - (a.now - a.usual)).slice(0, 6);
  const fading = topics.filter(s => s.usual >= 4 && s.change < -0.4).sort((a, b) => (a.now - a.usual) - (b.now - b.usual)).slice(0, 4);

  const start = new Date(endT - (WEEK - 1) * DAY).toISOString().slice(0, 10);
  return {
    start, end,
    week: recent.length,
    usualWeek: baseCount / baseWeeks,
    sources: new Set(recent.map(p => p.source)).size,
    names, widely, rising, fading,
  };
}
