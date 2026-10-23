import { useEffect, useState } from 'react';
import { Check, Compass, Copy, Ellipsis, EllipsisVertical, ExternalLink, Share, SquarePlus } from 'lucide-react';
import { isStandalone, useInstall } from '../hooks/useInstall';

// lekiosque.hodologic.fr/installer, the link to share: one page that shows each phone
// only what it needs to do to put Le Kiosque on its home screen.
const HERE = `${window.location.host}/installer`;
// Android opens intent:// links in the named app, with the page as fallback
const CHROME_INTENT = `intent://${HERE}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(`https://${HERE}`)};end`;

function Steps({ items }) {
  return (
    <ol className="k-install-steps">
      {items.map(([Icon, text], i) => (
        <li key={i}>
          <span className="k-install-num">{i + 1}</span>
          <span className="k-install-text">{text}</span>
          {Icon && <span className="k-install-glyph" aria-hidden="true"><Icon size={20} strokeWidth={1.7} /></span>}
        </li>
      ))}
    </ol>
  );
}

function CopyLink() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(`https://${HERE}`); setCopied(true); } catch { /* clipboard refused: the address stays readable below */ }
  };
  return (
    <button className="k-btn k-install-copy" onClick={copy}>
      {copied ? <Check size={17} /> : <Copy size={17} />}
      {copied ? 'Lien copié' : 'Copier le lien'}
    </button>
  );
}

function Body({ platform, canPrompt, install }) {
  if (canPrompt) {
    return (
      <>
        <button className="k-btn primary k-install-cta" onClick={install}>Installer Le Kiosque</button>
        <p className="k-install-note">Gratuit, sans passer par une boutique d'applications. Il prend moins de place qu'une photo.</p>
      </>
    );
  }
  switch (platform) {
    case 'ios-safari':
    case 'ios-other':
      return (
        <>
          <Steps items={[
            [Share, <>Touchez <strong>Partager</strong>, en bas de l'écran{platform === 'ios-other' ? ' ou dans la barre d\'adresse' : ' (ou dans le menu ⋯)'}.</>],
            [SquarePlus, <>Choisissez <strong>Sur l'écran d'accueil</strong>. Faites défiler la liste s'il n'apparaît pas.</>],
            [null, <>Touchez <strong>Ajouter</strong>, en haut à droite.</>],
          ]} />
        </>
      );
    case 'ios-inapp':
      return (
        <>
          <p className="k-install-lead">Ce lien s'est ouvert dans WhatsApp ou une autre application, qui ne peut pas installer Le Kiosque. Passez dans Safari :</p>
          <Steps items={[
            [Ellipsis, <>Touchez le menu <strong>⋯</strong> ou l'icône <strong>Safari</strong>, en bas ou en haut de l'écran.</>],
            [Compass, <>Choisissez <strong>Ouvrir dans Safari</strong>, puis suivez les trois étapes qui s'affichent.</>],
          ]} />
          <p className="k-install-or">Ou copiez le lien et collez-le dans Safari :</p>
          <CopyLink />
        </>
      );
    case 'android-inapp':
      return (
        <>
          <p className="k-install-lead">Ce lien s'est ouvert dans WhatsApp ou une autre application, qui ne peut pas installer Le Kiosque.</p>
          <a className="k-btn primary k-install-cta" href={CHROME_INTENT}><ExternalLink size={18} />Ouvrir dans Chrome</a>
          <p className="k-install-or">Sinon, touchez <strong>⋮</strong> puis <strong>Ouvrir dans le navigateur</strong>.</p>
        </>
      );
    case 'android':
      return (
        <Steps items={[
          [EllipsisVertical, <>Touchez le menu <strong>⋮</strong>, en haut à droite.</>],
          [SquarePlus, <>Choisissez <strong>Installer l'application</strong> ou <strong>Ajouter à l'écran d'accueil</strong>.</>],
          [null, <>Confirmez avec <strong>Installer</strong>.</>],
        ]} />
      );
    default:
      return (
        <>
          <p className="k-install-lead">Ouvrez cette adresse sur votre téléphone pour y installer Le Kiosque :</p>
          <p className="k-install-url">{HERE}</p>
          <CopyLink />
        </>
      );
  }
}

export default function Installer() {
  const { platform, canPrompt, installed, install } = useInstall();

  // Opened from the home screen already: straight to the paper
  useEffect(() => { if (isStandalone()) window.location.replace('/'); }, []);

  return (
    <main className="k-install">
      <div className="k-install-card">
        <img className="k-install-icon" src="/icons/icon-512.png" alt="" width="88" height="88" />
        <h1>Le Kiosque</h1>
        <div className="k-install-rule" />
        <p className="k-install-dek">La presse gabonaise, interrogeable. Plus de 26{'\u202f'}000 articles de 13 journaux, mis à jour toutes les deux heures.</p>

        {installed ? (
          <div className="k-install-done">
            <Check size={22} />
            <p>C'est fait. Le Kiosque est sur votre écran d'accueil : ouvrez-le depuis son icône.</p>
          </div>
        ) : (
          <section className="k-install-how" aria-label="Installer sur l'écran d'accueil">
            <h2>Sur votre écran d'accueil</h2>
            <Body platform={platform} canPrompt={canPrompt} install={install} />
          </section>
        )}

        <a className="k-install-skip" href="/">Lire sans installer</a>
      </div>
    </main>
  );
}
