// Options chain browser: calls | strike | puts for a chosen expiry.
const fmt = (x, dp = 2) => (x === null || x === undefined ? "—" : x.toFixed(dp));
const fmtInt = x => (x ? x.toLocaleString("en-US") : "—");

export function initChain({ selectEl, tableEl, toggleEl, infoEl }) {
  let data = null, showAll = false;

  function currentExpiry() {
    return data?.expiries.find(e => e.expiry === selectEl.value) || data?.expiries[0];
  }

  function render() {
    const exp = currentExpiry();
    if (!exp) { tableEl.innerHTML = ""; return; }
    const spot = data.spot;
    const byStrike = new Map();
    for (const c of exp.calls) byStrike.set(c.strike, { call: c });
    for (const p of exp.puts) (byStrike.get(p.strike) || byStrike.set(p.strike, {}).get(p.strike)).put = p;
    let strikes = [...byStrike.keys()].sort((a, b) => a - b);
    if (!showAll && spot) {
      const near = strikes.filter(k => Math.abs(k - spot) / spot <= 0.4);
      if (near.length >= 8) strikes = near;
    }
    const atm = spot ? strikes.reduce((best, k) => (Math.abs(k - spot) < Math.abs(best - spot) ? k : best), strikes[0]) : null;

    const rows = strikes.map(k => {
      const { call, put } = byStrike.get(k);
      const callItm = spot && k < spot, putItm = spot && k > spot;
      return `<tr class="${k === atm ? "atm-row" : ""}">
        <td class="${callItm ? "itm" : ""}">${fmt(call?.bid)} / ${fmt(call?.ask)}</td>
        <td class="${callItm ? "itm" : ""}">${fmt(call?.delta)}</td>
        <td class="${callItm ? "itm" : ""}">${fmtInt(call?.oi)}</td>
        <td class="${callItm ? "itm" : ""}">${fmtInt(call?.volume)}</td>
        <td style="text-align:center"><b>${fmt(k, k % 1 ? 2 : 0)}</b></td>
        <td class="${putItm ? "itm" : ""}">${fmt(put?.bid)} / ${fmt(put?.ask)}</td>
        <td class="${putItm ? "itm" : ""}">${fmt(put?.delta)}</td>
        <td class="${putItm ? "itm" : ""}">${fmtInt(put?.oi)}</td>
        <td class="${putItm ? "itm" : ""}">${fmtInt(put?.volume)}</td>
      </tr>`;
    }).join("");

    tableEl.innerHTML = `
      <thead>
        <tr><th colspan="4" style="text-align:center" class="chain-side">Calls — right to buy</th>
            <th style="text-align:center">Strike</th>
            <th colspan="4" style="text-align:center" class="chain-side">Puts — right to sell</th></tr>
        <tr><th>Bid / Ask</th><th>Delta</th><th>Open int.</th><th>Volume</th><th style="text-align:center">$</th>
            <th>Bid / Ask</th><th>Delta</th><th>Open int.</th><th>Volume</th></tr>
      </thead>
      <tbody>${rows}</tbody>`;
    infoEl.textContent = spot
      ? `Stock at $${fmt(spot)} · shaded cells are in-the-money · line marks the at-the-money strike`
      : "";
  }

  selectEl.addEventListener("change", render);
  toggleEl.addEventListener("click", () => {
    showAll = !showAll;
    toggleEl.setAttribute("aria-pressed", String(showAll));
    render();
  });

  return {
    load(optionsJson) {
      data = optionsJson;
      selectEl.innerHTML = data.expiries
        .map(e => `<option value="${e.expiry}">${e.expiry} (${e.dte}d)</option>`)
        .join("");
      const preferred = data.expiries.find(e => e.dte >= 25 && e.dte <= 75) || data.expiries[0];
      selectEl.value = preferred.expiry;
      render();
    },
    clear() { data = null; tableEl.innerHTML = ""; selectEl.innerHTML = ""; infoEl.textContent = ""; },
  };
}
