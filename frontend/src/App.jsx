import { useState, useEffect, useMemo } from 'react';
import Plot from 'react-plotly.js';
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

  // Prepare plot data whenever controls or data changes
  const plotData = useMemo(() => {
    if (!data || !data.points) return [];

    // Group points by the chosen color property (category or source)
    const groups = {};

    data.points.forEach(pt => {
      const projKey = `${method}_${dim}`;
      const coords = pt.projections[projKey];
      if (!coords) return;

      const groupName = pt[colorBy] || 'unknown';
      if (!groups[groupName]) {
        groups[groupName] = {
          name: groupName,
          x: [],
          y: [],
          z: [],
          text: [],
          hoverinfo: 'text',
          mode: 'markers',
          type: dim === '2D' ? 'scatter' : 'scatter3d',
          marker: {
            size: dim === '2D' ? 8 : 4,
            opacity: 0.85,
            line: { width: 0 }
          }
        };
      }

      groups[groupName].x.push(coords[0]);
      groups[groupName].y.push(coords[1]);
      if (dim === '3D') groups[groupName].z.push(coords[2]);

      // Build hover text
      const hover = `
        <b>${pt.title}</b><br>
        <i>${pt.date}</i> | Source: ${pt.source}<br><br>
        ${pt.snippet}
      `;
      groups[groupName].text.push(hover);
    });

    return Object.values(groups);
  }, [data, method, dim, colorBy]);

  // Layout configuration for Plotly
  const plotLayout = useMemo(() => {
    const is3D = dim === '3D';

    const commonLayout = {
      title: {
        text: `${method} ${dim} — Articles de Presse`,
        font: { color: '#e6edf3', family: 'Inter', size: 18 }
      },
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: { color: '#8b949e', family: 'Inter' },
      hovermode: 'closest',
      margin: { l: 0, r: 0, b: 0, t: 60 },
      showlegend: true,
      legend: {
        font: { color: '#e6edf3' },
        bgcolor: 'rgba(22, 27, 34, 0.7)',
        bordercolor: 'rgba(255,255,255,0.1)',
        borderwidth: 1,
        borderpad: 8
      }
    };

    if (is3D) {
      return {
        ...commonLayout,
        scene: {
          xaxis: { title: `${method} 1`, showgrid: true, gridcolor: 'rgba(255,255,255,0.1)', zerolinecolor: 'rgba(255,255,255,0.2)' },
          yaxis: { title: `${method} 2`, showgrid: true, gridcolor: 'rgba(255,255,255,0.1)', zerolinecolor: 'rgba(255,255,255,0.2)' },
          zaxis: { title: `${method} 3`, showgrid: true, gridcolor: 'rgba(255,255,255,0.1)', zerolinecolor: 'rgba(255,255,255,0.2)' },
          bgcolor: 'transparent'
        }
      };
    } else {
      return {
        ...commonLayout,
        xaxis: { title: `${method} 1`, showgrid: true, gridcolor: 'rgba(255,255,255,0.05)', zerolinecolor: 'rgba(255,255,255,0.1)' },
        yaxis: { title: `${method} 2`, showgrid: true, gridcolor: 'rgba(255,255,255,0.05)', zerolinecolor: 'rgba(255,255,255,0.1)' }
      };
    }
  }, [method, dim]);

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
            <button
              className={`radio-btn ${method === 'PCA' ? 'active' : ''}`}
              onClick={() => setMethod('PCA')}
            >PCA</button>
            <button
              className={`radio-btn ${method === 'UMAP' ? 'active' : ''}`}
              onClick={() => setMethod('UMAP')}
            >UMAP</button>
          </div>
        </div>

        <div className="control-group">
          <label className="control-label">Dimensions</label>
          <div className="radio-group">
            <button
              className={`radio-btn ${dim === '2D' ? 'active' : ''}`}
              onClick={() => setDim('2D')}
            >2D</button>
            <button
              className={`radio-btn ${dim === '3D' ? 'active' : ''}`}
              onClick={() => setDim('3D')}
            >3D</button>
          </div>
        </div>

        <div className="control-group">
          <label className="control-label">Color Coding</label>
          <div className="select-wrapper">
            <select
              className="select-box"
              value={colorBy}
              onChange={e => setColorBy(e.target.value)}
            >
              <option value="category">Category</option>
              <option value="source">News Source</option>
            </select>
            <ChevronDown size={16} className="select-icon" />
          </div>
        </div>

        {data && (
          <div className="stats-card">
            <div className="stats-icon">
              <Database size={24} />
            </div>
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
          <div className="plot-container">
            <Plot
              data={plotData}
              layout={plotLayout}
              config={{ responsive: true, displayModeBar: true }}
              style={{ width: '100%', height: '100%' }}
              useResizeHandler={true}
            />
          </div>
        )}
      </main>
    </div>
  );
}
