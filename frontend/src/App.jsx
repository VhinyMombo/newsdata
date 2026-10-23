import { lazy, Suspense, useCallback } from 'react';
import Masthead from './components/Masthead';
import AuthModal from './components/AuthModal';
import InstallBanner from './components/InstallBanner';
import Une from './views/Une';
import Assistant from './views/Assistant';
import Editions from './views/Editions';
import Codes from './views/Codes';
import { go, useRoute } from './hooks/useRoute';
import { useSession } from './hooks/useSession';
import { useHealth } from './hooks/useHealth';
import { useChat } from './hooks/useChat';
import { useReports } from './hooks/useReports';
import { useCompare } from './hooks/useCompare';
import { useCodes } from './hooks/useCodes';
import { useCorpusData } from './hooks/useCorpusData';

// Plotly and the dashboard are heavy: only fetched when Tendances is opened
const Tendances = lazy(() => import('./views/Tendances'));

export default function App() {
  const route = useRoute();
  const session = useSession();
  const health = useHealth();
  const chat = useChat({ setApiStatus: health.setApiStatus, authToken: session.authToken });
  const reports = useReports();
  const compare = useCompare({ gabonToday: health.gabonToday });
  const codes = useCodes();
  const corpus = useCorpusData();

  // Any view can hand a question to the assistant, in either corpus. A clicked
  // article (pinned) opens a conversation of its own.
  const { switchCorpus, runSearch } = chat;
  const ask = useCallback((q, target = 'presse', pinned = null) => {
    switchCorpus(target);
    go('assistant');
    runSearch(q, null, target, pinned, !!pinned);
  }, [switchCorpus, runSearch]);

  const view = ['une', 'assistant', 'editions', 'tendances', 'codes'].includes(route.view) ? route.view : 'une';

  return (
    <div className={`k-app view-${view}`}>
      <Masthead view={view} health={health} session={session} />
      {view !== 'assistant' && <InstallBanner />}

      {session.authModal && (
        <AuthModal
          mode={session.authModal}
          onClose={() => session.setAuthModal(null)}
          onSwitchMode={session.openAuth}
          onSubmit={session.submit}
          busy={session.authBusy}
          error={session.authError}
          user={session.user}
          authToken={session.authToken}
          onLogout={session.logout}
          onProfileUpdated={session.setUser}
        />
      )}

      <main className="k-main" id="contenu">
        {view === 'une' && <Une ask={ask} session={session} corpus={corpus} health={health} reports={reports} />}
        {view === 'assistant' && <Assistant chat={chat} compare={compare} health={health} sub={route.sub} session={session} />}
        {view === 'editions' && <Editions reports={reports} sub={route.sub} />}
        {view === 'tendances' && (
          <Suspense fallback={<div className="k-page"><p className="k-muted">Chargement…</p></div>}>
            <Tendances corpus={corpus} sub={route.sub} ask={ask} session={session} health={health} latestSources={chat.chatHistory.at(-1)?.sources} />
          </Suspense>
        )}
        {view === 'codes' && <Codes codes={codes} ask={ask} />}
      </main>
      {/* In a conversation the page ends with the dock: no footer under it */}
      {view !== 'assistant' && <footer className="k-footer">
        <div className="k-wrap k-footer-row">
          <p><strong>Le Kiosque</strong>, un projet <a href="https://hodologic.fr/fr/work/le-kiosque" target="_blank" rel="noreferrer">Hodologic</a>. Les articles appartiennent à leurs journaux : chaque lien renvoie à leur site.</p>
          <p className="k-muted">Les réponses sont rédigées par une IA à partir des articles cités. Vérifiez toujours les sources.</p>
        </div>
      </footer>}
    </div>
  );
}
