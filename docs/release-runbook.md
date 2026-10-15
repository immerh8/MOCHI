# Release runbook: the checklist you run by hand

This is the owner's runbook for the release checklist in `docs/packaging.md` ("Release
checklist (not reproducible on CI)"; audit finding F10 in `docs/audit-gate1.md`). Every
item of that checklist is here as numbered steps with what a pass and a fail look like, and
a results table to fill in. Nothing here needs Windows hardware: you run it in virtual
machines on your own computer.

**Time.** About half a day for the four VM sessions once the VMs exist (an hour or two to
build them the first time), plus the updater pair (about an hour of your time, most of it
waiting for two release builds).

**How to use it.**

1. Read "What the automation already covers" (section 1) so you skip what a machine has already done.
2. Build the four VMs (section 2). Do it once; keep the snapshots.
3. Pick the candidate build (section 3).
4. Do one session per VM (sections 4 to 6). The steps are the same on both Windows VMs and on both Ubuntu VMs.
5. Do the updater test pair (section 7).
6. Do the F8 guide check (section 8; it rides along in each session).
7. Record the results (section 9).

**Rules for the results.** A step passes only if you saw its "pass looks like". If you did
not do a step, write `NOT RUN`, never PASS. If something differs from both descriptions,
write FAIL and the exact text you saw. A failure of any step is a finding: do not release
on it; do not edit it to PASS later without re-running the step. This project never calls
an unsigned installer verified, trusted, safe, or secure: write "ran", "installed", or
"opened", not those words.

---

## 1. What the automation already covers

The workflow **`installer-smoke`** (`.github/workflows/installer-smoke.yml`, manual: Actions
tab, "installer-smoke", Run workflow) installs the CI-built installers in real Windows 11 and
Windows 10 22H2 **client** VMs (Microsoft evaluation media, run under QEMU/KVM on a GitHub
runner by the G6 harness, `docs/g6-windows-crash-replay.md`) and in Ubuntu 22.04 and 24.04,
and writes a results table to the run's summary. One green run on the candidate commit
replaces the steps marked **Automated** below; its evidence (the table, screenshots,
serial logs) is attached to the run for 90 days. You record the run's link in the results.

What the Windows VM is, so you know how far to trust it: a fresh client install of the
evaluation ISO, its throwaway administrator account logged on to a desktop, **no UAC prompt,
no Defender, no Windows Update** (so that it can run unattended), a user-mode network
adapter. Explorer, `ShellExecute`, the registry and the shell's own "Open with" list are the
real ones. It cannot see what a person sees (menus, dialogs, a screen reader), which is why
the rest stays on this runbook.

| Checklist item | Automated (check id in the run's table) | Still yours |
|---|---|---|
| Setup installs per user, silently, files and helper in place | `A-INSTALL`, `A-FILES`, `A-UNINSTALL-ENTRY` | The wizard itself (W-03) |
| WebView2 bootstrapper (needs network) | `A-WEBVIEW2`: PASS only if the VM first removed WebView2 and the installer put it back; INFO if it could not remove it | The same on your clean VM if the run says INFO (W-02, W-04) |
| App starts, window up, web view running | `B-LAUNCH` | Looking at it (W-05) |
| Start-menu entry exists and points at the app | `A-START-MENU` | Seeing it in Start (W-05) |
| Uninstall leaves nothing: no install folder, shortcuts, `Mochi*`, `MOCHI.Archive` or `MOCHI.Foreign` registry key or value, no program for `.mochi` | `A-UNINSTALL`, `A-LEFTOVERS`, `B-UNINSTALL`, `B-LEFTOVERS` | Uninstalling through Settings (W-09) |
| `.mochi` association and every Explorer verb registered, with the exact command | `A-ASSOC-VERBS`, `B-ASSOC-VERBS` | The menu showing them (W-07) |
| Each verb starts MOCHI on a path with spaces, non-ASCII letters and `&`, and writes nothing | `B-VERB-OPEN`, `B-VERB-EXTRACT-HERE`, `B-VERB-EXTRACT-TO-FOLDER`, `B-VERB-ADD-FILE`, `B-VERB-ADD-FOLDER`, `B-VERB-ADD-MULTI` (called through `ShellExecute`, the same call Explorer makes) | Right-clicking (W-07) and pressing **Extract** once |
| Double-click opens MOCHI; a second open goes to the running window | `B-DOUBLE-CLICK`, `B-SINGLE-INSTANCE` | |
| Foreign-format opt-in: off after a silent install, on with `/ASSOCIATE_FOREIGN`, never takes over a default; Windows' own "Open with" list for `.zip` | `A-FOREIGN-OFF`, `B-FOREIGN-ON`, `B-OPENWITH-ZIP` | The question in the wizard defaulting to **No** (W-03), the menu (W-08) |
| Each foreign format opens read-only through the opt-in handler | `B-FOREIGN-OPEN-ZIP`, `-7Z`, `-TAR`, `-TARGZ` (window up; wording checked when readable) | Encrypted 7z/RAR asking for a password, hostile names as text (W-08) |
| Ubuntu: `apt install ./mochi_*.deb`, type and "Open with" registration, start from the launcher under Xvfb, a hard path, second open goes to the same window, `apt remove` and `apt purge` leave nothing | `U-INSTALL` to `U-PURGE-LEFTOVERS` (on 22.04 and 24.04) | Double-click install, GNOME Files (U-02 to U-07) |
| Updater (T13) | not automated: it needs two published releases | All of section 7 |
| Screen readers, contrast themes, 200 % scaling | not automatable | All of section 6 |
| F8 Help, User guide | not automated | Section 8 |

If the run's table says `INCOMPLETE` or has a `NOT-RUN` row, that row is yours.

---

## 2. VM setup (once)

### 2.1 Pick your VM software

| Your computer | Use | Notes |
|---|---|---|
| Windows 10/11 Pro or Enterprise | **Hyper-V** (built in) or VirtualBox | Windows Home has no Hyper-V: use VirtualBox. Do not run both at once. |
| Windows Home | **VirtualBox** 7.x | |
| Linux | **VirtualBox** 7.x (virtualbox.org), or GNOME Boxes / virt-manager | |
| Mac with an Intel chip | **VirtualBox** 7.x or **UTM** ("Virtualize") | |
| Mac with Apple silicon (M1 and later) | **Not possible at usable speed.** These are x86-64 guests (decision O11) and the Mac can only emulate them very slowly, and Windows' Arm builds are not what MOCHI supports. Use any x86-64 PC (a borrowed one is enough) or rent an x86-64 cloud machine for the Windows and Ubuntu sessions. | |

The steps below name VirtualBox first; Hyper-V and UTM notes follow where they differ.

### 2.2 Get the installation media

| VM | Where | Notes |
|---|---|---|
| Windows 11 | Microsoft Evaluation Center, "Windows 11 Enterprise": `https://www.microsoft.com/en-us/evalcenter/` (search "Windows 11 Enterprise"), 64-bit, English (United States), **ISO**. The direct link the CI harness uses: `https://go.microsoft.com/fwlink/?linkid=2382600&clcid=0x409&culture=en-us&country=us` | Evaluation: 90 days, no key. |
| Windows 10 22H2 | Microsoft's own link: `https://go.microsoft.com/fwlink/p/?LinkID=2208844&clcid=0x409&culture=en-us&country=US` (Windows 10 Enterprise 22H2 evaluation, build 19045.2006). This is the media `docs/g6-windows-crash-replay.md` uses; Microsoft's Evaluation Center page for Windows 10 is retired but this link still serves the file. | SHA-256 of that file, from the G6 evidence: `ef7312733a9f5d7d51cfa04ac497671995674ca5e1058d5164d6028f0938d668`. Check it: Windows `Get-FileHash <file> -Algorithm SHA256`, Linux `sha256sum`, Mac `shasum -a 256`. A different hash means Microsoft changed the file: write the new hash in the results. |
| Ubuntu 22.04 | `https://releases.ubuntu.com/22.04/`, the **desktop** image (`ubuntu-22.04.*-desktop-amd64.iso`) | |
| Ubuntu 24.04 | `https://releases.ubuntu.com/24.04/`, the **desktop** image (`ubuntu-24.04.*-desktop-amd64.iso`) | |

### 2.3 Create the four VMs

Same settings for each, differences marked.

| Setting | Windows 11 | Windows 10 22H2 | Ubuntu 22.04 / 24.04 |
|---|---|---|---|
| CPUs | 4 | 4 | 2 |
| Memory | 8 GB | 6 GB | 4 GB |
| Disk | 80 GB | 60 GB | 40 GB |
| Firmware | UEFI **with Secure Boot and TPM 2.0** (Windows 11 will not install without them) | BIOS or UEFI, either | UEFI or BIOS |
| Network | NAT | NAT | NAT |
| Audio | **on** (for NVDA) | on | on (for Orca) |

* **VirtualBox:** New → name, **ISO Image**, tick **Skip Unattended Installation** → set memory/CPUs → disk size. Then, for Windows 11 only: Settings → System → Motherboard: tick **Enable EFI**, tick **Secure Boot**, set **TPM** to **v2.0**. Settings → Display: video memory to the maximum. Settings → Audio: tick **Enable Audio**, controller **Intel HD Audio**. Take a snapshot with Machine → Take Snapshot.
* **Hyper-V:** Hyper-V Manager → New → Virtual Machine → **Generation 2** → memory (untick *Use Dynamic Memory*) → connect to **Default Switch** → virtual disk → install from the ISO. Before the first start, VM → Settings → Security: tick **Enable Trusted Platform Module** (Windows 11), keep **Enable Secure Boot** with the *Microsoft Windows* template (Ubuntu: *Microsoft UEFI Certificate Authority*). A snapshot is a **Checkpoint** (Action → Checkpoint). Use *Enhanced Session* for copy and paste. Network off: Settings → Network Adapter → *Not connected*.
* **UTM (Intel Mac):** Create a New Virtual Machine → **Virtualize** → Windows (tick *Install Windows 10 or higher*, give the ISO) or Linux. UTM can snapshot QEMU-backed VMs (toolbar **Snapshot**); if there is no such button, right-click the VM → **Clone** and keep the clone as your snapshot.

### 2.4 Install each OS

* **Windows (both):** boot the ISO, *Install now*, *I don't have a product key*, choose the edition the eval offers, *Custom: install Windows only*. For the account, use a **local account** with a password you can type easily. If setup insists on a network or a Microsoft account, press **Shift+F10**, type `start ms-cxh:localonly`, Enter. **Keep the VM's network disconnected during setup** so that Windows Update does not add WebView2 (see 2.5). Make the account an administrator (the default for the first account).
* **Ubuntu:** boot the ISO → *Install Ubuntu* → *Normal installation* → erase the disk (it is a VM) → pick a username and password. After the first boot let it finish the welcome pages; do not install the "updates available" until after you take the "clean" snapshot, so both VMs start the session from the same state.

### 2.5 Make the "clean, no WebView2" snapshot (Windows)

The setup downloads Microsoft's WebView2 runtime if the machine lacks it, and that
download is one of the things this checklist exists for. A stock Windows 11 **has**
WebView2; a Windows 10 22H2 evaluation from 2022 normally does not. So on each Windows VM:

1. With the network still **disconnected**, open **PowerShell** (Start, type `powershell`, Enter) and run:

   ```powershell
   Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -Name pv -ErrorAction SilentlyContinue
   ```

   **Pass looks like:** no output at all (WebView2 is absent): skip to step 4.
   **Present looks like:** a line `pv : 1xx.x.xxxx.xx` (WebView2 is installed): do step 2.
2. Remove it. Open **PowerShell as administrator** (right-click → *Run as administrator*) and run:

   ```powershell
   $s = Get-ChildItem 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application\*\Installer\setup.exe'
   & $s.FullName --uninstall --msedgewebview --system-level --verbose-logging --force-uninstall
   ```

   (This is the same command the automated run uses; Settings → Apps greys out the uninstall button for this component on Windows 11, which is why it is a command.)
3. Run the check from step 1 again. **Pass looks like:** no output. **If the key is still there:** the runtime cannot be removed on this VM: write `NOT RUN (WebView2 could not be removed)` for steps W-02 and W-04 on this VM and rely on the CI run's `A-WEBVIEW2` row if it says PASS.
4. Shut the VM down (Start → Power → Shut down; not Restart) and take a snapshot named **`clean-no-webview2`**. Never connect this VM to the network before a test session starts.

For Ubuntu: after the install and the welcome pages, shut down and take a snapshot named **`clean-ubuntu`**.

### 2.6 Get the files into the VMs

You need, in each VM: the **installer**, and the **test files** below.

* **Installers.** Section 3 says which build. Download them on your computer (they are not signed: Windows will warn, see W-02), check the SHA-256 against the release page or the workflow's `SUBJECT.txt`, then move them into the VM: VirtualBox: Devices → Shared Folders (or Drag and Drop after *Insert Guest Additions CD image*); Hyper-V: copy and paste in an Enhanced Session; UTM: the shared directory. For the Ubuntu VMs you can also download the `.deb` in the VM's browser once the network is on.
* **Test files.** In the repository on GitHub: Code → **Download ZIP**, unzip it in each VM (it is about 15 MB), and use these files from `fixtures/`:

  | File (under `fixtures/`) | Used for |
  |---|---|
  | `golden/c5/valid-archive-3-commits.mochi` | the `.mochi` file for every verb and the screen-reader session |
  | `foreign/basic_infozip.zip`, `foreign/7z/basic.7z`, `foreign/rar/solid.rar`, `foreign/basic.tar`, `foreign/basic.tar.gz` | the foreign formats |
  | `foreign/7z/enc_names.7z` (password `SECRET`), `foreign/rar/comment-hpw-password.rar` (password `password`) | encrypted 7z and RAR asking for a password |
  | `foreign/traversal.zip` | the "hostile names" ZIP: its names must be shown as plain text |

* **The awkward folder.** In every VM make a folder named exactly `Tést & spaces Ünï` (copy it from here: **`Tést & spaces Ünï`**) in Documents, and copy `valid-archive-3-commits.mochi` into it **twice**, renamed `Ärchive & ço.mochi` and `Second é & copy.mochi`; also copy `basic_infozip.zip` into it as `Zip & ç.zip`, and make a text file `Note é & more.txt`. Use this folder for every shell-integration step: it is the "path with spaces, non-ASCII letters, and a `&`" the checklist asks for.

### 2.7 Watch network requests in a VM (for the updater start-up check)

You only need to know whether MOCHI contacts `github.com` when it starts. The app asks the
system to resolve that name before it connects, so the resolver's cache shows it. No packet
capture is needed.

* **Windows.** In PowerShell: `ipconfig /flushdns`, start MOCHI, wait 30 seconds, then
  `Get-DnsClientCache | Where-Object Entry -match 'github' | Format-Table Entry, Data`.
  **No request:** no rows. **A request:** a row `github.com` (and perhaps `objects.githubusercontent.com` later).
  Run `ipconfig /flushdns` again before each repeat. If you want to see packets anyway:
  Windows has a built-in capture, `pktmon start --capture` … `pktmon stop` (it writes
  `PktMon.etl`; `pktmon etl2txt PktMon.etl` shows the packets), and Wireshark works inside the VM.
* **Ubuntu.** In a terminal: `sudo apt install -y tcpdump`, then
  `sudo tcpdump -i any -nn -l 'udp port 53' | grep -i github`, start MOCHI in another
  window, wait 30 seconds. **No request:** the command prints nothing. **A request:** lines
  like `A? github.com.`. Stop with Ctrl+C.
* **From the host (optional).** VirtualBox can write a packet trace of a VM's adapter:
  `VBoxManage modifyvm "<vm>" --nictrace1 on --nictracefile1 trace.pcap` (VM powered off),
  then open `trace.pcap` in Wireshark and filter `dns`.

Turning the network off for the "no network" step: VirtualBox: Devices → Network → untick
**Connect Network Adapter**; Hyper-V: VM Settings → Network Adapter → *Not connected*; UTM:
Settings → Network → *Network Mode: Host Only* (or stop sharing); Ubuntu or Windows inside the
VM: turn off the network from the system tray also works.

### 2.8 Snapshot names used below

| Snapshot | Taken when |
|---|---|
| `clean-no-webview2` (Windows) / `clean-ubuntu` | Section 2.5 |
| `candidate-installed` | optional: after your own install of the candidate, to repeat shell steps without reinstalling |
| `v0.9.0-installed` | section 7, after installing the first test release |

---

## 3. The build you are testing

Run the workflow **release** only when you are ready to publish (section 7 explains the
release path). For this checklist you need:

* **The candidate installers.** The Windows `*-setup.exe` and the Ubuntu `.deb`, from the **draft** release that the `release` workflow made (Releases → the draft → Assets; you are signed in to GitHub, so you can see it), or from the `package` jobs of the CI run for the candidate commit (artifacts `mochi-installer-nsis-unsigned`, `mochi-installer-deb-unsigned`).
* **The commit** (the 40-character SHA of the tag or of the CI run) and the SHA-256 of both files. Write them in the results header (section 9).
* **A green `installer-smoke` run on that commit.** Actions → `installer-smoke` → Run workflow, with *ci_run_id* set to the CI run whose artifacts you downloaded (so it tests the very same bytes), or leave it empty to build fresh. Write its link in the results.

---

## 4. Windows session (run on Windows 11, then on Windows 10 22H2)

Start: revert to **`clean-no-webview2`**, start the VM, **connect the network** (NAT), log in.
Copy in the installer and the test files (2.6). Open `Documents\Tést & spaces Ünï`.

### W-01. WebView2 is absent before the test *(your clean VM)*

1. PowerShell: run the check from 2.5 step 1.
- **Pass looks like:** no output.
- **Fail looks like:** `pv : 1xx...`. Then this VM does not exercise the bootstrapper: do 2.5 again, or write `NOT RUN` for W-04.

### W-02. Run the unsigned installer *(SmartScreen)*

1. Double-click the `*-setup.exe`.
2. If a blue window **Windows protected your PC** appears: click **More info**, then **Run anyway**.
- **Pass looks like:** that window shows *Publisher: Unknown publisher* (or no publisher) and a **Run anyway** button; after it the MOCHI setup wizard opens.
- **Also acceptable:** no SmartScreen window at all (a file copied in from the host may carry no download mark).
- **Fail looks like:** a dialog saying the app **can't run on your PC** or is blocked with no way to continue. On Windows 11 this is **Smart App Control** (Windows Security → App & browser control → Smart App Control settings → **Off**; it cannot be turned back on without a reset, fine for a test VM). Say so in the notes; do not count it as a MOCHI failure but do record it.

### W-03. The wizard *(Automated: A-INSTALL / A-FILES cover the files; the wizard is yours)*

1. Follow the wizard (*Next*, *Install*). Do not tick anything extra.
2. Near the end, a question appears: *"Also offer MOCHI in the "Open with" list for ZIP, 7z, RAR, TAR, TGZ and GZ files?"* with **Yes** and **No**.
- **Pass looks like:** the question appears, **No** is the highlighted default button, and the text says that this does not make MOCHI the default. Answer **No** for the first pass.
- **Also:** the installer did not ask for an administrator password or a UAC prompt for MOCHI itself. (A UAC prompt from **Microsoft** during the WebView2 step is expected: allow it.)
- **Fail looks like:** no question, **Yes** being the default, or an administrator prompt naming MOCHI.
3. Finish. Leave *Run MOCHI* ticked or not, as you like.

### W-04. WebView2 bootstrap *(Automated when the run's `A-WEBVIEW2` says PASS)*

During W-03 there was a progress line about downloading the web view runtime.
1. After the wizard, PowerShell: run the check from 2.5 step 1 again.
- **Pass looks like:** a line `pv : 1xx.x.xxxx.xx`.
- **Fail looks like:** no output, or the app later says it cannot start because the web view is missing.

### W-05. Start menu and first start *(Automated: A-START-MENU, B-LAUNCH)*

1. Start menu → type `MOCHI`.
- **Pass looks like:** an entry named **MOCHI** with the app's icon under *Best match* or *Apps*. Open it: a window titled **MOCHI** appears within a few seconds, showing a heading and **Sections** with the links *Archive*, *Create and add*, *Extract*, *Search names*, *Passphrases*, *Test, health, and repair*, *Other archive formats*, *Job runner self-test*, *Settings*; no error text or blank window.
- **Fail looks like:** no entry, a blank white window that stays blank for 30 seconds, a message about a missing component or the web view, or a crash.
2. Settings → Apps → **Installed apps**.
- **Pass looks like:** **MOCHI** with a version number, publisher *The MOCHI Project contributors*.

### W-06. F8 guide *(Section 8)*

Do section 8 here, with the network **off** (2.7).

### W-07. Explorer shell integration *(the menu display is yours; the verbs themselves are Automated)*

Network may be on. Close MOCHI first. Use the awkward folder.

1. Right-click `Ärchive & ço.mochi`. On **Windows 11** click **Show more options** (or press **Shift+F10** on the file).
- **Pass looks like:** the classic menu lists **Open with MOCHI**, **Extract here**, **Extract to folder**.
- **Fail looks like:** any of the three is missing (Windows 11's first, short menu does not list them: that is expected and is why you open *Show more options*).
2. Click **Open with MOCHI**.
- **Pass looks like:** the MOCHI window opens with this archive shown (Archive section: a *Snapshots* list of commits and its folder contents); nothing was written next to the file.
3. Close MOCHI. Right-click the `.mochi` file → classic menu → **Extract here**.
- **Pass looks like:** MOCHI opens on the **Extract** plan for the whole snapshot with a button **Extract**; the folder next to the archive has **no new files**.
- **Fail looks like:** files appeared before you pressed anything, or an error text instead of the plan.
4. Close MOCHI. Right-click → **Extract to folder**.
- **Pass looks like:** the **Extract** plan shows a target folder named for the archive; Explorer shows that folder next to the archive, **empty** (this one empty folder is by design); no files inside until you press **Extract**.
5. Press **Extract** once.
- **Pass looks like:** a result line "Extracted …"; files appear in that folder; the text says extracting is not a verification.
6. Close MOCHI. Right-click `Note é & more.txt` → classic menu → **Add to MOCHI archive**.
- **Pass looks like:** MOCHI opens on the add panel with that file listed under **Chosen items**; nothing was written.
7. Close MOCHI. Select **three** files in the folder (Ctrl+click), right-click one → **Add to MOCHI archive**.
- **Pass looks like:** **one** MOCHI window, with all three items under **Chosen items** (Explorer starts MOCHI once per file; they collect in the one window).
- **Fail looks like:** two windows, or fewer than three items.
8. Close MOCHI. Right-click the **folder** `Tést & spaces Ünï`'s parent folder entry (or any folder) → **Add to MOCHI archive**.
- **Pass looks like:** the add panel with the folder under **Chosen items**.
9. With MOCHI running (open it from Start), double-click `Second é & copy.mochi`.
- **Pass looks like:** the **same** window now shows that archive; Task Manager (Ctrl+Shift+Esc) lists **one** MOCHI under Apps.
- **Fail looks like:** a second MOCHI window or two entries.
10. Throughout steps 2 to 9 the path had spaces, accented letters and an `&`.
- **Pass looks like:** every verb opened the right file.
- **Fail looks like:** an error such as "could not open", the wrong file, or a window that shows a path cut at the `&`.

### W-08. Foreign-format opt-in

Pass 1 (the opt-in answered **No** in W-03):

1. Right-click `Zip & ç.zip` → **Open with** (classic menu; or *Choose another app*).
- **Pass looks like:** the list does **not** offer MOCHI.
- **Fail looks like:** MOCHI is listed.
2. Uninstall MOCHI (W-09 steps 1 to 3; leave the checks of W-09 for the end), run the installer again, answer **Yes** to the question.
3. Right-click `Zip & ç.zip` → **Open with**.
- **Pass looks like:** MOCHI is offered. Double-click the file: it opens in the program it used before (File Explorer's compressed folder, or 7-Zip if you installed it); MOCHI is **not** the default.
4. For each of `.zip`, `.7z`, `.rar`, `.tar`, `.tar.gz`: right-click → **Open with** → **MOCHI**.
- **Pass looks like:** the window shows the **Other archive formats (read-only)** section with the entries listed, the sentence *"This is not a MOCHI archive. It is open read-only…"*, and **no** MOCHI health words (no PASS/FAIL/DEGRADED health table).
5. `enc_names.7z` (password `SECRET`) and `comment-hpw-password.rar` (password `password`): Open with → MOCHI.
- **Pass looks like:** a **Password** field appears in the window (the names are encrypted); a wrong password gives *"That password did not open the archive. Try again."*; the right one lists the entries.
6. `traversal.zip`: Open with → MOCHI.
- **Pass looks like:** names such as `../evil.txt` and `C:\win.txt` are listed as ordinary text, nothing is extracted, no window or link opens.
7. While MOCHI is open, do step 4 again from Explorer for another foreign file.
- **Pass looks like:** the same window shows it; no second window.

### W-09. Uninstall leaves nothing *(Automated: A-UNINSTALL, A-LEFTOVERS, B-UNINSTALL, B-LEFTOVERS)*

1. Close MOCHI. Settings → Apps → Installed apps → **MOCHI** → **Uninstall** → confirm.
- **Pass looks like:** an uninstall window runs and closes; MOCHI disappears from the list.
2. Explorer address bar: `%LOCALAPPDATA%\MOCHI`.
- **Pass looks like:** *"This folder doesn't exist"* (or the address does not open).
- **Fail looks like:** the folder exists with files.
3. Registry: PowerShell, run both:

   ```powershell
   reg query HKCU /f mochi /k /s
   reg query HKLM\SOFTWARE /f mochi /k /s
   ```

   Then look for the values: `reg query HKCU\Software\Classes /f MOCHI /s /v`.
- **Pass looks like:** `End of search: 0 match(es) found.` for each (or only keys under `Explorer\FileExts`, `RecentDocs`, `AppCompatFlags` or similar, which Windows writes because the app ran; note them).
- **Fail looks like:** any `Mochi*`, `MOCHI.Archive`, or `MOCHI.Foreign` key, or a value `MOCHI.Foreign` under an `OpenWithProgids` key.
4. Double-click `Ärchive & ço.mochi`.
- **Pass looks like:** Windows asks *"How do you want to open this file?"* (or says no app is associated). Cancel it. Explorer's *Type* column shows `MOCHI File`/`.mochi File`, not "MOCHI archive".
- **Fail looks like:** MOCHI still starts.
5. Observation, not a fail: `%APPDATA%\io.github.immerh8.mochi` and `%LOCALAPPDATA%\io.github.immerh8.mochi` (settings, the web view's cache) remain after an uninstall that does not delete application data. Write down whether the uninstaller offered to delete it.

### W-10. Windows accessibility → section 6.

---

## 5. Ubuntu session (run on Ubuntu 22.04, then on 24.04)

Start: revert to **`clean-ubuntu`**, start, connect the network, log in. Copy in the `.deb`
and the test files (2.6); make the awkward folder in Documents.

### U-01. Install by double-click *(not automated)*

1. Files → the `.deb` → double-click.
- **Pass looks like:** the software installer (*App Center* on 24.04, *Software Install* on 22.04) opens showing **MOCHI**, with **Install**; after your password it finishes and shows **Open** or **Remove**; libraries MOCHI needs are fetched without errors.
- **Fail looks like:** "dependency problem", "cannot be installed", or an install that never finishes.

### U-02. Start from the launcher *(Automated: U-LAUNCH, under Xvfb; here it is the real desktop)*

1. Press the Super key, type `MOCHI`, Enter.
- **Pass looks like:** an app named **MOCHI** with an icon; the window opens with the same Sections list as W-05.
- **Fail looks like:** no entry, a blank window, or a crash.

### U-03. `.mochi` in GNOME Files

1. Files → the awkward folder → right-click `Ärchive & ço.mochi` → **Properties**.
- **Pass looks like:** *Type* reads **MOCHI archive (application/x-mochi)**. (The package ships a type matching `*.mochi` by name only.)
2. Double-click the file.
- **Pass looks like:** MOCHI opens with the archive shown.
- **Fail looks like:** a different program, or "Could not find an app".

### U-04. "Open with" for foreign formats, the default unchanged

1. Right-click `Zip & ç.zip` → **Open With Other Application**.
- **Pass looks like:** the list includes **MOCHI**; the file's Properties → **Open With** tab shows **Archive Manager** (or whatever it was) still selected as the default.
2. Repeat for the `.7z`, `.rar` and `.tar.gz` files.
3. Choose **MOCHI** for each.
- **Pass looks like:** the **Other archive formats (read-only)** section with the entries, read-only, no MOCHI health words.

### U-05. Second `.mochi` goes to the running window

1. With MOCHI open, double-click `Second é & copy.mochi` in Files.
- **Pass looks like:** the **same** window now shows it; Activities shows one MOCHI window. (Automated: U-SINGLE-INSTANCE.)

### U-06. Terminal install and removal *(Automated: U-INSTALL … U-PURGE-LEFTOVERS)*

Already covered by the run's table. If you want to see it once: `sudo apt remove mochi`, then reinstall with `sudo apt install ./mochi_*.deb`.

### U-07. Removal leaves no "MOCHI archive" type

1. `sudo apt remove mochi`. In Files, right-click the `.mochi` file → Properties.
- **Pass looks like:** *Type* no longer says MOCHI archive (reopen Files if it still does; it caches); the launcher no longer finds MOCHI.
- **Fail looks like:** *MOCHI archive* is still shown after you reopen Files.
2. Reinstall (for later sessions): `sudo apt install ./mochi_*.deb`.

### U-08. F8 guide *(Section 8)*, with the network off.

---

## 6. Accessibility (D7): screen readers, contrast, scaling

Machines check names, structure, tab order and contrast (`pnpm test`, the keyboard E2E
spec). They cannot hear a screen reader or see a contrast theme.

### 6.1 Windows: NVDA

Setup (each Windows VM): download NVDA from `https://www.nvaccess.org/` in the VM, install,
choose *Use NVDA on the sign-in screen* off, and finish. **To read what it says without
audio:** NVDA menu (NVDA+N) → Tools → **Speech Viewer**: a window logs every phrase. Keep
it open and compare. Start NVDA before MOCHI. Use the keyboard only: Tab / Shift+Tab, arrows, Enter, Space.

| # | Do this | **Pass: you hear / see** | **Fail** |
|---|---|---|---|
| N-1 | Open MOCHI. Tab to **Open archive…**, Enter, choose `valid-archive-3-commits.mochi` in the file dialog, Enter. Tab into **Folder contents** and press Down Arrow through the rows. | The list is announced as *Folder contents, list, N items* (plus its keyboard hint about arrow keys, Page Up, Home and End). Each Down Arrow announces the row's **name and its kind** (File or Folder) and its position (*1 of N*). | Silence, "unlabelled", only a kind without a name, or a position that does not change. |
| N-2 | Tab to **New archive…**, Enter. Then tick **Encrypt with a passphrase**, type a passphrase in **Passphrase** and again in **Repeat it**, add a file through **Add files…** and press **Choose location and create…**, finish the dialog. | When the panel opens you hear its heading **New archive** and focus is on it. When the job ends you hear the result in the status line ("Committed commit … a local commit …"), once, without moving focus. No "backed up", "safe" or "preserved". | The panel opens silently, the result is never spoken, or it is spoken twice, or it says the data is backed up or safe. |
| N-3 | Section **Test, health, and repair** → **Test archive** (with the archive from N-1). | You hear the headline, then **Overall PASS (exit code 0); policy result …**, and then each dimension with its status **as a word** (PASS, FAIL, DEGRADED, UNKNOWN, OVERDUE, UNSUPPORTED), not only a symbol (✓ ✗ ! ? … –). | Only symbols, only colour, or the overall word missing. |
| N-4 | Create or open an **encrypted** archive, then enter a **wrong** passphrase and submit. | An alert is announced: *"The passphrase did not open this archive."* and **focus is back in the passphrase field**. | No announcement, or focus is lost (it stays on the button or the page). |
| N-5 | **Settings → Crash reports**: Tab to **Include the panic message in each record**. | NVDA reads the checkbox's name **and** the warning that begins *"The panic message is the program's own description of what went wrong…"* with it (as the description). | The warning is not read with the checkbox. |
| N-6 | **Settings → Updates**: Tab to **Check for updates when MOCHI starts (off unless you turn it on)**. | The label is read with its state (not checked). | No state. |

### 6.2 Windows: contrast themes, scaling, window size

| # | Do this | **Pass: you see** | **Fail** |
|---|---|---|---|
| C-1 | Windows 11: Settings → Accessibility → **Contrast themes** → choose **Night sky**, then **Desert**, **Apply**. Windows 10: Settings → Ease of Access → **High contrast** → *Turn on high contrast* with a dark and a light theme. Open MOCHI with an archive open and run a test. | Text readable. The selected row, snapshot and folder have a **visible 2-pixel outline**. Every status (PASS, FAIL, DEGRADED…) is a **word with a shape around it** (dashed for needs-attention); nothing depends on colour. | A selection you cannot find, text that disappears into the background, or a status you can only tell by colour. |
| C-2 | Settings → System → Display → **Scale 200 %**; make the MOCHI window about 1280×720 (VM window, or the display resolution in the VM). | No **horizontal scroll bar for the page**; panels reflow to one column. | The page scrolls sideways or controls are cut off. |
| C-3 | Turn the theme and scale back to the defaults. | | |

### 6.3 Ubuntu: Orca

Turn Orca on with **Super+Alt+S** (or Settings → Accessibility → **Screen Reader**). Orca
speaks through the VM's audio: make sure the VM audio is on and the volume is up. Repeat
N-1 to N-5 with Orca.

| # | Do this | **Pass: you hear** | **Fail** |
|---|---|---|---|
| O-1…O-5 | The same as N-1 to N-5 (arrow keys in the list, the New archive panel, the test status words, the wrong-passphrase alert with focus back in the field, the crash-report warning with its checkbox). | The same announcements. In Orca, list rows read *name, kind*; the alert is spoken when it appears. | As for N-x. |
| O-6 | GNOME **Settings → Accessibility → High Contrast** on, then off. Open MOCHI with an archive and run a test. | Outlines and statuses as in C-1. | As C-1. |

### 6.4 Record

Record the NVDA and Orca versions (NVDA: NVDA menu → About; Orca: `orca --version`). Write
what you actually heard for any row that is not a clean pass.

---

## 7. The updater (T13): the test release pair

The updater test needs **two published releases**, an old one installed and a newer one to
update to. To avoid using up real version numbers, publish a throwaway pair, **0.9.0 then
0.9.1**, as ordinary releases through the existing draft-only `release` workflow
(`.github/workflows/release.yml`, which never publishes by itself). They are marked as test
releases in their notes, they are tested, and then they are **deleted**. **1.0.0 later
supersedes both**: it is a higher version and a later commit.

> **Two cautions.**
> 1. While 0.9.1 is published, any copy of MOCHI older than 0.9.1 that checks for updates
>    will be offered it. Publish it only when you are ready to test, and delete both
>    releases straight after (7.6).
> 2. GitHub chooses `releases/latest` by the **date of the tagged commit** (not by version
>    and not by publish time). Make the 0.9.x commits **after** everything that 1.0.0 will
>    contain was merged, or delete them (7.6) **before** 1.0.0 is published; otherwise a
>    1.0.0 whose commit is older than 0.9.1's would not be the "latest".

### 7.1 One-time setup (you, in the GitHub web interface)

1. Repository **Settings → Secrets and variables → Actions → New repository secret**.
   * Name `TAURI_SIGNING_PRIVATE_KEY`; value: the **entire text** of the updater private key file (open it in a text editor, select all, copy, paste). Its public half is already in `apps/mochi-desktop/src-tauri/tauri.conf.json` (key ID `79A2DBFA840725F5`); apps trust only that key.
   * Name `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; value: the key's password.
   * **The key must have a password**: GitHub Actions secrets cannot be empty, and the workflow requires both. A key made without a password must be regenerated, which changes the public key and needs a new release (`docs/packaging.md`, "Releasing").
   * **Never** put the key, its password, or any part of them in the repository, an issue, a comment, a chat, a screenshot, or this runbook. If one was pasted anywhere public, treat the key as leaked.
2. Without both secrets the workflow stops in `preflight` and names the missing one. Nothing is built.

### 7.2 Publish 0.9.0

On your computer, in a clone of the repository:

1. Make a branch from the commit you are testing: `git switch -c release-test/0.9 <commit>`.
2. Set the version to `0.9.0` in **both** `apps/mochi-desktop/src-tauri/tauri.conf.json` (`"version"`) and `Cargo.toml` (`[workspace.package]` `version`); they must match. Then refresh the lock file, or the `--locked` build fails: `cargo update --workspace` (it only rewrites the workspace crates' own versions in `Cargo.lock`).
3. Write `docs/release-notes/v0.9.0.txt`, one plain-text line (the app shows it as text):
   `Test release for the 1.0 checklist, do not use.`
4. Commit (message: `TEST RELEASE 0.9.0, do not merge`) and push the branch: `git push -u origin release-test/0.9`. **Never merge this branch.**
5. Push the tag: `git tag v0.9.0 && git push origin v0.9.0`. (Alternative with no tag by hand: Actions → **release** → Run workflow, branch `release-test/0.9`; the tag is then created when you publish.)
6. Actions → the **release** run for `v0.9.0`. **Pass looks like:** all jobs green (`preflight`, `build` for both OSes, `smoke (ubuntu-24.04)`, `draft release`). **Fail looks like:** red; read the first red step.
7. Releases → the **draft** `MOCHI 0.9.0` → **Edit**. At the top of the description add the line **"Test release for the 1.0 checklist, do not use."** Make sure *Set as a pre-release* is **unticked** (a pre-release is invisible to the updater). **Publish release.**
8. Check: `https://github.com/immerh8/MOCHI/releases/latest/download/latest.json` opens a JSON file with `"version": "0.9.0"`.

### 7.3 Install 0.9.0 in the VMs

In each of the four VMs, from its clean snapshot (Windows: **`clean-no-webview2`** with the network on), install the **0.9.0** build from the published release (Windows `*-setup.exe`, answer **Yes** to the foreign-format question this time; Ubuntu: `sudo apt install ./mochi_0.9.0*.deb`). Start MOCHI once. Take a snapshot **`v0.9.0-installed`**.

### 7.4 Publish 0.9.1

1. On the same branch: set both versions to `0.9.1`, `cargo update --workspace`, write `docs/release-notes/v0.9.1.txt` with `Test release for the 1.0 checklist, do not use. Newer than 0.9.0.`, commit `TEST RELEASE 0.9.1, do not merge`, push, `git tag v0.9.1 && git push origin v0.9.1`.
2. As 7.2 steps 6 to 7: green run, edit the draft's description, not a pre-release, **Publish**.
3. Check: `latest.json` now says `"version": "0.9.1"` (GitHub may take a minute or two to serve the new file).

### 7.5 The updater checks (in every VM, from `v0.9.0-installed`)

Revert to **`v0.9.0-installed`**, network on, then:

| # | Do this | **Pass looks like** | **Fail looks like** |
|---|---|---|---|
| X-1 | Start MOCHI. Settings → **Updates**. Confirm the box **Check for updates when MOCHI starts (off unless you turn it on)** is **unticked**. Close MOCHI; flush the resolver cache and watch the network (2.7); start MOCHI; wait 30 seconds. | The text *"MOCHI will not check for updates by itself."* and **no** `github.com` lookup in the watch. | A `github.com` request with the box off. |
| X-2 | Tick the box. Close MOCHI, flush the cache, start it, wait 30 seconds. | *"MOCHI will check once each time it starts. It still asks before downloading anything."* and **one** `github.com` lookup. A dialog or text says that version 0.9.1 is available; **nothing was installed** (the version line still says 0.9.0). | No request with the box on, or something downloaded or installed by itself. |
| X-3 | Untick the box again. **Disconnect the network** (2.7). Press **Check for updates**. | *"Could not reach the update server. Check your connection and try again. Nothing was changed."* | A crash, a hang with no message, or a success message. |
| X-4 | Reconnect. Press **Check for updates**. | *"Version 0.9.1 is available. You are running version 0.9.0."*, **Release notes** showing the one test line **as plain text**, and the buttons **Not now** / **Download and install**. **Nothing installs yet.** Press **Not now**; the version line still says 0.9.0. | Notes rendered as markup, an install starting on its own, or a wrong version. |
| X-5 | **The edited signature.** See 7.5.1 below. | *"The update's signature did not match, so it was refused. Nothing was installed."* The app stays at 0.9.0. | The installer starts, the version changes, or the message says anything is installed or fine. |
| X-6 | **The update.** Windows: press **Check for updates**, then **Download and install**. | Windows: a progress readout, then **MOCHI closes**, the installer's own small progress bar (no questions) runs, and the **new version starts** (open MOCHI from Start if it does not). Settings → Updates says *"You are running version 0.9.1."*; Settings → Apps shows MOCHI **0.9.1**. | The app disappears and nothing comes back, an error box, or still 0.9.0. |
| X-7 | **Windows only.** After the update, check the shell: right-click `Zip & ç.zip` → Open with; the `.mochi` verbs; double-click a `.mochi` file. | Everything from W-07/W-08 still there; MOCHI **still offered under Open with** for ZIP (an update keeps the opt-in you chose at the first install); the `.mochi` association intact. | The opt-in or a verb vanished. |
| X-8 | **Ubuntu only (instead of X-6).** Press **Check for updates**, then **Download and install**. | A **password prompt** appears (*"Ubuntu will ask for your password to install the package."*); after you enter it, the text *"Version 0.9.1 was installed. Close MOCHI and open it again to use it."* Close and reopen MOCHI: Settings → Updates says version **0.9.1**; `dpkg -l mochi` shows 0.9.1. | No prompt, an error, or still 0.9.0 after reopening. |

Order inside a VM: X-1 to X-4, then **X-5 before X-6** (X-5 needs the 0.9.1 release in place
but must not leave the app updated), then X-6 or X-8, then X-7. Because X-6 updates the VM,
revert to `v0.9.0-installed` between repeats.

#### 7.5.1 The edited `.sig` (X-5)

The signature inside `latest.json` is the same text as the `.sig` file of the installer, so
editing it tests the same refusal.

1. On the **0.9.1** release page, download `latest.json`. Open it in a text editor. Find the line `"signature": "…"` for your platform (`windows-x86_64…` for the Windows VMs, `linux-x86_64…` for Ubuntu). Change **one letter in the middle** of that long text to a different letter. Save as `latest.json` (same name).
2. On the release: **Edit** → delete the `latest.json` asset → upload your edited file → **Update release**. Keep the original file safe: you will restore it.
3. Wait a minute, then in the VM press **Check for updates**, then **Download and install**.
4. **Pass:** the signature message above, nothing installed, version unchanged. **Fail:** anything else.
5. Restore: delete the edited `latest.json` asset from the release and upload the original. Check `releases/latest/download/latest.json` shows the original signature again before continuing with X-6.

You only need to edit and restore the asset once for all four VMs if you do X-5 in all of them first.

### 7.6 Clean up

After all four VMs are done:

1. Releases → `MOCHI 0.9.1` → delete (trash icon) → confirm; the same for `MOCHI 0.9.0`.
2. Delete the tags: `git push origin --delete v0.9.0 v0.9.1`; delete the branch: `git push origin --delete release-test/0.9`.
3. Check `https://github.com/immerh8/MOCHI/releases/latest` no longer lists 0.9.x.
4. Keep the VM snapshots until the real 1.0.0 has been through section 7.5's X-4/X-6 once (an update from a published release to 1.0.0 is the final proof), then delete them.

Nothing in the repository changes for this pair: the branch is never merged, the key is never in any file, and no endpoint, key, or `requireSignedVersion` setting is touched.

---

## 8. F8: Help → User guide, offline *(another worker is adding it; this step only checks it)*

In **each of the four installed VMs** (the Windows ones after W-05, the Ubuntu ones after U-02), with the candidate build installed from **its own installer** (not run from a repository checkout):

1. **Turn the network off** (2.7).
2. In MOCHI choose **Help → User guide**.
- **Pass looks like:** the guide opens with no network: its title and first page are readable, the text matches `docs/user/` (for example the *Getting started* and *An archive is not a backup* topics are reachable), and nothing tries to open the internet (no browser tab to a website, no "can't connect").
- **Fail looks like:** a browser window to a GitHub or other web address, an error about a missing file, a blank page, or the menu entry absent.
3. Check the page says an archive **is not a backup** and that a passing test does not make the file one (the F8 wording).

If the build has no **Help → User guide** yet (the F8 change has not landed in the build you are testing), write `NOT PRESENT`, not FAIL, and do not release gate 5 on that row.

---

## 9. Record the results

### 9.1 What to write down (header)

```
Candidate: commit <40-char sha>, tag v<version>
Installers: <file name> sha256 <hash>  (Windows)   <file name> sha256 <hash>  (Ubuntu)
installer-smoke run: <link>   (verdict, run date)
Windows 11: <Home/Enterprise> <display version> build <build>   (winver)
Windows 10: 22H2 build <build>
Ubuntu 22.04.<n> / 24.04.<n>
VM software: <name and version>, host OS
NVDA <version>, Orca <version>
Test release pair: v0.9.0 / v0.9.1, run <links>, deleted on <date>
Done by <you> on <dates>
```

### 9.2 The results table (copy; fill every cell with PASS / FAIL (text) / NOT RUN / N/A / AUTO (run link))

| Step | Win 11 | Win 10 | Ubuntu 22.04 | Ubuntu 24.04 | Notes |
|---|---|---|---|---|---|
| W-01 WebView2 absent before |  |  | N/A | N/A |  |
| W-02 Unsigned installer (SmartScreen) |  |  | N/A | N/A |  |
| W-03 Wizard, opt-in question defaults to No |  |  | N/A | N/A |  |
| W-04 WebView2 bootstrap |  |  | N/A | N/A |  |
| W-05 Start menu, first start, Apps entry |  |  | N/A | N/A |  |
| W-07 Right-click menu and each verb (awkward path) |  |  | N/A | N/A |  |
| W-08 Foreign opt-in No / Yes / each format / passwords / hostile names |  |  | N/A | N/A |  |
| W-09 Uninstall leaves nothing |  |  | N/A | N/A |  |
| U-01 Install by double-click | N/A | N/A |  |  |  |
| U-02 Start from the launcher | N/A | N/A |  |  |  |
| U-03 `.mochi` type and double-click | N/A | N/A |  |  |  |
| U-04 Open with for foreign formats, default unchanged | N/A | N/A |  |  |  |
| U-05 Second `.mochi` to the same window | N/A | N/A |  |  |  |
| U-07 `apt remove` leaves no type | N/A | N/A |  |  |  |
| Automated run: Windows checks | AUTO | AUTO | N/A | N/A | link |
| Automated run: `.deb` checks | N/A | N/A | AUTO | AUTO | link |
| N-1 / O-1 list rows read |  |  |  |  |  |
| N-2 / O-2 create with passphrase |  |  |  |  |  |
| N-3 / O-3 test status words |  |  |  |  |  |
| N-4 / O-4 wrong passphrase alert, focus back |  |  |  |  |  |
| N-5 / O-5 crash-report warning read with checkbox |  |  |  |  |  |
| C-1 / O-6 contrast themes |  |  |  |  |  |
| C-2 200 % scaling, 1280×720 |  |  | N/A | N/A |  |
| X-1 start-up check off: no request |  |  |  |  |  |
| X-2 start-up check on: one request |  |  |  |  |  |
| X-3 network off: could not reach |  |  |  |  |  |
| X-4 shows 0.9.1 and notes as text, installs nothing |  |  |  |  |  |
| X-5 edited signature refused |  |  |  |  |  |
| X-6 / X-8 update installs 0.9.1 |  |  |  |  |  |
| X-7 shell and opt-in survive the update | |  | N/A | N/A |  |
| F8 Help → User guide offline |  |  |  |  |  |

### 9.3 Where it goes

1. **The release notes.** Paste the header and the table into the description of the real release's draft (Releases → the draft → Edit) under the heading **Release checklist results**, and keep a copy as `docs/release-notes/checklist-v<version>.md` in the release commit's follow-up. Do not publish a release with a FAIL row or a blank cell.
2. **The audit F10 row.** In `docs/audit-gate1.md`, item **10. F10**, add a **Status** line below its *Next step*, in this form, and change nothing else in that item:

   ```
   **Status (<date>):** run by <you>, <build>, results in <release or file link>; <n> of <m> steps PASS, <list of FAIL / NOT RUN steps and the finding for each>. Automated part: <installer-smoke run link>.
   ```

   If a step failed, F10 stays open and the failed step becomes its own finding. Only when every row is PASS, AUTO, or a reasoned N/A may the line say *"checklist run, no findings"*.
3. If you change anything in this runbook because it was wrong or unclear, say so in the pull request.
