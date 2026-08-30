'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { User } from '@aiedit/shared';
import { ApiError, api, clearTokens, loadStoredTokens, setTokens } from './api';

interface AuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string) => Promise<void>;
  loginWithGoogle: (idToken: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface SessionResponse {
  user: User;
  accessToken: string;
  refreshToken?: string;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState>({ user: null, loading: true, error: null });

  const loadSession = useCallback(async () => {
    loadStoredTokens();
    try {
      const { user } = await api.get<{ user: User }>('/api/auth/me');
      setState({ user, loading: false, error: null });
    } catch {
      // A failed /me on boot simply means "not signed in".
      setState({ user: null, loading: false, error: null });
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const applySession = useCallback((session: SessionResponse) => {
    setTokens(session.accessToken, session.refreshToken);
    setState({ user: session.user, loading: false, error: null });
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      setState((s) => ({ ...s, error: null }));
      try {
        applySession(
          await api.post<SessionResponse>('/api/auth/login', { email, password }, { skipAuthRetry: true }),
        );
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Sign-in failed. Please try again.';
        setState((s) => ({ ...s, error: message }));
        throw err;
      }
    },
    [applySession],
  );

  const register = useCallback(
    async (email: string, password: string, name?: string) => {
      setState((s) => ({ ...s, error: null }));
      try {
        applySession(
          await api.post<SessionResponse>(
            '/api/auth/register',
            { email, password, name },
            { skipAuthRetry: true },
          ),
        );
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Could not create the account.';
        setState((s) => ({ ...s, error: message }));
        throw err;
      }
    },
    [applySession],
  );

  const loginWithGoogle = useCallback(
    async (idToken: string) => {
      setState((s) => ({ ...s, error: null }));
      try {
        applySession(
          await api.post<SessionResponse>('/api/auth/google', { idToken }, { skipAuthRetry: true }),
        );
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Google sign-in failed.';
        setState((s) => ({ ...s, error: message }));
        throw err;
      }
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    clearTokens();
    setState({ user: null, loading: false, error: null });
    router.push('/login');
  }, [router]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, login, register, loginWithGoogle, logout, refresh: loadSession }),
    [state, login, register, loginWithGoogle, logout, loadSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
