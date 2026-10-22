import { useState, useEffect } from 'react';
import { sourceLabel } from './format';

// ── Lightweight markdown rendering (bold + bullet lists) ───────────────────
// French typography: "16 000" and "15 %" must never break across lines, so the
// space inside a number, and before %, becomes a narrow no-break space
const keepNumbersWhole = (str) => str
  .replace(/(?<![\d.,])\d{1,3}(?:[ \u00a0]\d{3})+(?![\d])/g, (n) => n.replace(/[ \u00a0]/g, '\u202f'))
  .replace(/(\d)[ \u00a0]%/g, '$1\u202f%');

// [n] in an answer cites the n-th source: a small number that opens the article.
// A run of them ("Gabon [1][2][3]."), with the punctuation after it, stays on one
// line and against the word before: badges and a lone full stop wrapped badly.
function withCitations(str, sources, key) {
  if (!sources?.length) return str;
  return str.split(/\s*((?:\[\d{1,2}\])+[.,;:!?»)]*)/g).map((p, i) => {
    if (i % 2 === 0) return p;
    const [, refs, punct] = p.match(/^((?:\[\d{1,2}\])+)(.*)$/);
    const badges = [...refs.matchAll(/\[(\d{1,2})\]/g)].map(([, n], j) => {
      const src = sources[n - 1];
      if (!src) return null;
      return (
        <sup key={j} className="k-cite">
          <a href={src.url} target="_blank" rel="noreferrer" title={`${sourceLabel(src.source)} : ${src.title}`}
            aria-label={`Source ${n} : ${src.title}`}>{n}</a>
        </sup>
      );
    });
    return <span key={`${key}-${i}`} className="k-cites">{badges}{punct}</span>;
  });
}

function formatInline(str, sources) {
  const parts = keepNumbersWhole(str).split(/\*\*(.+?)\*\*/g);
  return parts.flatMap((p, i) => (i % 2 ? [<strong key={i}>{withCitations(p, sources, i)}</strong>] : [].concat(withCitations(p, sources, i))));
}

export function AnswerText({ text, streaming, sources }) {
  if (streaming) {
    // Mid-stream, an opened **bold** has no closing marker yet: close it virtually
    if ((text.split('**').length - 1) % 2 === 1) text += '**';
    // A bare list marker on the last line would flash as a stray character
    text = text.replace(/\n[ \t]*[-•*][ \t]*$/, '');
    // Nor a citation still being written ("[", "[1")
    text = text.replace(/\[\d{0,2}$/, '');
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
        b.type === 'ul' ? <ul key={i}>{b.items.map((it, j) => <li key={j}>{formatInline(it, sources)}</li>)}</ul>
          : b.type === 'h' ? <h4 key={i}>{formatInline(b.text, sources)}</h4>
            : <p key={i}>{formatInline(b.text, sources)}</p>
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
