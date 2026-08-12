// Plain-language reward/risk copy, quantified with the trade's own numbers.
import { fmtUsd } from "./funding.js";

const pct = x => `${x >= 0 ? "" : "-"}${Math.abs(x).toFixed(1)}%`;

export function renderRiskReward({ calc, worst30d, coin, kind }, els) {
  const { rewardList, riskList, maxReward, maxRisk } = els;
  if (!calc) { rewardList.innerHTML = riskList.innerHTML = ""; maxReward.textContent = maxRisk.textContent = ""; return; }
  const crypto = kind === "crypto";
  const asset = crypto ? "the coin" : "the stock";

  const rewards = [
    `<li><b>${fmtUsd(calc.grossFunding)}</b> of funding over the period at your assumed rate — collected hour by hour, whether ${asset} goes up or down.</li>`,
    `<li>The hedge means you are <b>not betting on ${asset}'s direction</b>. You earn the fee, not the price move.</li>`,
  ];
  if (calc.variant !== "stock") {
    rewards.push(`<li>The option hedge ties up far less cash than buying ${asset}, so the same funding is a <b>bigger % return</b> on the money you put in.</li>`);
  }
  if (calc.variant === "synthetic" && calc.netDebit !== undefined) {
    rewards.push(`<li>The put you sold brought in premium that <b>paid for most of the call</b> — entry cost ${fmtUsd(Math.max(calc.netDebit, 0))}.</li>`);
  }
  rewardList.innerHTML = rewards.join("");
  maxReward.innerHTML = `<b>Best case:</b> funding stays at or above your assumption and you keep ≈ ${fmtUsd(calc.net)} after costs. Funding has no cap — hot markets have paid shorts far more than average for weeks at a time.`;

  const risks = [
    `<li><b>Funding can flip negative.</b> Then the short perp <em>pays</em> instead of collecting.` +
      (worst30d !== null
        ? ` ${coin}'s worst actual 30-day stretch so far: <b>${pct(worst30d * 100)}</b> of position size.`
        : "") + `</li>`,
    `<li><b>Liquidation on the short perp.</b> At ${calc.liqRisePct ? (100 / calc.liqRisePct).toFixed(0) : "?"}× leverage, a price rise of roughly <b>${pct(calc.liqRisePct)}</b> can wipe the perp margin (${fmtUsd(calc.perpMargin)}) before your hedge profits — held at a different venue — can help. Fast gaps are the killer.</li>`,
  ];
  if (crypto) {
    risks.push(`<li><b>Basis gap.</b> The perp's price can drift from spot ${coin} (that drift is what creates funding in the first place), and your spot hedge sits on a different venue with its own withdrawal and counterparty risks.</li>`);
  } else {
    risks.push(
      `<li><b>Two venues, different hours.</b> The perp trades 24/7; the stock and options don't. Over weekends and overnight your hedge is frozen while the perp keeps moving.</li>`,
      `<li><b>Tracking gap.</b> The perp's price can drift from the real stock (that drift is what creates funding in the first place).</li>`,
    );
  }
  if (calc.variant === "ditm") {
    risks.push(`<li><b>Time value melts.</b> You paid ≈ ${fmtUsd(calc.timeValue ?? 0)} above the option's hard value; that bleeds to zero by expiry and you must <b>roll</b> into a new option to stay hedged.</li>`);
  }
  if (calc.variant === "synthetic") {
    risks.push(`<li><b>The short put is a real obligation.</b> If ${asset} collapses you carry its losses from $${calc.strike} down — same downside as holding ${asset} — and ${crypto ? "the exchange" : "your broker"} demands collateral (≈ ${fmtUsd(calc.extraCollateral)}) and can force you out at the worst time. ${crypto ? "Pin risk at expiry is an extra wrinkle." : "Early assignment and pin risk at expiry are extra wrinkles."}</li>`);
  }
  riskList.innerHTML = risks.join("");

  const worstCase = {
    stock: `<b>Worst case:</b> negative funding while you unwind, plus a fast gap that liquidates the perp before the ${crypto ? "spot" : "stock"} hedge offsets it. Hedged ≠ risk-free: the legs can be forced apart. You can lose several times the funding you hoped to earn, though the ${crypto ? "spot" : "stock"} hedge caps directional loss.`,
    ditm: `<b>Worst case:</b> everything above, plus the entire call premium (${fmtUsd(calc.denom ?? 0)}) if ${asset} crashes — though below the strike, the short perp is winning that back.`,
    synthetic: `<b>Worst case:</b> a crash ${crypto ? `lands the coin's full fall below $${calc.strike ?? "—"} on your short put while the exchange margin-calls it` : `puts the stock to you at $${calc.strike ?? "—"} while brokers margin-call the put`} — this variant has the same full downside as owning ${asset}, with less cash cushioning it. The small entry cost is NOT the maximum loss.`,
  };
  maxRisk.innerHTML = worstCase[calc.variant];
}
