import { useState, useEffect, useRef, useMemo } from 'react';
import Plotly from 'plotly.js-dist-min';
import { Newspaper, ChevronDown, Database, Activity } from 'lucide-react';
import './index.css';

export default function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Controls state
  const [method, setMethod] = useState('PCA'); // PCA | UMAP
  const [dim, setDim] = useState('2D');        // 2D | 3D
  const [colorBy, setColorBy] = useState('category'); // category | source

  const plotRef = useRef(null);

  useEffect(() => {
    fetch('/data.json')
      .then(res => {
        if (!res.ok) throw new Error('Data file not found. Ensure export_embeddings.py was run.');
        return res.json();
      })
      .then(json => {
        setData(json);
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setError(err.message);
        setLoading(false);
      });
  }, []);

  // Build Plotly traces
  const plotTraces = useMemo(() => {
    if (!data || !data.points) return [];

    const groups = {};

    data.points.forEach(pt => {
      const projKey = `${method}_${dim}`;
      const coords = pt.projections[projKey];
      if (!coords) return;

      const groupName = pt[colorBy] || 'unknown';
      if (!groups[groupName]) {
        groups[groupName] = {
          name: groupName,
          x: [], y: [], z: [],
          text: [],
          customdata: [],   // stores article URLs for click-to-open
          hovertemplate: '%{text}<extra></extra>',
          mode: 'markers',
          type: dim === '2D' ? 'scatter' : 'scatter3d',
          marker: { size: dim === '2D' ? 8 : 4, opacity: 0.85, line: { width: 0 } }
        };
      }

      groups[groupName].x.push(coords[0]);
      groups[groupName].y.push(coords[1]);
      if (dim === '3D') groups[groupName].z.push(coords[2]);

      const snippet = pt.snippet ? pt.snippet.substring(0, 200) : '';
      groups[groupName].text.push(`<b>${pt.title}</b><br>${pt.date} — ${pt.source}<br><br>${snippet}<br><br><i>🔗 Click to open article</i>`);
      groups[groupName].customdata.push(pt.url || '');
    });

    return Object.values(groups);
  }, [data, method, dim, colorBy]);

  // Render/update Plotly chart imperatively via useEffect
  useEffect(() => {
    if (!plotRef.current || plotTraces.length === 0) return;

    const is3D = dim === '3D';

    const layout = {
      title: { text: `${method} ${dim} — Articles de Presse`, font: { color: '#e6edf3', family: 'Inter', size: 18 } },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: '#8b949e', family: 'Inter' },
      hovermode: 'closest',
      margin: { l: 40, r: 20, b: 40, t: 60 },
      showlegend: true,
      legend: { font: { color: '#e6edf3' }, bgcolor: 'rgba(22,27,34,0.7)', bordercolor: 'rgba(255,255,255,0.1)', borderwidth: 1 },
      ...(is3D ? {
        scene: {
          xaxis: { title: `${method} 1`, gridcolor: 'rgba(255,255,255,0.1)', zerolinecolor: 'rgba(255,255,255,0.2)' },
          yaxis: { title: `${method} 2`, gridcolor: 'rgba(255,255,255,0.1)', zerolinecolor: 'rgba(255,255,255,0.2)' },
          zaxis: { title: `${method} 3`, gridcolor: 'rgba(255,255,255,0.1)', zerolinecolor: 'rgba(255,255,255,0.2)' },
          bgcolor: 'rgba(0,0,0,0)'
        }
      } : {
        xaxis: { title: `${method} 1`, gridcolor: 'rgba(255,255,255,0.05)', zerolinecolor: 'rgba(255,255,255,0.1)' },
        yaxis: { title: `${method} 2`, gridcolor: 'rgba(255,255,255,0.05)', zerolinecolor: 'rgba(255,255,255,0.1)' }
      })
    };

    Plotly.react(plotRef.current, plotTraces, layout, { responsive: true, displayModeBar: true });

    // Click handler: open article URL in a new tab
    const el = plotRef.current;
    el.removeAllListeners('plotly_click');
    el.on('plotly_click', (eventData) => {
      const pt = eventData.points[0];
      const url = pt.customdata;
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
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
            Visualisez la distribution thématique des articles de presse extraits de GabonReview et GabonMediaTime.
          </p>
        </div>

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
        {loading && (
          <div className="loading-container">
            <div className="spinner"></div>
            <p>Chargement des embeddings...</p>
          </div>
        )}

        {error && (
          <div className="error-container">
            <Activity size={32} style={{ margin: '0 auto 12px' }} />
            <h3>Erreur de Chargement</h3>
            <p>{error}</p>
          </div>
        )}

        {!loading && !error && (
          <div ref={plotRef} className="plot-container" />
        )}
      </main>
    </div>
  );
}
