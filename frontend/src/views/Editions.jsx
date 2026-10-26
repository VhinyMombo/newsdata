import { useEffect } from 'react';
import { Download, MessageCircle, RefreshCw } from 'lucide-react';
import { AnswerText, ReportSkeleton, Thinking } from '../utils/text';
import { longDate } from '../utils/format';
import { go } from '../hooks/useRoute';
import { track } from '../utils/track';

const TABS = [
  ['jour', 'Le point du jour'],
  ['semaine', 'La semaine'],
  ['archives', 'Archives'],
];
const KIND = { jour: 'daily', semaine: 'weekly' };

// The edition's opening sentence, without its markdown, cut on a word if too long;
// a heading standing alone above the first paragraph is skipped
// (the same cut as the evening notification, push_notify.brief_body)
function opening(text) {
  const paragraphs = (text || '').trim().split('\n\n').filter(p => p.trim());
  const prose = paragraphs.find(p => !/^(#+ .*|\*\*[^*\n]+\*\*)$/.test(p.trim())) ?? paragraphs[0] ?? '';
  const first = prose.replace(/[*_#>`]+/g, '').trim();
  const sentence = first.split(/(?<=[.!?…])\s/)[0];
  return sentence.length <= 220 ? sentence : `${sentence.slice(0, 220).replace(/\s+\S*$/, '').replace(/[,;:]$/, '')}…`;
}

// Today in Gabon (UTC+1), not on the reader's clock, as the editions are dated
const gabonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Libreville' }).format(new Date());

// A WhatsApp message carrying the edition: its name and date, its opening sentence,
// and a link. An archived edition keeps its own address; the edition of the day
// links to the day's edition, so the date in the message says which one it was.
function whatsappHref({ kind, date, text, archiveId }) {
  const name = kind === 'daily' ? 'Le point du jour' : 'La revue de la semaine';
  const path = archiveId ? `editions/archive?id=${archiveId}` : `editions/${kind === 'daily' ? 'jour' : 'semaine'}`;
  const message = `${name} du Kiosque, ${longDate(date)}\n\n${opening(text)}\n\n${window.location.origin}/#/${path}`;
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

function Archive({ reports }) {
  const { archiveList, loadArchive } = reports;
  useEffect(() => { loadArchive(); }, [loadArchive]);
  if (archiveList === null) return <Thinking phrases={['Chargement des archives…']} />;
  if (!archiveList.length) {
    return <p className="k-muted">Aucune édition archivée pour l'instant. Les éditions générées, depuis l'application ou automatiquement, s'accumulent ici.</p>;
  }
  return (
    <ol className="k-archive">
      {archiveList.map(r => (
        <li key={r.id}>
          <a href={`#/editions/archive?id=${r.id}`}>
            <span className={`k-kicker ${r.kind}`}>{r.kind === 'daily' ? 'Point du jour' : 'Semaine'}</span>
            <strong>{longDate(r.period_end)}</strong>
            <span className="k-muted">{r.article_count} articles</span>
            <p>{r.excerpt}…</p>
          </a>
        </li>
      ))}
    </ol>
  );
}

export default function Editions({ reports, sub }) {
  const tab = sub === 'archive' ? 'archives' : TABS.some(([k]) => k === sub) ? sub : 'jour';
  const archiveId = sub === 'archive' ? Number(new URLSearchParams(window.location.hash.split('?')[1]).get('id')) : null;
  const { report, reportKind, reportLoading, reportFromCache, viewingArchive, fetchReport, openArchived, pdfUrl } = reports;
  const kind = KIND[tab];

  // Opening a tab produces its edition, unless that edition is already on screen
  useEffect(() => {
    if (archiveId) { if (viewingArchive?.id !== archiveId) openArchived(archiveId); return; }
    if (kind && !reportLoading && (report === null || reportKind !== kind || viewingArchive)) fetchReport(kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, archiveId]);

  const showing = archiveId ? !!viewingArchive || reportLoading : kind && reportKind === kind && !viewingArchive;
  const title = (reportKind === 'daily' ? "Le point d'actualité du jour" : 'La revue de presse de la semaine');

  return (
    <div className="k-wrap k-page k-editions">
      <header className="k-page-head">
        <span className="k-eyebrow">Éditions</span>
        <h1 className="k-title">L'actualité, déjà résumée</h1>
        <p className="k-dek">Le point du jour et la revue de la semaine sont rédigés à partir de tous les titres publiés. La rédaction prend environ une minute, puis l'édition reste disponible et téléchargeable en PDF.</p>
      </header>
      <div className="k-segmented" role="tablist" aria-label="Éditions">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => go(`editions/${k}`)}>{l}</button>
        ))}
      </div>

      {tab === 'archives' && !archiveId ? <Archive reports={reports} /> : showing && (
        <article className="k-edition-doc">
          <header>
            <span className="k-kicker">
              {viewingArchive ? `Édition archivée · ${longDate(viewingArchive.period_end)}` : reportFromCache ? 'Déjà rédigée aujourd’hui' : reportLoading ? 'Rédaction en cours' : 'Rédigée à l’instant'}
            </span>
            <h2>{title}</h2>
            <div className="k-edition-actions">
              {!reportLoading && report && !viewingArchive && (
                <>
                  <a className="k-btn ghost" href={pdfUrl} target="_blank" rel="noreferrer" onClick={() => track('pdf', { edition: reportKind })}><Download size={14} /> PDF</a>
                  <button className="k-btn ghost" onClick={() => fetchReport(reportKind)}><RefreshCw size={13} /> Relancer</button>
                </>
              )}
              {!reportLoading && report && (viewingArchive || reportKind) && (
                <a
                  className="k-btn ghost"
                  href={whatsappHref({
                    kind: reportKind,
                    date: viewingArchive?.period_end || gabonToday(),
                    text: report,
                    archiveId: viewingArchive?.id,
                  })}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => track('partage', { canal: 'whatsapp', edition: reportKind })}
                >
                  <MessageCircle size={14} /> WhatsApp
                </a>
              )}
              {viewingArchive && <a className="k-btn ghost" href="#/editions/archives">Toutes les archives</a>}
            </div>
          </header>
          {report === '' && reportLoading ? (
            <>
              <Thinking phrases={[reportKind === 'daily' ? 'Lecture des titres du jour…' : 'Lecture des titres de la semaine…', 'Rédaction de l’édition…']} interval={8000} />
              <ReportSkeleton themes={reportKind === 'daily' ? 3 : 5} />
            </>
          ) : (
            <div aria-live="polite" aria-atomic="true" aria-busy={reportLoading}>
              <AnswerText text={report || ''} streaming={reportLoading} />
            </div>
          )}
        </article>
      )}
    </div>
  );
}
