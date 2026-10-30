import { lazy, Suspense, useCallback, useEffect, useRef } from 'react';
import Masthead from './components/Masthead';
import AuthModal from './components/AuthModal';
import InstallBanner from './components/InstallBanner';
import PullToRefresh from './components/PullToRefresh';
import Une from './views/Une';
import Assistant from './views/Assistant';
import Editions from './views/Editions';
import Codes from './views/Codes';
import Journaux from './views/Journaux';
import Notifications from './views/Notifications';
import Diffusion from './views/Diffusion';
import NotifPrompt from './components/NotifPrompt';
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

  // The password reset link lands here: open the window, then clean the token out of the address bar
  const { openReset } = session;
  useEffect(() => {
    if (route.view !== 'reinitialiser') return;
    const token = route.params.get('token');
    if (token) openReset(token);
    window.history.replaceState(null, '', '#/');
  }, [route, openReset]);

  // #/tester-facebook, opened once on a tester's phone, shows the Facebook button before Meta's review
  useEffect(() => {
    if (route.view !== 'tester-facebook') return;
    try { localStorage.setItem('lekiosque_tester', 'facebook'); } catch { /* private mode */ }
    window.location.replace('/');
  }, [route]);

  // Back from Google or Facebook: sign in with the one-time code, or say what went wrong
  const { exchange, showAuthError } = session;
  useEffect(() => {
    if (route.view !== 'connexion') return;
    const code = route.params.get('code');
    const error = route.params.get('erreur');
    window.history.replaceState(null, '', '#/');
    if (code) exchange(code);
    else if (error === 'compte') showAuthError(route.params.get('message') || 'Connexion impossible.');
    else if (error === 'expire') showAuthError('La connexion a expiré. Recommencez.');
    else if (error === 'fournisseur') showAuthError("Le service de connexion n'a pas répondu. Réessayez dans un instant.");
  }, [route, exchange, showAuthError]);

  // #/assistant?q=… (a "toute la presse en parle" notification, an announcement)
  // asks that question, then drops it so going back does not ask it again
  // (the route object keeps q after replaceState: remember it was handled)
  const askedFromLink = useRef(null);
  useEffect(() => {
    if (route.view !== 'assistant' || !route.params.get('q') || askedFromLink.current === route) return;
    askedFromLink.current = route;
    window.history.replaceState(null, '', '#/assistant');
    ask(route.params.get('q'));
  }, [route, ask]);

  // #/journal/<source> is a page of the Journaux section
  const view = route.view === 'journal' ? 'journaux'
    : ['une', 'assistant', 'editions', 'tendances', 'codes', 'journaux', 'notifications', 'diffusion'].includes(route.view) ? route.view : 'une';

  return (
    <div className={`k-app view-${view}`}>
      <Masthead view={view} health={health} session={session} />
      <PullToRefresh disabled={view === 'assistant' || !!session.authModal} />
      {view !== 'assistant' && <InstallBanner />}
      {view !== 'assistant' && view !== 'notifications' && <NotifPrompt authToken={session.authToken} />}

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
          onForgot={session.forgot}
          resetToken={session.resetToken}
          providers={session.providers}
          onDeleteAccount={session.deleteAccount}
          onProviderInApp={session.signInFromApp}
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
        {view === 'journaux' && <Journaux sub={route.view === 'journal' ? route.sub : null} ask={ask} />}
        {view === 'notifications' && <Notifications session={session} />}
        {view === 'diffusion' && <Diffusion session={session} />}
      </main>
    </div>
  );
}
