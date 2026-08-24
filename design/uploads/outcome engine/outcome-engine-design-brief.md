# Outcome Engine — Design Brief

## What this is
Outcome Engine is a platform for a private group (~20 invited friends) that scores Kalshi prediction-market trades from 1–10 using a weighted signal model, lets members take those trades through their own connected Kalshi accounts, tracks wins/losses, and bills a 20% platform fee on net profit. Trades are **score + human decides** — the platform recommends, the member chooses. Not automated trading, not pooled capital.

## Two products, two form factors
1. **Member app — native mobile (iOS/Android, React Native).** The trading experience: check scores, take trades, track positions and performance. Built for quick, on-the-go decisions.
2. **Admin dashboard — desktop web (React).** The management surface: tune the scoring model, monitor signal health, manage users/billing, run backtests, emergency controls. Data-dense, sit-down work.

Design each for its own form factor. Do NOT design the admin as a mobile layout with extra tabs.

## Visual direction
- Keep the existing color scheme: light gray background, white cards, green/teal accent (#1FBE87-ish), blue-to-green gradient for hero/summary elements, red for danger, amber/gold for caution states.
- Typography pairing that worked: clean sans (Inter) for UI, monospace (JetBrains Mono) for all numbers — scores, prices, PnL. Keep the quant/precision feel.
- Signature element to keep and refine: the **score ring** (circular progress ring around the 1–10 score, color-coded green ≥7 / gold 4.5–7 / red <4.5) and the **per-signal breakdown bars**.
- The attached wireframe images are the original inspiration — use their structure/IA as reference, but the final design should be significantly more refined and polished than them.
- Attached React mockups are working drafts of layout and content — treat as content spec, not final visual design.

---

## MEMBER APP (native mobile) — screens

### Onboarding (in order, one flow)
1. Invite code / invite link entry (no public signup)
2. Account creation (email/magic link)
3. Short explainer: what the score means, paper vs live, how the 20% fee works (net-profit basis, batched monthly, auto-charged)
4. Explicit agreement acknowledgment (simple, not legalese)
5. Payment method (Stripe card — required before live trading; Cash App/Venmo debit cards work here too)
6. Kalshi connection: guided flow for generating their own API key and pasting it in (key is encrypted; auto-fill username/profile basics from Kalshi where available)
7. Land in **Paper mode by default**

### Home
- Kalshi balance + amount in open positions
- This-period net PnL summary (gradient hero card)
- Open exposure / positions count / largest position
- Preview of top scored picks (links to Decision Desk)
- Recent activity snippet

### Decision Desk (core screen)
- Paper/Live mode toggle, always visible and unambiguous. Paper shows "practice, no real money" messaging
- Live mode shows current period net PnL + fee accruing
- Filter: All vs Strong (7+). Default to Strong
- One card per market: score ring, category, YES/NO side badge (model picks ONE side per market — never both), question, current price in cents, top tag preview
- Market detail: score ring large, "Why this score" per-signal breakdown bars (Market activity / News / Track record), annotation tags (info=blue, caution=gold, e.g. "Unusual volume with no matching news"), stake card, take-trade CTA

### Stake card (inside market detail)
- Contract quantity stepper
- Live math: you put in $X · if it hits +$Y · total payout $Z
- Live mode only: platform fee line (20% of profit) and "you'd keep" line, with note: "Estimate only — your actual bill nets this against losses in the same billing period"
- Balance check: disable CTA + warn if stake exceeds Kalshi balance
- CTA label reflects mode: "Put in $X" (live) vs "Take this trade (paper)"

### Positions
- Summary: total open / count / largest %
- Open positions: market, mode pill (paper/live), entry → current price, unrealized +/-, model version at entry
- Resolved: win/loss icon, PnL

### Performance
- Time range selector (Today/7D/30D/All)
- Total PnL, win rate, max drawdown, equity curve
- Breakdown: PnL by category, avg hold time, trade count

### Activity (member-scoped)
- Their own actions only: trades, resolutions, billing events, connection changes
- Search + event-type filter chips

### Billing / invoices (member)
- Current period: running net PnL and fee accruing
- Monthly invoice history (Stripe-backed): amount, status (paid/failed/grace period)
- Payment method management
- Grace-period state: clear banner explaining what happened and how to fix (update card or pay manually)

### Notifications (member)
- Notification center list + push notifications for: new model version published (+ new score & platform recommendation, esp. for open trades affected by a retune), trade resolved (win/loss), billing charged / payment failed / grace period, optional score-threshold alerts
- During a model version transition window: user can pick which stable version scores their view (short window, e.g. 2 weeks, then old version retires)

---

## ADMIN DASHBOARD (desktop web) — screens
Nav reference (from original wireframes): Home · Decision Desk · Positions · Performance · Strategy · Simulate · Accounts · Activity · Settings. Admin also has everything a member has (their own trading), plus:

### Admin Home
- Platform-wide snapshot: Kalshi feed status, active users, platform net PnL (30d), fees pending, risk state, open exposure across users
- Active signals / pending items / recent activity

### Strategy (two sub-views)
**Configure — 4-step flow (keep it simple, not one giant form):**
1. Signal weights — with per-category weight profiles: a platform default + optional per-category overrides (Economics / Politics / Weather / etc). Category chips with an override indicator dot; "customize" and "revert to default" actions
2. Score thresholds — strong-pick threshold slider, auto-tag toggles (volume anomalies, low liquidity)
3. Risk limits — daily loss limit, max trades/day, cooldown after loss
4. Review & publish — summary incl. which categories are overridden, "Preview vs last 30 days" and "Publish as vN"

**Signal health (monitoring):**
- Per signal source (Market activity / News / Track record): status pill (healthy / degraded / disabled), rolling win rate + sample size over last 100 resolved trades, trend sparkline
- Degraded: warning "will auto-disable if below min win rate." Disabled: reason + cooldown countdown
- Auto-disable rules config: rolling window, min win rate, accuracy-drop %, drawdown trigger, correlation-spike trigger, cooldown duration

### Simulate (backtesting)
- Inputs: strategy version, date range → run
- Results: simulated PnL, max drawdown, trade count
- Overlaid equity curves: live version vs simulated draft (one chart, not side-by-side)
- "Promote to live" (admin confirmation required)

### Accounts
- Every user: name, role (Admin/Member — role-based access exists for future co-admins), Kalshi connection status, account status (active / grace period / paused / **inactive**), mode, net PnL, trades, fee owed
- **Inactivity**: auto-flagged after N days without a platform trade (threshold admin-configurable); removal/kick is a manual admin action
- Billing management: per-user billing periods, failed payments, "mark as paid" manual override (for rare P2P-balance payments), invoice history
- Invite flow

### Tag review
- List of recent trades/markets with their auto-generated tags
- Admin can add/edit/remove tags on any trade (tags are auto rule-based + manual)
- Tag accuracy spot-checking is the feedback loop for improving tag rules

### Activity (full log)
- All users' events with filters: event type, date, user, keyword

### Settings
- API integration: Kalshi status, rate limit usage (note: Polymarket planned later, not connected)
- Platform risk limits: daily loss cap, max exposure per market, category locks
- Emergency controls: Pause trading (amber) and Global kill switch (red, confirmation modal) — kill switch stops all platform trading, does not close existing positions

## Key logic the design must respect
- **Fee**: 20% of NET profit per billing period (losses offset wins), billed monthly via Stripe, never deducted from Kalshi balance. Grace period on failed payment, then access paused. Paper trades never generate fees.
- **Sides**: the model picks YES or NO per market. One card per market, side badge shown. Never list both sides.
- **Model versioning**: every score and trade is tagged with a model version. Retunes notify users with new score + recommendation. Transition window lets users stay on the previous stable version briefly.
- **Paper vs live** must be visually unmistakable everywhere (cards, ledger, billing, notifications).
- **Roles**: members see their own data only; admin sees everything. Enforced at the data level, reflected in UI scoping.
- **Future (design can hint, don't build)**: usage tiers that lower the fee %, auto-adjusting weights (system proposes → admin approves → eventually autonomous), per-category signal health, Polymarket as second data source.

## Artifacts to attach in Claude Design
1. This brief
2. `outcome-engine-app.jsx` — the working mobile-sized React mockup (content + interaction spec for the member app and current admin drafts)
3. `outcome-engine-mockup.jsx` — earlier dark-theme concept (optional; only if exploring alternate directions)
4. The original wireframe images (Home, Decision Desk, Open Positions, Performance, Strategy Config, Market Sim, Accounts, Activity, Admin/System Settings, kill-switch confirm modal) — reference for admin IA and information density
