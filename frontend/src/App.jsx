import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Plotly from 'plotly.js-dist-min';
import { Newspaper, Search, ExternalLink, Loader, ChevronDown, Database, SlidersHorizontal } from 'lucide-react';
import './index.css';

const API_URL = 'http://localhost:8000';

export default function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Viz controls
  const [method, setMethod] = useState('PCA');
  const [dim, setDim] = useState('2D');
  const [colorBy, setColorBy] = useState('category');
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

  // Scroll chat to bottom when results arrive
  useEffect(() => {
    if (searchAnswer || searchResults) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [searchAnswer, searchResults]);

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

  // Semantic search
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
      setSearchError("Impossible de joindre l'API. Lancez: .venv/bin/python api.py");
    } finally {
      setSearching(false);
    }
  }, [question]);

  // Build Plotly traces
  const plotTraces = useMemo(() => {
    if (!data || !data.points) return [];
    const highlightUrls = new Set((searchResults || []).map(r => r.url));
    const groups = {};

    data.points.forEach(pt => {
      const coords = pt.projections[`${method}_${dim}`];
      if (!coords) return;
      const g = pt[colorBy] || 'unknown';
      if (!groups[g]) groups[g] = {
        name: g, x: [], y: [], z: [], text: [], customdata: [],
        hovertemplate: '%{text}<extra></extra>',
        mode: 'markers', type: dim === '2D' ? 'scatter' : 'scatter3d',
        marker: { size: dim === '2D' ? 6 : 3, opacity: highlightUrls.size > 0 ? 0.2 : 0.8, line: { width: 0 } }
      };
      groups[g].x.push(coords[0]);
      groups[g].y.push(coords[1]);
      if (dim === '3D') groups[g].z.push(coords[2]);
      groups[g].text.push(`<b>${pt.title}</b><br>${pt.date} — ${pt.source}<br><i>🔗 Cliquer pour ouvrir</i>`);
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
        const rank = (searchResults || []).findIndex(r => r.url === pt.url) + 1;
        ht.push(`<b>#${rank} — ${pt.title}</b><br><i>🔗 Cliquer pour ouvrir</i>`);
        hd.push(pt.url || '');
      });
      traces.push({
        name: '🔍 Résultats',
        x: hx, y: hy, z: dim === '3D' ? hz : undefined,
        text: ht, customdata: hd,
        hovertemplate: '%{text}<extra></extra>',
        mode: 'markers', type: dim === '2D' ? 'scatter' : 'scatter3d',
        marker: { size: dim === '2D' ? 18 : 9, color: '#00adef', opacity: 1, line: { color: '#fff', width: 2 }, symbol: 'star' }
      });
    }
    return traces;
  }, [data, method, dim, colorBy, searchResults]);

  // Render Plotly
  useEffect(() => {
    if (!plotRef.current || plotTraces.length === 0) return;
    const is3D = dim === '3D';
    const axisStyle = { gridcolor: 'rgba(0,173,239,0.07)', zerolinecolor: 'rgba(0,173,239,0.15)', color: '#4e6278' };
    Plotly.react(plotRef.current, plotTraces, {
      title: { text: `${method} ${dim}`, font: { color: '#94a3b8', family: 'Inter', size: 13 } },
      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(15,25,35,0.5)',
      font: { color: '#94a3b8', family: 'Inter' },
      hovermode: 'closest', margin: { l: 30, r: 10, b: 30, t: 40 }, showlegend: true,
      legend: { font: { color: '#fff', size: 10 }, bgcolor: 'rgba(15,25,35,0.9)', bordercolor: 'rgba(0,173,239,0.2)', borderwidth: 1 },
      ...(is3D ? {
        scene: {
          xaxis: { ...axisStyle, title: '' }, yaxis: { ...axisStyle, title: '' }, zaxis: { ...axisStyle, title: '' },
          bgcolor: 'rgba(15,25,35,0.3)'
        }
      } : { xaxis: { ...axisStyle, title: '' }, yaxis: { ...axisStyle, title: '' } })
    }, { responsive: true, displayModeBar: false });

    plotRef.current.removeAllListeners?.('plotly_click');
    plotRef.current.on('plotly_click', (e) => {
      const url = e.points[0].customdata;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    });
  }, [plotTraces, method, dim]);

  return (
    <div className="app">
      {/* ── Chat Panel (primary) ─────────────────────── */}
      <div className="chat-panel">

        {/* Header */}
        <div className="chat-header">
          <div className="chat-header-left">
            <Newspaper size={22} className="chat-logo" />
            <div>
              <h1 className="chat-title">GABON MEDIA RAG</h1>
              {data && <span className="chat-subtitle">{data.metadata?.total_articles || 0} articles indexés</span>}
            </div>
          </div>
          <button className="controls-toggle" onClick={() => setShowControls(v => !v)} title="Paramètres visualisation">
            <SlidersHorizontal size={16} />
          </button>
        </div>

        {/* Viz controls (collapsible) */}
        {showControls && (
          <div className="viz-controls">
            <div className="viz-row">
              <span className="viz-label">Projection</span>
              <div className="pill-group">
                {['PCA', 'UMAP'].map(m => <button key={m} className={`pill ${method === m ? 'active' : ''}`} onClick={() => setMethod(m)}>{m}</button>)}
              </div>
            </div>
            <div className="viz-row">
              <span className="viz-label">Dimensions</span>
              <div className="pill-group">
                {['2D', '3D'].map(d => <button key={d} className={`pill ${dim === d ? 'active' : ''}`} onClick={() => setDim(d)}>{d}</button>)}
              </div>
            </div>
            <div className="viz-row">
              <span className="viz-label">Couleur</span>
              <div className="select-wrapper">
                <select className="select-box" value={colorBy} onChange={e => setColorBy(e.target.value)}>
                  <option value="category">Catégorie</option>
                  <option value="source">Source</option>
                </select>
                <ChevronDown size={14} className="select-icon" />
              </div>
            </div>
          </div>
        )}

        {/* Chat messages area */}
        <div className="chat-messages">
          {!searchAnswer && !searchResults && !searching && (
            <div className="chat-empty">
              <Search size={40} style={{ color: 'var(--accent)', opacity: 0.4, marginBottom: 12 }} />
              <p className="chat-empty-title">Posez une question</p>
              <p className="chat-empty-sub">Ex: Que dit-on sur la SEEG? Qui est Kessany? Situation économique?</p>
            </div>
          )}

          {searching && (
            <div className="chat-thinking">
              <Loader size={16} className="spin" />
              <span>Recherche en cours...</span>
            </div>
          )}

          {searchError && <p className="chat-error">{searchError}</p>}

          {searchAnswer && (
            <div className="msg-ai">
              <div className="msg-avatar">IA</div>
              <div className="msg-bubble">
                <p className="msg-text">{searchAnswer}</p>
              </div>
            </div>
          )}

          {searchResults && searchResults.length > 0 && (
            <div className="results-section">
              <p className="results-header">📰 Sources ({searchResults.length} articles)</p>
              <div className="results-list">
                {searchResults.map((art, i) => (
                  <a key={i} href={art.url} target="_blank" rel="noopener noreferrer" className="result-card">
                    <div className="result-meta">
                      <span className="result-source">{art.source}</span>
                      <span className="result-date">{art.date}</span>
                    </div>
                    <p className="result-title">{art.title}</p>
                    <div className="result-link"><ExternalLink size={11} /> Ouvrir l'article</div>
                  </a>
                ))}
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Input fixed at bottom */}
        <form className="chat-input-bar" onSubmit={handleSearch}>
          <input
            ref={inputRef}
            className="chat-input"
            type="text"
            placeholder="Posez une question sur l'actualité gabonaise..."
            value={question}
            onChange={e => setQuestion(e.target.value)}
            disabled={searching}
          />
          <button type="submit" className="chat-send-btn" disabled={searching || !question.trim()}>
            {searching ? <Loader size={18} className="spin" /> : <Search size={18} />}
          </button>
        </form>
      </div>

      {/* ── Visualization Panel (secondary) ─────────── */}
      <div className="plot-panel">
        {loading && <div className="plot-loading"><div className="spinner" /><p>Chargement...</p></div>}
        {error && <div className="plot-error"><p>{error}</p></div>}
        {!loading && !error && <div ref={plotRef} className="plot-container" />}
      </div>
    </div>
  );
}
