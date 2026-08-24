import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { AccountStatus, Role, TradeMode } from '@outcome/shared';

/**
 * Session, profile, onboarding progress and the paper/live mode toggle.
 *
 * Mode lives here rather than in a screen because it changes the meaning of
 * everything on screen — the desk, the stake card, the ledger and the billing
 * summary all read it, and a stale copy in one of them would be the kind of
 * bug that costs someone real money.
 */

export interface Profile {
  id: string;
  email: string;
  display_name: string | null;
  role: Role;
  account_status: AccountStatus;
  agreed_at: string | null;
  onboarded_at: string | null;
  preferred_model_version_id: string | null;
}

export interface OnboardingState {
  hasProfile: boolean;
  agreed: boolean;
  hasPaymentMethod: boolean;
  kalshiConnected: boolean;
  complete: boolean;
}

interface SessionValue {
  loading: boolean;
  session: Session | null;
  profile: Profile | null;
  onboarding: OnboardingState;
  /** Platform settings the UI needs: fee rate, pause flags. */
  settings: { feeRate: number; tradingPaused: boolean; killSwitch: boolean };
  mode: TradeMode;
  setMode: (m: TradeMode) => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const EMPTY_ONBOARDING: OnboardingState = {
  hasProfile: false,
  agreed: false,
  hasPaymentMethod: false,
  kalshiConnected: false,
  complete: false,
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingState>(EMPTY_ONBOARDING);
  const [settings, setSettings] = useState({ feeRate: 0.2, tradingPaused: false, killSwitch: false });

  // Paper is the default and stays the default until the member switches. The
  // brief is explicit that new accounts land in paper mode.
  const [mode, setMode] = useState<TradeMode>('paper');

  const load = useCallback(async (current: Session | null) => {
    if (!current) {
      setProfile(null);
      setOnboarding(EMPTY_ONBOARDING);
      return;
    }

    const [profileRes, paymentRes, kalshiRes, settingsRes] = await Promise.all([
      supabase.from('users').select('*').eq('id', current.user.id).maybeSingle(),
      supabase.from('payment_methods').select('id').eq('user_id', current.user.id).limit(1),
      supabase.from('kalshi_connections').select('status').eq('user_id', current.user.id).maybeSingle(),
      supabase.from('platform_settings').select('key, value').in('key', ['fee_rate', 'trading_paused', 'kill_switch']),
    ]);

    const p = (profileRes.data as Profile) ?? null;
    setProfile(p);

    const hasPaymentMethod = (paymentRes.data ?? []).length > 0;
    const kalshiConnected = kalshiRes.data?.status === 'connected';

    setOnboarding({
      hasProfile: Boolean(p),
      agreed: Boolean(p?.agreed_at),
      hasPaymentMethod,
      kalshiConnected,
      // Onboarding is complete once the member has agreed. Payment and Kalshi
      // are prerequisites for LIVE trading, not for entering the app — paper
      // mode has to work before either exists, or there is nothing to try.
      complete: Boolean(p?.agreed_at),
    });

    const map = new Map(
      (settingsRes.data ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]),
    );
    setSettings({
      feeRate: Number(map.get('fee_rate') ?? 0.2),
      tradingPaused: map.get('trading_paused') === true,
      killSwitch: map.get('kill_switch') === true,
    });
  }, []);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      await load(data.session);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, next) => {
      if (!active) return;
      setSession(next);
      await load(next);
      // Signing out must drop the member back to paper, so a fresh sign-in on
      // a shared device never starts in live mode.
      if (!next) setMode('paper');
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [load]);

  const refresh = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    setSession(data.session);
    await load(data.session);
  }, [load]);

  const value = useMemo<SessionValue>(
    () => ({
      loading,
      session,
      profile,
      onboarding,
      settings,
      mode,
      setMode,
      refresh,
      signOut: async () => { await supabase.auth.signOut(); },
    }),
    [loading, session, profile, onboarding, settings, mode, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

/** Why live trading is unavailable right now, or null if it is available. */
export function liveBlockedReason(v: SessionValue): string | null {
  if (v.settings.killSwitch) return 'Trading is halted platform-wide.';
  if (v.settings.tradingPaused) return 'Live trading is paused by the admin.';
  if (v.profile?.account_status === 'grace') {
    return 'Your last payment failed. Update your card to resume live trading.';
  }
  if (v.profile?.account_status === 'paused') return 'Your account is paused.';
  if (!v.onboarding.hasPaymentMethod) return 'Add a payment method to trade live.';
  if (!v.onboarding.kalshiConnected) return 'Connect your Kalshi account to trade live.';
  return null;
}
