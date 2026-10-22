import { useState, useEffect } from 'react';
import { sourceLabel } from './format';

// ── Lightweight markdown rendering (bold + bullet lists) ───────────────────
// French typography: "16 000" and "15 %" must never break across lines, so the
// space inside a number, and before %, becomes a narrow no-break space
const keepNumbersWhole = (str) => str
  .replace(/(?<![\d.,])\d{1,3}(?:[ \u00a0]\d{3})+(?![\d])/g, (n) => n.replace(/[ \u00a0]/g, '\u202f'))
  .replace(/(\d)[ \u00a0]%/g, '$1\u202f%');

function formatInline(str) {
  const parts = keepNumbersWhole(str).split(/\*\*(.+?)\*\*/g);
  return parts.map((p, i) => (i % 2 ? <strong key={i}>{p}</strong> : p));
}

export function AnswerText({ text, streaming }) {
  if (streaming) {
    // Mid-stream, an opened **bold** has no closing marker yet: close it virtually
    if ((text.split('**').length - 1) % 2 === 1) text += '**';
    // A bare list marker on the last line would flash as a stray character
    text = text.replace(/\n[ \t]*[-•*][ \t]*$/, '');
  }
  const blocks = [];
  let list = null;
  text.split('\n').forEach(line => {
    const m = line.match(/^\s*[-•*]\s+(.*)/);
    const h = line.match(/^\s*#{1,4}\s+(.*)/);
    if (m) {
      if (!list) { list = []; blocks.push({ type: 'ul', items: list }); }
      list.push(m[1]);
    } else {
      list = null;
      if (h) blocks.push({ type: 'h', text: h[1] });
      else if (line.trim()) blocks.push({ type: 'p', text: line });
    }
  });
  return (
    <div className="k-prose">
      {blocks.map((b, i) =>
        b.type === 'ul' ? <ul key={i}>{b.items.map((it, j) => <li key={j}>{formatInline(it)}</li>)}</ul>
          : b.type === 'h' ? <h4 key={i}>{formatInline(b.text)}</h4>
            : <p key={i}>{formatInline(b.text)}</p>
      )}
      {streaming && <span className="k-cursor" />}
    </div>
  );
}

// Waiting label that advances through phases: perceived wait drops when the system visibly progresses
export function ThinkingLabel({ phrases, interval = 5000 }) {
  const [step, setStep] = useState(0);
  const key = phrases.join('|');
  useEffect(() => {
    setStep(0);
    const id = setInterval(() => setStep(s => Math.min(s + 1, phrases.length - 1)), interval);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, interval]);
  return <span>{phrases[Math.min(step, phrases.length - 1)]}</span>;
}

export function Thinking({ phrases, interval }) {
  return (
    <div className="k-thinking" role="status" aria-live="polite">
      <span className="k-dots" aria-hidden="true"><i /><i /><i /></span>
      <ThinkingLabel phrases={phrases} interval={interval} />
    </div>
  );
}

// How many articles from how many outlets: flags an answer resting on a single outlet
export function ProvenanceLine({ sources }) {
  if (!sources || sources.length === 0) return null;
  const counts = {};
  sources.forEach(s => { counts[s.source] = (counts[s.source] || 0) + 1; });
  const bySource = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = sources.length;
  if (bySource.length === 1) {
    return (
      <p className="k-provenance single">
        Une seule source : <strong>{sourceLabel(bySource[0][0])}</strong> ({total} article{total > 1 ? 's' : ''})
      </p>
    );
  }
  return (
    <p className="k-provenance">
      {total} articles de {bySource.length} sources : {bySource.map(([s, c]) => `${sourceLabel(s)} (${c})`).join(', ')}
    </p>
  );
}

export function SourceList({ sources }) {
  if (!sources?.length) return null;
  return (
    <div className="k-sources">
      <ProvenanceLine sources={sources} />
      <h3 className="k-kicker">Sources</h3>
      <ol>
        {sources.map((art, i) => (
          <li key={i}>
            <a href={art.url} target="_blank" rel="noreferrer">
              <span className="k-src-n">{i + 1}</span>
              <span className="k-src-title">{art.title}</span>
              <span className="k-src-meta">{sourceLabel(art.source)}{art.date ? ` · ${art.date}` : ''}</span>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

// Shape of a report while the model is still reading the headlines
export function ReportSkeleton({ themes = 3 }) {
  return (
    <div className="k-skeleton" aria-hidden="true">
      <div className="w90" /><div className="w75" /><div className="w60" />
      {Array.from({ length: themes }).map((_, i) => (
        <div key={i} className="k-skeleton-theme"><div className="t w40" /><div className="w85" /><div className="w70" /></div>
      ))}
    </div>
  );
}
