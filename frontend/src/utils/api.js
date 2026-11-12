export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export const authHeaders = (token) => (token ? { Authorization: `Bearer ${token}` } : {});

// Error text for a non-OK response: the API's own `detail` when it sends one
export async function errorDetail(res) {
  // 429 without a detail: the per-minute limit (the daily quotas send their own text)
  let detail = res.status === 429
    ? "Trop de questions d'affilée : patientez une minute avant la suivante."
    : `Le serveur a renvoyé une erreur (${res.status}).`;
  try {
    const j = await res.json();
    if (typeof j.detail === 'string') detail = j.detail;
  } catch { /* non-JSON error body */ }
  return detail;
}

// /answer and the reports stream plain text, chunk by chunk (no SSE framing)
export async function readStream(res, onText) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    onText(text);
  }
  return text;
}

// The account token, when signed in (useSession's key): /answer counts a reader's
// daily questions by account rather than by address
const storedToken = () => {
  try { return localStorage.getItem('lekiosque_auth_token'); } catch { return null; }
};

export const postJSON = (path, body, signal) => fetch(`${API_URL}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...authHeaders(storedToken()) },
  body: JSON.stringify(body),
  signal,
});
