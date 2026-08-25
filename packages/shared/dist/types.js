/**
 * Shared domain types. These mirror the Postgres schema in supabase/migrations.
 * Keep them in sync by hand — the row shapes are small and stable enough that a
 * generated client type would cost more than it saves at this scale.
 */
export const SIGNAL_LABELS = {
    micro: 'Market activity',
    news: 'News',
    base: 'Track record',
};
export const SIGNAL_KEYS = ['micro', 'news', 'base'];
//# sourceMappingURL=types.js.map