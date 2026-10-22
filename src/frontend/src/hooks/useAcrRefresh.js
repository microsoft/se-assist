import { useEffect, useRef } from 'react';
import { onAcrProgress } from '../electronBridge';

export function useAcrRefresh(cache, reload) {
  const callback = useRef(reload);
  callback.current = reload;
  const keys = JSON.stringify([...new Set([...(cache?.refreshKeys || []), ...(cache?.queryKeys || [])])]);
  useEffect(() => {
    const waiting = new Set(JSON.parse(keys));
    if (!waiting.size) return undefined;
    let timer;
    const unsubscribe = onAcrProgress(event => {
      if (!['done', 'error'].includes(event?.phase) || !waiting.has(event.queryKey)) return;
      clearTimeout(timer);
      // Let the main process finish recording cache/error metadata before reading it.
      timer = setTimeout(() => callback.current?.(false), 100);
    });
    return () => { unsubscribe(); clearTimeout(timer); };
  }, [keys]);
}
