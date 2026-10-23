// Visitor statistics (Umami on stats.hodologic.fr, loaded in index.html). Events
// carry no personal data, and are dropped quietly when the tracker is blocked.
export function track(name, data) {
  try { window.umami?.track(name, data); } catch { /* tracker blocked or not loaded */ }
}
