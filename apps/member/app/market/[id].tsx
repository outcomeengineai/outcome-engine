import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  COLORS, formatPriceCents, formatUsd, quoteStake,
} from '@outcome/shared';
import {
  Banner, BreakdownBars, Button, Card, Hint, Loading, ModePill,
  Money, Pill, ScoreRing, monoFont, s,
} from '@/components/ui';
import { useKalshiConnection, useMarket } from '@/lib/data';
import { liveBlockedReason, useSession } from '@/lib/session';
import { ApiError, callFunction } from '@/lib/supabase';

const STEP_CHOICES = [10, 25, 50, 100];

export default function MarketDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const session = useSession();
  const { profile, mode, settings } = session;

  const market = useMarket(id, profile?.id);
  const connection = useKalshiConnection(profile?.id);

  const [contracts, setContracts] = useState(50);
  const [balance, setBalance] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocked = liveBlockedReason(session);

  // The Kalshi balance is only meaningful in live mode, and fetching it costs
  // a signed API call, so it is loaded lazily rather than on every render.
  useEffect(() => {
    if (mode !== 'live' || connection.data?.status !== 'connected') {
      setBalance(null);
      return;
    }
    (async () => {
      try {
        const res = await callFunction<{ balanceCents: number | null }>('kalshi-balance');
        setBalance(res.balanceCents);
      } catch {
        // Not fatal — the server re-checks the balance before any order, so a
        // missing figure here costs a warning, not a bad fill.
        setBalance(null);
      }
    })();
  }, [mode, connection.data?.status]);

  if (market.loading && !market.data) return <Loading />;

  if (!market.data) {
    return (
      <View style={s.center}>
        <Text style={s.h2}>Not available</Text>
        <Hint style={{ marginTop: 6, textAlign: 'center' }}>
          This market is no longer scored — it may have closed, resolved, or dropped below the
          surfacing threshold.
        </Hint>
        <Button label="Back to the desk" variant="secondary" onPress={() => router.back()} style={{ marginTop: 18 }} />
      </View>
    );
  }

  const m = market.data;
  const price = m.side_price ?? 0;

  // THE quote. Same function the billing job's fee rule is tested against, so
  // the number shown here is derived exactly like the one on the invoice.
  const quote = quoteStake({
    priceCents: price,
    contracts,
    mode,
    feeRate: settings.feeRate,
  });

  const overBalance = mode === 'live' && balance !== null && quote.stake > balance;
  const canTrade = !blocked || mode === 'paper';
  const ctaDisabled = busy || price < 1 || price > 99 || overBalance ||
    (mode === 'live' && !canTrade) || settings.killSwitch;

  async function takeTrade() {
    setBusy(true);
    setError(null);
    try {
      const res = await callFunction<{
        filled?: number; requested?: number; partial?: boolean;
      }>('execute-trade', {
        marketId: m.market_id,
        mode,
        contracts,
        quotedPriceCents: price,
      });

      Alert.alert(
        mode === 'paper' ? 'Paper trade recorded' : 'Trade placed',
        res.partial
          ? `Partially filled: ${res.filled} of ${res.requested} contracts. Only what filled counts as a position.`
          : mode === 'paper'
            ? 'Practice only — this will never be billed.'
            : `${res.filled ?? contracts} contracts at ${formatPriceCents(price)}.`,
        [{ text: 'OK', onPress: () => router.replace('/(tabs)/positions') }],
      );
    } catch (e) {
      // Failures are surfaced verbatim: these messages are written for the
      // member and a swallowed order is far worse than a blunt error.
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Trade failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: COLORS.bg }}
      contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 14 }}
    >
      {/* --- header --------------------------------------------------- */}
      <View style={[s.row, { gap: 16, alignItems: 'flex-start' }]}>
        <ScoreRing score={m.score} size={76} />
        <View style={{ flex: 1 }}>
          <View style={[s.row, { gap: 6, marginBottom: 7, flexWrap: 'wrap' }]}>
            <Pill tone="muted">{m.category}</Pill>
            <Pill tone={m.side === 'YES' ? 'green' : 'blue'}>{m.side}</Pill>
            <ModePill mode={mode} />
          </View>
          <Text style={{ fontSize: 16, lineHeight: 22, fontWeight: '600' }}>{m.question}</Text>
          <Hint style={{ marginTop: 5 }}>
            {formatPriceCents(price)} for {m.side}
            {m.close_time
              ? ` · closes ${new Date(m.close_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
              : ''}
          </Hint>
        </View>
      </View>

      {/* --- why this score -------------------------------------------- */}
      <Card>
        <Text style={[s.h2, { marginBottom: 12 }]}>Why this score</Text>
        <BreakdownBars breakdown={m.breakdown} total={m.score} />
        <Hint style={{ marginTop: 12 }}>
          The three add up to {m.score.toFixed(1)}. A signal the admin has disabled contributes
          nothing and its weight is spread across the others.
        </Hint>
      </Card>

      {/* --- tags ------------------------------------------------------- */}
      {m.tags.length > 0 ? (
        <Card style={{ gap: 10 }}>
          <Text style={s.h2}>Worth knowing</Text>
          {m.tags.map((t, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 9 }}>
              <View
                style={{
                  width: 6, height: 6, borderRadius: 999, marginTop: 6,
                  backgroundColor: t.severity === 'caution' ? COLORS.gold : COLORS.blue,
                }}
              />
              <Text
                style={{
                  flex: 1, fontSize: 13, lineHeight: 18.5,
                  color: t.severity === 'caution' ? COLORS.gold : COLORS.blue,
                }}
              >
                {t.text}
              </Text>
            </View>
          ))}
        </Card>
      ) : null}

      {/* --- stake card -------------------------------------------------- */}
      <Card>
        <View style={[s.rowBetween, { marginBottom: 14 }]}>
          <Text style={s.h2}>Your stake</Text>
          <ModePill mode={mode} />
        </View>

        <View style={[s.rowBetween, { marginBottom: 12 }]}>
          <Pressable
            onPress={() => setContracts((c) => Math.max(1, c - 10))}
            style={{
              width: 44, height: 44, borderRadius: 12,
              borderWidth: 1, borderColor: COLORS.border,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: COLORS.surfaceMuted,
            }}
          >
            <Text style={{ fontSize: 21, color: COLORS.muted }}>−</Text>
          </Pressable>

          <View style={{ alignItems: 'center' }}>
            <Text style={[monoFont, { fontSize: 28, fontWeight: '700', letterSpacing: -0.8 }]}>
              {contracts}
            </Text>
            <Hint>contracts</Hint>
          </View>

          <Pressable
            onPress={() => setContracts((c) => c + 10)}
            style={{
              width: 44, height: 44, borderRadius: 12,
              borderWidth: 1, borderColor: COLORS.border,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: COLORS.surfaceMuted,
            }}
          >
            <Text style={{ fontSize: 21, color: COLORS.muted }}>+</Text>
          </Pressable>
        </View>

        <View style={[s.row, { gap: 7, justifyContent: 'center', marginBottom: 16 }]}>
          {STEP_CHOICES.map((n) => (
            <Pressable
              key={n}
              onPress={() => setContracts(n)}
              style={{
                paddingVertical: 5, paddingHorizontal: 13, borderRadius: 999,
                borderWidth: 1,
                borderColor: contracts === n ? COLORS.green : COLORS.border,
                backgroundColor: contracts === n ? '#E4F7EF' : 'transparent',
              }}
            >
              <Text
                style={{
                  fontSize: 12.5, fontWeight: '600',
                  color: contracts === n ? COLORS.greenDark : COLORS.muted,
                }}
              >
                {n}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={{ height: 1, backgroundColor: COLORS.border, marginBottom: 14 }} />

        {/* live math */}
        <View style={{ gap: 9 }}>
          <View style={s.rowBetween}>
            <Hint>You put in</Hint>
            <Money cents={quote.stake} size={15} />
          </View>
          <View style={s.rowBetween}>
            <Hint>If it hits</Hint>
            <Text style={[monoFont, { color: COLORS.greenDark, fontSize: 15, fontWeight: '600' }]}>
              {formatUsd(quote.profitIfWin, { signed: true })}
            </Text>
          </View>
          <View style={s.rowBetween}>
            <Hint>Total payout</Hint>
            <Money cents={quote.payout} size={15} />
          </View>

          {mode === 'live' ? (
            <>
              <View style={{ height: 1, backgroundColor: COLORS.border, marginVertical: 3 }} />
              <View style={s.rowBetween}>
                <Hint>Platform fee ({Math.round(settings.feeRate * 100)}% of profit)</Hint>
                <Text style={[monoFont, { color: COLORS.gold, fontSize: 15, fontWeight: '600' }]}>
                  −{formatUsd(quote.estimatedFee)}
                </Text>
              </View>
              <View style={s.rowBetween}>
                <Text style={{ fontSize: 13.5, fontWeight: '700' }}>You&rsquo;d keep</Text>
                <Text style={[monoFont, { fontSize: 16, fontWeight: '700' }]}>
                  {formatUsd(quote.youdKeep, { signed: true })}
                </Text>
              </View>
              <Hint style={{ marginTop: 2 }}>
                Estimate only — your actual bill nets this against every other live trade that
                resolves in the same billing period, so a loss elsewhere reduces it.
              </Hint>
            </>
          ) : (
            <Hint style={{ marginTop: 4 }}>
              Paper mode — no money moves and no fee is charged.
            </Hint>
          )}
        </View>

        {/* balance check */}
        {mode === 'live' && balance !== null ? (
          <View style={{ marginTop: 14 }}>
            {overBalance ? (
              <Banner tone="danger" title="Not enough in your Kalshi account">
                This costs {formatUsd(quote.stake)} and you have {formatUsd(balance)}. Reduce the
                quantity or add funds on Kalshi.
              </Banner>
            ) : (
              <Hint>
                Kalshi balance {formatUsd(balance)} → {formatUsd(balance - quote.stake)} after this
                trade.
              </Hint>
            )}
          </View>
        ) : null}

        {mode === 'live' && blocked ? (
          <View style={{ marginTop: 14 }}>
            <Banner tone="warn">{blocked}</Banner>
          </View>
        ) : null}

        {error ? (
          <View style={{ marginTop: 14 }}>
            <Banner tone="danger" title="Trade not placed">{error}</Banner>
          </View>
        ) : null}

        <Button
          label={mode === 'live' ? `Put in ${formatUsd(quote.stake)}` : 'Take this trade (paper)'}
          onPress={takeTrade}
          loading={busy}
          disabled={ctaDisabled}
          style={{ marginTop: 16 }}
        />

        <Hint style={{ marginTop: 10, textAlign: 'center' }}>
          Your call, not ours. The score is a ranking, not a prediction.
        </Hint>
      </Card>
    </ScrollView>
  );
}
