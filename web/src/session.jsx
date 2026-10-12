import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, ApiError } from './lib/api.js';

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [me, setMe] = useState(undefined); // undefined = loading, null = signed out
  const [loadError, setLoadError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await api.get('/api/me'));
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setMe(null);
      else setLoadError(err);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const signIn = async (email, password) => {
    await api.post('/api/auth/login', { email, password });
    await refresh();
  };
  const signOut = async () => {
    await api.post('/api/auth/logout');
    setMe(null);
  };

  return <SessionContext.Provider value={{ me, loadError, refresh, signIn, signOut }}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return useContext(SessionContext);
}
