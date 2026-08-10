// Shop overlay: Axes / Helpers / Style tabs rendered from the economy
// tables. All purchases route through Game methods, which own the save.

import { AXES, BOOSTS, COSMETICS, HELPERS } from "../economy";
import { abbrev } from "../scene/floating-text";
import type { Game } from "../scene/game";

type Tab = "axes" | "helpers" | "boosts" | "style";

export function initShop(game: Game): void {
  const overlay = document.getElementById("shop")!;
  const openBtn = document.getElementById("shop-btn")!;
  const closeBtn = document.getElementById("shop-close")!;
  const listEl = document.getElementById("shop-list")!;
  const woodEl = document.getElementById("shop-wood")!;
  const tabBtns = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#shop-tabs button"),
  );

  let tab: Tab = "axes";
  let refreshTimer: number | null = null;

  function row(
    label: string,
    sub: string,
    action: { text: string; enabled: boolean; onClick?: () => void } | null,
  ): HTMLElement {
    const el = document.createElement("div");
    el.className = "shop-row";
    const info = document.createElement("div");
    info.className = "shop-info";
    const name = document.createElement("div");
    name.textContent = label;
    const blurb = document.createElement("div");
    blurb.className = "shop-sub";
    blurb.textContent = sub;
    info.append(name, blurb);
    el.append(info);
    if (action) {
      const btn = document.createElement("button");
      btn.textContent = action.text;
      btn.disabled = !action.enabled;
      if (action.onClick) {
        btn.addEventListener("click", () => {
          action.onClick!();
          renderList();
        });
      }
      el.append(btn);
    }
    return el;
  }

  function renderList(): void {
    const s = game.save;
    woodEl.textContent = `wood: ${abbrev(s.wood)} · amber: ${abbrev(s.amber)}`;
    listEl.replaceChildren();

    if (tab === "axes") {
      AXES.forEach((axe, i) => {
        const sub = `damage ${abbrev(axe.damage)}`;
        if (i <= s.ownedAxe) {
          listEl.append(row(axe.name, sub, { text: i === s.ownedAxe ? "equipped" : "owned", enabled: false }));
        } else if (i === s.ownedAxe + 1) {
          listEl.append(
            row(axe.name, `${sub} · ${abbrev(axe.cost)} wood`, {
              text: "Buy",
              enabled: s.wood >= axe.cost,
              onClick: () => void game.buyAxe(i),
            }),
          );
        } else {
          listEl.append(row(axe.name, `${sub} · locked`, { text: "locked", enabled: false }));
        }
      });
    } else if (tab === "helpers") {
      for (const helper of HELPERS) {
        const owned = (s.helpers as string[]).includes(helper.id);
        const gated = helper.requires && !(s.helpers as string[]).includes(helper.requires);
        if (owned) {
          listEl.append(row(helper.name, helper.blurb, { text: "owned", enabled: false }));
        } else if (gated) {
          listEl.append(row(helper.name, `${helper.blurb} · requires ${helper.requires}`, { text: "locked", enabled: false }));
        } else {
          listEl.append(
            row(helper.name, `${helper.blurb} · ${abbrev(helper.cost)} wood`, {
              text: "Buy",
              enabled: s.wood >= helper.cost,
              onClick: () => void game.buyHelper(helper.id),
            }),
          );
        }
      }
    } else if (tab === "boosts") {
      for (const boost of BOOSTS) {
        const gated = boost.id === "espresso" && !(s.helpers as string[]).includes("gnome1");
        if (gated) {
          listEl.append(
            row(boost.name, `${boost.blurb} · needs a gnome`, { text: "locked", enabled: false }),
          );
        } else {
          listEl.append(
            row(boost.name, `${boost.blurb} · ${abbrev(boost.cost)} amber`, {
              text: "Use",
              enabled: s.amber >= boost.cost,
              onClick: () => void game.buyBoost(boost.id),
            }),
          );
        }
      }
    } else {
      for (const cos of COSMETICS) {
        const owned = (s.cosmetics as string[]).includes(cos.id);
        const equipped = s.equippedCap === cos.id || s.equippedTreeSkin === cos.id;
        if (owned) {
          listEl.append(
            row(cos.name, cos.kind === "cap" ? "cap" : "tree skin", {
              text: equipped ? "unequip" : "equip",
              enabled: true,
              onClick: () => game.equipCosmetic(cos.id),
            }),
          );
        } else {
          listEl.append(
            row(cos.name, `${cos.kind === "cap" ? "cap" : "tree skin"} · ${abbrev(cos.cost)} wood`, {
              text: "Buy",
              enabled: s.wood >= cos.cost,
              onClick: () => void game.buyCosmetic(cos.id),
            }),
          );
        }
      }
    }
  }

  function open(): void {
    overlay.classList.remove("hidden");
    renderList();
    refreshTimer = window.setInterval(renderList, 1000);
  }

  function close(): void {
    overlay.classList.add("hidden");
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  openBtn.addEventListener("click", () => {
    if (overlay.classList.contains("hidden")) {
      open();
    } else {
      close();
    }
  });
  closeBtn.addEventListener("click", close);
  for (const btn of tabBtns) {
    btn.addEventListener("click", () => {
      tab = btn.dataset.tab as Tab;
      for (const b of tabBtns) {
        b.classList.toggle("active", b === btn);
      }
      renderList();
    });
  }
}
