// Single-flight across the chat, the comparison and the reports: Ollama serialises
// generations anyway, and a second run would just queue behind the first and look frozen.
let busy = false;

export const acquire = () => {
  if (busy) return false;
  busy = true;
  document.body.dataset.generating = '1';
  return true;
};

export const release = () => {
  busy = false;
  delete document.body.dataset.generating;
};

export const isBusy = () => busy;
