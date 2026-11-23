// Trend-filtered dip rider for make.fun "Race a BTC trading bot live for 24 hours"
// (btc-race-24h-20261123-0511). Long-only cbBTC/USDC, 1-minute bars, $1,000 paper.
//
// The dev window (24h, BTC +3.59%, $58,669-$61,655) is a steady climb, but the
// four earlier windows show the other side: 13 Nov -4.91%, 15 Nov -3.92%,
// 18 Nov -2.79%. Unfiltered dip-buyers bleed out on those falling days —
// offline replays lose $30 to $135 there, mostly by re-entering every dip of
// a falling market and eating one stop-loss after another. So this bot only
// buys dips while the 240-bar trend is up, and otherwise sits in cash:
//
//   Entry: close down >= 0.8% over the last 30 bars AND an uptick (close
//          above the previous bar's close) AND (fewer than 240 bars seen,
//          or the close above the close 240 bars ago), full cash, one
//          position at a time.
//   Exit:  +3.0% from the fill price, or -1.2%, or 240 bars held.
//          Sells the whole position. No trailing stop.
//   max_slippage_bps 300 on every order (the dev window's biggest
//   1-minute open-vs-previous-close gap is 0.2%, so fills are never
//   refused for slippage on data like this).
//
// Offline replay of the same rules on all five published windows (same fill
// model as the kit: next-open fills, 4 bps fee, 2 bps slippage,
// constant-product impact against the bar's open depth):
//   23 Nov dev: +$33.46, 3 round trips (6 fills), max drawdown 0.95%
//   13 Nov:     -$14.23 | 15 Nov: -$0.26 | 17 Nov: +$0.02 | 18 Nov: -$1.39
// Worst window -$14.23, sum over the five windows +$17.60. For comparison,
// buy-and-hold on the dev window makes +$32.33 but loses $51.01 on 13 Nov
// and $43.47 on 15 Nov, and the unfiltered version of this same dip rule
// loses $80.75 on 15 Nov. The trend filter is what keeps the downside
// bounded while the uptrend entries still capture the climb.
//
// Deterministic: float64 arithmetic on the closes alone, no clock, no
// environment, no randomness. Every run on the same bars gives the same
// orders.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Lookback for the dip: close down this much over N bars. */
const N_BARS = 30;
const DIP = 0.008;
/** Trend filter lookback: the close must be above the close this many bars ago. */
const TREND_BARS = 240;
/** Take profit / stop loss, as a fraction of the fill price. */
const TAKE_PROFIT = 0.03;
const STOP_LOSS = 0.012;
/** Maximum bars to hold a position. */
const MAX_HOLD_BARS = 240;
const MAX_SLIPPAGE_BPS = 300;

/** Closes seen so far, in price-scale units (1e5 per USDC). */
const closes: number[] = [];
/** Fill price of the open position (price-scale units), or null when flat. */
let entryPrice: number | null = null;
/** Batch seq at which the buy fill was reported. */
let entrySeq = -1;

function entryReason(close: number): string | null {
  const i = closes.length - 1;
  if (i < 1 || close <= closes[i - 1]) return null; // needs an uptick
  if (i < N_BARS) return null;
  if (close / closes[i - N_BARS] - 1 > -DIP) return null; // not dipped enough
  if (i >= TREND_BARS && close <= closes[i - TREND_BARS]) return null; // trend down
  return 'dip+uptick+uptrend';
}

function exitReason(state: BarsState, close: number): string | null {
  if (entryPrice === null) return null;
  const ret = close / entryPrice - 1;
  if (ret >= TAKE_PROFIT) return 'take-profit';
  if (ret <= -STOP_LOSS) return 'stop-loss';
  if (state.seq - entrySeq >= MAX_HOLD_BARS) return 'max-hold';
  return null;
}

await runBars({
  onBatch(state, batch: Batch) {
    // Learn fills first: a buy fill sets the entry, a sell fill clears it.
    // Harness closes (client ids starting with '_') are not our orders.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled' || fill.client_id.startsWith('_')) continue;
      if (fill.side === 'buy') {
        entryPrice = Number(fill.price);
        entrySeq = batch.seq;
      } else {
        entryPrice = null;
        entrySeq = -1;
      }
    }

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    closes.push(close);
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    if (held !== undefined && held.qty > 0n) {
      if (exitReason(state, close) !== null) {
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    if (entryReason(close) === null) return [];
    if (state.cash <= 0n) return [];
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
