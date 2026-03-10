import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Plotly from 'plotly.js-dist-min';
import { Newspaper, ChevronDown, Database, Search, ExternalLink, Loader } from 'lucide-react';
import './index.css';

const API_URL = 'http://localhost:8000';

export default function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Plot controls
  const [method, setMethod] = useState('PCA');
  const [dim, setDim] = useState('2D');
  const [colorBy, setColorBy] = useState('category');

  // Search state
  const [question, setQuestion] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState(null);
  const [searchError, setSearchError] = useState(null);

  const plotRef = useRef(null);

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

  // Semantic search via the Python API
  const handleSearch = useCallback(async (e) => {
    e?.preventDefault();
    if (!question.trim()) return;

    setSearching(true);
    setSearchError(null);
    setSearchResults(null);

    try {
      const res = await fetch(`${API_URL}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question.trim(), n_results: 5 }),
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const json = await res.json();
      setSearchResults(json.results);
    } catch (err) {
      setSearchError("Could not reach the API server. Make sure it's running: .venv/bin/python api.py");
    } finally {
      setSearching(false);
    }
  }, [question]);

  // Build Plotly traces
  const plotTraces = useMemo(() => {
    if (!data || !data.points) return [];
    const groups = {};
    // Build a set of URLs from current search results for fast lookup
    const highlightUrls = new Set((searchResults || []).map(r => r.url));

    data.points.forEach(pt => {
      const projKey = `${method}_${dim}`;
      const coords = pt.projections[projKey];
      if (!coords) return;
      const groupName = pt[colorBy] || 'unknown';
      if (!groups[groupName]) {
        groups[groupName] = {
          name: groupName, x: [], y: [], z: [], text: [], customdata: [],
          hovertemplate: '%{text}<extra></extra>',
          mode: 'markers', type: dim === '2D' ? 'scatter' : 'scatter3d',
          marker: { size: dim === '2D' ? 7 : 4, opacity: highlightUrls.size > 0 ? 0.25 : 0.85, line: { width: 0 } }
        };
      }
      groups[groupName].x.push(coords[0]);
      groups[groupName].y.push(coords[1]);
      if (dim === '3D') groups[groupName].z.push(coords[2]);
      const snippet = pt.snippet ? pt.snippet.substring(0, 200) : '';
      groups[groupName].text.push(`<b>${pt.title}</b><br>${pt.date} — ${pt.source}<br><br>${snippet}<br><br><i>🔗 Click to open article</i>`);
      groups[groupName].customdata.push(pt.url || '');
    });

    const baseTraces = Object.values(groups);

    // Highlighted search result overlay
    if (highlightUrls.size > 0) {
      const hx = [], hy = [], hz = [], htxt = [], hdata = [];
      data.points.forEach(pt => {
        if (!highlightUrls.has(pt.url)) return;
        const coords = pt.projections[`${method}_${dim}`];
        if (!coords) return;
        hx.push(coords[0]); hy.push(coords[1]);
        if (dim === '3D') hz.push(coords[2]);
        // Find rank in results
        const rank = (searchResults || []).findIndex(r => r.url === pt.url) + 1;
        htxt.push(`<b>#${rank} — ${pt.title}</b><br>${pt.date} — ${pt.source}<br><br><i>🔗 Click to open article</i>`);
        hdata.push(pt.url || '');
      });
      baseTraces.push({
        name: '🔍 Résultats de recherche',
        x: hx, y: hy, z: dim === '3D' ? hz : undefined,
        text: htxt, customdata: hdata,
        hovertemplate: '%{text}<extra></extra>',
        mode: 'markers', type: dim === '2D' ? 'scatter' : 'scatter3d',
        marker: {
          size: dim === '2D' ? 16 : 8,
          color: '#58a6ff',
          opacity: 1,
          line: { color: '#ffffff', width: 2 },
          symbol: 'star'
        }
      });
    }

    return baseTraces;
  }, [data, method, dim, colorBy, searchResults]);

  // Render Plotly chart
  useEffect(() => {
    if (!plotRef.current || plotTraces.length === 0) return;
    const is3D = dim === '3D';
    const layout = {
      title: { text: `${method} ${dim} — Articles de Presse Gabonaise`, font: { color: '#ffffff', family: 'Inter', size: 16, weight: 700 } },
      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(15,25,35,0.6)',
      font: { color: '#94a3b8', family: 'Inter' },
      hovermode: 'closest', margin: { l: 40, r: 20, b: 40, t: 50 }, showlegend: true,
      legend: { font: { color: '#ffffff', size: 11 }, bgcolor: 'rgba(15,25,35,0.85)', bordercolor: 'rgba(0,173,239,0.2)', borderwidth: 1 },
      ...(is3D ? {
        scene: {
          xaxis: { title: `${method} 1`, gridcolor: 'rgba(0,173,239,0.1)', zerolinecolor: 'rgba(0,173,239,0.3)', color: '#94a3b8' },
          yaxis: { title: `${method} 2`, gridcolor: 'rgba(0,173,239,0.1)', zerolinecolor: 'rgba(0,173,239,0.3)', color: '#94a3b8' },
          zaxis: { title: `${method} 3`, gridcolor: 'rgba(0,173,239,0.1)', zerolinecolor: 'rgba(0,173,239,0.3)', color: '#94a3b8' },
          bgcolor: 'rgba(15,25,35,0.3)'
        }
      } : {
        xaxis: { title: `${method} 1`, gridcolor: 'rgba(0,173,239,0.07)', zerolinecolor: 'rgba(0,173,239,0.15)', color: '#4e6278' },
        yaxis: { title: `${method} 2`, gridcolor: 'rgba(0,173,239,0.07)', zerolinecolor: 'rgba(0,173,239,0.15)', color: '#4e6278' }
      })
    };
    Plotly.react(plotRef.current, plotTraces, layout, { responsive: true, displayModeBar: true });
    const el = plotRef.current;
    el.removeAllListeners('plotly_click');
    el.on('plotly_click', (eventData) => {
      const url = eventData.points[0].customdata;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    });
  }, [plotTraces, method, dim]);

  return (
    <div className="app-container">
      <aside className="sidebar">
        <div>
          <header className="header">
            <Newspaper size={28} className="logo-icon" />
            <h1 className="title">Gabon Media RAG</h1>
          </header>
          <p className="description">
            Visualisez et interrogez les articles de presse extraits de GabonReview et GabonMediaTime.
          </p>
        </div>

        {/* ── Search Panel ───────────────────────────────── */}
        <div className="search-section">
          <label className="control-label">
            <Search size={13} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            Poser une question
          </label>
          <form onSubmit={handleSearch} className="search-form">
            <textarea
              className="search-input"
              placeholder="Ex: Que dit l'opposition sur la transition ?"
              value={question}
              onChange={e => setQuestion(e.target.value)}
              rows={3}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) handleSearch(e); }}
            />
            <button type="submit" className="search-btn" disabled={searching || !question.trim()}>
              {searching ? <Loader size={16} className="spin" /> : <Search size={16} />}
              {searching ? 'Recherche...' : 'Rechercher'}
            </button>
          </form>

          {searchError && (
            <p className="search-error">{searchError}</p>
          )}

          {searchResults && searchResults.length > 0 && (
            <div className="search-results">
              <p className="results-label">{searchResults.length} articles les plus proches :</p>
              {searchResults.map((art, i) => (
                <a
                  key={i}
                  href={art.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="result-card"
                >
                  <div className="result-header">
                    <span className="result-source">{art.source}</span>
                    <span className="result-date">{art.date}</span>
                  </div>
                  <p className="result-title">{art.title}</p>
                  <p className="result-snippet">{art.snippet.substring(0, 120)}…</p>
                  <div className="result-link">
                    <ExternalLink size={12} /> Ouvrir l'article
                  </div>
                </a>
              ))}
            </div>
          )}

          {searchResults && searchResults.length === 0 && (
            <p className="search-error">Aucun résultat trouvé.</p>
          )}
        </div>

        {/* ── Plot Controls ───────────────────────────────── */}
        <div className="control-group">
          <label className="control-label">Projection Method</label>
          <div className="radio-group">
            {['PCA', 'UMAP'].map(m => (
              <button key={m} className={`radio-btn ${method === m ? 'active' : ''}`} onClick={() => setMethod(m)}>{m}</button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <label className="control-label">Dimensions</label>
          <div className="radio-group">
            {['2D', '3D'].map(d => (
              <button key={d} className={`radio-btn ${dim === d ? 'active' : ''}`} onClick={() => setDim(d)}>{d}</button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <label className="control-label">Color Coding</label>
          <div className="select-wrapper">
            <select className="select-box" value={colorBy} onChange={e => setColorBy(e.target.value)}>
              <option value="category">Category</option>
              <option value="source">News Source</option>
            </select>
            <ChevronDown size={16} className="select-icon" />
          </div>
        </div>

        {data && (
          <div className="stats-card">
            <div className="stats-icon"><Database size={24} /></div>
            <div className="stats-info">
              <span className="stats-value">{data.metadata?.total_articles || 0}</span>
              <span className="stats-label">Articles Loadés</span>
            </div>
          </div>
        )}
      </aside>

      <main className="main-content">
        {loading && <div className="loading-container"><div className="spinner"></div><p>Chargement des embeddings...</p></div>}
        {error && <div className="error-container"><p>{error}</p></div>}
        {!loading && !error && <div ref={plotRef} className="plot-container" />}
      </main>
    </div>
  );
}
