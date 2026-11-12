import { createContext, useContext } from 'react';

// Sign-in through Clerk when the build has its publishable key (VITE_CLERK_PUBLISHABLE_KEY),
// else the site's own sign-in. Clerk proves who the reader is; the API then hands out the
// Kiosque's own session (POST /auth/clerk), so the rest of the site does not change.
// Clerk's code sits in its own file (components/ClerkRoot.jsx), fetched only when the key
// is there: without it, readers do not download it.
export const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || '';

// { clerk, isLoaded, isSignedIn, getToken } under ClerkRoot, null otherwise
export const ClerkBridgeContext = createContext(null);
export const useClerkBridge = () => useContext(ClerkBridgeContext);

// Clerk's sign-in windows dressed as the Kiosque's own (styles/auth.css): the logo and
// a Newsreader title, the claret rule on top, plain claret button without gradient or
// arrow, providers' buttons spelled out, 16px fields (iOS zooms on anything smaller)
const SERIF = "'Newsreader', 'Iowan Old Style', 'Palatino Linotype', Georgia, serif";
const RULE_STRONG = '1px solid rgba(15, 42, 58, 0.32)';
export const CLERK_APPEARANCE = {
  // "options" since @clerk/react 6 (it was "layout")
  options: {
    logoImageUrl: `${window.location.origin}/icons/icon-192.png`,
    logoPlacement: 'inside',
    socialButtonsVariant: 'blockButton',
    privacyPageUrl: '/confidentialite.html',
    // The "Development mode" band only shows with the test keys of the rehearsal copy
    unsafe_disableDevelopmentModeWarnings: true,
  },
  variables: {
    colorPrimary: '#7A1F2B',
    colorPrimaryForeground: '#F8F7F3',
    colorForeground: '#0F2A3A',
    colorMutedForeground: '#5B6B7A',
    colorBackground: '#FFFFFF',
    colorInput: '#FFFFFF',
    colorNeutral: '#0F2A3A',
    colorDanger: '#A8431F',
    fontFamily: "'Hanken Grotesk', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    fontSize: '15px',
    borderRadius: '10px',
  },
  elements: {
    modalBackdrop: { background: 'rgba(15, 42, 58, 0.5)' },
    cardBox: { borderRadius: '12px', boxShadow: '0 20px 60px rgba(0, 0, 0, 0.25)', borderTop: '4px solid #7A1F2B', maxWidth: '400px' },
    card: { boxShadow: 'none', padding: '28px 24px 24px' },
    logoBox: { height: '56px', justifyContent: 'center' },
    logoImage: { width: '56px', height: '56px', borderRadius: '14px', boxShadow: '0 6px 18px rgba(15, 42, 58, 0.16)' },
    headerTitle: { font: `600 1.6rem/1.15 ${SERIF}`, color: '#0F2A3A' },
    headerSubtitle: { font: `400 0.98rem/1.4 ${SERIF}`, color: '#34495A' },
    socialButtonsBlockButton: { minHeight: '48px', border: RULE_STRONG, borderRadius: '10px', boxShadow: 'none', background: '#FFFFFF' },
    socialButtonsBlockButtonText: { fontWeight: 600, fontSize: '0.95rem', color: '#0F2A3A' },
    dividerText: { color: '#5B6B7A' },
    formFieldLabel: { fontWeight: 500, color: '#0F2A3A' },
    formFieldInput: { minHeight: '48px', fontSize: '16px', borderRadius: '10px', border: RULE_STRONG, boxShadow: 'none' },
    formButtonPrimary: {
      minHeight: '50px', fontSize: '0.98rem', fontWeight: 600, borderRadius: '10px',
      background: '#7A1F2B', backgroundImage: 'none', boxShadow: 'none', textTransform: 'none',
      '&::before, &::after': { display: 'none' },
      '&:hover, &:focus': { background: '#681A25', boxShadow: 'none' },
    },
    buttonArrowIcon: { display: 'none' },
    footer: { background: '#F4F6F4' },
    footerActionLink: { color: '#7A1F2B', fontWeight: 600 },
  },
};
