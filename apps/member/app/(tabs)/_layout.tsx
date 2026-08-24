import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { COLORS } from '@outcome/shared';

/**
 * Four tabs, not nine. The member app is for quick decisions on a phone —
 * Billing, Activity, Notifications and Settings are reachable from Home rather
 * than competing for the bottom bar.
 */
function TabIcon({ glyph, color }: { glyph: string; color: string }) {
  return <Text style={{ fontSize: 19, color }}>{glyph}</Text>;
}

export default function TabsLayout() {
  return (
    <Tabs
      sceneContainerStyle={{ backgroundColor: COLORS.bg }}
      screenOptions={{
        headerStyle: { backgroundColor: COLORS.bg },
        headerShadowVisible: false,
        headerTitleStyle: { fontSize: 16, fontWeight: '600' },
        tabBarActiveTintColor: COLORS.greenDark,
        tabBarInactiveTintColor: COLORS.faint,
        tabBarStyle: {
          backgroundColor: COLORS.surface,
          borderTopColor: COLORS.border,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => <TabIcon glyph="◉" color={color} />,
        }}
      />
      <Tabs.Screen
        name="desk"
        options={{
          title: 'Desk',
          tabBarIcon: ({ color }) => <TabIcon glyph="◎" color={color} />,
        }}
      />
      <Tabs.Screen
        name="positions"
        options={{
          title: 'Positions',
          tabBarIcon: ({ color }) => <TabIcon glyph="▤" color={color} />,
        }}
      />
      <Tabs.Screen
        name="performance"
        options={{
          title: 'Performance',
          tabBarIcon: ({ color }) => <TabIcon glyph="◪" color={color} />,
        }}
      />
    </Tabs>
  );
}
