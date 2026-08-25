/**
 * Design tokens, lifted from the Claude Design canvas and the mockup in
 * design/uploads/outcome engine/outcome-engine-app.jsx so both clients render
 * the same palette. Plain values, no framework — React Native and the web
 * dashboard both consume these directly.
 */
export declare const COLORS: {
    readonly bg: "#F1F3F5";
    readonly surface: "#FFFFFF";
    readonly surfaceMuted: "#F7F8FA";
    readonly border: "#E3E6EA";
    readonly text: "#161B22";
    readonly muted: "#69707C";
    readonly faint: "#9AA1AC";
    readonly green: "#1FBE87";
    readonly greenDark: "#149A6D";
    readonly blue: "#3E7BFA";
    readonly red: "#E2544F";
    readonly gold: "#DE9F35";
    readonly purple: "#8B6FD8";
};
export declare const GRADIENT_STOPS: readonly ["#3E7BFA", "#1FBE87"];
export declare const GRADIENT_CSS: string;
/** Per-signal accent colours for the breakdown bars. */
export declare const SIGNAL_COLORS: {
    readonly micro: "#1FBE87";
    readonly news: "#3E7BFA";
    readonly base: "#8B6FD8";
};
/** Score-ring colour, keyed off the same bands as `scoreBand`. */
export declare const BAND_COLORS: {
    readonly strong: "#1FBE87";
    readonly moderate: "#DE9F35";
    readonly weak: "#E2544F";
};
export declare const SEVERITY_COLORS: {
    readonly info: "#3E7BFA";
    readonly caution: "#DE9F35";
};
export declare const FONTS: {
    readonly sans: "Inter";
    readonly mono: "JetBrains Mono";
};
//# sourceMappingURL=theme.d.ts.map