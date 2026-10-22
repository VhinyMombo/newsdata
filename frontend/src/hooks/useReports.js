import { useCallback, useEffect, useState } from 'react';
import { API_URL, readStream } from '../utils/api';
import { acquire, release } from '../utils/lock';

// Daily and weekly reports, streamed from the API, plus the archive of past editions
export function useReports() {
  const [report, setReport] = useState(null); // null = never generated, '' = loading
  const [reportKind, setReportKind] = useState('daily'); // 'daily' | 'weekly'
  const [reportLoading, setReportLoading] = useState(false);
  // A cache hit still has this window's articles server-side, so its PDF stays valid
  const [reportFromCache, setReportFromCache] = useState(false);
  // An archived edition is text only: no PDF, and it shows its own date
  const [viewingArchive, setViewingArchive] = useState(null); // archive row | null
  const [archiveList, setArchiveList] = useState(null);
  const [lastSeenArchiveId, setLastSeenArchiveId] = useState(() => Number(localStorage.getItem('lekiosque_last_seen_report_id')) || 0);
  const [latestArchiveId, setLatestArchiveId] = useState(0);
  // A first visit has nothing to compare with: no badge until an edition has been opened once
  const newSinceVisit = lastSeenArchiveId ? Math.max(0, latestArchiveId - lastSeenArchiveId) : 0;

  useEffect(() => {
    fetch(`${API_URL}/reports/archive?limit=1`)
      .then(r => (r.ok ? r.json() : []))
      .then(list => { if (list[0]) setLatestArchiveId(list[0].id); })
      .catch(() => {});
  }, []);

  const loadArchive = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/reports/archive?limit=30`);
      const list = res.ok ? await res.json() : [];
      setArchiveList(list);
      if (list[0]) {
        setLastSeenArchiveId(list[0].id);
        localStorage.setItem('lekiosque_last_seen_report_id', String(list[0].id));
      }
    } catch {
      setArchiveList([]);
    }
  }, []);

  const openArchived = useCallback(async (id) => {
    setReport('');
    setReportFromCache(false);
    setReportLoading(true);
    try {
      const res = await fetch(`${API_URL}/reports/archive/${id}`);
      if (!res.ok) throw new Error();
      const row = await res.json();
      setReportKind(row.kind);
      setViewingArchive(row);
      setReport(row.text);
    } catch {
      setViewingArchive(null);
      setReport('Impossible de charger cette édition archivée.');
    } finally {
      setReportLoading(false);
    }
  }, []);

  const fetchReport = useCallback(async (kind) => {
    if (!acquire()) return;
    setReportKind(kind);
    setViewingArchive(null);
    setReportLoading(true);
    setReport('');
    setReportFromCache(false);
    try {
      const res = await fetch(`${API_URL}/${kind === 'daily' ? 'daily_report' : 'weekly_report'}`);
      if (!res.ok) throw new Error(`Le serveur a renvoyé une erreur (${res.status}).`);
      setReportFromCache(res.headers.get('X-Report-Source') === 'cache');
      await readStream(res, setReport);
    } catch (e) {
      setReport(`Impossible de générer le rapport : ${e.message}`);
    } finally {
      release();
      setReportLoading(false);
    }
  }, []);

  const pdfUrl = `${API_URL}/${reportKind === 'daily' ? 'daily_report' : 'weekly_report'}/pdf`;

  return {
    report, reportKind, reportLoading, reportFromCache, viewingArchive, archiveList, newSinceVisit,
    fetchReport, loadArchive, openArchived, pdfUrl,
  };
}
