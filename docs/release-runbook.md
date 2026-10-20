# Release runbook: the checklist you run by hand

The owner's checklist for `docs/packaging.md` ("Release checklist (not reproducible on
CI)"; audit finding F10 in `docs/audit-gate1.md`). **One Windows 11 notebook, no virtual
machines, one sitting (about two hours, most of it waiting for two release builds).**
Each step says what a pass and a fail look like. Fill in the results table (section 6).

**Rules.** A step passes only if you saw its "pass". Not done = `NOT RUN`, never PASS.
Something that matches neither description = FAIL plus the exact text you saw. Do not edit
a FAIL to PASS without re-running it. Write "ran", "installed", "opened"; never "verified",
"trusted", "safe" or "secure" about an unsigned installer.

**Cautions for a daily-use machine.**

1. Work in a **scratch folder** (section 1.2). Never point MOCHI at your real documents; make test archives only from the scratch files.
2. The foreign-format step (W-07) must leave `.zip` opening in the program it opened in before; the final **uninstall must put everything back** (W-11 checks it). If anything is left, say so before you carry on using the machine.
3. Do **not** turn off Smart App Control or other protection to get past a block (see W-02): record the block and stop.
4. Never put the updater key or its password anywhere except the GitHub secret fields (2.1).

---

## 0. What the automation already did

The manual workflow **`installer-smoke`** (Actions tab → *installer-smoke* → Run workflow)
installs the CI-built setup in real Windows 11 **and Windows 10 22H2** client VMs and the
`.deb` on Ubuntu 22.04 and 24.04, and writes a results table to the run summary (screenshots
and logs attached for 90 days). **Run it on the candidate commit first and record its link.**
It replaces the steps marked *Automated*. Its result per check is PASS, FAIL, INFO (an observation), NOT-RUN (could not be judged), or KNOWN-GAP (a real failure already written down as a finding below; reported, never a pass). The verdict is FAIL, INCOMPLETE, FINDINGS or PASS; read the table, not only the colour. The VM has no UAC prompt, Defender or Windows
Update, and a throwaway administrator account; Explorer's `ShellExecute`, the registry and
Windows' own "Open with" list are the real ones. It cannot see menus, dialogs or hear a screen reader.

| Item | Automated check (run table id) | Still yours |
|---|---|---|
| Silent per-user install, files, helper, uninstall entry | `A-INSTALL`, `A-FILES`, `A-UNINSTALL-ENTRY` | the wizard (W-03) |
| **WebView2 bootstrap** | Windows 10 leg, `A-WEBVIEW2`: PASS only if WebView2 was absent and the installer put it back (observed: absent at start, the bootstrapper installed 155.0.4283.45). INFO means it was already there and the item is a **gap**. The Windows 11 leg reports INFO: WebView2 is part of Windows 11 and the removal command exits 93 | nothing: Windows 11 ships WebView2 and it cannot be removed, so the bootstrap is not checkable on your notebook |
| App starts, window up, web view running | `B-LAUNCH` | seeing it (W-05) |
| Start-menu entry | `A-START-MENU` | seeing it (W-05) |
| Uninstall leaves nothing | `A-UNINSTALL`, `A-LEFTOVERS`, `B-UNINSTALL`, `B-LEFTOVERS` (no `Mochi*`, `MOCHI.Archive`, `MOCHI.Foreign` key or value, no program for `.mochi`, install folder and shortcuts gone), and `A-INSTALL-KEY` / `B-INSTALL-KEY` (Tauri's install-location key `HKCU\SOFTWARE\The MOCHI Project contributors\MOCHI` is gone; `packaging/nsis/hooks.nsh` removes it on uninstall, not on update). Windows' own traces of the app having run (MuiCache, Start tile cache, compatibility records) are listed and ignored | the same on your notebook, once, at the very end (W-11) |
| `.mochi` association, the three "MOCHI" submenus and every entry registered with its exact command | `A-ASSOC-VERBS`, `B-ASSOC-VERBS` | the menu showing them (W-06) |
| Each submenu entry starts MOCHI on a path with spaces, accents and `&`; the quick entries write at once and replace nothing, one archive for three launches | `B-VERB-*` (the entry's registered command with `%1` replaced, as Explorer runs it) | right-clicking (W-06) |
| Double-click opens MOCHI; a second open reuses the window | `B-DOUBLE-CLICK`, `B-SINGLE-INSTANCE` | W-06 |
| Opt-in off by default, on with `/ASSOCIATE_FOREIGN`, no default taken; Windows' own `.zip` "Open with" list | `A-FOREIGN-OFF`, `B-FOREIGN-ON`, `B-OPENWITH-ZIP` | the wizard question defaulting to **No**, the menu (W-03, W-07) |
| Each foreign format opens read-only | `B-FOREIGN-OPEN-*` | passwords, hostile names (W-07) |
| Ubuntu 22.04 / 24.04: `apt install ./*.deb`, type and "Open with" registration, launcher start under Xvfb, hard path, one window, `apt remove`/`purge` leave nothing | `U-*`. Finding (`U-DEFAULT-BY-ORDER`, INFO): with no desktop defaults list naming a program, the fallback default for a type is the first handler in `mimeinfo.cache`, and `MOCHI.desktop` sorts before `org.gnome.FileRoller.desktop` (`update-desktop-database` orders handlers by file name, so a lower-case `mochi.desktop` would sort first too); whether that happens on a real Ubuntu desktop depends on its own defaults list | **not run on client hardware for 1.0**: double-click install, GNOME Files, Orca, the launcher |

Items for **Windows 10 22H2 and Ubuntu** that need a person (screen reader, contrast
themes, the desktop launcher, GNOME Files, an update on those systems) are **not run on
client hardware for 1.0**. That goes in the results table, the release notes and audit F10
as written, never as a pass. If the run says `INCOMPLETE` or has a `NOT-RUN` row, that row is a gap too.

---

## 1. Before you start

### 1.1 What you are testing

* The candidate commit (40-character SHA) and the green `installer-smoke` run (link).
* Windows 11 edition and build: Start → type `winver`, Enter. Write them down.

### 1.2 Scratch folder and test files

1. In the repository on GitHub: Code → **Download ZIP**; unzip it to `C:\mochi-scratch\repo` (about 15 MB).
2. Make `C:\mochi-scratch\Tést & spaces Ünï` (copy that name). Copy into it, from `repo\fixtures\`: `golden\c5\valid-archive-3-commits.mochi` **twice**, renamed `Ärchive & ço.mochi` and `Second é & copy.mochi`; `foreign\basic_infozip.zip` as `Zip & ç.zip`; `foreign\7z\basic.7z`, `foreign\rar\solid.rar`, `foreign\basic.tar`, `foreign\basic.tar.gz`, `foreign\traversal.zip`, `foreign\7z\enc_names.7z` (password `SECRET`), `foreign\rar\comment-hpw-password.rar` (password `password`). Make a text file `Note é & more.txt` and a subfolder `Folder & ü` with a file in it.
3. Every shell step below uses this folder: it is the "path with spaces, non-ASCII letters and `&`".
4. Note which program opens a `.zip` today (double-click `Zip & ç.zip`; probably File Explorer). You compare against it in W-07 and W-11.

### 1.3 Watching network requests

MOCHI asks Windows to resolve `github.com` before it connects, so the resolver cache shows
it. PowerShell: `ipconfig /flushdns`, start MOCHI, wait 30 s, then
`Get-DnsClientCache | Where-Object Entry -match 'github' | Format-Table Entry`.
**No request:** no rows. **A request:** a `github.com` row. Flush again before each repeat.
(`pktmon start --capture` … `pktmon stop` is the built-in packet capture if you want packets.)
Network off: the Wi-Fi flyout → Wi-Fi off, or Airplane mode; unplug the cable.

---

## 2. The test release pair for the updater (T13)

The updater test needs two published releases. To spend no real version, publish a throwaway
pair **0.9.0 then 0.9.1** as ordinary releases through the draft-only `release` workflow
(`.github/workflows/release.yml`; it never publishes by itself). 1.0.0 later supersedes both.
**You install 0.9.0 as your first install (W-02), update it to 0.9.1 (X-6), and run the rest
of the checklist on the updated app**, so everything happens once. The 0.9.x commits are cut
from the candidate commit, so the code is the candidate's; only the version and notes differ.
The candidate's own installer bytes are covered by the automated run.

> **Cautions.** (1) While 0.9.1 is published, any older MOCHI that checks for updates is
> offered it: publish only when ready and delete both releases at the end (4.1). (2) GitHub
> picks `releases/latest` by the **date of the tagged commit**, not by version: delete the
> pair before 1.0.0 is published, or make sure the 0.9.x commits are older than 1.0.0's.

### 2.1 One-time setup (GitHub web interface)

1. Repository **Settings → Secrets and variables → Actions → New repository secret**:
   `TAURI_SIGNING_PRIVATE_KEY` = the entire text of the updater private key file (open it in a text editor, select all, copy, paste); `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = its password. **The key must have a password** (secrets cannot be empty and the workflow needs both; a key made without one must be regenerated, which changes the public key and needs a new release). Its public half is already in `apps/mochi-desktop/src-tauri/tauri.conf.json` (key ID `79A2DBFA840725F5`). Never put any of it in the repository, an issue, a chat or a screenshot.
2. Without both secrets the workflow stops in `preflight` and names the missing one.

### 2.2 Publish 0.9.0

In a clone of the repository:

1. `git switch -c release-test/0.9 <candidate commit>`.
2. Set `0.9.0` in **both** `apps/mochi-desktop/src-tauri/tauri.conf.json` (`"version"`) and `Cargo.toml` (`[workspace.package]`), then `cargo update --workspace` (the installer is built with `--locked`, so `Cargo.lock` must carry the same version).
3. Write `docs/release-notes/v0.9.0.txt`: `Test release for the 1.0 checklist, do not use.` (the app shows it as text).
4. Commit `TEST RELEASE 0.9.0, do not merge`; `git push -u origin release-test/0.9`; `git tag v0.9.0 && git push origin v0.9.0`. **Never merge this branch.** (No tag by hand: Actions → *release* → Run workflow on that branch; the tag is made when you publish.)
5. The **release** run is green (`preflight`, both `build`s, `smoke (ubuntu-24.04)`, `draft release`); otherwise read the first red step.
6. Releases → the **draft** → Edit: add **"Test release for the 1.0 checklist, do not use."** at the top, leave *pre-release* **unticked** (a pre-release is invisible to the updater), **Publish**.
7. `https://github.com/immerh8/MOCHI/releases/latest/download/latest.json` shows `"version": "0.9.0"`.

### 2.3 Publish 0.9.1

Same branch: version `0.9.1` in both files, `cargo update --workspace`, `docs/release-notes/v0.9.1.txt` = `Test release for the 1.0 checklist, do not use. Newer than 0.9.0.`, commit, push, tag `v0.9.1`, green run, edit the description, publish. Do this **after** W-02 to W-05, when you are ready for X-1.

---

## 3. The checklist (Windows 11 notebook)

All steps are on your notebook (**host**). Network on unless a step says otherwise. Use the
scratch folder. Install the **0.9.0** setup from its published release.

### W-01. Start state

1. Start menu → type `MOCHI`; Settings → Apps → Installed apps → search `MOCHI`.
- **Pass:** nothing named MOCHI. **Fail:** a MOCHI is already installed: uninstall it first (or use another account) so that W-11 means something.

### W-02. Run the unsigned installer (SmartScreen)

1. Double-click the `*-setup.exe` (download it from the 0.9.0 release page).
- **Pass:** a blue **Windows protected your PC** window with *Unknown publisher* and a **More info → Run anyway** path; after it the MOCHI wizard opens. (No window at all is also acceptable.)
- **Fail / stop:** "can't run on your PC" with no way on: that is **Smart App Control**. Do not turn it off on your daily machine; write `BLOCKED (Smart App Control)`, record it as a finding, and stop the Windows steps.

### W-03. The wizard

1. *Next*, *Install*; tick nothing extra. Near the end a question appears: *"Also offer MOCHI in the "Open with" list for ZIP, 7z, RAR, TAR, TGZ and GZ files?"*
- **Pass:** the question appears with **No** the highlighted default and text saying it does not make MOCHI the default program; no administrator prompt for MOCHI. **Now click Yes** (W-07 needs it; undone by the uninstall).
- **Fail:** no question, **Yes** the default, or an administrator prompt naming MOCHI.

### W-04. Start menu and first start

1. Start → `MOCHI`; open it.
- **Pass:** an entry **MOCHI** with the app icon; a window titled **MOCHI** within seconds showing a toolbar (*Add*, *Extract*, *Test*, *Remove*, *Find*, *Info*, *More*, *Help*), **What would you like to do?** with two large buttons *Create archive* and *Open archive*, and a closed **Advanced** disclosure at the bottom (opening it shows the **Sections** links *Search names*, *Passphrases*, *Test, health, and repair*, *Other archive formats*, *Job runner self-test*, *Settings*; the exact set may differ slightly; what matters is that the window is up and readable); no error text.
- **Fail:** no entry, a blank window after 30 s, a missing-web-view message, a crash.
2. Settings → Apps → Installed apps → **MOCHI**: **Pass:** version 0.9.0, publisher *The MOCHI Project contributors*.

### W-05. Help → User guide (command line), offline (F8)

1. Turn the network **off** (1.3). In the MOCHI window scroll to the **Help** section at the bottom of the window and press **User guide (command line)**. Its note says the guide is written for the `mochi` command line, opens the copy installed with MOCHI in your default web browser, and needs no network.
- **Pass:** your default browser opens a **local file** (the address starts `file:///` and ends in the install folder's `guide/index.html`), the first page is readable, its links to the other topics work (*Getting started*, *An archive is not a backup*, ...), and nothing tries to reach a website. The guide says an archive is not a backup and that a passing test does not make the file one. MOCHI shows "The user guide was handed to your default program for web pages."
- **Fail:** a web address (`https://...`), "file not found" or a blank page, an error line "Could not open the user guide", or no button.
2. Network back on.

### W-06. The MOCHI right-click menu (the menu display is yours; the entries themselves are Automated)

**Layout changed 2026-10-20 (owner decision, O10): the menu is flat, with no "MOCHI" submenu.** Read every "MOCHI ▸ X" below as the flat entry X. Every file and folder shows exactly two entries, **Add to archive...** and **Add to "<Name>.mochi"** (drawn by `mochi-shellext.dll`; the name is the file's name without extension, the folder's name, or for several items their folder's name); `.mochi` files also show **Open with MOCHI**, **Extract here**, **Extract to a new folder**. Also do the Windows 11 client check in `docs/packaging.md` (Release checklist, Shell integration): the labels, and an update while Explorer runs (locked DLL). The guest checks `A-ASSOC-VERBS`, `B-ASSOC-VERBS` and `B-VERB-ADD-*` (`ci/g6-windows/guest/payload/user.ps1`) read the new layout.

Close MOCHI first each time. In the scratch folder:

1. Right-click `Ärchive & ço.mochi` → **Show more options** (or Shift+F10).
- **Pass:** the classic menu has one entry **MOCHI** with a **▸**; hovering lists **Open with MOCHI**, **Extract here**, **Extract to a new folder**, **Add to archive**, **Add to archive...** in that order. (Windows 11's first short menu does not show it; that is expected, O10.)
2. **MOCHI ▸ Open with MOCHI** → **Pass:** the full window shows the archive (snapshots, folder contents); nothing written next to it.
3. **MOCHI ▸ Extract here** → **Pass:** only a **small** window (not the full program) with a progress bar and then "Extracted … into …", with **Show in folder** and **Close**; the files are next to the archive; no existing file changed. **Fail:** the full window opens, or the small window never ends.
4. **Extract here** again → **Pass:** the small window says nothing was written because names already exist, and the full window opens on the **Extract** plan; your files are unchanged.
5. **MOCHI ▸ Extract to a new folder** → **Pass:** a folder named for the archive that did not exist before (if one did, `… (2)`); an existing folder is left alone. **Show in folder** opens it.
6. Right-click `Note é & more.txt` → **MOCHI ▸ Add to archive** → **Pass:** the small window says "Archive created: Note é & more.mochi" and that it is a local commit (it does not say backed up or safe); the archive is next to the file. Again: `… (2).mochi`, the first untouched.
7. Select three files (Ctrl+click) → **MOCHI ▸ Add to archive** → **Pass:** **one** small window and **one** archive named for the folder. **Fail:** three archives or three windows.
8. Right-click the folder `Folder & ü` → **MOCHI ▸ Add to archive...** → **Pass:** a **small** "Add to archive" form (archive name `Folder & ü.mochi`, Browse…, Format, Level, OK, Cancel); the full window does not open; nothing written until you press OK. Choose Format **ZIP** → the name ends in `.zip`; OK → one `.zip` next to the folder.
9. With MOCHI open, double-click `Second é & copy.mochi` → **Pass:** the **same** window shows it; Task Manager lists **one** MOCHI. **Fail:** a second window.
10. Throughout: **Pass:** every entry used the right file despite the spaces, accents and `&`. **Fail:** "could not open", the wrong file, or a name cut at the `&`.

### W-07. Foreign formats (opt-in answered Yes in W-03)

1. Right-click `Zip & ç.zip` → **Open with**. **Pass:** MOCHI is offered. Double-click the file: it opens in the **same program as before** (1.2 step 4); MOCHI is **not** the default. **Fail:** MOCHI took over `.zip`.
2. For `.zip`, `.7z`, `.rar`, `.tar`, `.tar.gz`: **Open with → MOCHI**. **Pass:** the **Other archive formats (read-only)** section lists the entries with *"This is not a MOCHI archive. It is open read-only…"* and no MOCHI health words.
3. `enc_names.7z` (`SECRET`), `comment-hpw-password.rar` (`password`) → **Pass:** a **Password** field; a wrong one gives *"That password did not open the archive. Try again."*; the right one lists the entries.
4. `traversal.zip` → **Pass:** names like `../evil.txt`, `C:\win.txt` appear as plain text; nothing extracted.
5. With MOCHI open, open another foreign file from Explorer → **Pass:** same window.

### W-08. Screen reader (NVDA) *(first start after install may take a minute)*

Install NVDA from `nvaccess.org` for the session (uninstall it in W-11 if you do not use it). To read what it says without sound: NVDA menu → Tools → **Speech Viewer**. Keyboard only.

| # | Do this | **Pass: you hear / see** | **Fail** |
|---|---|---|---|
| N-1 | **Open archive**, pick `valid-archive-3-commits.mochi`; Tab into **Folder contents**, Down Arrow | *Folder contents, list, N items* (plus the key hint); each Down Arrow says the row's **name and kind** and *n of N* | silence, a kind without a name, no position |
| N-2 | **Create archive**; **Add files…** (scratch files); open **Options**, tick **Protect with a password (a passphrase)**; type **Passphrase** and **Repeat it**; **Create archive** | on opening, the heading **Create a new archive** is spoken with focus on it; the two steps are announced as headings (*1. Choose what to put in the archive*, *2. Where it will be saved*); at the end the one-line result ("Created … · N files · size") is spoken once, no focus move (the one-file note is now behind the **Details** button, not in the line); never "backed up", "safe" | silent panel, result unspoken or twice, "backed up/safe" |
| N-3 | **Advanced → Test, health, and repair → Test archive** | the headline, **Overall PASS (exit code 0)…**, then each dimension's status **as a word**, not only ✓ ✗ ! ? … – | symbols only, overall word missing |
| N-4 | open an **encrypted** archive, submit a **wrong** passphrase | an alert *"The passphrase did not open this archive."* and **focus back in the field** | no alert, or focus lost |
| N-5 | **Advanced → Settings → Crash reports** → **Include the panic message in each record** | NVDA reads the checkbox **and** the warning *"The panic message is the program's own description…"* with it | warning not read |

### W-09. Contrast themes, scaling, window size

1. Settings → Accessibility → **Contrast themes** → *Night sky*, then *Desert*. Open an archive and run a test. **Pass:** text readable; selected row/snapshot/folder have a **visible 2-pixel outline**; every status is a **word inside a shape** (dashed for needs-attention); nothing depends on colour. **Fail:** a selection you cannot find, text lost in the background.
2. Settings → System → Display → **Scale 200 %**, window about 1280×720. **Pass:** no **horizontal** scroll bar for the page; panels reflow to one column. **Fail:** sideways scrolling or cut-off controls.
3. Put the theme and scale back.

### W-09a. The start screen, drag and drop, and the simple Create and Extract flows (D10)

WebDriver cannot drag files from Explorer, so this one is yours. Close MOCHI, start it from the Start menu.

1. **Pass:** the window asks **What would you like to do?** with **Create archive** and **Open archive**; no word like *snapshot*, *commit*, *hash* on this screen; **Advanced** is closed; the toolbar's *Add*, *Extract*, *Test*, *Remove*, *Find* and *Info* are greyed out. Press **Help** (?): **Pass:** one sentence says an archive is not a second copy. **Fail:** more than those two actions on the screen, jargon, or *backup/safe*.
2. Drag the scratch file `Note é & more.txt` from Explorer onto the window. **Pass:** the **Create a new archive** panel opens with the file listed under step 1 and the full path of `Note é & more.mochi` (next to the file) under step 2; **Options** is closed. Press **Create archive**. **Pass:** the result is one line, *Created Note é & more.mochi · 1 file · …* (parts are separated by " · "; the one-file note is behind **Details**), and **Show in folder** opens Explorer on that folder. Repeat the drag and create again: **Pass:** the second archive is `Note é & more (2).mochi`; the first is untouched (never replaced).
3. Close the archive, then drag `Second é & copy.mochi` onto the window. **Pass:** it opens (no panel to add it to a new archive). Drag it together with a text file: **Pass:** both go to the create panel instead.
4. **More > Open and extract…** → choose `Ärchive & ço.mochi`. **Pass:** the plan names a **new folder next to the archive** (`Ärchive & ço`), says it was made for this, and offers **Extract** and **Choose a different folder…**; press **Extract**. **Pass:** the files appear in that folder; **Show in folder** opens it. Press the toolbar's **Extract** again from the open archive: **Pass:** a second folder `Ärchive & ço (2)`; nothing from the first is overwritten. Press **Close** on that plan without extracting: **Pass:** the empty `(2)`-style folder is removed.
5. Close the archive. **Pass:** the start screen lists the archives you opened under **Recent archives**; one click reopens one; **Clear this list** empties it.
6. Keyboard only (Tab, Enter): **Pass:** the toolbar (including **More** and its items), both start actions, the recent list, Advanced, and the create panel (including **Options**) are reachable and operable.
7. Drag out (the archive list to Explorer; WebDriver cannot drive an operating-system drag). Open `Ärchive & ço.mochi`, select a file inside a sub-folder and a folder, drag them onto the desktop. **Pass:** the file appears on the desktop under its own name only (not inside its sub-folders), the folder appears with what is in it, and the archive is unchanged. Start a drag and press Esc: **Pass:** nothing appears, and the drag-out folder under `%LOCALAPPDATA%\<app id>\drag-out` for that drag is gone. Repeat with an open `.zip`. **Fail:** a path or an error naming a temporary folder in the window.

---

## 4. The updater (T13) on this notebook, then final cleanup

Install the **0.9.0** release (W-02 to W-09 were done on it). Publish **0.9.1** now (2.3). Then:

| # | Do this | **Pass looks like** | **Fail looks like** |
|---|---|---|---|
| X-1 | Settings → **Updates**: the box **Check for updates when MOCHI starts (off unless you turn it on)** is **unticked**. Close MOCHI, flush the cache, start it, wait 30 s (1.3) | *"MOCHI will not check for updates by itself."* and **no** `github.com` lookup | a `github.com` request with the box off |
| X-2 | Tick the box. Close, flush, start, wait 30 s | *"MOCHI will check once each time it starts…"*, **one** `github.com` lookup, and 0.9.1 offered; **nothing installed** (version line still 0.9.0) | no request, or anything installed by itself |
| X-3 | Untick. **Network off**. **Check for updates** | *"Could not reach the update server. Check your connection and try again. Nothing was changed."* | crash, silent hang, a success message |
| X-4 | Network on. **Check for updates** | *"Version 0.9.1 is available. You are running version 0.9.0."*, **Release notes** with the one test line as **plain text**, buttons **Not now** / **Download and install**. Press **Not now**; still 0.9.0 | markup in the notes, an install starting by itself |
| X-5 | **Edited signature**, see below | *"The update's signature did not match, so it was refused. Nothing was installed."*; stays 0.9.0 | the installer starts, the version changes, any success text |
| X-6 | Restore the real `latest.json`. **Check for updates → Download and install** | a progress readout, **MOCHI closes**, the installer's small progress bar runs (no questions), the **new version starts** (else open it from Start). Settings → Updates: *"You are running version 0.9.1."*; Settings → Apps: **0.9.1** | the app vanishes and nothing returns, an error box, still 0.9.0 |
| X-7 | After the update: right-click `Zip & ç.zip` → Open with; the MOCHI submenu on a `.mochi`; double-click a `.mochi` | all of W-06/W-07 still there (the submenu once, no leftover flat "Extract here" entries of 0.1.0); MOCHI **still offered** for ZIP (an update keeps the opt-in); association intact | the opt-in or a verb vanished |

**X-5, the edited `.sig`.** The signature inside `latest.json` is the same text as the installer's `.sig`.
1. On the **0.9.1** release page download `latest.json`, open it in a text editor, change **one letter in the middle** of the long `"signature"` text for `windows-x86_64…`, save as `latest.json`.
2. Release → Edit: delete the `latest.json` asset, upload the edited one, **Update release**. Keep the original.
3. Wait a minute; **Check for updates → Download and install** (the signature is checked after the download). Pass/fail as in the table.
4. Delete the edited asset, upload the original, confirm `releases/latest/download/latest.json` carries the original signature, **then** do X-6.

### W-10. Re-run W-04 step 2 and W-05 on 0.9.1

**Pass:** the same as before, version 0.9.1.

### W-11. Final uninstall: leaves nothing, restores everything *(Automated in the VMs; this is your machine, once)*

1. Close MOCHI. Settings → Apps → Installed apps → **MOCHI** → **Uninstall**. **Pass:** an uninstall window runs and closes; MOCHI leaves the list. Uninstall NVDA too if you installed it only for this.
2. Explorer address bar: `%LOCALAPPDATA%\MOCHI`. **Pass:** *"This folder doesn't exist."* **Fail:** it exists.
3. PowerShell:

   ```powershell
   reg query HKCU /f mochi /k /s
   reg query HKLM\SOFTWARE /f mochi /k /s
   reg query HKCU\Software\Classes /f MOCHI /s /v
   ```

   **Pass:** no `MOCHI.Archive` or `MOCHI.Foreign` key, no `Mochi*` verb key, no `MOCHI.Foreign` value under an `OpenWithProgids` key. No `HKCU\SOFTWARE\The MOCHI Project contributors` key either (Tauri's install-location key; the uninstaller removes it). **Expected, write it down:** keys under `Explorer\FileExts`, `RecentDocs`, `AppCompatFlags`, `MuiCache`, `Start\TileProperties` are Windows noting that the app ran: list them, they are not a fail. **Fail:** any other `Mochi*` key.
4. Double-click `Ärchive & ço.mochi`. **Pass:** Windows asks how to open it (no program). **Fail:** MOCHI starts.
5. Double-click `Zip & ç.zip` and right-click → Open with. **Pass:** it opens in the program from 1.2 step 4 and MOCHI is no longer offered. **Fail:** anything else changed.
6. Observation, not a fail: `%APPDATA%\io.github.immerh8.mochi` and `%LOCALAPPDATA%\io.github.immerh8.mochi` (settings, web-view cache) stay after an uninstall that does not delete application data. Write whether the uninstaller offered to delete it.
7. Delete `C:\mochi-scratch`.

### 4.1 Clean up the test pair (do right after X-7, before W-11 if you like)

1. Releases → `MOCHI 0.9.1` → delete (trash) → confirm; the same for `MOCHI 0.9.0`.
2. `git push origin --delete v0.9.0 v0.9.1 release-test/0.9`.
3. `https://github.com/immerh8/MOCHI/releases/latest` no longer lists 0.9.x.

Nothing in the repository changes for the pair: the branch is never merged, the key is in no file, and no endpoint, key or `requireSignedVersion` setting is touched.

---

## 5. Not run on client hardware for 1.0

Windows 10 22H2 and Ubuntu 22.04/24.04 run only the scriptable part (`installer-smoke`).
These stay **not run on client hardware for 1.0** and are recorded so, never as passed:

* Windows 10 22H2: the wizard, SmartScreen, NVDA, contrast themes, the Explorer menus, the updater, the real uninstall through Settings; the WebView2 bootstrap if the run's `A-WEBVIEW2` says INFO (a gap).
* Ubuntu 22.04 / 24.04: install by double-click, the launcher on a real desktop, GNOME Files (type name, Open with lists, default unchanged), Orca, high contrast, the `.deb` update with its password prompt.
* Windows 11 on VM or other hardware, and any other edition.

---

## 6. Record the results

Header (paste into the release notes):

```
Candidate: commit <sha>, tag v<version>; installers sha256 <hash> (Windows) <hash> (Ubuntu)
installer-smoke run: <link> (verdict, date)
Windows 11 <edition> <display version> build <build> (winver); NVDA <version>
Test release pair: v0.9.0 / v0.9.1, runs <links>, deleted <date>
Done by <you> on <date>
```

| Step | Windows 11 notebook | Win 10 22H2 | Ubuntu 22.04 | Ubuntu 24.04 |
|---|---|---|---|---|
| W-01 start state, W-02 SmartScreen, W-03 wizard question defaults to No |  | not run on client hardware for 1.0 | N/A | N/A |
| W-04 Start menu, first start, Apps entry |  | AUTO (run link) | N/A | N/A |
| W-05 Help → User guide (command line), offline |  | not run on client hardware for 1.0 | not run on client hardware for 1.0 | not run on client hardware for 1.0 |
| W-06 right-click verbs, awkward path |  | AUTO | N/A | N/A |
| W-07 foreign opt-in, each format, passwords, hostile names, `.zip` default unchanged |  | AUTO | N/A | N/A |
| W-08 NVDA N-1 to N-5 |  | not run on client hardware for 1.0 | Orca: not run on client hardware for 1.0 | Orca: not run on client hardware for 1.0 |
| W-09 contrast, 200 %, 1280×720 |  | not run on client hardware for 1.0 | not run on client hardware for 1.0 | not run on client hardware for 1.0 |
| W-09a step 7 drag out to Explorer / the file manager, Esc cleans up |  | not run on client hardware for 1.0 | not run on client hardware for 1.0 | not run on client hardware for 1.0 |
| X-1 start-up check off: no request |  | not run on client hardware for 1.0 | same | same |
| X-2 on: one request |  | same | same | same |
| X-3 network off message |  | same | same | same |
| X-4 shows 0.9.1, notes as text, installs nothing |  | same | same | same |
| X-5 edited signature refused |  | same | same | same |
| X-6 update installs 0.9.1 |  | same | same | same |
| X-7 shell and opt-in survive the update |  | same | N/A | N/A |
| W-10 version 0.9.1 re-check |  | N/A | N/A | N/A |
| W-11 uninstall leaves nothing, `.zip` restored |  | AUTO | AUTO (`apt purge`) | AUTO (`apt purge`) |
| WebView2 bootstrap | N/A (ships with Windows 11) | AUTO if `A-WEBVIEW2` PASS, else GAP | N/A | N/A |
| Ubuntu double-click install, launcher, GNOME Files | N/A | N/A | not run on client hardware for 1.0 | not run on client hardware for 1.0 |
| Ubuntu `.deb` checks | N/A | N/A | AUTO | AUTO |

Where it goes:

1. **The release notes.** Paste the header and table into the real release draft's description under **Release checklist results**. Do not publish with a FAIL, or a blank cell on the notebook.
2. **The audit F10 row.** In `docs/audit-gate1.md` item **10. F10**, add one line below its *Next step* and change nothing else:

   ```
   **Status (<date>):** run by <you> on one Windows 11 notebook, <build>, results in <release link>; <n> of <m> notebook steps PASS, <FAIL steps with the finding>. Not run on client hardware for 1.0: Windows 10 22H2 and Ubuntu human-only items (listed in the runbook, section 5). Automated part: <installer-smoke run link>.
   ```

   F10 stays open while any step failed or any item is not run on client hardware; it is closed only by a decision of the owner that says so.
