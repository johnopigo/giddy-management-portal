import { useCallback, useEffect, useState } from 'react';

/** Loads data with fn() on mount; reload() fetches again after a change. */
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: undefined, error: null, loading: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(fn, deps);
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      setState({ data: await load(), error: null, loading: false });
    } catch (error) {
      setState({ data: undefined, error, loading: false });
    }
  }, [load]);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}
