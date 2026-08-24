import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import {
  COLORS, feeOnNetPnlCents, formatUsd,
} from '@outcome/shared';
import {
  Banner, Button, Card, Empty, Hint, Loading, Money, Pill, Stat, s,
} from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/session';
import { useCurrentPeriod } from '@/lib/data';

const STATUS_TONE: Record<string, 'green' | 'gold' | 'red' | 'muted' | 'blue' | 'purple'> = {
  paid: 'green',
  invoiced: 'blue',
  grace: 'gold',
  failed: 'red',
  waived: 'purple',
  open: 'muted',
};

/**
 * Billing.
 *
 * The current period's fee is a running estimate, not a charge — it moves as
 * trades resolve and is only fixed when the period closes. Saying so plainly
 * matters more than the number itself.
 */
export default function BillingScreen() {
  const { profile, settings } = useSession();
  const period = useCurrentPeriod(profile?.id);

  const [history, setHistory] = useState<Array<Record<string, any>> | null>(null);
  const [card, setCard] = useState<Record<string, any> | null>(null);

  useEffect(() => {
    if (!profile) return;
    (async () => {
      const [{ data: periods }, { data: methods }] = await Promise.all([
        supabase
          .from('billing_periods')
          .select('*')
          .order('period_start', { ascending: false })
          .limit(24),
        supabase.from('payment_methods').select('*').eq('is_primary', true).maybeSingle(),
      ]);
      setHistory(periods ?? []);
      setCard(methods ?? null);
    })();
  }, [profile]);

  if (period.loading && !period.data) return <Loading />;

  const net = Number(period.data?.net_pnl ?? 0);
  const running = feeOnNetPnlCents(net, settings.feeRate);
  const feePct = Math.round(settings.feeRate * 100);

  const closed = (history ?? []).filter((p) => p.status !== 'open');

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: COLORS.bg }}
      contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }}
    >
      {profile?.account_status === 'grace' ? (
        <Banner tone="warn" title="Payment failed">
          We could not charge your card. Update it below, or ask the admin to record a manual
          payment. Live trading is on hold until it clears — your open positions are unaffected and
          will still resolve normally.
        </Banner>
      ) : null}

      {profile?.account_status === 'paused' ? (
        <Banner tone="danger" title="Account paused">
          The grace period for an unpaid fee has passed. Settle it to restore access. Nothing has
          happened to your Kalshi account or your open positions.
        </Banner>
      ) : null}

      {/* --- current period ---------------------------------------------- */}
      <Card>
        <Text style={[s.h2, { marginBottom: 14 }]}>This period</Text>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Stat
            label="Net PnL (live)"
            value={<Money cents={net} signed size={22} weight="700" />}
            hint="Wins minus losses, resolved this month"
          />
          <Stat
            label={`Fee accruing (${feePct}%)`}
            value={
              <Text style={{ fontSize: 22, fontWeight: '700', color: COLORS.gold }}>
                {formatUsd(running)}
              </Text>
            }
            hint={net <= 0 ? 'nothing owed on a losing month' : undefined}
          />
        </View>

        <View style={{ height: 1, backgroundColor: COLORS.border, marginVertical: 14 }} />

        <Hint>
          This is an estimate that moves as trades resolve. It is charged once, after the month
          closes — never per trade, and never taken out of your Kalshi balance. Paper trades are
          not included.
        </Hint>
      </Card>

      {/* --- payment method ----------------------------------------------- */}
      <Card>
        <View style={s.rowBetween}>
          <View>
            <Text style={s.h2}>Payment method</Text>
            {card ? (
              <Hint style={{ marginTop: 3 }}>
                {card.brand ?? 'Card'} ending {card.last4 ?? '••••'}
              </Hint>
            ) : (
              <Hint style={{ marginTop: 3 }}>
                None on file — required before live trading.
              </Hint>
            )}
          </View>
          {card ? <Pill tone="green">● active</Pill> : <Pill tone="gold">needed</Pill>}
        </View>

        <Button
          label={card ? 'Replace card' : 'Add a card'}
          variant="secondary"
          onPress={() => { /* opens the Stripe sheet once the SDK is wired in */ }}
          style={{ marginTop: 14 }}
        />
        <Hint style={{ marginTop: 8 }}>
          Cash App and Venmo debit cards work here — they run on the same card rail.
        </Hint>
      </Card>

      {/* --- invoice history ---------------------------------------------- */}
      <Card>
        <Text style={[s.h2, { marginBottom: 12 }]}>Invoices</Text>

        {history === null ? (
          <Hint>Loading…</Hint>
        ) : closed.length === 0 ? (
          <Empty>No invoices yet. Your first arrives after your first profitable month.</Empty>
        ) : (
          <View style={{ gap: 14 }}>
            {closed.map((p) => (
              <View key={p.id} style={s.rowBetween}>
                <View>
                  <Text style={{ fontSize: 14, fontWeight: '600' }}>
                    {new Date(p.period_start).toLocaleDateString('en-US', {
                      month: 'long', year: 'numeric', timeZone: 'UTC',
                    })}
                  </Text>
                  <Hint style={{ marginTop: 2 }}>
                    {formatUsd(p.net_pnl, { signed: true })} net
                    {p.status === 'grace' && p.grace_until
                      ? ` · pay by ${new Date(p.grace_until).toLocaleDateString()}`
                      : ''}
                  </Hint>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Money cents={p.fee_owed} size={15} />
                  <Pill tone={STATUS_TONE[p.status] ?? 'muted'}>{p.status}</Pill>
                </View>
              </View>
            ))}
          </View>
        )}
      </Card>
    </ScrollView>
  );
}
