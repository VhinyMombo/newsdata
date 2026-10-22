import { useEffect, useMemo, useRef, useState } from 'react';
import Plotly from 'plotly.js-dist-min';
import { ExternalLink } from 'lucide-react';
import { normalizeCategory } from '../utils/categories';
import { sourceLabel } from '../utils/format';

// Shared between the map layout and its HTML legend: index i means the same group in both
const PLOT_COLORWAY = ['#2E554B', '#3A6FB8', '#C0672F', '#9E4A8C', '#B88A1E', '#5752B0', '#1E8F88', '#B83D44', '#2E6F8E', '#8A6A43'];
const NEUTRAL_MARKER = '#D5DBD7';
const HIGHLIGHT = 'Vos résultats';

// Long unwrapped titles push the hover label past the container edge
const wrapTitle = (title, width = 42) => {
  const lines = [];
  let line = '';
  for (const w of (title || '').split(' ')) {
    if ((`${line} ${w}`).trim().length > width) { lines.push(line.trim()); line = w; } else line = (`${line} ${w}`).trim();
  }
  if (line) lines.push(line);
  return lines.join('<br>');
};

export default function SemanticMap({ data, latestSources, isPhone }) {
  const plotRef = useRef(null);
  const [dim, setDim] = useState(() => (isPhone ? '2D' : '3D'));
  // The editorial rubrique by default: the clustering lumps its noise points into one huge group
  const [colorBy, setColorBy] = useState('category');
  const [highlighted, setHighlighted] = useState(null);
  const [hovered, setHovered] = useState(null);
  const method = 'UMAP';

  const traces = useMemo(() => {
    if (!data?.points) return [];
    const hl = new Set((latestSources || []).map(r => r.url));
    const make = (name) => ({
      name, x: [], y: [], z: [], text: [], customdata: [], hovertemplate: '%{text}<extra></extra>', mode: 'markers',
      type: dim === '2D' ? 'scatter' : 'scatter3d',
      marker: { size: dim === '2D' ? 7 : 4.5, opacity: hl.size ? 0.15 : 1, line: { width: 0 } },
    });
    const groups = {};
    data.points.forEach(pt => {
      const c = pt.projections[`${method}_${dim}`];
      if (!c) return;
      const g = colorBy === 'category' ? normalizeCategory(pt.category, pt.source)
        : colorBy === 'source' ? sourceLabel(pt.source) : (pt[colorBy] || 'Inconnu');
      groups[g] ??= make(g);
      groups[g].x.push(c[0]); groups[g].y.push(c[1]); if (dim === '3D') groups[g].z.push(c[2]);
      groups[g].text.push(`<b>${wrapTitle(pt.title)}</b><br>${pt.date} · ${sourceLabel(pt.source)}`);
      groups[g].customdata.push({ url: pt.url || '', title: pt.title, date: pt.date, source: pt.source });
    });
    // Rubriques past the eight largest go to "Autres", or the legend runs to thirty entries
    if (colorBy === 'category') {
      const bySize = Object.keys(groups).filter(n => n !== 'Autres').sort((a, b) => groups[b].x.length - groups[a].x.length);
      if (bySize.length > 8) {
        const autres = groups.Autres || make('Autres');
        bySize.slice(8).forEach(n => {
          const g = groups[n];
          autres.x.push(...g.x); autres.y.push(...g.y); autres.z.push(...g.z); autres.text.push(...g.text); autres.customdata.push(...g.customdata);
          delete groups[n];
        });
        groups.Autres = autres;
      }
    }
    const out = Object.values(groups);
    if (hl.size) {
      const h = make(HIGHLIGHT);
      data.points.forEach(pt => {
        if (!hl.has(pt.url)) return;
        const c = pt.projections[`${method}_${dim}`];
        if (!c) return;
        h.x.push(c[0]); h.y.push(c[1]); if (dim === '3D') h.z.push(c[2]);
        h.text.push(`<b>${wrapTitle(pt.title)}</b>`);
        h.customdata.push({ url: pt.url || '', title: pt.title, date: pt.date, source: pt.source });
      });
      h.marker = { size: dim === '2D' ? 14 : 9, color: '#0F2A3A', symbol: 'diamond' };
      if (dim === '2D') delete h.z;
      out.push(h);
    }
    return out;
  }, [data, dim, colorBy, latestSources]);

  useEffect(() => setHighlighted(null), [colorBy]);

  useEffect(() => {
    const gd = plotRef.current;
    if (!gd || !traces.length) return;
    const axis = { visible: false };
    Plotly.react(gd, traces, {
      colorway: PLOT_COLORWAY, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: '#5B6B7A', family: 'Hanken Grotesk' }, showlegend: false, margin: { l: 0, r: 0, b: 0, t: 0 },
      hoverlabel: { bgcolor: '#FFFFFF', bordercolor: '#6B8F7A', align: 'left', font: { size: 11.5 } },
      ...(dim === '3D' ? { scene: { xaxis: axis, yaxis: axis, zaxis: axis, bgcolor: 'transparent' } } : { xaxis: axis, yaxis: axis }),
    }, { responsive: true, displayModeBar: false });
    gd.removeAllListeners?.('plotly_click');
    gd.on?.('plotly_click', (e) => { const url = e.points[0].customdata?.url; if (url) window.open(url, '_blank'); });
    // A tap on 3D is easily taken as a rotation; hover fires reliably and drives the open bar
    gd.removeAllListeners?.('plotly_hover');
    gd.on?.('plotly_hover', (e) => { const cd = e.points[0].customdata; if (cd?.url) setHovered(cd); });
  }, [traces, dim]);

  // Legend isolation: other groups go flat grey (grey on grey stays grey, unlike low opacity).
  // The baseline is recomputed each time because restyle mutates the trace objects in place.
  useEffect(() => {
    const gd = plotRef.current;
    if (!gd?.data?.length || traces.length !== gd.data.length) return;
    const base = (latestSources || []).length ? 0.15 : 1;
    Plotly.restyle(gd, {
      'marker.color': traces.map((t, i) => (t.name === HIGHLIGHT ? '#0F2A3A' : !highlighted || t.name === highlighted ? PLOT_COLORWAY[i % PLOT_COLORWAY.length] : NEUTRAL_MARKER)),
      'marker.opacity': traces.map(t => (t.name === HIGHLIGHT ? 1 : !highlighted || t.name === highlighted ? base : Math.min(base, 0.4))),
    });
  }, [highlighted, traces, latestSources]);

  const entries = traces.map((t, i) => ({ name: t.name, color: PLOT_COLORWAY[i % PLOT_COLORWAY.length], n: t.x.length }))
    .filter(e => e.name !== HIGHLIGHT).sort((a, b) => b.n - a.n);
  const cap = colorBy === 'cluster_name' ? 8 : entries.length;
  const shown = entries.slice(0, cap);
  const visible = highlighted && !shown.some(e => e.name === highlighted) ? [entries.find(e => e.name === highlighted), ...shown].filter(Boolean) : shown;

  return (
    <section className="k-map" aria-labelledby="map-title">
      <header className="k-map-head">
        <div>
          <h3 id="map-title">Carte des sujets</h3>
          <p className="k-muted">Chaque point est un article. Deux points proches traitent de sujets voisins. Cliquez un point pour ouvrir l'article, une rubrique pour l'isoler.
            {latestSources?.length > 0 && ' Les losanges sont les sources de votre dernière question.'}</p>
        </div>
        <div className="k-map-controls">
          <div className="k-segmented small" role="group" aria-label="Format">
            {['2D', '3D'].map(d => <button key={d} className={dim === d ? 'on' : ''} aria-pressed={dim === d} onClick={() => setDim(d)}>{d}</button>)}
          </div>
          <label className="k-select">
            <span>Grouper par</span>
            <select value={colorBy} onChange={e => setColorBy(e.target.value)}>
              <option value="category">Rubrique</option>
              <option value="cluster_name">Thème détecté</option>
              <option value="source">Journal</option>
            </select>
          </label>
        </div>
      </header>
      <div className="k-legend">
        {highlighted && <button className="k-chip" onClick={() => setHighlighted(null)}>Tout afficher</button>}
        {visible.map(e => (
          <button key={e.name} className={`k-chip ${highlighted === e.name ? 'on' : ''}`} aria-pressed={highlighted === e.name} onClick={() => setHighlighted(g => (g === e.name ? null : e.name))}>
            <i style={{ background: e.color }} />{e.name.length > 24 ? `${e.name.slice(0, 23)}…` : e.name}
          </button>
        ))}
        {entries.length > shown.length && <span className="k-muted">+{entries.length - shown.length} autres</span>}
      </div>
      <div ref={plotRef} className="k-plot" role="img"
        aria-label={`Carte des ${data?.points?.length ?? 0} articles de presse placés selon la proximité de leurs sujets. Les mêmes articles restent accessibles par l'assistant et ses sources.`} />
      {isPhone && hovered && (
        <div className="k-map-open">
          <div><strong>{hovered.title}</strong><span className="k-muted">{hovered.date} · {sourceLabel(hovered.source)}</span></div>
          <a className="k-btn primary" href={hovered.url} target="_blank" rel="noreferrer">Ouvrir <ExternalLink size={13} /></a>
        </div>
      )}
    </section>
  );
}
