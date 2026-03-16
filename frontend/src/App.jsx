import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Plotly from 'plotly.js-dist-min';
import { Newspaper, Search, ExternalLink, Loader, ChevronDown, Database, SlidersHorizontal, BarChart3, Map as MapIcon } from 'lucide-react';
import './index.css';

const API_URL = 'http://localhost:8000';

export default function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeView, setActiveView] = useState('explore'); // 'explore' or 'stats'

  // Viz controls
  const [method, setMethod] = useState('UMAP');
  const [dim, setDim] = useState('3D');
  const [colorBy, setColorBy] = useState('cluster_name');
  const [showControls, setShowControls] = useState(false);

  // Chat state
  const [question, setQuestion] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState(null);
  const [searchAnswer, setSearchAnswer] = useState(null);
  const [searchError, setSearchError] = useState(null);

  const plotRef = useRef(null);
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);

  // Load data.json
  useEffect(() => {
    fetch('/data.json')
      .then(res => {
        if (!res.ok) throw new Error('data.json not found. Run export_embeddings.py first.');
        return res.json();
      })
      .then(json => { setData(json); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, []);

  // Scroll chat
  useEffect(() => {
    if ((searchAnswer || searchResults) && activeView === 'explore') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [searchAnswer, searchResults, activeView]);

  const handleSearch = useCallback(async (e) => {
    e?.preventDefault();
    if (!question.trim()) return;
    setSearching(true);
    setSearchError(null);
    setSearchResults(null);
    setSearchAnswer(null);
    try {
      const res = await fetch(`${API_URL}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question.trim(), n_results: 5 }),
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const json = await res.json();
      setSearchAnswer(json.answer);
      setSearchResults(json.results);
    } catch {
      setSearchError("Impossible de joindre l'API.");
    } finally {
      setSearching(false);
    }
  }, [question]);

  // Map Data
  const plotTraces = useMemo(() => {
    if (!data || !data.points) return [];
    const highlightUrls = new Set((searchResults || []).map(r => r.url));
    const groups = {};
    data.points.forEach(pt => {
      const coords = pt.projections[`${method}_${dim}`];
      if (!coords) return;
      const g = pt[colorBy] || 'Inconnu';
      if (!groups[g]) groups[g] = {
        name: g, x: [], y: [], z: [], text: [], customdata: [],
        hovertemplate: '%{text}<extra></extra>',
        mode: 'markers', type: dim === '2D' ? 'scatter' : 'scatter3d',
        marker: { size: dim === '2D' ? 8 : 5, opacity: highlightUrls.size > 0 ? 0.15 : 1, line: { width: 0 } }
      };
      groups[g].x.push(coords[0]);
      groups[g].y.push(coords[1]);
      if (dim === '3D') groups[g].z.push(coords[2]);
      groups[g].text.push(`<b>${pt.title}</b><br>${pt.date} — ${pt.source}`);
      groups[g].customdata.push(pt.url || '');
    });
    const traces = Object.values(groups);
    if (highlightUrls.size > 0) {
      const hx = [], hy = [], hz = [], ht = [], hd = [];
      data.points.forEach(pt => {
        if (!highlightUrls.has(pt.url)) return;
        const coords = pt.projections[`${method}_${dim}`];
        if (!coords) return;
        hx.push(coords[0]); hy.push(coords[1]);
        if (dim === '3D') hz.push(coords[2]);
        ht.push(`<b>📌 ${pt.title}</b>`);
        hd.push(pt.url || '');
      });
      traces.push({
        name: '📌 Vos Résultats', x: hx, y: hy, z: dim === '3D' ? hz : undefined,
        text: ht, customdata: hd, hovertemplate: '%{text}<extra></extra>', mode: 'markers',
        type: dim === '2D' ? 'scatter' : 'scatter3d',
        marker: { size: dim === '2D' ? 14 : 10, color: '#10b981', symbol: 'diamond' }
      });
    }
    return traces;
  }, [data, method, dim, colorBy, searchResults]);

  // Render Map
  useEffect(() => {
    if (activeView !== 'explore' || !plotRef.current || plotTraces.length === 0) return;
    const is3D = dim === '3D';
    const axisStyle = { gridcolor: 'rgba(0,0,0,0.04)', color: '#64748b', showticklabels: false, title: '' };
    Plotly.react(plotRef.current, plotTraces, {
      colorway: [
        '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981', '#06b6d4',
        '#3b82f6', '#8b5cf6', '#d946ef', '#f43f5e'
      ],
      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: '#94a3b8', family: 'Inter' }, showlegend: true,
      legend: { orientation: 'h', y: -0.1, x: 0.5, xanchor: 'center', bgcolor: 'rgba(255,255,255,0.8)' },
      margin: { l: 0, r: 0, b: 0, t: 0 },
      ...(is3D ? { scene: { xaxis: axisStyle, yaxis: axisStyle, zaxis: axisStyle, bgcolor: 'transparent' } } : { xaxis: axisStyle, yaxis: axisStyle })
    }, { responsive: true, displayModeBar: false });
    plotRef.current.on?.('plotly_click', (e) => {
      const url = e.points[0].customdata;
      if (url) window.open(url, '_blank');
    });
  }, [plotTraces, activeView, dim]);

  if (loading) return <div className="loading-full"><div className="spinner" /><p>Chargement des données...</p></div>;

  return (
    <div className="app-container">
      <nav className="navbar">
        <div className="nav-left">
          <Newspaper className="nav-logo" size={20} />
          <span className="nav-title">Le Kiosque Gabonais</span>
        </div>
        <div className="nav-menu">
          <button className={`nav-item ${activeView === 'explore' ? 'active' : ''}`} onClick={() => setActiveView('explore')}>
            <MapIcon size={16} /> Carte 2D/3D
          </button>
          <button className={`nav-item ${activeView === 'stats' ? 'active' : ''}`} onClick={() => setActiveView('stats')}>
            <BarChart3 size={16} /> Statistiques
          </button>
        </div>
        <div style={{ width: 140 }} /> {/* Spacer */}
      </nav>

      <main className="main-content">
        {activeView === 'explore' ? (
          <>
            <div className="chat-panel">
              <div className="chat-header">
                <div className="chat-header-left">
                  <Database size={16} className="chat-logo" />
                  <span className="chat-subtitle">{data.metadata?.total_articles.toLocaleString()} articles analysés</span>
                </div>
                <button className="controls-toggle" onClick={() => setShowControls(v => !v)}>
                  <SlidersHorizontal size={14} />
                </button>
              </div>

              {showControls && (
                <div className="viz-controls">
                  <div className="viz-row">
                    <span className="viz-label">Format</span>
                    <div className="pill-group">
                      {['2D', '3D'].map(d => <button key={d} className={`pill ${dim === d ? 'active' : ''}`} onClick={() => setDim(d)}>{d}</button>)}
                    </div>
                  </div>
                  <div className="viz-row">
                    <span className="viz-label">Grouper par</span>
                    <div className="select-wrapper">
                      <select className="select-box" value={colorBy} onChange={e => setColorBy(e.target.value)}>
                        <option value="cluster_name">Thématiques IA</option>
                        <option value="category">Rubriques</option>
                        <option value="source">Journal</option>
                      </select>
                      <ChevronDown size={14} className="select-icon" />
                    </div>
                  </div>
                </div>
              )}

              <div className="chat-messages">
                {!searchAnswer && !searchResults && !searching && (
                  <div className="chat-empty">
                    <div className="chat-empty-icon"><Search size={24} /></div>
                    <p className="chat-empty-title">Posez une question</p>
                    <p className="chat-empty-sub">Ex: Quelles sont les nouvelles sur la SEEG ?</p>
                  </div>
                )}
                {searching && <div className="chat-thinking"><Loader size={14} className="spin" /><span>Analyse...</span></div>}
                {searchAnswer && (
                  <div className="msg-ai">
                    <div className="msg-avatar">IA</div>
                    <div className="msg-bubble"><p className="msg-text">{searchAnswer}</p></div>
                  </div>
                )}
                {searchResults && (
                  <div className="results-list">
                    {searchResults.map((art, i) => (
                      <a key={i} href={art.url} target="_blank" className="result-card">
                        <div className="result-meta"><span className="result-source">{art.source}</span><span className="result-date">{art.date}</span></div>
                        <p className="result-title">{art.title}</p>
                      </a>
                    ))}
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              <form className="chat-input-bar" onSubmit={handleSearch}>
                <input className="chat-input" placeholder="Questions..." value={question} onChange={e => setQuestion(e.target.value)} disabled={searching} />
                <button type="submit" className="chat-send-btn" disabled={searching || !question.trim()}>
                  <Search size={18} />
                </button>
              </form>
            </div>
            <div className="plot-panel">
              <div ref={plotRef} className="plot-container" />
            </div>
          </>
        ) : (
          <MetricsDashboard data={data} />
        )}
      </main>
    </div>
  );
}

function MetricsDashboard({ data }) {
  const trendChartRef = useRef(null);
  const catChartRef = useRef(null);

  const stats = useMemo(() => {
    if (!data || !data.points) return null;
    const sources = {};
    const days = {};
    const categories = {}; // { cat: { source: count } }

    const normalizeCategory = (cat) => {
      if (!cat) return 'Autres';
      const c = cat.toLowerCase().trim().replace(/['"«»]/g, '');
      if (c.includes('politique')) return 'Politique';
      if (c.includes('economie') || c.includes('économie')) return 'Économie';
      if (c.includes('societe') || c.includes('société') || c.includes('social')) return 'Société';
      if (c.includes('sport') || c.includes('foot')) return 'Sport';
      if (c.includes('justice') || c.includes('fait divers') || c.includes('faits_divers') || c.includes('faits divers')) return 'Faits Divers / Justice';
      if (c.includes('provinces')) return 'Provinces';
      if (c.includes('culture') || c.includes('musique') || c.includes('cinéma')) return 'Culture';
      if (c.includes('enviro')) return 'Environnement';
      if (c.includes('santé') || c.includes('sante')) return 'Santé';
      if (c.includes('admin') || c.includes('instit')) return 'Administration';
      if (c.includes('diplomatie')) return 'Diplomatie';
      if (c.includes('international')) return 'International';
      if (c.includes('education') || c.includes('formation')) return 'Éducation';
      if (c.includes('communication') || c.includes('médias')) return 'Communication';
      if (c.includes('ia') || c.includes('numérique')) return 'IA / Numérique';
      return cat.charAt(0).toUpperCase() + cat.slice(1);
    };

    try {
      data.points.forEach(pt => {
        if (!pt.source) return;
        
        // Total by source
        sources[pt.source] = (sources[pt.source] || 0) + 1;

        // Daily trend
        if (pt.date) {
          const dayKey = pt.date;
          if (!days[dayKey]) days[dayKey] = {};
          days[dayKey][pt.source] = (days[dayKey][pt.source] || 0) + 1;
        }

        // Category distribution
        const cat = normalizeCategory(pt.category);
        if (!categories[cat]) categories[cat] = {};
        categories[cat][pt.source] = (categories[cat][pt.source] || 0) + 1;
      });

      const sortedDays = Object.keys(days).sort();
      const sourcesList = Object.keys(sources);
      // Colors matching user screenshot: blue, teal, pink, orange
      const colors = { 
        gabonactu: '#3b82f6', 
        gabonmediatime: '#06b6d4', 
        gabonreview: '#d946ef', 
        lunion: '#f97316' 
      };

      // 1. Trend Traces
      const trendTraces = sourcesList.map(src => ({
        name: src,
        x: sortedDays,
        y: sortedDays.map(d => days[d][src] || 0),
        type: 'scatter',
        mode: 'lines+markers',
        line: { shape: 'spline', width: 2, color: colors[src] || '#64748b' },
        marker: { size: 4 }
      }));

      // 2. Category Traces (Stacked Horizontal Bars as Percentages)
      const sortedCats = Object.keys(categories).sort((a, b) => {
        const sumA = Object.values(categories[a]).reduce((s, v) => s + v, 0);
        const sumB = Object.values(categories[b]).reduce((s, v) => s + v, 0);
        return sumA - sumB; 
      });

      const catTraces = sourcesList.map(src => ({
        name: src,
        y: sortedCats,
        x: sortedCats.map(cat => {
          const totalInCat = Object.values(categories[cat]).reduce((s, v) => s + v, 0);
          const count = categories[cat][src] || 0;
          return totalInCat > 0 ? (count / totalInCat) * 100 : 0;
        }),
        type: 'bar',
        orientation: 'h',
        marker: { color: colors[src] || '#64748b' }
      }));

      return { trendTraces, catTraces, total: data.points.length, sources };
    } catch (err) {
      console.error('Error calculating metrics:', err);
      return null;
    }
  }, [data]);

  useEffect(() => {
    if (!trendChartRef.current || !stats || !stats.trendTraces.length) return;
    try {
      Plotly.react(trendChartRef.current, stats.trendTraces, {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        margin: { t: 20, r: 40, l: 60, b: 80 },
        hovermode: 'x unified',
        xaxis: { gridcolor: '#f1f5f9', zeroline: false },
        yaxis: { gridcolor: '#f1f5f9', title: 'Articles par jour' },
        legend: { orientation: 'h', y: -0.2, x: 0.5, xanchor: 'center' }
      }, { responsive: true, displayModeBar: false });

      if (catChartRef.current && stats.catTraces.length) {
        Plotly.react(catChartRef.current, stats.catTraces, {
          barmode: 'stack',
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
          margin: { t: 40, r: 40, l: 150, b: 60 },
          xaxis: { gridcolor: '#f1f5f9', title: 'Percentage of Articles (%)', range: [0, 100], zeroline: false },
          yaxis: { gridcolor: '#f1f5f9', automargin: true },
          title: { text: 'Distribution of Article Categories by News Source', font: { size: 14 } },
          legend: { orientation: 'v', x: 1.05, y: 1 }
        }, { responsive: true, displayModeBar: false });
      }
    } catch (err) {
      console.error('Plotly error:', err);
    }
  }, [stats]);

  if (!stats) return <div className="metrics-view"><p>Erreur lors du calcul des statistiques. Vérifiez la console.</p></div>;

  return (
    <div className="metrics-view">
      <div className="metrics-header">
        <h2 className="metrics-title">Tableau de bord analytique</h2>
        <p className="metrics-subtitle">Fréquence de publication quotidienne et répartition thématique</p>
      </div>

      <div className="metrics-grid">
        <div className="stat-card">
          <span className="stat-label">Total articles</span>
          <div className="stat-value">{stats?.total.toLocaleString()}</div>
        </div>
        {Object.entries(stats?.sources || {}).map(([src, count]) => (
          <div key={src} className="stat-card">
            <span className="stat-label">{src}</span>
            <div className="stat-value">{count.toLocaleString()}</div>
          </div>
        ))}
      </div>

      <div className="chart-container">
        <div className="chart-header">
          <h3 className="chart-title">Évolution de la publication quotidienne</h3>
        </div>
        <div ref={trendChartRef} className="chart-viz" />
      </div>

      <div className="chart-container" style={{ marginTop: '2rem' }}>
        <div ref={catChartRef} className="chart-viz" style={{ height: '600px' }} />
      </div>
    </div>
  );
}
