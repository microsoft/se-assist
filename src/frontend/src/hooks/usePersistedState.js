import { useCallback, useState } from 'react';

// Read a JSON-serialized value from localStorage, falling back when the key is
// absent or the stored payload is unreadable.
function readStored(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * useState backed by localStorage under a shared key so the value survives
 * navigation and is shared across every component that uses the same key.
 *
 * The stored value is only written when the setter is called — never on mount —
 * so components with different fallback defaults keep their own default until the
 * user actually makes a selection, after which the choice persists everywhere.
 *
 * The setter accepts a value or an updater function, matching useState.
 *
 * @template T
 * @param {string} key localStorage key (shared across pages)
 * @param {T} defaultValue used when nothing is stored yet
 * @returns {[T, (next: T | ((cur: T) => T)) => void]}
 */
export function usePersistedState(key, defaultValue) {
  const [value, setValue] = useState(() => readStored(key, defaultValue));

  const set = useCallback((next) => {
    setValue((cur) => {
      const resolved = typeof next === 'function' ? next(cur) : next;
      try {
        window.localStorage.setItem(key, JSON.stringify(resolved));
      } catch {
        /* storage full or unavailable — keep the in-memory value */
      }
      return resolved;
    });
  }, [key]);

  return [value, set];
}

export default usePersistedState;
