# PowerWheel rules

**Version 2026.11.16** · the rules in force. They change often; every change gets a new version and a
line in the changelog at the bottom.

This file is the plain-words half of the ruleset. The other half is [`src/lib/rules.ts`](../src/lib/rules.ts),
which holds the numbers (thresholds, weights) and the math that applies them. Both carry the same version, and
everything that makes a decision reads from them:

- **Sunday prep and the Wednesday check** (`npm run prep`, shown at `/prep`) score and rank the week's puts.
- **The AI-vs-Kyle paper race** trades the same picks with the same sizing.
- Every weekly report and every logged pick records the rules version that produced it, so a rule change can be
  judged by results instead of by feel.

To change a rule: edit both files, bump `RULES_VERSION` in `rules.ts` and the version line above, and add a
changelog line saying what changed and why.

---

## 1. The game

Sell cash-secured puts for weekly premium. Stay mostly in cash; owning shares is a step in the wheel, not the goal.

- **Core, about 70% of put collateral:** sector and theme funds that are Leading or Improving on the rotation map,
  or the large leaders inside those groups. Liquid weekly options only.
- **Satellite, about 30%:** large-cap edge names (AI, platforms), market cap of at least $20B. Only on red days and
  only at strikes you'd be fine owning.
- **No new puts on small speculative names.** They can stay on the watchlist to be watched, not sold.
- Idle cash sits in a T-bill fund and doubles as put collateral.
- Target about **0.5% of the strike per week**. More than 2% a week means the market knows something: check why
  before selling it.

## 2. Reading the market

**Rotation map.** Each fund's return relative to SPY over 13 weeks (trend) and 4 weeks (momentum):

| Quadrant | 13-week | 4-week | What to do |
|---|---|---|---|
| Leading | ahead | ahead | Sell puts on pullbacks, full size |
| Improving | behind | ahead | Start small, further-out strikes |
| Weakening | ahead | behind | No new puts; money is leaving |
| Lagging | behind | behind | Wait until it turns Improving |

Trust a quadrant change more when it holds for two or three Sundays.

**Trend stage of a stock or fund** (4- and 13-week return vs SPY, price vs its 50- and 200-day averages):

- **Leader:** ahead on both, above both averages.
- **Leader pulling back:** ahead over 13 weeks, above the 200-day, within 5% of the 50-day.
- **Turning up:** ahead over 4 weeks and back above the 50-day, but not yet a leader.
- **Downtrend:** behind over 13 weeks, and under the 200-day or with the 50-day under the 200-day.
- **Breaking down:** anything else that is losing its trend.

**Never sell puts here:** below the 200-day and on the lower Bollinger band (band position 0.2 or less). In a
backtest of about 15,000 weekly puts (2023 to 2026) it was the only clearly losing zone: premium fell 23% short of
fair, with twice the rate of losses over 10%. Above the 200-day every band zone was about fair, and a pullback toward
the middle band was best.

## 3. What qualifies as a pick

A name is a pick when all of these hold:

1. Trend stage is Leader or Leader pulling back, or Turning up while above the 200-day (small size, far strike).
2. It is not in the never-sell zone.
3. It has weekly options with a real market at the strike: a bid above zero, a bid/ask spread no wider than 20% of
   the mid (or $0.10 for cheap options), and at least 100 contracts open.
4. No earnings before the expiration (earnings on expiration day after the close is fine).
5. Funds of any size, but only while Leading or Improving on the rotation map; stocks only at $20B market cap or
   more (a stock's group quadrant counts in its score instead).

Picks that can be sold rank first, by score. Names with a good trend that can't be sold this week (earnings, no
weeklies, no real market, too small) come next, then everything else.

## 4. Scoring and ranking

Every pick gets a score from 0 to 100. The top 5 are the week's picks, with at most 2 from the same sector so one
theme can't fill the list.

| Part | Points | Best when |
|---|---|---|
| Trend | 30 | Leader pulling back (30), Leader (26), Turning up above the 200-day (15) |
| Rotation | 15 | Its group is Leading (15) or Improving (10); Weakening scores 3, Lagging 0 |
| Location | 25 | Band position 0.2 to 0.6, a pullback toward the middle band (25); 0.6 to 0.8 (18); above 0.8 (10); below 0.2 while above the 200-day (12) |
| Premium | 20 | Weekly premium at or above the 0.5% target (live quote), or a high IV rank when there is no quote |
| Liquidity | 10 | Tight spread and busy options at the strike |

Over 2% a week costs 10 points and gets a "check why" flag.

## 5. Choosing the strike

The old habit was a strike just under the floor (the recent swing low). That farms premium, but it gets you assigned
exactly when support breaks, because everyone's stops sit there too.

- **Start one expected move below the price**: price × implied volatility × √(days ÷ 365), which is about a
  0.16-delta put, the strike the backtest used.
- **Then stay out of the danger zone.** If that strike lands just under the floor (within one average daily range,
  ATR, below it), move it down to *floor minus 1 ATR*. Above the floor is fine: the stock has to break support first.
- Use the listed strike at or just under the target that has a real market (section 3).
- The floor is the lowest low of the last 20 trading days.

## 6. Sizing

- **Assigned exposure** (shares held plus every short put's strike × 100) stays around 1.0 to 1.2 times account
  value. Hard ceiling 1.5x.
- At most about 12% of account value per ticker, and 25 to 30% per theme (a fund and the stocks inside it count as
  one theme; mega-cap tech and AI count as one).
- Half size in earnings weeks.
- Deploy about 60% of put room on Monday into 3 to 4 top picks; keep about 40% for red days and roll defense.

## 7. Managing the trade

- **Profit velocity:** if you have captured X% of the premium in well under X% of the time, close it, especially with
  earnings or a headline ahead.
- **First close below the floor:** close or roll that put the same day. Don't wait for expiration.
- **Rolls:** only for a net credit, down and out. Two rolls on one name, then close.
- **Assigned shares:** exit on a close-based stop (a close below the prior day's low after the bounce stalls, or a
  close below the floor), then sell puts lower if the setup is still good. Shares in a Downtrend two Sundays in a row
  get sold on the next green day.
- **Covered calls:** only on stable names, at or above net cost, above the next resistance and outside the expected
  move. Skip them on volatile names: a stop does the hedging job better.
- **Wash sales:** after selling at a loss, no new shares or assignable puts on the same ticker in any account (Roth
  included) for 31 days. A similar company in the same theme is fine.

## 8. Tech-bottom checklist

Tech is a trend to ride again (closer-to-the-money puts on the leaders) only when most of these are true. Until then,
tech rallies are bounces to sell premium into.

- SMH holds a higher low above its early-November low (448).
- SMH is back above its 50-day average.
- Junk bonds (HYG) close above 77.50.
- Long bonds (TLT) close above 80.20.
- Chips (SMH) move into Improving or Leading on the rotation map.

## 9. Trusting the machine

The weekly top 5, with the exact put, are logged every Sunday and settled at expiration, next to a plain baseline
(an SPY put one expected move below the price). Judge the picks on win rate, return on collateral and worst loss over
8 to 12 weeks before giving them real size. Review the weights monthly, not weekly.

---

## Changelog

- **2026.11.16:** first version in the repo. Consolidates the Sunday Market Prep rules (rotation map, trend stages,
  the backtest's never-sell zone, picks with weeklies and a real market, no earnings before expiry), the sizing
  framework, profit velocity, close-or-roll on the first close below the floor, the strike rule (one expected move
  below the price, pushed to 1 ATR under the floor when it lands just under it) and the stop-instead-of-covered-call
  change. New: the 0 to 100 score and the top 5 with at most 2 per sector.
