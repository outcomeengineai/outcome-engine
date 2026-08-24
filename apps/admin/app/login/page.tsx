'use client';

import { useState } from 'react';
import { browserClient } from '@/lib/supabase-browser';

/**
 * Magic-link sign-in. No password field anywhere in the product — passwords
 * are one more thing to leak for twenty accounts that all have email anyway.
 */
export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setState('sending');

    const { error } = await browserClient().auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        // The dashboard never creates accounts. An admin exists because they
        // were seeded or invited; a stray email address gets nothing.
        shouldCreateUser: false,
      },
    });

    if (error) {
      setError(error.message);
      setState('idle');
      return;
    }
    setState('sent');
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div className="card" style={{ width: 380, padding: 28 }}>
        <div className="wordmark">Outcome <span>Engine</span></div>
        <div className="eyebrow" style={{ marginTop: 6 }}>Admin dashboard</div>

        {state === 'sent' ? (
          <>
            <h1 style={{ fontSize: 17, marginTop: 22 }}>Check your email</h1>
            <p className="sub">
              We sent a sign-in link to <strong>{email}</strong>. It expires in an hour.
            </p>
            <button className="btn" style={{ marginTop: 8 }} onClick={() => setState('idle')}>
              Use a different address
            </button>
          </>
        ) : (
          <form onSubmit={submit} style={{ marginTop: 22 }}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              required
              autoFocus
              placeholder="you@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />

            {error ? (
              <div className="banner banner-danger" style={{ marginTop: 14, marginBottom: 0 }}>
                {error}
              </div>
            ) : null}

            <button
              type="submit"
              className="btn btn-primary"
              style={{ width: '100%', marginTop: 16 }}
              disabled={state === 'sending' || !email.trim()}
            >
              {state === 'sending' ? 'Sending…' : 'Send sign-in link'}
            </button>

            <p className="hint" style={{ marginTop: 14, marginBottom: 0 }}>
              Access is invite-only. Members use the mobile app.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
