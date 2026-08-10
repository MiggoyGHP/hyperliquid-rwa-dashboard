// The funding-harvest math. One short perp leg + one of three hedge legs.
//
// Yield definition (per the study's spec):
//   numerator   = funding collected over the period − hedge carry − perp fees
//   denominator = cash needed to ENTER the hedge (buy) leg
// A second "capital basis" adds the perp margin (and short-put collateral for
// the synthetic) so cheap hedges don't show absurd unbounded yields.

export const VARIANTS = {
  stock: {
    label: "Buy the real stock",
    small: "1 share hedges 1 share. Simple, most cash up front.",
  },
  ditm: {
    label: "Buy a deep in-the-money call",
    small: "Delta ≈ 1 behaves like the stock for a fraction of the cash.",
  },
  synthetic: {
    label: "Synthetic: buy call + sell put",
    small: "Same strike & expiry ≈ owning the stock. The put you sell pays for the call.",
  },
};

const TAKER_FEE = 0.00045; // Hyperliquid taker fee per side (editable in source)

// Pick a sensible default contract for each variant.
export function defaultStrike(variant, expiryChain, spot) {
  if (!expiryChain) return null;
  if (variant === "ditm") {
    // lowest-cost call that still behaves like stock: smallest delta >= 0.90 with a real ask
    const deep = expiryChain.calls.filter(c => c.delta >= 0.9 && c.ask > 0);
    if (!deep.length) return null;
    return deep.reduce((a, b) => (b.delta < a.delta ? b : a)).strike;
  }
  if (variant === "synthetic") {
    // at-the-money: intrinsic values cancel cleanly
    const withBoth = expiryChain.calls
      .filter(c => c.ask > 0 && expiryChain.puts.some(p => p.strike === c.strike && p.bid > 0));
    if (!withBoth.length) return null;
    return withBoth.reduce((a, b) => (Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a)).strike;
  }
  return null;
}

export function compute({ variant, usd, days, apr, leverage, spot, maxLeverage, expiryChain }) {
  const out = { variant, warnings: [] };
  if (!spot || !usd || !days) return null;

  const shares = usd / spot;
  const notional = usd;
  out.notional = notional;
  out.grossFunding = notional * apr * (days / 365);
  out.fees = 2 * TAKER_FEE * notional;

  let carry = 0, denom = null, extraCollateral = 0, contracts = 0, legDesc = "";

  if (variant === "stock") {
    denom = notional;
    legDesc = `${shares.toFixed(2)} shares at $${spot.toFixed(2)}`;
  } else {
    if (!expiryChain) return null;
    const strike = out.strike = expiryChain.pickedStrike;
    const call = expiryChain.calls.find(c => c.strike === strike);
    const put = expiryChain.puts.find(p => p.strike === strike);
    const dte = expiryChain.dte || 1;
    if (days > dte) out.warnings.push(`Your ${days}-day period is longer than this option's ${dte} days to expiry — you would need to roll into a new option (extra cost not counted here).`);
    const frac = Math.min(days, dte) / dte;

    if (variant === "ditm") {
      if (!call || !call.ask) return null;
      const delta = call.delta || 1;
      contracts = shares / (100 * delta);
      const premium = call.ask * 100 * contracts;
      const intrinsic = Math.max(spot - strike, 0) * 100 * contracts;
      const timeValue = Math.max(premium - intrinsic, 0);
      carry = timeValue * frac; // time value bleeds away by expiry
      denom = premium;
      legDesc = `${contracts.toFixed(2)} call(s), $${strike} strike, delta ${delta.toFixed(2)}`;
      out.timeValue = timeValue;
      if (delta < 0.85) out.warnings.push(`Delta ${delta.toFixed(2)} is not that deep — the hedge will track the stock imperfectly.`);
    }

    if (variant === "synthetic") {
      if (!call?.ask || !put?.bid) return null;
      contracts = shares / 100; // synthetic long has delta ≈ 1 by construction
      const netDebit = (call.ask - put.bid) * 100 * contracts;
      const intrinsic = (spot - strike) * 100 * contracts;
      carry = (netDebit - intrinsic) * frac; // net time value (can be negative)
      denom = Math.max(netDebit, 0);
      extraCollateral = 0.2 * strike * 100 * contracts; // broker short-put margin, rule of thumb
      legDesc = `buy ${contracts.toFixed(2)} call(s) + sell ${contracts.toFixed(2)} put(s), $${strike} strike`;
      out.netDebit = netDebit;
      if (netDebit <= 0) out.warnings.push("This combo currently costs nothing (or pays you) to enter — the headline yield is unbounded, so judge it by the capital-basis number instead.");
    }
  }

  out.carry = carry;
  out.legDesc = legDesc;
  out.contracts = contracts;
  out.net = out.grossFunding - carry - out.fees;
  out.denom = denom;
  out.periodYield = denom > 0 ? out.net / denom : null;
  out.annualized = out.periodYield === null ? null : out.periodYield * (365 / days);

  const perpMargin = notional / Math.min(leverage, maxLeverage || leverage);
  out.perpMargin = perpMargin;
  out.capitalBase = (denom || 0) + perpMargin + extraCollateral;
  out.capitalYield = out.capitalBase > 0 ? out.net / out.capitalBase : null;
  out.capitalAnnualized = out.capitalYield === null ? null : out.capitalYield * (365 / days);
  out.extraCollateral = extraCollateral;

  // liquidation cushion on the short perp: price rise that eats the margin
  out.liqRisePct = 100 / leverage;
  return out;
}
