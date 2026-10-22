const consumedGenerations = new Map();
const MAX_GENERATION_KEYS = 500;

export function consumeReloadGeneration(scope, queryKey, generation) {
  const normalized = Math.max(0, Number(generation) || 0);
  if (normalized === 0) return false;
  const key = `${scope}:${queryKey}`;
  const consumed = consumedGenerations.get(key) || 0;
  if (normalized <= consumed) return false;
  consumedGenerations.set(key, normalized);
  if (consumedGenerations.size > MAX_GENERATION_KEYS) {
    consumedGenerations.delete(consumedGenerations.keys().next().value);
  }
  return true;
}
