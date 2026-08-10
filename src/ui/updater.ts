// In-app updates from GitHub releases: a quiet check on startup surfaces an
// update pill when a newer version exists; settings has a manual check.
// Updates are cryptographically verified against the pubkey in tauri.conf.

import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export function initUpdater(): void {
  const pill = document.getElementById("update") as HTMLButtonElement;
  const checkBtn = document.getElementById("check-updates") as HTMLButtonElement;
  let installing = false;

  async function install(update: Update): Promise<void> {
    if (installing) return;
    installing = true;
    pill.disabled = true;
    try {
      pill.textContent = "Downloading…";
      await update.downloadAndInstall((event) => {
        if (event.event === "Finished") {
          pill.textContent = "Restarting…";
        }
      });
      await relaunch();
    } catch {
      pill.textContent = "Update failed — try again";
      pill.disabled = false;
      installing = false;
    }
  }

  async function doCheck(manual: boolean): Promise<void> {
    if (manual) {
      checkBtn.textContent = "Checking…";
    }
    try {
      const update = await check();
      if (update) {
        pill.textContent = `⬆ Update to v${update.version}`;
        pill.classList.remove("hidden");
        pill.onclick = () => void install(update);
        if (manual) {
          checkBtn.textContent = "Check for updates";
        }
      } else if (manual) {
        checkBtn.textContent = "Up to date ✓";
        window.setTimeout(() => {
          checkBtn.textContent = "Check for updates";
        }, 2500);
      }
    } catch {
      if (manual) {
        checkBtn.textContent = "Check failed";
        window.setTimeout(() => {
          checkBtn.textContent = "Check for updates";
        }, 2500);
      }
    }
  }

  checkBtn.addEventListener("click", () => void doCheck(true));
  // Quiet startup check, delayed so launch stays snappy.
  window.setTimeout(() => void doCheck(false), 5000);
}
