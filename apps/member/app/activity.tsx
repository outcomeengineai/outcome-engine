import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { COLORS } from '@outcome/shared';
import { Card, Empty, Hint, Loading, Pill, relativeTime, s } from '@/components/ui';
import { useActivity } from '@/lib/data';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'trade', label: 'Trades' },
  { key: 'billing', label: 'Billing' },
  { key: 'kalshi', label: 'Connection' },
  { key: 'model', label: 'Model' },
] as const;

function tone(type: string) {
  if (type.includes('failed')) return 'red' as const;
  if (type.startsWith('billing')) return 'gold' as const;
  if (type.startsWith('trade')) return 'green' as const;
  if (type.startsWith('model')) return 'purple' as const;
  return 'muted' as const;
}

/**
 * Member-scoped activity. RLS restricts activity_log to the caller's own rows,
 * so this is the same query the admin dashboard runs — it simply returns less.
 */
export default function ActivityScreen() {
  const { data, loading } = useActivity();
  const [filter, setFilter] = useState<string>('all');
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    return (data ?? []).filter((e) => {
      if (filter !== 'all' && !String(e.event_type).startsWith(filter)) return false;
      if (query) {
        const hay = `${e.event_type} ${e.detail ?? ''}`.toLowerCase();
        if (!hay.includes(query.toLowerCase())) return false;
      }
      return true;
    });
  }, [data, filter, query]);

  if (loading && !data) return <Loading />;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: COLORS.bg }}
      contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 12 }}
    >
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search your activity…"
        placeholderTextColor={COLORS.faint}
        style={s.input}
      />

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 7 }}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            onPress={() => setFilter(f.key)}
            style={{
              paddingVertical: 7, paddingHorizontal: 14, borderRadius: 999,
              borderWidth: 1,
              borderColor: filter === f.key ? COLORS.green : COLORS.border,
              backgroundColor: filter === f.key ? '#E4F7EF' : COLORS.surface,
            }}
          >
            <Text
              style={{
                fontSize: 12.5, fontWeight: '600',
                color: filter === f.key ? COLORS.greenDark : COLORS.muted,
              }}
            >
              {f.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {rows.length === 0 ? (
        <Card><Empty>Nothing matches.</Empty></Card>
      ) : (
        <Card style={{ gap: 15 }}>
          {rows.map((e) => (
            <View key={e.id} style={s.rowBetween}>
              <View style={{ flex: 1, marginRight: 10 }}>
                <Pill tone={tone(String(e.event_type))}>{String(e.event_type)}</Pill>
                <Text style={{ fontSize: 13, lineHeight: 18.5, color: COLORS.muted, marginTop: 5 }}>
                  {e.detail ?? '—'}
                </Text>
              </View>
              <Hint>{relativeTime(e.ts)}</Hint>
            </View>
          ))}
        </Card>
      )}
    </ScrollView>
  );
}
