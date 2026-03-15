import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Plotly from 'plotly.js-dist-min';
import { Newspaper, Search, ExternalLink, Loader, ChevronDown, Database, SlidersHorizontal } from 'lucide-react';
import './index.css';

const API_URL = 'http://localhost:8000';

export default function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Viz controls (Internal state, hidden from general public)
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
      setSearchError("Impossible de joindre l'API d'Intelligence Artificielle.");
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
      groups[g].text.push(`<b>${pt.title}</b><br>${pt.date} — ${pt.source}<br><i>👉 Cliquer pour lire l'article</i>`);
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
        ht.push(`<b>Sélection #${rank} : ${pt.title}</b><br><i>👉 Cliquer pour lire l'article</i>`);
        hd.push(pt.url || '');
      });
      traces.push({
        name: '📌 Vos Résultats',
        x: hx, y: hy, z: dim === '3D' ? hz : undefined,
        text: ht, customdata: hd,
        hovertemplate: '%{text}<extra></extra>',
        mode: 'markers', type: dim === '2D' ? 'scatter' : 'scatter3d',
        marker: { size: dim === '2D' ? 14 : 10, color: '#10b981', opacity: 1, line: { color: '#ffffff', width: 2 }, symbol: 'diamond' }
      });
    }
    return traces;
  }, [data, method, dim, colorBy, searchResults]);

  // Render Plotly
  useEffect(() => {
    if (!plotRef.current || plotTraces.length === 0) return;
    const is3D = dim === '3D';
    const axisStyle = {
      gridcolor: 'rgba(255,255,255,0.04)',
      zerolinecolor: 'rgba(255,255,255,0.08)',
      color: '#64748b',
      showticklabels: false,
      title: ''
    };
    Plotly.react(plotRef.current, plotTraces, {
      colorway: [
        '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981', '#06b6d4',
        '#3b82f6', '#8b5cf6', '#d946ef', '#f43f5e', '#b91c1c', '#ea580c',
        '#d97706', '#65a30d', '#059669', '#0891b2', '#2563eb', '#7c3aed',
        '#c026d3', '#e11d48', '#7f1d1d', '#9a3412', '#92400e', '#3f6212',
        '#064e3b', '#164e63', '#1e3a8a', '#4c1d95', '#701a75', '#881337'
      ],
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: '#94a3b8', family: 'Inter' },
      hovermode: 'closest',
      margin: { l: 0, r: 0, b: 0, t: 0 },
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.1, x: 0.5, xanchor: 'center', yanchor: 'top',
        font: { color: '#f8fafc', size: 10 },
        bgcolor: 'rgba(15,23,42,0.85)',
        bordercolor: 'rgba(255,255,255,0.1)',
        borderwidth: 1,
        itemsizing: 'constant'
      },
      ...(is3D ? {
        scene: {
          xaxis: axisStyle, yaxis: axisStyle, zaxis: axisStyle,
          bgcolor: 'transparent',
          camera: { eye: { x: 1.5, y: 1.5, z: 1.2 } }
        }
      } : {
        xaxis: axisStyle,
        yaxis: axisStyle
      })
    }, { responsive: true, displayModeBar: false });

    plotRef.current.removeAllListeners?.('plotly_click');
    plotRef.current.on('plotly_click', (e) => {
      const url = e.points[0].customdata;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    });
  }, [plotTraces]);

  return (
    <div className="app">
      {/* ── Chat Panel (primary) ─────────────────────── */}
      <div className="chat-panel">

        {/* Header */}
        <div className="chat-header">
          <div className="chat-header-left">
            <div className="chat-logo-container">
              <Newspaper size={24} className="chat-logo" />
            </div>
            <div>
              <h1 className="chat-title">Le Kiosque Gabonais</h1>
              {data && <span className="chat-subtitle">{data.metadata?.total_articles.toLocaleString()} articles analysés en {dim}</span>}
            </div>
          </div>
          <button className="controls-toggle" onClick={() => setShowControls(v => !v)} title="Options d'affichage">
            <SlidersHorizontal size={18} />
          </button>
        </div>

        {/* User-friendly controls */}
        {showControls && (
          <div className="viz-controls">
            <div className="viz-row">
              <span className="viz-label">Format</span>
              <div className="pill-group">
                {['2D', '3D'].map(d => <button key={d} className={`pill ${dim === d ? 'active' : ''}`} onClick={() => setDim(d)}>{d}</button>)}
              </div>
            </div>
            <div className="viz-row">
              <span className="viz-label">Colorer la carte par</span>
              <div className="select-wrapper">
                <select className="select-box" value={colorBy} onChange={e => setColorBy(e.target.value)}>
                  <option value="cluster_name">Grandes Thématiques (Déduites par l'IA)</option>
                  <option value="category">Rubriques Classiques</option>
                  <option value="source">Journal Source</option>
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
              <div className="chat-empty-icon">
                <Search size={32} />
              </div>
              <p className="chat-empty-title">Que souhaitez-vous savoir ?</p>
              <p className="chat-empty-sub">Posez-moi une question sur l'actualité du Gabon. Je chercherai les meilleures sources pour vous répondre.</p>

              <div className="chat-suggestions">
                <button className="suggestion-chip" onClick={() => setQuestion("Que dit-on sur la SEEG et les délestages ?")}>💡 La SEEG et l'énergie</button>
                <button className="suggestion-chip" onClick={() => setQuestion("Quelles sont les dernières actualités sportives du pays ?")}>💡 Dernières infos sport</button>
                <button className="suggestion-chip" onClick={() => setQuestion("Que pense le gouvernement de la dette ?")}>💡 Le gouvernement et la dette</button>
              </div>
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
