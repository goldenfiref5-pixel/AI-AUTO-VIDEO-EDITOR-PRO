'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/primitives';

interface AuthConfig {
  googleClientId: string | null;
  passwordLoginEnabled: boolean;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: { client_id: string; callback: (r: { credential: string }) => void }) => void;
          renderButton: (el: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

export default function LoginPage() {
  const router = useRouter();
  const { user, loading, login, register, loginWithGoogle, error } = useAuth();

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const googleButtonRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loading && user) router.replace('/dashboard');
  }, [loading, user, router]);

  useEffect(() => {
    void api
      .get<AuthConfig>('/api/auth/config', { skipAuthRetry: true })
      .then(setConfig)
      .catch(() => setConfig({ googleClientId: null, passwordLoginEnabled: true }));
  }, []);

  // Google Identity Services is loaded on demand, and only when the server
  // actually has a client id configured.
  useEffect(() => {
    const clientId = config?.googleClientId;
    if (!clientId || !googleButtonRef.current) return undefined;

    const mount = () => {
      if (!window.google || !googleButtonRef.current) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (response) => {
          void loginWithGoogle(response.credential)
            .then(() => router.replace('/dashboard'))
            .catch(() => undefined);
        },
      });
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        theme: 'filled_black',
        size: 'large',
        width: 320,
        text: 'continue_with',
      });
    };

    if (window.google) {
      mount();
      return undefined;
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = mount;
    document.head.appendChild(script);

    return () => {
      script.remove();
    };
  }, [config?.googleClientId, loginWithGoogle, router]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password, name || undefined);
      router.replace('/dashboard');
    } catch {
      // The error is surfaced through the auth context.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-brand text-sm font-bold text-white">
            AE
          </div>
          <h1 className="text-xl font-semibold text-ink">AI Auto Editor Pro</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Upload a voiceover. Get a finished video.
          </p>
        </div>

        <div className="card p-5">
          <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-canvas p-1">
            {(['login', 'register'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={`rounded-md py-1.5 text-xs font-medium transition-colors ${
                  mode === value ? 'bg-surface-raised text-ink' : 'text-ink-muted hover:text-ink'
                }`}
              >
                {value === 'login' ? 'Sign in' : 'Create account'}
              </button>
            ))}
          </div>

          <form onSubmit={onSubmit} className="space-y-3">
            {mode === 'register' ? (
              <Field label="Name" htmlFor="name">
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                />
              </Field>
            ) : null}

            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@studio.com"
                autoComplete="email"
              />
            </Field>

            <Field
              label="Password"
              htmlFor="password"
              hint={mode === 'register' ? 'At least 10 characters.' : undefined}
            >
              <Input
                id="password"
                type="password"
                required
                minLength={mode === 'register' ? 10 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••"
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              />
            </Field>

            {error ? (
              <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                {error}
              </p>
            ) : null}

            <Button type="submit" className="w-full" loading={busy}>
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
          </form>

          {config?.googleClientId ? (
            <>
              <div className="my-4 flex items-center gap-3">
                <span className="h-px flex-1 bg-line" />
                <span className="text-[11px] uppercase tracking-wider text-ink-faint">or</span>
                <span className="h-px flex-1 bg-line" />
              </div>
              <div ref={googleButtonRef} className="flex justify-center" />
            </>
          ) : null}
        </div>

        <p className="mt-6 text-center text-xs text-ink-faint">
          The first account created on a fresh install becomes the administrator.
        </p>
      </div>
    </div>
  );
}
