import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Plotly from 'plotly.js-dist-min';
import {
  Landmark, TrendingUp, Users, Scale, Trophy, MapPin, Palette, Leaf, Building2, Globe, HeartPulse, GraduationCap, Package, Star, X, Flame, BellOff,
} from 'lucide-react';
import { API_URL } from '../utils/api';
import { sourceLabel } from '../utils/format';
import { normalizeCategory, titleWords, titlePhrases, computeFollowDeltas, PROFILE_COLORS, PROFILE_OTHER, PROFILE_OTHER_COLOR } from '../utils/categories';

// ── Custom Treemap Algorithm using Squarify approach ───────────────────────
function computeTreemap(data, width, height) {
  let result = [];
  function recurse(items, rx, ry, rw, rh) {
    if (items.length === 0) return;
    if (items.length === 1 || rw <= 0 || rh <= 0) {
      if (items.length > 0) result.push({ ...items[0], x: rx, y: ry, width: rw, height: rh });
      return;
    }
    const total = items.reduce((s, i) => s + i.value, 0);
    let half = total / 2, sum = 0, splitIdx = 0;
    for (let i = 0; i < items.length - 1; i++) {
      sum += items[i].value;
      if (sum >= half) { splitIdx = i; break; }
    }
    const c1 = items.slice(0, splitIdx + 1);
    const c2 = items.slice(splitIdx + 1);
    const sum1 = c1.reduce((s, i) => s + i.value, 0);
    const ratio = total > 0 ? sum1 / total : 0.5;
    
    if (rw > rh) { // split horizontally
      const lw = rw * ratio;
      recurse(c1, rx, ry, lw, rh);
      recurse(c2, rx + lw, ry, rw - lw, rh);
    } else { // split vertically
      const lh = rh * ratio;
      recurse(c1, rx, ry, rw, lh);
      recurse(c2, rx, ry + lh, rw, rh - lh);
    }
  }
  // Sort descending by value
  recurse([...data].sort((a,b) => b.value - a.value), 0, 0, width, height);
  return result;
}

// A rank heatmap, not a line chart: after two rounds a bump chart's crossing
// lines were still the problem, and crossing lines are inherent to that
// form once several words trade ranks often — no amount of smoothing or
// curve-fitting removes the spaghetti, only fewer crossings does. A grid
// has no lines to cross: one row per word (always legible, no legend to
// decode), one cell per bucket, shaded by that bucket's rank. Color here is
// sequential (one hue, light-to-dark by rank), not categorical, so this
// also sidesteps the whole "how many distinct hues can a reader track"
// ceiling entirely — rows can scale well past 10 without any color cost.
function TrendHeatmapStrip({ ranks, buckets, rankCap }) {
  return (
    <div className="trend-heatmap-strip">
      {ranks.map((r, i) => {
        const intensity = r === null ? 0 : 1 - (r - 1) / Math.max(rankCap - 1, 1);
        return (
          <div
            key={i}
            className="trend-heatmap-cell"
            style={r !== null ? { opacity: 0.16 + intensity * 0.8 } : undefined}
            title={r !== null ? `${buckets[i]} — #${r}` : `${buckets[i]} — hors top 10`}
          />
        );
      })}
    </div>
  );
}

function CustomTreemap({ data, total, categories, isFollowed, toggleFollow, onAskAssistant }) {
  const containerRef = useRef(null);
  const [dims, setDims] = useState({ width: 0, height: 0 });
  const [activeCategory, setActiveCategory] = useState(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(entries => {
      if (entries[0]) setDims({ width: entries[0].contentRect.width, height: entries[0].contentRect.height });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const catIcons = {
    'Politique': Landmark, 'Économie': TrendingUp, 'Société': Users, 
    'Faits Divers / Justice': Scale, 'Sport': Trophy, 'Provinces': MapPin,
    'Culture': Palette, 'Environnement': Leaf, 'Administration': Building2,
    'Afrique': Globe, 'Santé': HeartPulse, 'Éducation': GraduationCap, 'Monde': Globe,
    'Faits-divers': Scale, 'International': Globe, 'Nécrologie': Package, 'Autres': Package
  };

  const layout = useMemo(() => {
    if (!dims.width || !dims.height || !data || data.length === 0) return [];
    return computeTreemap(data.map((d, i) => ({ name: d[0], value: d[1], index: i })), dims.width, dims.height);
  }, [data, dims.width, dims.height]);

  return (
    <div ref={containerRef} className="custom-treemap-container">
      {layout.map(item => {
        const IconComp = catIcons[item.name] || Package;
        const colorIdx = data.findIndex(d => d[0] === item.name);
        // Single-hue sequential ramp on the brand's deep green: larger
        // themes read darker. Lightness is capped so white labels keep contrast.
        const rankT = data.length > 1 ? colorIdx / (data.length - 1) : 0;
        const color = `hsl(${163 - rankT * 18}, ${30 - rankT * 10}%, ${24 + rankT * 20}%)`;
        const pct = ((item.value / total) * 100).toFixed(1);

        const isActive = activeCategory === item.name;
        
        let breakdownNodes = null;
        if (isActive && categories && categories[item.name]) {
          const srcData = Object.entries(categories[item.name])
            .sort((a,b) => b[1] - a[1]);
          // "Autres" is a mixed catch-all bucket (everything outside the top
          // 12), not a stable normalizeCategory() value — following it
          // wouldn't match anything meaningful in the delta computation
          const followableTheme = item.name !== 'Autres';
          const themeFollowed = followableTheme && isFollowed('theme', item.name);
          breakdownNodes = (
            <div className="custom-treemap-breakdown">
              <div className="breakdown-title-row">
                <span className="breakdown-title">{item.name} par Source</span>
                {followableTheme && (
                  <button
                    className={`follow-toggle on-dark ${themeFollowed ? 'active' : ''}`}
                    onClick={(e) => { e.stopPropagation(); toggleFollow('theme', item.name, item.name); }}
                    title={themeFollowed ? `Ne plus suivre ${item.name}` : `Suivre ${item.name}`}
                    aria-pressed={themeFollowed}
                  >
                    <Star size={13} /> {themeFollowed ? 'Suivi' : 'Suivre'}
                  </button>
                )}
                <button
                  className="follow-toggle on-dark ask-pill"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAskAssistant(`Que disent les articles récents sur le thème ${item.name} ?`);
                  }}
                  title={`Demander à l'assistant : ${item.name}`}
                >
                  Demander à l'assistant →
                </button>
              </div>
              <div className="breakdown-list">
                {srcData.map(([src, count]) => {
                  const srcPct = ((count / item.value) * 100).toFixed(1);
                  return (
                    <div key={src} className="breakdown-row">
                      <span className="breakdown-src">{sourceLabel(src)}</span>
                      <span className="breakdown-pct">{srcPct}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        }

        return (
          <div key={item.name} 
            className={`custom-treemap-box ${isActive ? 'active' : ''}`}
            onClick={() => setActiveCategory(isActive ? null : item.name)}
            style={{ 
              left: isActive ? '0px' : `${item.x}px`, top: isActive ? '0px' : `${item.y}px`, 
              width: isActive ? '100%' : `${item.width}px`, height: isActive ? '100%' : `${item.height}px`,
              backgroundColor: color 
            }}>
            
            {isActive ? breakdownNodes : (
              <div className="custom-treemap-content">
                {item.width > 60 && item.height > 60 && (
                   <IconComp className="custom-treemap-icon" size={Math.min(item.width, item.height) * 0.25} />
                )}
                {/* Below these sizes labels truncate unreadably ("vironnem"):
                    small cells stay blank, the hover overlay carries the info */}
                {item.height > 35 && item.width > 90 && (
                  <div className="custom-treemap-text">
                    <span className="custom-treemap-name">{item.name}</span>
                    {item.height > 75 && item.width > 110 && (
                      <span className="custom-treemap-meta">{item.value} art. ({pct}%)</span>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Hover overlay via CSS (hidden when active) */}
            {!isActive && (
              <div className="custom-treemap-hover">
                <span className="hover-name">{item.name}</span>
                <span className="hover-val">{item.value} articles ({pct}%)</span>
                <span className="hover-hint">Cliquer pour voir les sources</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const FOLLOWS_KEY = 'lekiosque_follows';
const LAST_VISIT_KEY = 'lekiosque_stats_last_seen_date';

export default function MetricsDashboard({ data, gabonToday, onAskAssistant, user, authToken }) {
  const trendChartRef = useRef(null);
  const sourceDonutRef = useRef(null);
  const profileChartRef = useRef(null);

  // Followed keywords/sources/thèmes — persisted so the "since your last
  // visit" strip below has something to diff against on the next visit.
  // localStorage stays the baseline (works logged-out); once signed in, the
  // server becomes the source of truth and any local-only follows (e.g.
  // picked before creating an account) are migrated up on the first mount
  // after login rather than silently dropped.
  const [follows, setFollows] = useState(() => {
    try { return JSON.parse(localStorage.getItem(FOLLOWS_KEY) || '[]'); } catch { return []; }
  });
  useEffect(() => {
    localStorage.setItem(FOLLOWS_KEY, JSON.stringify(follows));
  }, [follows]);
  const migratedRef = useRef(false);
  useEffect(() => {
    if (!user || !authToken || migratedRef.current) return;
    migratedRef.current = true;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/follows`, { headers: { Authorization: `Bearer ${authToken}` } });
        const serverFollows = res.ok ? await res.json() : [];
        const localOnly = follows.filter(f => !serverFollows.some(sf => sf.type === f.type && sf.value === f.value));
        await Promise.all(localOnly.map(f => fetch(`${API_URL}/follows`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify(f),
        }).catch(() => {})));
        setFollows([...serverFollows, ...localOnly]);
      } catch { /* stay on the local list if the sync itself fails */ }
    })();
  }, [user, authToken]);

  const isFollowed = useCallback(
    (type, value) => follows.some(f => f.type === type && f.value === value),
    [follows]
  );
  const toggleFollow = useCallback((type, value, label) => {
    const existed = follows.some(f => f.type === type && f.value === value);
    setFollows(prev => existed
      ? prev.filter(f => !(f.type === type && f.value === value))
      : [...prev, { type, value, label }]);
    if (user && authToken) {
      if (existed) {
        fetch(`${API_URL}/follows?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` },
        }).catch(() => {});
      } else {
        fetch(`${API_URL}/follows`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ type, value, label }),
        }).catch(() => {});
      }
    }
  }, [follows, user, authToken]);
  // Snapshot the *previous* visit's date once per mount, before this visit
  // overwrites it below — same "mark as seen on open" pattern as the report
  // archive badge, anchored on the corpus's own latest article date (not the
  // visitor's device clock) so it stays correct across timezones/misconfig
  const [lastSeenDate] = useState(() => localStorage.getItem(LAST_VISIT_KEY));

  // Phones default to a readable window (90 days, weekly); desktop shows all
  const [granularity, setGranularity] = useState(() => window.innerWidth <= 768 ? 'week' : 'day');
  const [trendRange, setTrendRange] = useState(() => window.innerWidth <= 768 ? '90' : 'all');

  const stats = useMemo(() => {
    if (!data || !data.points) return null;
    const sources = {};
    const timeSeries = {}; // keys will be days or mondays
    const categories = {}; // { cat: { source: count } }

    const getMonday = (dStr) => {
      const d = new Date(dStr);
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      return new Date(d.setDate(diff)).toISOString().split('T')[0];
    };

    try {
      data.points.forEach(pt => {
        if (!pt.source) return;

        // Total by source
        sources[pt.source] = (sources[pt.source] || 0) + 1;

        // Time trend
        if (pt.date) {
          const timeKey = granularity === 'week' ? getMonday(pt.date) : pt.date;
          if (!timeSeries[timeKey]) timeSeries[timeKey] = {};
          timeSeries[timeKey][pt.source] = (timeSeries[timeKey][pt.source] || 0) + 1;
        }

        // Category distribution
        const cat = normalizeCategory(pt.category, pt.source);
        if (!categories[cat]) categories[cat] = {};
        categories[cat][pt.source] = (categories[cat][pt.source] || 0) + 1;
      });

      // The corpus starts in December 2025; the trickle of older articles
      // (long archive tails of some sources) makes a misleading flat prefix
      const TREND_START = '2025-12-01';
      const sortedTimeKeys = Object.keys(timeSeries).filter(k => k >= TREND_START).sort();
      const sourcesList = Object.keys(sources);
      // Fixed per-entity palette, 13 validated categorical hues. The order below
      // (descending source volume) passes the CVD/normal-vision adjacency checks;
      // the tightest pairs sit in the 6–8 CVD band, acceptable because every view
      // carries direct labels. New sources beyond these fold into "Autres".
      const colors = {
        gabonmediatime:    '#23805C',
        gabonreview:       '#3A6FB8',
        lunion:            '#D0703A',
        focusgroupemedia:  '#9E4A8C',
        gabonactu:         '#C99A2A',
        directinfosgabon:  '#5752B0',
        '7joursinfo':      '#1EA39B',
        insidenews241:     '#C9434A',
        depeches241:       '#2E6F8E',
        gabonallsport:     '#8A6A43',
        kongossanews:      '#7A5AA0',
        gabonquotidien:    '#6B7F22',
        ethiquemediagabon: '#B0476E',
      };
      const OTHER_COLOR = '#6B7A89';
      const OTHER_LABEL = 'Autres';
      const mainSources = Object.keys(colors).filter(s => sources[s]);
      const tailSources = sourcesList.filter(s => !colors[s]);

      // KPI calculations
      const dates = data.points.map(p => p.date).filter(Boolean).sort();
      const dateMin = dates[0] || '—';
      const dateMax = dates[dates.length - 1] || '—';
      const uniqueDays = new Set(dates).size;
      const avgPerDay = uniqueDays > 0 ? (data.points.length / uniqueDays).toFixed(1) : 0;
      const totalCategories = Object.keys(categories).length;
      const topSource = Object.entries(sources).sort((a, b) => b[1] - a[1])[0];
      // Catch-all buckets are not themes: they must not win "Thème #1"
      const NON_THEMES = new Set(['Non classé', 'Autres', 'Autres / non classé']);
      const topCategory = Object.entries(categories)
        .filter(([cat]) => !NON_THEMES.has(cat))
        .map(([cat, srcMap]) => [cat, Object.values(srcMap).reduce((s, v) => s + v, 0)])
        .sort((a, b) => b[1] - a[1])[0];

      // Busiest day of week
      const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
      const dayCounts = [0, 0, 0, 0, 0, 0, 0];
      dates.forEach(d => { try { dayCounts[new Date(d).getDay()]++; } catch { /* unparsable date: skipped */ } });
      // Busiest by average per occurrence (computed below), not raw totals
      let busiestDay = dayNames[dayCounts.indexOf(Math.max(...dayCounts))];

      // Week-over-week trend
      const now = new Date();
      const oneWeekAgo = new Date(now); oneWeekAgo.setDate(now.getDate() - 7);
      const twoWeeksAgo = new Date(now); twoWeeksAgo.setDate(now.getDate() - 14);
      const thisWeekStr = oneWeekAgo.toISOString().split('T')[0];
      const lastWeekStr = twoWeeksAgo.toISOString().split('T')[0];
      const nowStr = now.toISOString().split('T')[0];
      const thisWeekCount = dates.filter(d => d >= thisWeekStr && d <= nowStr).length;
      const lastWeekCount = dates.filter(d => d >= lastWeekStr && d < thisWeekStr).length;
      const weekTrend = lastWeekCount > 0 ? (((thisWeekCount - lastWeekCount) / lastWeekCount) * 100).toFixed(0) : 0;

      // Record day (single day with most articles)
      const dayArticleCounts = {};
      dates.forEach(d => { dayArticleCounts[d] = (dayArticleCounts[d] || 0) + 1; });
      const recordDay = Object.entries(dayArticleCounts).sort((a, b) => b[1] - a[1])[0] || ['—', 0];

      // Source freshness — latest article date per source
      const sourceFreshness = {};
      data.points.forEach(pt => {
        if (!pt.source || !pt.date) return;
        if (!sourceFreshness[pt.source] || pt.date > sourceFreshness[pt.source]) {
          sourceFreshness[pt.source] = pt.date;
        }
      });


      // Day-of-week heatmap data — average per weekday occurrence, not totals
      // (totals just mirror how many of each weekday the corpus happens to span)
      const dayOccurrences = [0, 0, 0, 0, 0, 0, 0];
      new Set(dates).forEach(d => { try { dayOccurrences[new Date(d).getDay()]++; } catch { /* bad date */ } });
      const dayOfWeekData = dayNames.map((name, i) => ({
        name,
        count: dayOccurrences[i] > 0 ? dayCounts[i] / dayOccurrences[i] : 0,
      }));
      busiestDay = dayOfWeekData.reduce((a, b) => (b.count > a.count ? b : a)).name;

      // 1. Trend Traces — stacked area chart: the 8 colored sources as series,
      // remaining sources aggregated into one "Autres" series.
      // Data is sliced to the selected window (not just an axis range) so the
      // y-axis rescales to what is actually visible
      let trendKeys = sortedTimeKeys;
      if (trendRange !== 'all' && sortedTimeKeys.length) {
        const last = new Date(sortedTimeKeys[sortedTimeKeys.length - 1]);
        const cutoff = new Date(last.getTime() - Number(trendRange) * 86400000)
          .toISOString().slice(0, 10);
        trendKeys = sortedTimeKeys.filter(k => k >= cutoff);
      }
      const trendTraces = mainSources.map(src => ({
        name: sourceLabel(src),
        x: trendKeys,
        y: trendKeys.map(k => timeSeries[k][src] || 0),
        type: 'scatter',
        mode: 'lines',
        fill: 'tonexty',
        stackgroup: 'one',
        line: { shape: 'spline', width: 1, color: colors[src] },
        fillcolor: colors[src] + '55'
      }));
      if (tailSources.length > 0) {
        trendTraces.push({
          name: `${OTHER_LABEL} (${tailSources.length} sources)`,
          x: trendKeys,
          y: trendKeys.map(k => tailSources.reduce((s, src) => s + (timeSeries[k][src] || 0), 0)),
          type: 'scatter',
          mode: 'lines',
          fill: 'tonexty',
          stackgroup: 'one',
          line: { shape: 'spline', width: 1, color: OTHER_COLOR },
          fillcolor: OTHER_COLOR + '55'
        });
      }

      // 2. Category Top Entries (for custom treemap)
      const catTotals = Object.entries(categories).map(([cat, srcMap]) => [
        cat, Object.values(srcMap).reduce((s, v) => s + v, 0)
      ]).sort((a, b) => b[1] - a[1]);

      const topCatsAbsolute = catTotals.slice(0, 8);

      const TOP_N = 14;
      const topCatEntries = catTotals.slice(0, TOP_N);
      const otherCats = catTotals.slice(TOP_N);
      const otherTotal = otherCats.reduce((s, c) => s + c[1], 0);

      if (otherTotal > 0) {
        topCatEntries.push(['Autres', otherTotal]);
        const autresSources = {};
        otherCats.forEach(([cat]) => {
          if (categories[cat]) {
            Object.entries(categories[cat]).forEach(([src, count]) => {
              autresSources[src] = (autresSources[src] || 0) + count;
            });
          }
        });
        categories['Autres'] = autresSources;
      }

      // 3. Source donut — colored sources as slices, the rest folded into "Autres"
      const mainEntries = mainSources
        .map(s => [s, sources[s]])
        .sort((a, b) => b[1] - a[1]);
      const tailTotal = tailSources.reduce((s, src) => s + sources[src], 0);
      const donutEntries = tailTotal > 0
        ? [...mainEntries, [`${OTHER_LABEL} (${tailSources.length} sources)`, tailTotal]]
        : mainEntries;
      const donutTrace = {
        labels: donutEntries.map(e => sourceLabel(e[0])),
        values: donutEntries.map(e => e[1]),
        type: 'pie',
        hole: 0.55,
        // Outside labels with automargin: the pie shrinks to fit them inside
        // the pinned-height chart instead of overflowing the card
        textinfo: 'label+percent',
        textposition: 'outside',
        automargin: true,
        outsidetextfont: { size: 11 },
        marker: { colors: donutEntries.map(e => colors[e[0]] || OTHER_COLOR) },
        hoverinfo: 'label+value+percent',
        sort: false
      };

      return {
        trendTraces, topCatEntries, donutTrace,
        total: data.points.length, sources, categories,
        dateMin, dateMax, avgPerDay, totalCategories,
        topSource, topCategory, colors,
        busiestDay, thisWeekCount, lastWeekCount, weekTrend,
        recordDay, sourceFreshness,
        dayOfWeekData, topCatsAbsolute
      };
    } catch (err) {
      console.error('Error calculating metrics:', err);
      return null;
    }
  }, [data, granularity, trendRange]);

  // Marks this visit as "seen" for next time — deliberately happens after
  // lastSeenDate was already snapshotted into state above, so this visit's
  // own strip still diffs against the *previous* visit, not itself
  useEffect(() => {
    if (stats?.dateMax) localStorage.setItem(LAST_VISIT_KEY, stats.dateMax);
  }, [stats?.dateMax]);

  // "Depuis votre dernière visite": for each followed keyword/source/thème,
  // compare articles published since lastSeenDate against a same-length
  // baseline window immediately before it — a flat "3 nouveaux articles"
  // means little without knowing whether 3 is normal, a spike, or the item
  // going quiet, same reasoning as sourceMomentum's day-of-week comparison
  // above, just anchored on the visitor's own last visit instead of a
  // calendar period
  const followDeltas = useMemo(
    () => computeFollowDeltas(data?.points, follows, lastSeenDate, stats?.dateMax),
    [data, follows, lastSeenDate, stats?.dateMax]
  );

  // Editorial profile per media, with its own time window.
  // Windows are anchored on the most recent collected article, not the wall
  // clock, so the view stays populated when scraping lags.
  const [profileRange, setProfileRange] = useState('all'); // 'day' | 'week' | 'all'
  const profileTraces = useMemo(() => {
    if (!data || !data.points) return [];
    const allDates = data.points.map(p => p.date).filter(Boolean);
    const maxDate = allDates.length ? allDates.reduce((a, b) => (b > a ? b : a)) : null;
    let cutoff = null;
    if (maxDate && profileRange === 'day') cutoff = maxDate;
    if (maxDate && profileRange === 'week') {
      const d = new Date(maxDate);
      d.setDate(d.getDate() - 6);
      cutoff = d.toISOString().split('T')[0];
    }

    const sources = {};
    const bySource = {};
    data.points.forEach(pt => {
      if (!pt.source) return;
      if (cutoff && (!pt.date || pt.date < cutoff)) return;
      sources[pt.source] = (sources[pt.source] || 0) + 1;
      const cat = normalizeCategory(pt.category, pt.source);
      if (!bySource[pt.source]) bySource[pt.source] = {};
      bySource[pt.source][cat] = (bySource[pt.source][cat] || 0) + 1;
    });

    const lightHues = new Set(['#C99A2A', '#1EA39B']);
    const profileSources = Object.keys(sources).sort((a, b) => sources[b] - sources[a]);
    return [...Object.keys(PROFILE_COLORS), PROFILE_OTHER].map(cat => {
      const counts = profileSources.map(src => {
        const m = bySource[src] || {};
        if (cat === PROFILE_OTHER) {
          return Object.entries(m).reduce((s, [c, n]) => s + (PROFILE_COLORS[c] ? 0 : n), 0);
        }
        return m[cat] || 0;
      });
      const color = PROFILE_COLORS[cat] || PROFILE_OTHER_COLOR;
      const pcts = profileSources.map((src, i) => (sources[src] ? (counts[i] / sources[src]) * 100 : 0));
      return {
        name: cat,
        type: 'bar',
        orientation: 'h',
        y: profileSources,
        x: pcts,
        customdata: counts,
        marker: { color, line: { color: '#ffffff', width: 1 } },
        text: pcts.map(p => (p >= 7 ? `${Math.round(p)}%` : '')),
        textposition: 'inside',
        insidetextanchor: 'middle',
        textfont: { size: 10, color: lightHues.has(color) ? '#0F2A3A' : '#ffffff' },
        hovertemplate: `<b>%{y}</b> · ${cat}<br>%{customdata} articles (%{x:.1f} %)<extra></extra>`,
      };
    });
  }, [data, profileRange]);

  // Source momentum: current period vs the one before, anchored on the
  // newest collected article rather than the wall clock. Same toggle
  // pattern as the editorial profile above.
  const [momentumRange, setMomentumRange] = useState('week'); // 'day' | 'week' | 'all'
  const sourceMomentum = useMemo(() => {
    if (!data || !data.points) return [];
    const freshness = {};
    data.points.forEach(pt => {
      if (!pt.source || !pt.date) return;
      if (!freshness[pt.source] || pt.date > freshness[pt.source]) freshness[pt.source] = pt.date;
    });
    const maxDateStr = Object.values(freshness).sort().pop();
    if (!maxDateStr) return [];

    if (momentumRange === 'all') {
      // No "previous period" over the whole corpus: a straight volume
      // ranking instead of a delta
      const total = {};
      data.points.forEach(pt => {
        if (!pt.source) return;
        total[pt.source] = (total[pt.source] || 0) + 1;
      });
      return Object.entries(total)
        .map(([name, w1]) => ({ name, w1, w0: 0, delta: null }))
        .sort((a, b) => b.w1 - a.w1);
    }

    if (momentumRange === 'day') {
      // A single-previous-day comparison is too noisy at daily volumes (2
      // vs 5 articles reads as "+150 %"), and a source doesn't publish at
      // the same pace every weekday (weekend lull, etc.) — so "normal" for
      // a Monday means the average of previous Mondays, not the average of
      // every day. Same framing as the day-of-week KPI card elsewhere in
      // this dashboard, applied per source.
      const todayDow = new Date(maxDateStr).getDay();
      const byDate = {}; // { source: { date: count } }
      data.points.forEach(pt => {
        if (!pt.source || !pt.date) return;
        (byDate[pt.source] ||= {})[pt.date] = (byDate[pt.source][pt.date] || 0) + 1;
      });
      return Object.entries(byDate)
        .map(([name, dates]) => {
          const w1 = dates[maxDateStr] || 0;
          const sameDowPriorDays = Object.keys(dates).filter(d => {
            if (d === maxDateStr) return false;
            const t = new Date(d);
            return !isNaN(t.getTime()) && t.getDay() === todayDow;
          });
          const avg = sameDowPriorDays.length
            ? sameDowPriorDays.reduce((s, d) => s + dates[d], 0) / sameDowPriorDays.length
            : 0;
          return {
            name, w1, w0: avg,
            delta: avg > 0 ? Math.round((w1 - avg) / avg * 100) : null,
          };
        })
        .sort((a, b) => b.w1 - a.w1);
    }

    const spanDays = 7;
    const maxT = new Date(maxDateStr).getTime();
    const curStart = maxT - (spanDays - 1) * 86400000;
    const prevStart = maxT - (spanDays * 2 - 1) * 86400000;
    const momentum = {};
    data.points.forEach(pt => {
      const t = new Date(pt.date).getTime();
      if (!pt.source || isNaN(t) || t < prevStart) return;
      const m = momentum[pt.source] || (momentum[pt.source] = { w1: 0, w0: 0 });
      if (t >= curStart) m.w1++; else m.w0++;
    });
    return Object.entries(momentum)
      .map(([name, m]) => ({
        name, w1: m.w1, w0: m.w0,
        delta: m.w0 > 0 ? Math.round((m.w1 - m.w0) / m.w0 * 100) : null,
      }))
      .sort((a, b) => b.w1 - a.w1);
  }, [data, momentumRange]);

  // Top keywords from titles, same adjustable-window pattern
  const [keywordsRange, setKeywordsRange] = useState('all'); // 'day' | 'week' | 'all'
  const topKeywords = useMemo(() => {
    if (!data || !data.points) return [];
    const allDates = data.points.map(p => p.date).filter(Boolean);
    const maxDate = allDates.length ? allDates.reduce((a, b) => (b > a ? b : a)) : null;
    let cutoff = null;
    if (maxDate && keywordsRange === 'day') cutoff = maxDate;
    if (maxDate && keywordsRange === 'week') {
      const d = new Date(maxDate);
      d.setDate(d.getDate() - 6);
      cutoff = d.toISOString().split('T')[0];
    }
    const wordCounts = {};
    data.points.forEach(pt => {
      if (!pt.title) return;
      if (cutoff && (!pt.date || pt.date < cutoff)) return;
      titleWords(pt.title).forEach(w => { wordCounts[w] = (wordCounts[w] || 0) + 1; });
    });
    return Object.entries(wordCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [data, keywordsRange]);

  // Top 10 trending topics as a bump chart (rank over time), not a raw-count
  // line chart. Two problems with the earlier version, both real: (1) "top
  // 10" was decided once from the total across the whole window and then
  // held fixed — a word that only became prominent this week could never
  // appear, and one that mattered early but faded never dropped off; a
  // *trending* list has to be allowed to turn over. (2) raw daily counts are
  // small, noisy integers — ties and one-off spikes made the lines an
  // unreadable tangle. Ranking each bucket independently fixes both: the
  // top 10 is recomputed per bucket (so the roster genuinely rotates), and
  // rank is a bounded 1-10 ordinal, structurally smoother than raw counts.
  const RANK_CAP = 10;
  // Total distinct words that pass through the top 10 across a whole window
  // can run well past 10 (a rotating roster, by design) — capped here to
  // keep the color/line count sane, favoring words that held a top-10 spot
  // for the most buckets (sustained relevance) over one-day flashes.
  const CAST_CAP = 12;
  const [trendTopicsGranularity, setTrendTopicsGranularity] = useState('week'); // 'day' | 'week' | 'month'
  const trendTopicsSeries = useMemo(() => {
    if (!data || !data.points) return { series: [], buckets: [] };
    const allDates = data.points.map(p => p.date).filter(Boolean);
    if (!allDates.length) return { series: [], buckets: [] };
    const maxDate = allDates.reduce((a, b) => (b > a ? b : a));

    let windowStartStr;
    if (trendTopicsGranularity === 'day') {
      const d = new Date(maxDate); d.setDate(d.getDate() - 29);
      windowStartStr = d.toISOString().slice(0, 10);
    } else if (trendTopicsGranularity === 'week') {
      const d = new Date(maxDate); d.setDate(d.getDate() - 7 * 15);
      windowStartStr = d.toISOString().slice(0, 10);
    } else {
      // Monthly: the whole corpus (it only starts Dec 2025, so this is
      // already a handful of buckets, not hundreds)
      windowStartStr = '2025-12-01';
    }

    const bucketKey = (dateStr) => {
      if (trendTopicsGranularity === 'month') return dateStr.slice(0, 7);
      if (trendTopicsGranularity === 'week') {
        const d = new Date(dateStr);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        return new Date(d.setDate(diff)).toISOString().slice(0, 10);
      }
      return dateStr;
    };

    const bucketWordCounts = {}; // bucket -> { word: count }
    const bucketSet = new Set();
    data.points.forEach(pt => {
      if (!pt.title || !pt.date || pt.date < windowStartStr) return;
      const bucket = bucketKey(pt.date);
      bucketSet.add(bucket);
      const counts = (bucketWordCounts[bucket] ||= {});
      titlePhrases(pt.title).forEach(w => { counts[w] = (counts[w] || 0) + 1; });
    });
    const buckets = Array.from(bucketSet).sort();

    // Ranking on a single bucket's raw count is noisy past the top 2-3
    // spots — daily counts are small integers with frequent near-ties, so
    // rank order for anything below the leaders flips around on almost
    // nothing. A trailing rolling sum smooths that into something that
    // reads as an actual trend rather than single-day static; weekly/
    // monthly buckets are already coarse enough that this matters less.
    const ROLLING_WINDOW = trendTopicsGranularity === 'day' ? 3 : trendTopicsGranularity === 'week' ? 2 : 1;
    const smoothedCounts = buckets.map((_, i) => {
      const merged = {};
      buckets.slice(Math.max(0, i - ROLLING_WINDOW + 1), i + 1).forEach(b => {
        Object.entries(bucketWordCounts[b] || {}).forEach(([w, c]) => { merged[w] = (merged[w] || 0) + c; });
      });
      return merged;
    });

    // Per bucket, the top 10 words that bucket (by smoothed count) — an
    // independent ranking each time, which is exactly what lets the roster
    // turn over
    const bucketTop10 = smoothedCounts.map(counts =>
      Object.entries(counts).sort((a, c) => c[1] - a[1]).slice(0, RANK_CAP).map(([w]) => w)
    );

    const appearances = {};
    bucketTop10.forEach(ranked => ranked.forEach(w => { appearances[w] = (appearances[w] || 0) + 1; }));
    const cast = Object.entries(appearances).sort((a, b) => b[1] - a[1]).slice(0, CAST_CAP).map(([w]) => w);
    const castSet = new Set(cast);

    const wordTotals = {};
    data.points.forEach(pt => {
      if (!pt.title || !pt.date || pt.date < windowStartStr) return;
      titlePhrases(pt.title).forEach(w => { if (castSet.has(w)) wordTotals[w] = (wordTotals[w] || 0) + 1; });
    });

    const series = cast.map(word => {
      const ranks = bucketTop10.map(ranked => {
        const idx = ranked.indexOf(word);
        return idx === -1 ? null : idx + 1;
      });
      return { word, ranks, total: wordTotals[word] || 0 };
    }).sort((a, b) => {
      // Currently-ranked words first (best rank first), then words that
      // have since dropped out of the top 10 entirely
      const aLast = a.ranks[a.ranks.length - 1];
      const bLast = b.ranks[b.ranks.length - 1];
      if (aLast !== null && bLast !== null) return aLast - bLast;
      if (aLast !== null) return -1;
      if (bLast !== null) return 1;
      return b.total - a.total;
    });

    return { series, buckets };
  }, [data, trendTopicsGranularity]);

  // Shared by the Plotly layout and the wrapper div: the flex container only
  // grows past its min-height when the div itself carries the height.
  // On mobile the legend is HTML (above the chart), not Plotly's.
  // Reactive so the charts re-render with the right config on window resize
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia('(max-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const fn = e => setIsNarrow(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  const profileHeight = profileTraces.length
    ? Math.max(180, (isNarrow ? 30 : 90) + profileTraces[0].y.length * 36)
    : 200;

  useEffect(() => {
    if (!profileChartRef.current || !profileTraces.length) return;
    try {
      Plotly.react(profileChartRef.current, profileTraces, {
        barmode: 'stack',
        bargap: 0.45,
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        // Narrow screens: a 140px gutter would eat a third of the width
        margin: { t: 10, r: isNarrow ? 8 : 20, l: isNarrow ? 104 : 140, b: 30 },
        height: profileHeight,
        xaxis: {
          range: [0, 100], ticksuffix: ' %',
          gridcolor: 'rgba(15,42,58,0.07)', zeroline: false, tickfont: { size: 11 }
        },
        yaxis: { autorange: 'reversed', tickfont: { size: isNarrow ? 10 : 12 } },
        // Mobile uses the wrapping HTML legend rendered above the chart:
        // Plotly's own legend refuses to pack tightly on narrow screens
        showlegend: !isNarrow,
        legend: {
          orientation: 'h', y: 1.02, yanchor: 'bottom', x: 0.5, xanchor: 'center',
          font: { size: 11 }, traceorder: 'normal',
        },
        font: { family: 'inherit', size: 12 },
      }, { responsive: true, displayModeBar: false });
    } catch (err) {
      console.error('Plotly error (profile):', err);
    }
  }, [profileTraces, profileHeight, isNarrow]);

  useEffect(() => {
    if (!trendChartRef.current || !stats || !stats.trendTraces.length) return;
    try {
      Plotly.react(trendChartRef.current, stats.trendTraces, {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        margin: isNarrow ? { t: 12, r: 8, l: 34, b: 48 } : { t: 20, r: 20, l: 50, b: 70 },
        hovermode: 'x',
        xaxis: {
          gridcolor: 'rgba(15,42,58,0.07)', zeroline: false,
          tickangle: -30,
          // Tick spacing follows the visible window (wider on phones) so the
          // date axis stays legible
          dtick: (trendRange === '30' ? 7
                  : trendRange === '90' ? (isNarrow ? 21 : 14)
                  : trendRange === '180' ? (isNarrow ? 30 : 21)
                  : granularity === 'week' ? (isNarrow ? 28 : 7)
                  : (isNarrow ? 30 : 14)) * 86400000,
          tickfont: { size: isNarrow ? 10 : 11 }
        },
        yaxis: {
          gridcolor: 'rgba(15,42,58,0.07)',
          title: isNarrow ? '' : (granularity === 'week' ? 'Articles par semaine' : 'Articles par jour'),
          zeroline: false,
          rangemode: 'tozero',
          tickfont: { size: isNarrow ? 10 : 12 }
        },
        // Mobile uses the wrapping HTML legend under the chart
        showlegend: !isNarrow,
        legend: { orientation: 'h', y: -0.22, x: 0.5, xanchor: 'center', font: { size: 11 } },
        font: { family: 'inherit', size: 12 }
      }, { responsive: true, displayModeBar: false });

      if (sourceDonutRef.current && stats.donutTrace) {
        // Narrow screens: outside labels degenerate into a ragged column, so
        // switch to inside percents + a wrapping legend below the donut
        const mobile = isNarrow;
        const donutTrace = mobile ? {
          ...stats.donutTrace,
          textinfo: 'percent',
          textposition: 'inside',
          insidetextorientation: 'horizontal',
          automargin: false,
        } : stats.donutTrace;
        Plotly.react(sourceDonutRef.current, [donutTrace], {
          paper_bgcolor: 'transparent',
          margin: mobile ? { t: 6, r: 6, l: 6, b: 6 } : { t: 16, r: 16, l: 16, b: 16 },
          height: 380,  // pinned: matches the container div, never trust auto-sizing
          showlegend: mobile,
          ...(mobile ? {
            legend: { orientation: 'h', y: -0.04, x: 0.5, xanchor: 'center', font: { size: 10 } },
            uniformtext: { minsize: 10, mode: 'hide' },
          } : {}),
          font: { family: 'inherit', size: 12 },
          annotations: [{
            text: `<b>${stats.total.toLocaleString('fr-FR')}</b><br>articles`,
            showarrow: false, font: { size: mobile ? 15 : 18, color: '#34495A' }
          }]
        }, { responsive: true, displayModeBar: false });
      }
    } catch (err) {
      console.error('Plotly error:', err);
    }
  }, [stats, granularity, trendRange, isNarrow]);

  if (!stats) return <div className="metrics-view"><p>Erreur lors du calcul des statistiques. Vérifiez la console.</p></div>;

  return (
    <div className="metrics-view">
      <div className="metrics-header">
        <div>
          <h2 className="metrics-title">Tableau de bord analytique</h2>
          <p className="metrics-subtitle">Vue d'ensemble de la couverture médiatique gabonaise</p>
        </div>
      </div>

      {/* ── Since your last visit ─────────────────────
          Only followed items produce a card here, and only once there's a
          real previous visit to diff against (first-ever visit has nothing
          to compare, so it stays silent rather than showing empty state) */}
      {followDeltas.length > 0 && (
        <div className="follow-strip">
          <span className="follow-strip-title">Depuis votre dernière visite</span>
          <div className="follow-strip-items">
            {followDeltas.map(d => (
              <div key={`${d.type}-${d.value}`} className={`follow-card ${d.status}`}>
                {d.status === 'spiked' && <Flame size={14} />}
                {d.status === 'quiet' && <BellOff size={14} />}
                {d.status === 'new' && <Star size={14} />}
                <div className="follow-card-body">
                  <span className="follow-card-label">{d.label}</span>
                  <span className="follow-card-detail">
                    {d.status === 'spiked' && `${d.sinceCount} articles — bien plus que d'habitude (~${d.baselineCount})`}
                    {d.status === 'quiet' && `silence depuis — habituellement ~${d.baselineCount} sur cette période`}
                    {d.status === 'new' && `${d.sinceCount} nouvel${d.sinceCount > 1 ? 'les' : ''} article${d.sinceCount > 1 ? 's' : ''}`}
                  </span>
                </div>
                <button
                  className="follow-card-remove"
                  onClick={() => toggleFollow(d.type, d.value, d.label)}
                  title={`Ne plus suivre ${d.label}`}
                  aria-label={`Ne plus suivre ${d.label}`}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {follows.length === 0 && (
        <p className="follow-hint">
          <Star size={12} /> Suivez un mot-clé, une source ou un thème ci-dessous (icône ★) pour voir leur évolution ici à votre prochaine visite.
        </p>
      )}

      {/* ── KPI Row ────────────────────────────────── */}
      <div className="metrics-grid">
        <div className="stat-card stat-highlight">
          <span className="stat-label">Articles collectés</span>
          <div className="stat-value">{stats.total.toLocaleString('fr-FR')}</div>
        </div>
        <div className="stat-card">
          <span className="stat-label">Période couverte</span>
          <div className="stat-value stat-value-sm">{stats.dateMin}<br/>→ {stats.dateMax}</div>
        </div>
        <div className="stat-card">
          <span className="stat-label">Articles par jour en moyenne</span>
          <div className="stat-value">{String(stats.avgPerDay).replace('.', ',')}</div>
        </div>
        <div className="stat-card">
          <span className="stat-label">Rubriques recensées</span>
          <div className="stat-value">{stats.totalCategories}</div>
        </div>
        {stats.topSource && (
          <div className="stat-card">
            <span className="stat-label">Média le plus prolifique</span>
            <div className="stat-value stat-value-sm">{sourceLabel(stats.topSource[0])}</div>
            <span className="stat-detail">{stats.topSource[1].toLocaleString('fr-FR')} articles</span>
          </div>
        )}
        {stats.topCategory && (
          <div className="stat-card">
            <span className="stat-label">Thème le plus couvert</span>
            <div className="stat-value stat-value-sm">{stats.topCategory[0]}</div>
            <span className="stat-detail">{stats.topCategory[1].toLocaleString('fr-FR')} articles</span>
          </div>
        )}
        <div className="stat-card">
          <span className="stat-label">Jour de la semaine le plus actif</span>
          <div className="stat-value stat-value-sm">{stats.busiestDay}</div>
        </div>
        <div className="stat-card">
          <span className="stat-label">Record d'articles en une journée</span>
          <div className="stat-value">{stats.recordDay[1]}</div>
          <span className="stat-detail">le {stats.recordDay[0]}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Articles ces 7 derniers jours</span>
          <div className="stat-value">{stats.thisWeekCount}</div>
          <span className="stat-detail" style={{ color: Number(stats.weekTrend) >= 0 ? '#2E554B' : '#A8433A' }}>
            {Number(stats.weekTrend) >= 0 ? '▲' : '▼'} {Math.abs(stats.weekTrend)}% vs la semaine précédente
          </span>
        </div>
        {/* Silent ingestion failures directly degrade answer freshness:
            surface them at the top instead of burying them at page bottom */}
        {(() => {
          const stale = Object.entries(stats.sourceFreshness)
            .filter(([, d]) => (new Date() - new Date(d)) / 86400000 > 7);
          if (!stale.length) return null;
          return (
            <div className="stat-card stat-alert">
              <span className="stat-label">Sources silencieuses (+ de 7 jours)</span>
              <div className="stat-value">{stale.length}</div>
              <span className="stat-detail">{stale.map(([s]) => s).slice(0, 3).join(', ')}{stale.length > 3 ? '…' : ''}</span>
            </div>
          );
        })()}
      </div>

      {/* ── Today vs average for this day of week ── */}
      {(() => {
        const dayNames = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
        // Anchored on the newest collected article, not the visitor's own
        // device clock: a device's local date (or worse, its UTC date via
        // toISOString()) can disagree with Gabon's calendar day for a chunk
        // of every 24h, for any visitor outside Gabon's timezone — same
        // anchoring principle as the temporal RAG "today" queries.
        const todayStr = stats.dateMax;
        const todayIdx = todayStr && todayStr !== '—' ? new Date(todayStr).getDay() : new Date().getDay();
        const todayName = dayNames[todayIdx];

        // Count articles published today
        const todayCount = data.points.filter(p => p.date === todayStr).length;

        // Count how many of this weekday exist in the dataset and their total articles
        const allDates = [...new Set(data.points.map(p => p.date).filter(Boolean))];
        const sameDayDates = allDates.filter(d => new Date(d).getDay() === todayIdx && d !== todayStr);
        const sameDayArticles = data.points.filter(p => sameDayDates.includes(p.date)).length;
        const avgForDay = sameDayDates.length > 0 ? sameDayArticles / sameDayDates.length : 0;

        const pctDiff = avgForDay > 0 ? ((todayCount - avgForDay) / avgForDay * 100).toFixed(0) : 0;
        const isAbove = Number(pctDiff) >= 0;

        // Data can lag the real calendar day (scraping runs 3x/day, not
        // continuously) — say so plainly instead of implying today's
        // articles are in when the freshest thing we have is yesterday's.
        // gabonToday is the server's authoritative "today" (§ api.py
        // gabon_now()); until it loads, don't guess off a device clock.
        const isTrueToday = gabonToday && todayStr === gabonToday;

        return (
          <div className="today-comparison">
            <div className="today-main">
              <span className="today-label">
                {isTrueToday
                  ? `Publiés aujourd'hui (${todayName.toLowerCase()})`
                  : `Dernier jour couvert (${todayName.toLowerCase()})`}
              </span>
              <span className="today-count">{todayCount} <small>articles</small></span>
              {!isTrueToday && gabonToday && (
                <span className="today-stale-note">La collecte du jour n'est pas encore arrivée.</span>
              )}
            </div>
            <div className="today-vs">
              <span className="today-vs-label">Moyenne des {todayName.toLowerCase()}s</span>
              <span className="today-vs-avg">{avgForDay.toFixed(1).replace('.', ',')} articles</span>
              <span className="today-vs-pct" style={{ color: isAbove ? '#2E554B' : '#A8433A' }}>
                {isAbove ? '▲' : '▼'} {Math.abs(pctDiff)}%
              </span>
            </div>
          </div>
        );
      })()}

      {/* ── Source donut + Bar breakdown side by side ── */}
      <div className="charts-row">
        <div className="chart-container chart-sm">
          <h3 className="chart-title">Répartition par source</h3>
          <div ref={sourceDonutRef} className="chart-viz" style={{ height: '380px' }} />
        </div>
        <div className="chart-container chart-sm">
          <div className="chart-header">
            <h3 className="chart-title">Dynamique des sources</h3>
            <div className="granularity-selector">
              {[['day', "Aujourd'hui"], ['week', '7 jours'], ['all', 'Tout']].map(([key, label]) => (
                <button
                  key={key}
                  className={`granularity-btn ${momentumRange === key ? 'active' : ''}`}
                  onClick={() => setMomentumRange(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p className="chart-note">
            {momentumRange === 'day'
              ? (() => {
                  const dowNames = ['dimanches', 'lundis', 'mardis', 'mercredis', 'jeudis', 'vendredis', 'samedis'];
                  const dow = dowNames[new Date().getDay()];
                  return `Articles publiés le dernier jour couvert, comparés à la moyenne des ${dow} de chaque source.`;
                })()
              : momentumRange === 'week'
              ? "Articles publiés sur les 7 derniers jours couverts, et évolution par rapport aux 7 jours précédents."
              : "Total des articles publiés par source depuis le début de la collecte."}
          </p>
          <div className="source-bars">
            {sourceMomentum.map(({ name, w1, w0, delta }) => {
              const max = sourceMomentum[0]?.w1 || 1;
              const cls = delta === null ? 'flat' : delta > 5 ? 'up' : delta < -5 ? 'down' : 'flat';
              const label = momentumRange === 'all' ? ''
                : delta === null ? 'nouveau'
                : `${delta > 0 ? '▲ +' : delta < 0 ? '▼ ' : ''}${delta} %`;
              // The reference the % is computed against — same value driving
              // `delta` above, just also shown so "+40 %" is legible as
              // "12 vs 8.6", not a bare number nobody can double-check.
              const baseline = label && delta !== null
                ? (Number.isInteger(w0) ? w0 : w0.toFixed(1))
                : null;
              const baselineTitle = momentumRange === 'day'
                ? `Moyenne des mêmes jours de la semaine pour ${name}`
                : `${name} sur les 7 jours précédents`;
              const followed = isFollowed('source', name);
              return (
                <div key={name} className="source-bar-row">
                  <button
                    className={`follow-toggle ${followed ? 'active' : ''}`}
                    onClick={() => toggleFollow('source', name, name)}
                    title={followed ? `Ne plus suivre ${name}` : `Suivre ${name}`}
                    aria-label={followed ? `Ne plus suivre ${name}` : `Suivre ${name}`}
                    aria-pressed={followed}
                  >
                    <Star size={12} />
                  </button>
                  <button
                    className="source-bar-label"
                    onClick={() => onAskAssistant(`Quelles sont les dernières actualités de ${sourceLabel(name)} ?`)}
                    title={`Demander à l'assistant : dernières actualités de ${sourceLabel(name)}`}
                  >
                    {sourceLabel(name)}
                  </button>
                  <div className="source-bar-track">
                    <div
                      className="source-bar-fill"
                      style={{ width: `${(w1 / max) * 100}%`, background: stats.colors[name] || '#6B7A89' }}
                    />
                  </div>
                  <span className="source-bar-count">
                    {w1}
                    {baseline !== null && (
                      <span className="source-bar-baseline" title={baselineTitle}> ({baseline})</span>
                    )}
                  </span>
                  {label && <span className={`source-delta ${cls}`}>{label}</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Trend chart ─────────────────────────────── */}
      <div className="chart-container">
        <div className="chart-header">
          <h3 className="chart-title">Évolution de la publication</h3>
          <div className="chart-header-controls">
            <div className="granularity-selector">
              {[['30', '30 j'], ['90', '90 j'], ['180', '6 mois'], ['all', 'Tout']].map(([val, label]) => (
                <button
                  key={val}
                  className={`granularity-btn ${trendRange === val ? 'active' : ''}`}
                  onClick={() => setTrendRange(val)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="granularity-selector">
              <button
                className={`granularity-btn ${granularity === 'day' ? 'active' : ''}`}
                onClick={() => setGranularity('day')}
              >
                Journalier
              </button>
              <button
                className={`granularity-btn ${granularity === 'week' ? 'active' : ''}`}
                onClick={() => setGranularity('week')}
              >
                Hebdomadaire
              </button>
            </div>
          </div>
        </div>
        <div ref={trendChartRef} className="chart-viz" />
        {isNarrow && stats.trendTraces.length > 0 && (
          <div className="html-legend">
            {stats.trendTraces.map(t => (
              <span key={t.name} className="html-legend-item">
                <span className="html-legend-swatch" style={{ background: t.line.color }} />
                {t.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── Custom React Treemap with Lucide ──────────────────────────── */}
      <div className="chart-container">
        <h3 className="chart-title">Répartition thématique (Top 12 + Autres)</h3>
        <CustomTreemap
          data={stats.topCatEntries} total={stats.total} categories={stats.categories}
          isFollowed={isFollowed} toggleFollow={toggleFollow} onAskAssistant={onAskAssistant}
        />
      </div>

      {/* ── Editorial profile per media ────────────── */}
      <div className="chart-container">
        <div className="chart-header">
          <h3 className="chart-title">Profil éditorial par média</h3>
          <div className="granularity-selector">
            {[['day', 'Aujourd\'hui'], ['week', '7 jours'], ['all', 'Tout']].map(([key, label]) => (
              <button
                key={key}
                className={`granularity-btn ${profileRange === key ? 'active' : ''}`}
                onClick={() => setProfileRange(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="chart-note">Part de chaque rubrique dans la production de chaque source. Les rubriques génériques (« À la une », « Actualités ») et les thèmes minoritaires sont regroupés dans « Autres / non classé ». Fenêtres ancrées sur le dernier article collecté.</p>
        {isNarrow && profileTraces.length > 0 && (
          <div className="html-legend">
            {profileTraces.map(t => (
              <span key={t.name} className="html-legend-item">
                <span className="html-legend-swatch" style={{ background: t.marker.color }} />
                {t.name}
              </span>
            ))}
          </div>
        )}
        <div ref={profileChartRef} className="chart-viz" style={{ height: `${profileHeight}px`, flex: 'none' }} />
      </div>

      {/* ── Top Keywords ──────────────────────────── */}
      <div className="charts-row">
        <div className="chart-container chart-sm">
          <div className="chart-header">
            <h3 className="chart-title">Mots-clés fréquents</h3>
            <div className="granularity-selector">
              {[['day', "Aujourd'hui"], ['week', '7 jours'], ['all', 'Tout']].map(([key, label]) => (
                <button
                  key={key}
                  className={`granularity-btn ${keywordsRange === key ? 'active' : ''}`}
                  onClick={() => setKeywordsRange(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p className="chart-note">
            {keywordsRange === 'day'
              ? "Les mots qui reviennent le plus dans les titres du dernier jour couvert (mots courants exclus)."
              : keywordsRange === 'week'
              ? "Les mots qui reviennent le plus dans les titres des 7 derniers jours couverts (mots courants exclus)."
              : "Les mots qui reviennent le plus dans les titres d'articles depuis le début de la collecte (mots courants exclus)."}
          </p>
          <div className="keywords-grid">
            {topKeywords.map(([word, count], i) => {
              const followed = isFollowed('keyword', word);
              return (
                <div key={word} className={`keyword-chip ${followed ? 'active' : ''}`}>
                  <button
                    className="follow-toggle"
                    onClick={() => toggleFollow('keyword', word, word)}
                    title={followed ? `Ne plus suivre "${word}"` : `Suivre "${word}"`}
                    aria-label={followed ? `Ne plus suivre "${word}"` : `Suivre "${word}"`}
                    aria-pressed={followed}
                  >
                    <Star size={11} />
                  </button>
                  <button
                    className="keyword-chip-main"
                    onClick={() => onAskAssistant(`Que disent les articles récents sur ${word} ?`)}
                    title={`Demander à l'assistant : ${word}`}
                  >
                    <span className="keyword-rank">#{i + 1}</span>
                    <span className="keyword-word">{word}</span>
                    <span className="keyword-count">{count}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div className="chart-container chart-sm">
          <h3 className="chart-title">Activité par jour de la semaine</h3>
          <p className="chart-note">
            Nombre moyen d'articles publiés pour chaque jour de la semaine,
            calculé sur toute la période couverte. Le pourcentage compare
            chaque jour à la moyenne générale : la presse publie surtout en
            semaine, beaucoup moins le week-end.
          </p>
          <div className="weekday-heatmap">
            {(() => {
              const avgCount = stats.dayOfWeekData.reduce((s, d) => s + d.count, 0) / 7;
              const maxCount = Math.max(...stats.dayOfWeekData.map(x => x.count));
              return stats.dayOfWeekData.map(d => {
                const intensity = maxCount > 0 ? d.count / maxCount : 0;
                const pctDiff = avgCount > 0 ? ((d.count - avgCount) / avgCount * 100).toFixed(0) : 0;
                const isAbove = Number(pctDiff) >= 0;
                return (
                  <div key={d.name} className="weekday-cell">
                    <span className="weekday-name">{d.name.slice(0, 3)}</span>
                    <div className="weekday-bar" style={{
                      height: `${Math.max(intensity * 100, 5)}%`,
                      background: `rgba(46, 85, 75, ${0.2 + intensity * 0.8})`
                    }} />
                    <span className="weekday-count">{d.count.toFixed(1)}</span>
                    <span className="weekday-pct" style={{ color: isAbove ? '#2E554B' : '#A8433A' }}>
                      {isAbove ? '▲' : '▼'} {Math.abs(pctDiff)}%
                    </span>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      </div>

      {/* ── Trending topics time series ─────────── */}
      <div className="chart-container">
        <div className="chart-header">
          <h3 className="chart-title">Sujets tendance</h3>
          <div className="granularity-selector">
            {[['day', 'Quotidien'], ['week', 'Hebdomadaire'], ['month', 'Mensuel']].map(([key, label]) => (
              <button
                key={key}
                className={`granularity-btn ${trendTopicsGranularity === key ? 'active' : ''}`}
                onClick={() => setTrendTopicsGranularity(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="chart-note">
          Classement (1 = le plus mentionné) des mots les plus présents dans les titres,
          {trendTopicsGranularity === 'day' ? ' recalculé jour par jour sur les 30 derniers jours couverts.'
            : trendTopicsGranularity === 'week' ? ' recalculé semaine par semaine sur les 15 dernières semaines couvertes.'
            : ' recalculé mois par mois depuis le début de la collecte.'}
          {' '}Le top 10 est propre à chaque période : un mot peut y entrer ou en sortir — une case vide
          veut dire que le mot n'était simplement pas dans le top 10 ce jour-là. Plus une case est
          foncée, plus le classement était haut.
        </p>
        {trendTopicsSeries.series.length > 0 ? (
          <div className="trend-topics-list">
            <div className="trend-topic-row trend-topic-row-header">
              <span className="trend-heatmap-date">{trendTopicsSeries.buckets[0]}</span>
              <span className="trend-heatmap-date trend-heatmap-date-end">{trendTopicsSeries.buckets[trendTopicsSeries.buckets.length - 1]}</span>
            </div>
            {trendTopicsSeries.series.map((s) => {
              const followed = isFollowed('keyword', s.word);
              const currentRank = s.ranks[s.ranks.length - 1];
              return (
                <div key={s.word} className={`trend-topic-row ${followed ? 'active' : ''}`}>
                  <button
                    className="follow-toggle"
                    onClick={() => toggleFollow('keyword', s.word, s.word)}
                    title={followed ? `Ne plus suivre "${s.word}"` : `Suivre "${s.word}"`}
                    aria-label={followed ? `Ne plus suivre "${s.word}"` : `Suivre "${s.word}"`}
                    aria-pressed={followed}
                  >
                    <Star size={11} />
                  </button>
                  <button
                    className="trend-topic-name"
                    onClick={() => onAskAssistant(`Que disent les articles récents sur ${s.word} ?`)}
                    title={`Demander à l'assistant : ${s.word}`}
                  >
                    {s.word}
                  </button>
                  <TrendHeatmapStrip ranks={s.ranks} buckets={trendTopicsSeries.buckets} rankCap={RANK_CAP} />
                  <span className="trend-topic-total">{s.total} mention{s.total > 1 ? 's' : ''}</span>
                  <span className={`source-delta ${currentRank === null ? 'down' : currentRank <= 3 ? 'up' : 'flat'}`}>
                    {currentRank === null ? 'hors top 10' : `#${currentRank} actuellement`}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="chat-empty-sub">Pas assez de données sur cette période pour dégager des tendances.</p>
        )}
      </div>

      {/* ── Source Freshness ──────────────────── */}
      <div className="chart-container">
        <h3 className="chart-title">Dernière publication par source</h3>
        <p className="chart-note">
          Date du dernier article collecté pour chaque média. Un média sans
          publication récente peut être en pause ou poser un problème de
          collecte.
        </p>
        <div className="freshness-grid">
          {Object.entries(stats.sourceFreshness).sort((a, b) => b[1].localeCompare(a[1])).map(([src, lastDate]) => {
            const daysAgo = Math.floor((new Date() - new Date(lastDate)) / 86400000);
            const fresh = daysAgo <= 1 ? 'fresh' : daysAgo <= 7 ? 'recent' : 'stale';
            return (
              <div key={src} className={`freshness-card freshness-${fresh}`}>
                <span className="freshness-source">{sourceLabel(src)}</span>
                <span className="freshness-date">{lastDate}</span>
                <span className="freshness-badge">
                  {daysAgo === 0 ? "Aujourd'hui" : daysAgo === 1 ? 'Hier' : `Il y a ${daysAgo}j`}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
