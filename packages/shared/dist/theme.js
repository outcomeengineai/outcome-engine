/**
 * Design tokens, lifted from the Claude Design canvas and the mockup in
 * design/uploads/outcome engine/outcome-engine-app.jsx so both clients render
 * the same palette. Plain values, no framework — React Native and the web
 * dashboard both consume these directly.
 */
export const COLORS = {
    bg: '#F1F3F5',
    surface: '#FFFFFF',
    surfaceMuted: '#F7F8FA',
    border: '#E3E6EA',
    text: '#161B22',
    muted: '#69707C',
    faint: '#9AA1AC',
    green: '#1FBE87',
    greenDark: '#149A6D',
    blue: '#3E7BFA',
    red: '#E2544F',
    gold: '#DE9F35',
    purple: '#8B6FD8',
};
export const GRADIENT_STOPS = [COLORS.blue, COLORS.green];
export const GRADIENT_CSS = `linear-gradient(100deg, ${COLORS.blue} 0%, ${COLORS.green} 100%)`;
/** Per-signal accent colours for the breakdown bars. */
export const SIGNAL_COLORS = {
    micro: COLORS.green,
    news: COLORS.blue,
    base: COLORS.purple,
};
/** Score-ring colour, keyed off the same bands as `scoreBand`. */
export const BAND_COLORS = {
    strong: COLORS.green,
    moderate: COLORS.gold,
    weak: COLORS.red,
};
export const SEVERITY_COLORS = {
    info: COLORS.blue,
    caution: COLORS.gold,
};
export const FONTS = {
    sans: 'Inter',
    mono: 'JetBrains Mono',
};
//# sourceMappingURL=theme.js.map