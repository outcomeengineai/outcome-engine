import { Pressable, Text, View } from 'react-native';
import { COLORS } from '@outcome/shared';
import type { TradeMode } from '@outcome/shared';
import { Hint } from './ui';

/**
 * The paper/live switch.
 *
 * Always visible and never ambiguous — this is the control that decides
 * whether a tap spends real money. Live is deliberately harder to select when
 * it is unavailable: the reason is shown inline rather than the option simply
 * doing nothing.
 */
export function ModeToggle({
  mode,
  onChange,
  liveBlockedReason,
}: {
  mode: TradeMode;
  onChange: (m: TradeMode) => void;
  liveBlockedReason: string | null;
}) {
  const liveAvailable = liveBlockedReason === null;

  return (
    <View>
      <View
        style={{
          flexDirection: 'row',
          backgroundColor: COLORS.surfaceMuted,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: COLORS.border,
          padding: 3,
        }}
      >
        {(['paper', 'live'] as const).map((m) => {
          const active = mode === m;
          const disabled = m === 'live' && !liveAvailable;

          return (
            <Pressable
              key={m}
              onPress={() => !disabled && onChange(m)}
              style={({ pressed }) => ({
                flex: 1,
                paddingVertical: 9,
                borderRadius: 999,
                alignItems: 'center',
                backgroundColor: active ? COLORS.surface : 'transparent',
                opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
                shadowColor: '#000',
                shadowOpacity: active ? 0.06 : 0,
                shadowRadius: 2,
                shadowOffset: { width: 0, height: 1 },
                elevation: active ? 1 : 0,
              })}
            >
              <Text
                style={{
                  fontSize: 14,
                  fontWeight: '600',
                  color: active
                    ? m === 'live' ? COLORS.greenDark : '#6A4FC0'
                    : COLORS.faint,
                }}
              >
                {m === 'live' ? '● Live' : 'Paper'}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {mode === 'paper' ? (
        <Hint style={{ marginTop: 7, textAlign: 'center' }}>
          Practice mode — no real money, and no fees.
        </Hint>
      ) : null}

      {!liveAvailable ? (
        <Hint style={{ marginTop: 7, textAlign: 'center', color: COLORS.gold }}>
          {liveBlockedReason}
        </Hint>
      ) : null}
    </View>
  );
}
