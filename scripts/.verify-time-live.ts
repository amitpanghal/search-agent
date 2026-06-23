// .verify-time-live — fetch the REAL WC26 fixtures (Kambi, no auth, NO LLM) and show the time filter
// biting at different windows. Proves the drop-behaviour on live data without any Anthropic cost.
import { eventsByGroup, type KEvent } from "../src/resolver/offering-client";
import { resolveTimeWindow, filterEventsByTime } from "../src/resolver/time-window";

const WC26 = 2010133908;
const now = new Date();
const startOf = (e: KEvent) => (e.start ? new Date(e.start) : null);

const events = await eventsByGroup(WC26);
const dated = events.map(startOf).filter((d): d is Date => d != null).sort((a, b) => a.getTime() - b.getTime());
console.log(`WC26 group ${WC26}: ${events.length} events; ${dated.length} dated`);
if (dated.length) console.log(`  span: ${dated[0]!.toISOString()}  ->  ${dated[dated.length - 1]!.toISOString()}`);
console.log(`  now = ${now.toISOString()}\n`);

const show = (label: string, time: any) => {
  const w = resolveTimeWindow(time, { now, tournamentStart: dated[0] });
  const kept = filterEventsByTime(events, w);
  const win = w.from || w.to ? `[${w.from?.toISOString().slice(0, 16) ?? "…"} .. ${w.to?.toISOString().slice(0, 16) ?? "…"}]` : JSON.stringify(w);
  console.log(`${label.padEnd(16)} ${win}  ->  kept ${kept.length}/${events.length}`);
};

show("today", { date_window: { value: "today", anchor: "now" } });
show("tomorrow", { date_window: { value: "tomorrow", anchor: "now" } });
show("next_2_days", { date_window: { value: "next_2_days", anchor: "now" } });
show("next_5_days", { date_window: { value: "next_5_days", anchor: "now" } });
show("weekend", { date_window: { value: "weekend", anchor: "now" } });
