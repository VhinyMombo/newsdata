import { useMemo } from 'react';
import { ClerkProvider, SignIn, SignUp, useAuth, useClerk } from '@clerk/react';
import { frFR } from '@clerk/localizations';
import { CLERK_APPEARANCE, CLERK_KEY, ClerkBridgeContext } from '../hooks/clerkBridge';

// Hands Clerk's state to the site (useClerkBridge), the same object while nothing changes,
// with its sign-in and sign-up forms, which the Kiosque's own window shows (AuthModal)
function Bridge({ children }) {
  const clerk = useClerk();
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const value = useMemo(() => ({ clerk, isLoaded, isSignedIn, getToken, SignIn, SignUp }), [clerk, isLoaded, isSignedIn, getToken]);
  return <ClerkBridgeContext.Provider value={value}>{children}</ClerkBridgeContext.Provider>;
}

// Clerk's French leaves a few texts in English
const LOCALIZATION = { ...frFR, formFieldInputPlaceholder__signUpPassword: 'Choisissez un mot de passe' };

// Loaded only when the build has Clerk's key (main.jsx)
export default function ClerkRoot({ children }) {
  return (
    <ClerkProvider publishableKey={CLERK_KEY} localization={LOCALIZATION} appearance={CLERK_APPEARANCE}
      afterSignOutUrl={`${window.location.origin}/#/`}>
      <Bridge>{children}</Bridge>
    </ClerkProvider>
  );
}
