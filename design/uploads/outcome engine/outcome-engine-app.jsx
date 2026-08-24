import React, { useState } from "react";
import {
  AreaChart, Area, ResponsiveContainer, YAxis,
} from "recharts";
import {
  Home, Crosshair, Briefcase, LineChart, SlidersHorizontal, FlaskConical,
  Users, ScrollText, ShieldCheck, Bell, ChevronLeft, ChevronRight,
  FlaskConical as FlaskIcon, Radio, ShieldAlert, Info, TrendingUp, TrendingDown,
  ArrowRight, Check, X, Power, Pause, Circle, Search, Wallet, Minus, Plus,
} from "lucide-react";

/* ---------------------------------- tokens --------------------------------- */
const C = {
  bg: "#F1F3F5",
  surface: "#FFFFFF",
  surfaceMuted: "#F7F8FA",
  border: "#E3E6EA",
  text: "#161B22",
  muted: "#69707C",
  faint: "#9AA1AC",
  green: "#1FBE87",
  greenDark: "#149A6D",
  blue: "#3E7BFA",
  red: "#E2544F",
  gold: "#DE9F35",
};
const GRADIENT = `linear-gradient(100deg, ${C.blue} 0%, ${C.green} 100%)`;
const MARKER_LABEL = { micro: "Market activity", news: "News", base: "Track record" };
const MARKER_COLOR = { micro: C.green, news: C.blue, base: "#8B6FD8" };
const FEE_RATE = 0.20;
const kalshiBalance = 1284.60;

/* ---------------------------------- mock data --------------------------------- */
const markets = [
  {
    id: "KXFED-26SEP", question: "Will the Fed cut rates at the September meeting?",
    category: "Economics", side: "YES", price: 0.71, score: 8.4,
    breakdown: { micro: 5.1, news: 2.0, base: 1.3 },
    tags: [{ text: "Unusual volume with no matching news", severity: "caution" }],
  },
  {
    id: "KXCPI-OCT26", question: "Will October CPI come in above 3.0%?",
    category: "Economics", side: "YES", price: 0.44, score: 6.8,
    breakdown: { micro: 3.9, news: 1.9, base: 1.0 },
    tags: [{ text: "News is one-sided but price hasn't moved yet", severity: "info" }],
  },
  {
    id: "KXTEMP-NYC", question: "Will NYC hit 90°F this week?",
    category: "Weather", side: "YES", price: 0.62, score: 7.2,
    breakdown: { micro: 3.8, news: 0.4, base: 3.0 }, tags: [],
  },
  {
    id: "KXGOV-SHUT26", question: "Government shutdown before November 1st?",
    category: "Politics", side: "NO", price: 0.82, score: 7.6,
    breakdown: { micro: 3.9, news: 2.2, base: 1.5 },
    tags: [{ text: "Low liquidity — could be costly to exit", severity: "caution" }],
  },
];
const openPositions = [
  { id: "T-1042", market: "Fed rate cut — September", mode: "live", model: "v2", entryScore: 8.1, entry: 0.68, current: 0.74, size: 200 },
  { id: "T-1039", market: "October CPI above 3.0%", mode: "paper", model: "v3-draft", entryScore: 6.5, entry: 0.41, current: 0.39, size: 100 },
];
const resolved = [
  { id: "T-0998", market: "Budget resolution by Aug 1", outcome: "win", pnl: 84.2 },
  { id: "T-0991", market: "Oil closes above $80", outcome: "loss", pnl: -32.0 },
  { id: "T-0987", market: "Fed rate cut — July", outcome: "win", pnl: 51.5 },
];
const accountsData = [
  { name: "Marcus T.", role: "Member", kalshi: "connected", status: "active", mode: "live", netPnl: 312.4, feeOwed: 62.5 },
  { name: "Priya K.", role: "Member", kalshi: "connected", status: "active", mode: "live", netPnl: -41.0, feeOwed: 0 },
  { name: "Dev R.", role: "Member", kalshi: "connected", status: "grace period", mode: "live", netPnl: 128.9, feeOwed: 25.8 },
  { name: "You", role: "Admin", kalshi: "connected", status: "active", mode: "paper", netPnl: 205.0, feeOwed: 0 },
];
const activityLog = [
  { time: "09:41", event: "Trade", user: "Marcus T.", detail: "Took Fed rate cut — September, +$18 sim", tone: "green" },
  { time: "09:12", event: "Model published", user: "You", detail: "v3 published — microstructure weight 60%", tone: "blue" },
  { time: "08:55", event: "Billing", user: "Dev R.", detail: "Payment failed — grace period started", tone: "gold" },
  { time: "08:20", event: "Trade resolved", user: "Priya K.", detail: "Oil above $80 — loss, -$32", tone: "red" },
  { time: "Yesterday", event: "Connection", user: "You", detail: "Kalshi API key rotated", tone: "muted" },
];
const equityData = [2,4,3,6,5,8,7,9,8,11,9,12,10,13,12,15,13,14,12,15].map((v, i) => ({ i, v }));
const simLive = [2,4,3,6,5,8,7,9,8,11].map((v, i) => ({ i, v }));
const simSimulated = [2,3,5,4,7,6,10,8,12,11].map((v, i) => ({ i, v }));

/* ---------------------------------- shared bits --------------------------------- */
function Sparkline({ data, color }) {
  return (
    <div style={{ width: "100%", height: 44 }}>
      <ResponsiveContainer>
        <AreaChart data={data}>
          <YAxis hide domain={["dataMin - 1", "dataMax + 1"]} />
          <defs>
            <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey="v" stroke={color} strokeWidth={2} fill="url(#spark)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function Card({ children, style, className = "" }) {
  return (
    <div className={`rounded-2xl border ${className}`} style={{ borderColor: C.border, backgroundColor: C.surface, ...style }}>
      {children}
    </div>
  );
}

function Pill({ children, tone = "muted" }) {
  const map = {
    green: { c: C.greenDark, bg: "#E7F8F1" },
    gold: { c: "#8A5B0E", bg: "#FBF1DF" },
    red: { c: "#9A2E2A", bg: "#FBE9E8" },
    blue: { c: "#1E4FB8", bg: "#E9F0FF" },
    muted: { c: C.muted, bg: C.surfaceMuted },
  }[tone];
  return (
    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full" style={{ color: map.c, backgroundColor: map.bg }}>
      {children}
    </span>
  );
}

function ScoreRing({ score, size = 52 }) {
  const color = score >= 7 ? C.green : score >= 4.5 ? C.gold : C.red;
  const r = 20, circ = 2 * Math.PI * r, pct = (score / 10) * 100;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 48 48" className="-rotate-90">
        <circle cx="24" cy="24" r={r} fill="none" stroke={C.border} strokeWidth="4" />
        <circle cx="24" cy="24" r={r} fill="none" stroke={color} strokeWidth="4"
          strokeDasharray={circ} strokeDashoffset={circ - (pct / 100) * circ} strokeLinecap="round" />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="font-mono text-[15px] font-semibold" style={{ color }}>{score.toFixed(1)}</span>
      </div>
    </div>
  );
}

/* ---------------------------------- nav --------------------------------- */
const NAV = [
  { key: "home", label: "Home", icon: Home },
  { key: "decision", label: "Decision Desk", icon: Crosshair },
  { key: "positions", label: "Positions", icon: Briefcase },
  { key: "performance", label: "Performance", icon: LineChart },
  { key: "strategy", label: "Strategy", icon: SlidersHorizontal, adminOnly: true },
  { key: "sim", label: "Simulate", icon: FlaskConical, adminOnly: true },
  { key: "accounts", label: "Accounts", icon: Users, adminOnly: true },
  { key: "activity", label: "Activity", icon: ScrollText },
  { key: "settings", label: "Settings", icon: ShieldCheck, adminOnly: true },
];

function TopNav({ view, setView, isAdmin }) {
  const items = NAV.filter((n) => !n.adminOnly || isAdmin);
  return (
    <div className="flex gap-1 overflow-x-auto pb-1 -mx-4 px-4" style={{ scrollbarWidth: "none" }}>
      {items.map((n) => {
        const Icon = n.icon;
        const active = view === n.key;
        return (
          <button key={n.key} onClick={() => setView(n.key)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-full text-[13px] font-medium whitespace-nowrap transition-colors shrink-0"
            style={{ backgroundColor: active ? "#E7F8F1" : "transparent", color: active ? C.greenDark : C.muted }}>
            <Icon size={14} />
            {n.label}
          </button>
        );
      })}
    </div>
  );
}

function RoleToggle({ isAdmin, setIsAdmin }) {
  return (
    <div className="flex items-center gap-1 p-0.5 rounded-full border" style={{ borderColor: C.border, backgroundColor: C.surfaceMuted }}>
      {[{ v: false, l: "Member" }, { v: true, l: "Admin" }].map((o) => (
        <button key={o.l} onClick={() => setIsAdmin(o.v)}
          className="px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors"
          style={{ backgroundColor: isAdmin === o.v ? C.surface : "transparent", color: isAdmin === o.v ? C.text : C.faint, boxShadow: isAdmin === o.v ? "0 1px 2px rgba(0,0,0,0.06)" : "none" }}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------- Home --------------------------------- */
function HomeView({ setView }) {
  return (
    <div className="space-y-5">
      <Card style={{ backgroundImage: GRADIENT, border: "none" }} className="p-5 text-white">
        <div className="flex items-center gap-2 mb-1">
          <Circle size={8} fill="white" style={{ color: "white" }} />
          <span className="text-sm font-medium opacity-90">Kalshi connected · Manual review mode</span>
        </div>
        <p className="text-3xl font-mono font-semibold mt-2">+$271.40</p>
        <p className="text-xs opacity-80 mt-1">This period, net · risk within limits</p>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Card className="p-3.5 flex items-center gap-2.5">
          <Wallet size={16} style={{ color: C.muted }} />
          <div>
            <p className="font-mono text-base" style={{ color: C.text }}>${kalshiBalance.toFixed(2)}</p>
            <p className="text-[11px]" style={{ color: C.faint }}>Kalshi balance</p>
          </div>
        </Card>
        <Card className="p-3.5 flex items-center gap-2.5">
          <Briefcase size={16} style={{ color: C.muted }} />
          <div>
            <p className="font-mono text-base" style={{ color: C.text }}>$680</p>
            <p className="text-[11px]" style={{ color: C.faint }}>in open positions</p>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Open exposure", value: "$680" },
          { label: "Positions", value: "2" },
          { label: "Largest position", value: "29%" },
        ].map((s) => (
          <Card key={s.label} className="p-3.5 text-center">
            <p className="font-mono text-lg" style={{ color: C.text }}>{s.value}</p>
            <p className="text-[11px] mt-0.5" style={{ color: C.faint }}>{s.label}</p>
          </Card>
        ))}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium" style={{ color: C.text }}>Today's picks</p>
          <button onClick={() => setView("decision")} className="text-xs font-medium flex items-center gap-0.5" style={{ color: C.greenDark }}>
            Decision Desk <ChevronRight size={13} />
          </button>
        </div>
        <div className="space-y-2">
          {markets.slice(0, 2).map((m) => (
            <Card key={m.id} className="p-3 flex items-center gap-3">
              <ScoreRing score={m.score} size={40} />
              <p className="flex-1 text-sm truncate" style={{ color: C.text }}>{m.question}</p>
              <span className="font-mono text-sm" style={{ color: C.muted }}>{Math.round(m.price * 100)}¢</span>
            </Card>
          ))}
        </div>
      </div>

      <div>
        <p className="text-sm font-medium mb-2" style={{ color: C.text }}>Recent activity</p>
        <Card className="p-1">
          {activityLog.slice(0, 3).map((a, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2.5" style={{ borderBottom: i < 2 ? `1px solid ${C.border}` : "none" }}>
              <span className="text-[11px] font-mono w-10 shrink-0" style={{ color: C.faint }}>{a.time}</span>
              <p className="flex-1 text-sm truncate" style={{ color: C.text }}>{a.detail}</p>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

/* ---------------------------------- Decision Desk --------------------------------- */
function TopTag({ tag }) {
  if (!tag) return null;
  const color = tag.severity === "caution" ? C.gold : C.blue;
  const Icon = tag.severity === "caution" ? ShieldAlert : Info;
  return (
    <div className="flex items-center gap-1.5 text-xs mt-1.5" style={{ color: C.muted }}>
      <Icon size={12} style={{ color }} /> <span>{tag.text}</span>
    </div>
  );
}

function MarketCard({ m, onOpen }) {
  const sideColor = m.side === "NO" ? C.red : C.blue;
  return (
    <button onClick={() => onOpen(m)}
      className="w-full text-left rounded-2xl border p-4 flex items-center gap-4 transition-colors hover:bg-black/[0.015]"
      style={{ borderColor: C.border, backgroundColor: C.surface }}>
      <ScoreRing score={m.score} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <p className="text-[11px] uppercase tracking-wide" style={{ color: C.faint }}>{m.category}</p>
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ color: sideColor, backgroundColor: `${sideColor}14` }}>{m.side}</span>
        </div>
        <p className="text-[15px] leading-snug font-medium" style={{ color: C.text }}>{m.question}</p>
        <TopTag tag={m.tags[0]} />
      </div>
      <div className="text-right shrink-0">
        <p className="font-mono text-base" style={{ color: C.text }}>{Math.round(m.price * 100)}¢</p>
        <p className="text-[11px]" style={{ color: C.faint }}>chance</p>
      </div>
    </button>
  );
}

function MarketDetail({ m, onBack, mode }) {
  const [contracts, setContracts] = useState(50);
  const cost = (contracts * m.price);
  const potentialPayout = contracts * 1.0;
  const potentialProfit = potentialPayout - cost;
  const platformFee = mode === "live" ? potentialProfit * FEE_RATE : 0;
  const netProfit = potentialProfit - platformFee;
  const balanceAfter = kalshiBalance - cost;
  const overBalance = mode === "live" && cost > kalshiBalance;

  return (
    <div className="space-y-6">
      <button onClick={onBack} className="flex items-center gap-1 text-sm" style={{ color: C.muted }}>
        <ChevronLeft size={16} /> Back
      </button>
      <div className="flex items-start gap-4">
        <ScoreRing score={m.score} size={64} />
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <p className="text-[11px] uppercase tracking-wide" style={{ color: C.faint }}>{m.category}</p>
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ color: m.side === "NO" ? C.red : C.blue, backgroundColor: m.side === "NO" ? "#FBE9E8" : "#E9F0FF" }}>{m.side}</span>
          </div>
          <h2 className="text-xl font-semibold leading-snug" style={{ color: C.text }}>{m.question}</h2>
        </div>
      </div>
      <div className="flex gap-3">
        <Card className="flex-1 p-3 text-center"><p className="font-mono text-lg" style={{ color: C.text }}>{Math.round(m.price * 100)}¢</p><p className="text-[11px]" style={{ color: C.faint }}>current price</p></Card>
        <Card className="flex-1 p-3 text-center"><p className="font-mono text-lg" style={{ color: C.text }}>{m.id}</p><p className="text-[11px]" style={{ color: C.faint }}>market</p></Card>
      </div>
      <div>
        <p className="text-sm font-medium mb-3" style={{ color: C.text }}>Why this score</p>
        <div className="space-y-3">
          {["micro", "news", "base"].map((k) => (
            <div key={k}>
              <div className="flex justify-between text-sm mb-1">
                <span style={{ color: C.muted }}>{MARKER_LABEL[k]}</span>
                <span className="font-mono" style={{ color: MARKER_COLOR[k] }}>{m.breakdown[k].toFixed(1)}</span>
              </div>
              <div className="h-1.5 rounded-full w-full" style={{ backgroundColor: C.surfaceMuted }}>
                <div className="h-1.5 rounded-full" style={{ width: `${(m.breakdown[k] / 10) * 100}%`, backgroundColor: MARKER_COLOR[k] }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-medium" style={{ color: C.text }}>Stake this {m.side} position</p>
          <span className="text-xs" style={{ color: C.faint }}>
            {mode === "live" ? "Live" : "Paper"} · balance ${kalshiBalance.toFixed(2)}
          </span>
        </div>
        <Card className="p-4">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm" style={{ color: C.muted }}>Contracts</span>
            <div className="flex items-center gap-3">
              <button onClick={() => setContracts(Math.max(1, contracts - 10))}
                className="w-8 h-8 rounded-full flex items-center justify-center border" style={{ borderColor: C.border, color: C.muted }}>
                <Minus size={14} />
              </button>
              <span className="font-mono text-base w-10 text-center" style={{ color: C.text }}>{contracts}</span>
              <button onClick={() => setContracts(contracts + 10)}
                className="w-8 h-8 rounded-full flex items-center justify-center border" style={{ borderColor: C.border, color: C.muted }}>
                <Plus size={14} />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 pt-3" style={{ borderTop: `1px solid ${C.border}` }}>
            <div>
              <p className="font-mono text-sm" style={{ color: C.text }}>${cost.toFixed(2)}</p>
              <p className="text-[11px]" style={{ color: C.faint }}>you put in</p>
            </div>
            <div>
              <p className="font-mono text-sm" style={{ color: C.greenDark }}>+${potentialProfit.toFixed(2)}</p>
              <p className="text-[11px]" style={{ color: C.faint }}>if it hits</p>
            </div>
            <div>
              <p className="font-mono text-sm" style={{ color: C.text }}>${potentialPayout.toFixed(2)}</p>
              <p className="text-[11px]" style={{ color: C.faint }}>total payout</p>
            </div>
          </div>
          {mode === "live" && (
            <div className="flex items-center justify-between text-xs mt-3 pt-3" style={{ borderTop: `1px solid ${C.border}` }}>
              <span style={{ color: C.faint }}>Platform fee (20% of profit if this wins)</span>
              <span className="font-mono" style={{ color: C.gold }}>-${platformFee.toFixed(2)}</span>
            </div>
          )}
          {mode === "live" && (
            <div className="flex items-center justify-between text-xs mt-1.5">
              <span style={{ color: C.faint }}>You'd keep</span>
              <span className="font-mono font-medium" style={{ color: C.greenDark }}>${netProfit.toFixed(2)}</span>
            </div>
          )}
          {mode === "live" && (
            <p className="text-[11px] mt-2" style={{ color: C.faint }}>
              Estimate only — your actual bill nets this against any losses in the same billing period.
            </p>
          )}
          {overBalance && (
            <p className="text-xs mt-3 flex items-center gap-1.5" style={{ color: C.red }}>
              <ShieldAlert size={13} /> This exceeds your Kalshi balance
            </p>
          )}
        </Card>
      </div>

      {m.tags.length > 0 && (
        <div className="space-y-2">
          {m.tags.map((t, i) => {
            const color = t.severity === "caution" ? C.gold : C.blue;
            const bg = t.severity === "caution" ? "#FBF1DF" : "#E9F0FF";
            const Icon = t.severity === "caution" ? ShieldAlert : Info;
            return (
              <div key={i} className="flex items-start gap-2 text-sm rounded-xl p-3" style={{ backgroundColor: bg, color: C.muted }}>
                <Icon size={15} style={{ color, marginTop: 1, flexShrink: 0 }} /> <span>{t.text}</span>
              </div>
            );
          })}
        </div>
      )}
      <button disabled={overBalance} className="w-full py-3.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-1.5 text-white"
        style={{ backgroundImage: GRADIENT, opacity: overBalance ? 0.5 : 1 }}>
        {mode === "live" ? `Put in $${cost.toFixed(2)}` : "Take this trade (paper)"} <ArrowRight size={15} />
      </button>
    </div>
  );
}

function DecisionDeskView() {
  const [mode, setMode] = useState("paper");
  const [minScore, setMinScore] = useState(7);
  const [selected, setSelected] = useState(null);
  const filtered = markets.filter((m) => m.score >= minScore);
  if (selected) return <MarketDetail m={selected} onBack={() => setSelected(null)} mode={mode} />;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-1 p-1 rounded-full border w-full" style={{ borderColor: C.border, backgroundColor: C.surfaceMuted }}>
        <button onClick={() => setMode("paper")} className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-full text-sm font-medium"
          style={{ backgroundColor: mode === "paper" ? C.surface : "transparent", color: mode === "paper" ? C.text : C.faint, boxShadow: mode === "paper" ? "0 1px 2px rgba(0,0,0,0.06)" : "none" }}>
          <FlaskIcon size={14} /> Paper
        </button>
        <button onClick={() => setMode("live")} className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-full text-sm font-medium"
          style={{ backgroundColor: mode === "live" ? C.surface : "transparent", color: mode === "live" ? C.greenDark : C.faint, boxShadow: mode === "live" ? "0 1px 2px rgba(0,0,0,0.06)" : "none" }}>
          <Radio size={14} /> Live
        </button>
      </div>
      {mode === "paper" && <p className="text-xs text-center" style={{ color: C.faint }}>Practice mode. Nothing here uses real money.</p>}

      <div className="flex items-center justify-between">
        <p className="text-sm font-medium" style={{ color: C.text }}>Scored markets</p>
        <div className="flex gap-1">
          {[{ v: 0, l: "All" }, { v: 7, l: "Strong" }].map((o) => (
            <button key={o.v} onClick={() => setMinScore(o.v)}
              className="px-3 py-1 rounded-full text-xs font-medium border"
              style={{ borderColor: minScore === o.v ? C.green : C.border, color: minScore === o.v ? C.greenDark : C.faint, backgroundColor: minScore === o.v ? "#E7F8F1" : "transparent" }}>
              {o.l}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-3">
        {filtered.map((m) => <MarketCard key={m.id} m={m} onOpen={setSelected} />)}
      </div>
    </div>
  );
}

/* ---------------------------------- Positions --------------------------------- */
function PositionsView() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <Card className="p-3.5 text-center"><p className="font-mono text-lg" style={{ color: C.text }}>$680</p><p className="text-[11px]" style={{ color: C.faint }}>total open</p></Card>
        <Card className="p-3.5 text-center"><p className="font-mono text-lg" style={{ color: C.text }}>2</p><p className="text-[11px]" style={{ color: C.faint }}>positions</p></Card>
        <Card className="p-3.5 text-center"><p className="font-mono text-lg" style={{ color: C.text }}>29%</p><p className="text-[11px]" style={{ color: C.faint }}>largest</p></Card>
      </div>
      <div>
        <p className="text-sm font-medium mb-2" style={{ color: C.text }}>Open</p>
        <Card className="p-1">
          {openPositions.map((t, i) => (
            <div key={t.id} className="p-3" style={{ borderBottom: i < openPositions.length - 1 ? `1px solid ${C.border}` : "none" }}>
              <div className="flex items-center justify-between mb-1">
                <p className="text-sm font-medium truncate pr-2" style={{ color: C.text }}>{t.market}</p>
                <Pill tone={t.mode === "live" ? "green" : "muted"}>{t.mode}</Pill>
              </div>
              <div className="flex items-center justify-between text-xs" style={{ color: C.faint }}>
                <span className="font-mono">entry {Math.round(t.entry * 100)}¢ → now {Math.round(t.current * 100)}¢</span>
                <span className="font-mono" style={{ color: t.current >= t.entry ? C.greenDark : C.red }}>
                  {t.current >= t.entry ? "+" : ""}{Math.round((t.current - t.entry) * 100)}¢
                </span>
              </div>
            </div>
          ))}
        </Card>
      </div>
      <div>
        <p className="text-sm font-medium mb-2" style={{ color: C.text }}>Resolved</p>
        <Card className="p-1">
          {resolved.map((t, i) => (
            <div key={t.id} className="flex items-center gap-3 px-3 py-2.5" style={{ borderBottom: i < resolved.length - 1 ? `1px solid ${C.border}` : "none" }}>
              {t.outcome === "win" ? <TrendingUp size={14} style={{ color: C.greenDark }} /> : <TrendingDown size={14} style={{ color: C.red }} />}
              <p className="flex-1 text-sm truncate" style={{ color: C.text }}>{t.market}</p>
              <span className="font-mono text-sm" style={{ color: t.pnl >= 0 ? C.greenDark : C.red }}>{t.pnl >= 0 ? "+" : ""}{t.pnl.toFixed(0)}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

/* ---------------------------------- Performance --------------------------------- */
function PerformanceView() {
  const [range, setRange] = useState("30D");
  return (
    <div className="space-y-5">
      <div className="flex gap-1">
        {["Today", "7D", "30D", "All"].map((r) => (
          <button key={r} onClick={() => setRange(r)}
            className="px-3 py-1.5 rounded-full text-xs font-medium border"
            style={{ borderColor: range === r ? C.green : C.border, color: range === r ? C.greenDark : C.faint, backgroundColor: range === r ? "#E7F8F1" : "transparent" }}>
            {r}
          </button>
        ))}
      </div>
      <Card className="p-4">
        <div className="grid grid-cols-3 gap-3 mb-3">
          <div><p className="font-mono text-lg" style={{ color: C.greenDark }}>+$271</p><p className="text-[11px]" style={{ color: C.faint }}>total PnL</p></div>
          <div><p className="font-mono text-lg" style={{ color: C.text }}>61%</p><p className="text-[11px]" style={{ color: C.faint }}>win rate</p></div>
          <div><p className="font-mono text-lg" style={{ color: C.text }}>-8%</p><p className="text-[11px]" style={{ color: C.faint }}>max drawdown</p></div>
        </div>
        <Sparkline data={equityData} color={C.green} />
      </Card>
      <div className="grid grid-cols-3 gap-3">
        <Card className="p-3 text-center"><p className="text-[11px] mb-1" style={{ color: C.faint }}>PnL by category</p><p className="font-mono text-sm" style={{ color: C.text }}>Econ +$210</p></Card>
        <Card className="p-3 text-center"><p className="text-[11px] mb-1" style={{ color: C.faint }}>Avg hold time</p><p className="font-mono text-sm" style={{ color: C.text }}>2.4d</p></Card>
        <Card className="p-3 text-center"><p className="text-[11px] mb-1" style={{ color: C.faint }}>Trades</p><p className="font-mono text-sm" style={{ color: C.text }}>19</p></Card>
      </div>
    </div>
  );
}

/* ---------------------------------- Strategy (simplified stepper) --------------------------------- */
const CATEGORIES = ["All markets", "Economics", "Politics", "Weather"];
const DEFAULT_WEIGHTS = { micro: 60, news: 25, base: 15 };

function StrategyView() {
  const [tab, setTab] = useState("configure");
  const [step, setStep] = useState(0);
  const [activeCategory, setActiveCategory] = useState("All markets");
  const [weightsByCategory, setWeightsByCategory] = useState({
    "All markets": { ...DEFAULT_WEIGHTS },
    Economics: null,
    Politics: null,
    Weather: null,
  });
  const [minScore, setMinScore] = useState(7);
  const steps = ["Signal weights", "Score thresholds", "Risk limits", "Review & publish"];

  const globalWeights = weightsByCategory["All markets"];
  const isOverridden = activeCategory !== "All markets" && weightsByCategory[activeCategory] !== null;
  const activeWeights = isOverridden ? weightsByCategory[activeCategory] : globalWeights;
  const overrideCount = CATEGORIES.filter((c) => c !== "All markets" && weightsByCategory[c] !== null).length;

  const setWeight = (key, val) => {
    setWeightsByCategory({ ...weightsByCategory, [activeCategory]: { ...activeWeights, [key]: val } });
  };
  const enableOverride = () => {
    setWeightsByCategory({ ...weightsByCategory, [activeCategory]: { ...globalWeights } });
  };
  const clearOverride = () => {
    setWeightsByCategory({ ...weightsByCategory, [activeCategory]: null });
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-1 p-1 rounded-full border w-full" style={{ borderColor: C.border, backgroundColor: C.surfaceMuted }}>
        <button onClick={() => setTab("configure")} className="flex-1 py-2 rounded-full text-sm font-medium transition-colors"
          style={{ backgroundColor: tab === "configure" ? C.surface : "transparent", color: tab === "configure" ? C.text : C.faint, boxShadow: tab === "configure" ? "0 1px 2px rgba(0,0,0,0.06)" : "none" }}>
          Configure
        </button>
        <button onClick={() => setTab("health")} className="flex-1 py-2 rounded-full text-sm font-medium transition-colors flex items-center justify-center gap-1.5"
          style={{ backgroundColor: tab === "health" ? C.surface : "transparent", color: tab === "health" ? C.text : C.faint, boxShadow: tab === "health" ? "0 1px 2px rgba(0,0,0,0.06)" : "none" }}>
          Signal health
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: C.gold }} />
        </button>
      </div>

      {tab === "health" ? <SignalHealthPanel /> : (
      <>
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium" style={{ color: C.text }}>{steps[step]}</p>
          <span className="text-xs font-mono" style={{ color: C.faint }}>{step + 1} / {steps.length}</span>
        </div>
        <div className="flex gap-1">
          {steps.map((_, i) => (
            <div key={i} className="h-1 flex-1 rounded-full" style={{ backgroundColor: i <= step ? C.green : C.border }} />
          ))}
        </div>
      </div>

      <Card className="p-4">
        {step === 0 && (
          <div className="space-y-5">
            <div>
              <p className="text-xs mb-2" style={{ color: C.muted }}>
                How much each signal type moves a market's score. Set a platform default, then override it for categories that behave differently.
              </p>
              <div className="flex gap-1.5 overflow-x-auto -mx-4 px-4" style={{ scrollbarWidth: "none" }}>
                {CATEGORIES.map((c) => {
                  const hasOverride = c !== "All markets" && weightsByCategory[c] !== null;
                  return (
                    <button key={c} onClick={() => setActiveCategory(c)}
                      className="px-3 py-1.5 rounded-full text-xs font-medium border whitespace-nowrap shrink-0 flex items-center gap-1.5"
                      style={{
                        borderColor: activeCategory === c ? C.green : C.border,
                        color: activeCategory === c ? C.greenDark : C.faint,
                        backgroundColor: activeCategory === c ? "#E7F8F1" : "transparent",
                      }}>
                      {c}
                      {hasOverride && <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: C.gold }} />}
                    </button>
                  );
                })}
              </div>
            </div>

            {!isOverridden && activeCategory !== "All markets" && (
              <div className="flex items-center justify-between text-xs rounded-xl px-3 py-2.5" style={{ backgroundColor: C.surfaceMuted }}>
                <span style={{ color: C.muted }}>Using the platform default — no {activeCategory}-specific tuning yet.</span>
                <button onClick={enableOverride} className="font-medium shrink-0 ml-2" style={{ color: C.greenDark }}>Customize</button>
              </div>
            )}

            {["micro", "news", "base"].map((k) => (
              <div key={k}>
                <div className="flex justify-between text-sm mb-2">
                  <span style={{ color: C.muted }}>{MARKER_LABEL[k]}</span>
                  <span className="font-mono" style={{ color: MARKER_COLOR[k] }}>{activeWeights[k]}%</span>
                </div>
                <input type="range" min="0" max="100" value={activeWeights[k]}
                  onChange={(e) => setWeight(k, Number(e.target.value))}
                  className="w-full" style={{ color: MARKER_COLOR[k] }} />
              </div>
            ))}

            {isOverridden && (
              <button onClick={clearOverride} className="text-xs font-medium" style={{ color: C.faint }}>
                Remove {activeCategory} override — revert to platform default
              </button>
            )}
          </div>
        )}
        {step === 1 && (
          <div className="space-y-5">
            <p className="text-xs" style={{ color: C.muted }}>Which scores get surfaced as "strong" picks on the Decision Desk.</p>
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span style={{ color: C.muted }}>Strong-pick threshold</span>
                <span className="font-mono" style={{ color: C.greenDark }}>{minScore}+</span>
              </div>
              <input type="range" min="1" max="10" value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} className="w-full" style={{ color: C.green }} />
            </div>
            <div className="flex items-center justify-between text-sm py-1">
              <span style={{ color: C.muted }}>Auto-tag volume anomalies</span>
              <Check size={16} style={{ color: C.greenDark }} />
            </div>
            <div className="flex items-center justify-between text-sm py-1">
              <span style={{ color: C.muted }}>Auto-tag low liquidity</span>
              <Check size={16} style={{ color: C.greenDark }} />
            </div>
          </div>
        )}
        {step === 2 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-sm">
              <span style={{ color: C.muted }}>Daily loss limit</span>
              <span className="font-mono" style={{ color: C.text }}>3%</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span style={{ color: C.muted }}>Max trades per day</span>
              <span className="font-mono" style={{ color: C.text }}>15</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span style={{ color: C.muted }}>Cooldown after loss</span>
              <span className="font-mono" style={{ color: C.text }}>30m</span>
            </div>
          </div>
        )}
        {step === 3 && (
          <div className="space-y-4">
            <p className="text-sm font-medium" style={{ color: C.text }}>Draft v3 — ready to preview</p>
            <div className="text-sm space-y-1.5" style={{ color: C.muted }}>
              <p>Default weights: activity {globalWeights.micro}%, news {globalWeights.news}%, track record {globalWeights.base}%</p>
              {overrideCount > 0 ? (
                <p>{overrideCount} categor{overrideCount === 1 ? "y override" : "y overrides"} set: {CATEGORIES.filter((c) => c !== "All markets" && weightsByCategory[c] !== null).join(", ")}</p>
              ) : (
                <p>No category overrides — one profile applies everywhere.</p>
              )}
              <p>Strong picks at {minScore}+</p>
              <p>Daily loss limit 3%, 15 trades/day max</p>
            </div>
            <div className="flex gap-2 pt-1">
              <button className="flex-1 py-2.5 rounded-xl text-sm font-medium border" style={{ borderColor: C.border, color: C.muted }}>
                Preview vs. last 30 days
              </button>
              <button className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white" style={{ backgroundImage: GRADIENT }}>
                Publish as v3
              </button>
            </div>
          </div>
        )}
      </Card>

      <div className="flex gap-2">
        <button disabled={step === 0} onClick={() => setStep(step - 1)}
          className="flex-1 py-2.5 rounded-xl text-sm font-medium border" style={{ borderColor: C.border, color: step === 0 ? C.faint : C.muted }}>
          Back
        </button>
        {step < steps.length - 1 && (
          <button onClick={() => setStep(step + 1)} className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white" style={{ backgroundImage: GRADIENT }}>
            Continue
          </button>
        )}
      </div>
      </>
      )}
    </div>
  );
}

/* ---------------------------------- Signal Health --------------------------------- */
const signalHealthData = [
  { key: "micro", status: "healthy", winRate: 64, sample: 142, trend: [58,60,59,62,61,63,64,63,65,64] },
  { key: "news", status: "degraded", winRate: 51, sample: 88, trend: [61,59,58,55,54,52,53,51,52,51] },
  { key: "base", status: "disabled", winRate: 39, sample: 34, cooldown: "14h left", trend: [55,50,47,44,41,40,38,37,39,39] },
];

function SignalHealthPanel() {
  return (
    <div className="space-y-5">
      <p className="text-xs" style={{ color: C.muted }}>
        Rolling accuracy per signal source, over the last 100 resolved trades. A signal that degrades gets flagged automatically — it can be auto-disabled before it drags scores down.
      </p>
      <div className="space-y-3">
        {signalHealthData.map((s) => {
          const tone = s.status === "healthy" ? "green" : s.status === "degraded" ? "gold" : "red";
          const lineColor = s.status === "healthy" ? C.green : s.status === "degraded" ? C.gold : C.red;
          return (
            <Card key={s.key} className="p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: MARKER_COLOR[s.key] }} />
                  <p className="text-sm font-medium" style={{ color: C.text }}>{MARKER_LABEL[s.key]}</p>
                </div>
                <Pill tone={tone}>{s.status}</Pill>
              </div>
              <div className="flex items-center gap-4 mb-3">
                <div>
                  <p className="font-mono text-lg" style={{ color: C.text }}>{s.winRate}%</p>
                  <p className="text-[11px]" style={{ color: C.faint }}>win rate · {s.sample} trades</p>
                </div>
                <div className="flex-1">
                  <Sparkline data={s.trend.map((v, i) => ({ i, v }))} color={lineColor} />
                </div>
              </div>
              {s.status === "disabled" && (
                <p className="text-xs flex items-center gap-1.5" style={{ color: C.red }}>
                  <ShieldAlert size={13} /> Auto-disabled — accuracy dropped over 10%. Cooldown: {s.cooldown}
                </p>
              )}
              {s.status === "degraded" && (
                <p className="text-xs flex items-center gap-1.5" style={{ color: "#8A5B0E" }}>
                  <Info size={13} /> Trending down — will auto-disable if it drops below min win rate
                </p>
              )}
            </Card>
          );
        })}
      </div>

      <div>
        <p className="text-sm font-medium mb-2" style={{ color: C.text }}>Auto-disable rules</p>
        <Card className="p-4 space-y-3 text-sm">
          <div className="flex justify-between"><span style={{ color: C.muted }}>Rolling accuracy window</span><span className="font-mono" style={{ color: C.text }}>100 trades</span></div>
          <div className="flex justify-between"><span style={{ color: C.muted }}>Min win rate</span><span className="font-mono" style={{ color: C.text }}>55%</span></div>
          <div className="flex justify-between"><span style={{ color: C.muted }}>Disable if accuracy drops</span><span className="font-mono" style={{ color: C.text }}>&gt;10%</span></div>
          <div className="flex justify-between"><span style={{ color: C.muted }}>Disable if drawdown exceeds max</span><Check size={16} style={{ color: C.greenDark }} /></div>
          <div className="flex justify-between"><span style={{ color: C.muted }}>Disable if signal correlation spikes</span><Check size={16} style={{ color: C.greenDark }} /></div>
          <div className="flex justify-between"><span style={{ color: C.muted }}>Cooldown after disable</span><span className="font-mono" style={{ color: C.text }}>24h</span></div>
        </Card>
      </div>
    </div>
  );
}

/* ---------------------------------- Simulate --------------------------------- */
function SimulateView() {
  const [ran, setRan] = useState(false);
  return (
    <div className="space-y-5">
      <Card className="p-4 space-y-3">
        <p className="text-sm font-medium" style={{ color: C.text }}>Run a backtest</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-xl border px-3 py-2" style={{ borderColor: C.border }}><p className="text-[11px]" style={{ color: C.faint }}>Strategy version</p><p style={{ color: C.text }}>v3-draft</p></div>
          <div className="rounded-xl border px-3 py-2" style={{ borderColor: C.border }}><p className="text-[11px]" style={{ color: C.faint }}>Date range</p><p style={{ color: C.text }}>Last 6 months</p></div>
        </div>
        <button onClick={() => setRan(true)} className="w-full py-2.5 rounded-xl text-sm font-semibold text-white" style={{ backgroundImage: GRADIENT }}>
          Run backtest
        </button>
      </Card>

      {ran && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Card className="p-3 text-center"><p className="font-mono text-sm" style={{ color: C.greenDark }}>+$412</p><p className="text-[11px]" style={{ color: C.faint }}>simulated PnL</p></Card>
            <Card className="p-3 text-center"><p className="font-mono text-sm" style={{ color: C.text }}>-11%</p><p className="text-[11px]" style={{ color: C.faint }}>max drawdown</p></Card>
            <Card className="p-3 text-center"><p className="font-mono text-sm" style={{ color: C.text }}>34</p><p className="text-[11px]" style={{ color: C.faint }}>trades</p></Card>
          </div>
          <Card className="p-4">
            <div className="flex items-center gap-4 mb-2">
              <span className="flex items-center gap-1.5 text-xs" style={{ color: C.muted }}><span className="w-2 h-2 rounded-full" style={{ backgroundColor: C.faint }} /> Live (v2)</span>
              <span className="flex items-center gap-1.5 text-xs" style={{ color: C.muted }}><span className="w-2 h-2 rounded-full" style={{ backgroundColor: C.green }} /> Simulated (v3-draft)</span>
            </div>
            <div style={{ width: "100%", height: 140 }}>
              <ResponsiveContainer>
                <AreaChart>
                  <YAxis hide />
                  <Area data={simLive} dataKey="v" type="monotone" stroke={C.faint} fill={C.faint} fillOpacity={0.12} strokeWidth={2} />
                  <Area data={simSimulated} dataKey="v" type="monotone" stroke={C.green} fill={C.green} fillOpacity={0.18} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <button className="w-full py-3 rounded-xl text-sm font-semibold border" style={{ borderColor: C.green, color: C.greenDark }}>
            Promote to live <span style={{ color: C.faint, fontWeight: 400 }}>· admin confirmation required</span>
          </button>
        </>
      )}
    </div>
  );
}

/* ---------------------------------- Accounts --------------------------------- */
function AccountsView() {
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium" style={{ color: C.text }}>Members</p>
        <button className="text-xs font-medium px-3 py-1.5 rounded-full text-white" style={{ backgroundImage: GRADIENT }}>Invite</button>
      </div>
      <Card className="p-1">
        {accountsData.map((u, i) => (
          <div key={u.name} className="p-3" style={{ borderBottom: i < accountsData.length - 1 ? `1px solid ${C.border}` : "none" }}>
            <div className="flex items-center justify-between mb-1">
              <p className="text-sm font-medium" style={{ color: C.text }}>{u.name} <span className="text-xs font-normal" style={{ color: C.faint }}>· {u.role}</span></p>
              <span className="font-mono text-sm" style={{ color: u.netPnl >= 0 ? C.greenDark : C.red }}>{u.netPnl >= 0 ? "+" : ""}{u.netPnl.toFixed(0)}</span>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <Pill tone={u.status === "active" ? "green" : "gold"}>{u.status}</Pill>
              <Pill tone="muted">{u.mode}</Pill>
              <Pill tone="blue">Kalshi {u.kalshi}</Pill>
              {u.feeOwed > 0 && <Pill tone="gold">${u.feeOwed.toFixed(2)} fee due</Pill>}
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

/* ---------------------------------- Activity --------------------------------- */
function ActivityView({ isAdmin }) {
  const [filter, setFilter] = useState("All");
  const types = ["All", "Trade", "Model published", "Billing", "Connection"];
  const scoped = isAdmin ? activityLog : activityLog.filter((a) => a.user === "You");
  const filtered = scoped.filter((a) => filter === "All" || a.event === filter);
  return (
    <div className="space-y-4">
      {!isAdmin && <p className="text-xs" style={{ color: C.faint }}>Showing your own activity only.</p>}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: C.faint }} />
        <input placeholder="Search activity" className="w-full pl-9 pr-3 py-2 rounded-xl border text-sm outline-none"
          style={{ borderColor: C.border, backgroundColor: C.surface, color: C.text }} />
      </div>
      <div className="flex gap-1.5 overflow-x-auto -mx-4 px-4" style={{ scrollbarWidth: "none" }}>
        {types.map((t) => (
          <button key={t} onClick={() => setFilter(t)}
            className="px-3 py-1 rounded-full text-xs font-medium border whitespace-nowrap shrink-0"
            style={{ borderColor: filter === t ? C.green : C.border, color: filter === t ? C.greenDark : C.faint, backgroundColor: filter === t ? "#E7F8F1" : "transparent" }}>
            {t}
          </button>
        ))}
      </div>
      <Card className="p-1">
        {filtered.map((a, i) => (
          <div key={i} className="flex items-start gap-3 px-3 py-3" style={{ borderBottom: i < filtered.length - 1 ? `1px solid ${C.border}` : "none" }}>
            <span className="text-[11px] font-mono w-14 shrink-0 pt-0.5" style={{ color: C.faint }}>{a.time}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5">
                <Pill tone={a.tone === "muted" ? "muted" : a.tone}>{a.event}</Pill>
                <span className="text-xs" style={{ color: C.faint }}>{a.user}</span>
              </div>
              <p className="text-sm" style={{ color: C.text }}>{a.detail}</p>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

/* ---------------------------------- Settings / Admin --------------------------------- */
function SettingsView() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm font-medium mb-2" style={{ color: C.text }}>API integration</p>
        <Card className="p-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Circle size={8} fill={C.green} style={{ color: C.green }} />
            <div>
              <p className="text-sm" style={{ color: C.text }}>Kalshi</p>
              <p className="text-[11px]" style={{ color: C.faint }}>Connected · rate limit 340/500 used</p>
            </div>
          </div>
          <Pill tone="green">Online</Pill>
        </Card>
        <p className="text-[11px] mt-1.5" style={{ color: C.faint }}>Polymarket support is planned for later — not connected yet.</p>
      </div>

      <div>
        <p className="text-sm font-medium mb-2" style={{ color: C.text }}>Risk limits</p>
        <Card className="p-4 space-y-3 text-sm">
          <div className="flex justify-between"><span style={{ color: C.muted }}>Daily loss cap</span><span className="font-mono" style={{ color: C.text }}>3%</span></div>
          <div className="flex justify-between"><span style={{ color: C.muted }}>Max exposure per market</span><span className="font-mono" style={{ color: C.text }}>2%</span></div>
          <div className="flex justify-between"><span style={{ color: C.muted }}>Category locks</span><span className="font-mono" style={{ color: C.text }}>None</span></div>
        </Card>
      </div>

      <div>
        <p className="text-sm font-medium mb-2" style={{ color: C.text }}>Emergency controls</p>
        <div className="flex gap-2">
          <button className="flex-1 py-3 rounded-xl text-sm font-semibold flex items-center justify-center gap-1.5"
            style={{ backgroundColor: "#FBF1DF", color: "#8A5B0E" }}>
            <Pause size={15} /> Pause trading
          </button>
          <button onClick={() => setConfirmOpen(true)} className="flex-1 py-3 rounded-xl text-sm font-semibold flex items-center justify-center gap-1.5 text-white"
            style={{ backgroundColor: C.red }}>
            <Power size={15} /> Kill switch
          </button>
        </div>
      </div>

      {confirmOpen && (
        <div className="fixed inset-0 flex items-center justify-center p-6" style={{ backgroundColor: "rgba(22,27,34,0.45)" }}>
          <Card className="w-full max-w-xs p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold" style={{ color: C.text }}>Confirm</p>
              <button onClick={() => setConfirmOpen(false)}><X size={16} style={{ color: C.faint }} /></button>
            </div>
            <p className="text-sm mb-4" style={{ color: C.muted }}>This stops all trading platform-wide and closes no existing positions. Are you sure?</p>
            <button onClick={() => setConfirmOpen(false)} className="w-full py-2.5 rounded-xl text-sm font-semibold text-white" style={{ backgroundColor: C.red }}>
              Confirm kill switch
            </button>
          </Card>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- App shell --------------------------------- */
export default function OutcomeEngineApp() {
  const [view, setView] = useState("home");
  const [isAdmin, setIsAdmin] = useState(true);

  const handleSetIsAdmin = (v) => {
    setIsAdmin(v);
    const adminOnlyKeys = NAV.filter((n) => n.adminOnly).map((n) => n.key);
    if (!v && adminOnlyKeys.includes(view)) setView("home");
  };

  const VIEWS = {
    home: <HomeView setView={setView} />,
    decision: <DecisionDeskView />,
    positions: <PositionsView />,
    performance: <PerformanceView />,
    strategy: <StrategyView />,
    sim: <SimulateView />,
    accounts: <AccountsView />,
    activity: <ActivityView isAdmin={isAdmin} />,
    settings: <SettingsView />,
  };

  return (
    <div className="min-h-screen w-full flex justify-center" style={{ backgroundColor: C.bg, fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap');
        .font-mono { font-family: 'JetBrains Mono', monospace; }
        input[type=range] { -webkit-appearance: none; height: 4px; border-radius: 999px; background: #E3E6EA; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; border-radius: 999px; background: currentColor; cursor: pointer; border: 3px solid #F1F3F5; }
        ::-webkit-scrollbar { display: none; }
      `}</style>
      <div className="w-full max-w-md px-4 py-5 pb-12">
        <header className="flex items-center justify-between mb-4 gap-2">
          <span className="text-[14px] font-bold tracking-tight shrink-0" style={{ color: C.text }}>
            Outcome <span style={{ color: C.green }}>Engine</span>
          </span>
          <div className="flex items-center gap-2.5 shrink-0">
            <RoleToggle isAdmin={isAdmin} setIsAdmin={handleSetIsAdmin} />
            <button className="relative">
              <Bell size={18} style={{ color: C.muted }} />
              <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full" style={{ backgroundColor: C.red }} />
            </button>
            <div className="w-7 h-7 rounded-full" style={{ backgroundColor: C.surfaceMuted, border: `1px solid ${C.border}` }} />
          </div>
        </header>

        <div className="mb-5">
          <TopNav view={view} setView={setView} isAdmin={isAdmin} />
        </div>

        {VIEWS[view]}
      </div>
    </div>
  );
}
