// In-app updates from GitHub releases: a quiet check on startup surfaces an
// update pill when a newer version exists; settings has a manual check.
// Updates are cryptographically verified against the pubkey in tauri.conf.

import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export function initUpdater(): void {
  const pill = document.getElementById("update") as HTMLButtonElement;
  const checkBtn = document.getElementById("check-updates") as HTMLButtonElement;
  let installing = false;

  /** False on a Linux .deb/.rpm install, where a self-update would run
   * `dpkg -i` and can leave the package unpacked-but-unconfigured — see
   * can_self_update in lib.rs for the full story. Resolved once, defaulting
   * to the self-update path if the command is somehow unavailable, so a
   * failure here can never make a working updater stop working. */
  let selfUpdateOk = true;
  void invoke<boolean>("can_self_update")
    .then((ok) => {
      selfUpdateOk = ok;
    })
    .catch(() => {});

  async function install(update: Update): Promise<void> {
    if (installing) return;
    // A package-managed install hands off to the package manager instead of
    // overwriting itself. The download is a browser away rather than one
    // click, which is the cost of not being able to break someone's install.
    if (!selfUpdateOk) {
      pill.textContent = "Opening download…";
      try {
        await invoke("open_releases_page");
        pill.textContent = `⬆ Get v${update.version}`;
      } catch {
        pill.textContent = "Visit the releases page";
      }
      return;
    }
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
        // "Get" rather than "Update to" where the click opens a download page
        // instead of installing — the label should not promise an in-place
        // update the app has deliberately opted out of performing.
        pill.textContent = selfUpdateOk
          ? `⬆ Update to v${update.version}`
          : `⬆ Get v${update.version}`;
        pill.title = selfUpdateOk
          ? ""
          : "Installed from a package — opens the download page so your package manager can resolve dependencies";
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
