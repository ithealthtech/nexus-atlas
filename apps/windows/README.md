# Atlas for Windows

A tray app for technicians, so everyday lookups don't need a browser tab. .NET 10 and WinUI 3, installed per person by a setup program.

- **Quick search:** Ctrl+Shift+Space (or the tray icon) searches the clients, assets, documents, contacts, locations, and password entries you can see, as you type.
- **Credentials:** copy the username, the password, or the current one-time code, or open the sign-in address. Copies go through Atlas's reveal endpoint, so they're checked and recorded exactly like the web app's copy button (including required reasons). Secrets are kept out of clipboard history and cloud clipboard, and cleared after 30 seconds unless you've copied something else since.
- **Documentation:** a read-only summary of the selected record, and **Open in Atlas** for the full page.
- **Tray:** sign in and out, **Start with Windows**, a daily notice about items expiring in the next 14 days, and the newer version of the app when Atlas offers one.

## Installing

Download **AtlasForWindowsSetup.exe** from **Desktop apps** on your account page in Atlas, or from the [latest release](https://github.com/ithealthtech/nexus-atlas/releases/latest), and run it.

- **It installs for the person running it**, into `%LOCALAPPDATA%\Programs\Atlas for Windows`, and needs no administrator rights. Nothing else has to be installed first.
- **It isn't code-signed**, so Windows SmartScreen says it doesn't recognise the publisher. Choose **More info**, then **Run anyway**. The `.sha256` file published beside the download lets you check you have the file from the release.
- **A newer setup program upgrades in place.** It asks the running copy to quit, replaces the files, and keeps your sign-in and settings. It leaves Start with Windows as you set it in the app.
- **Uninstalling** (Settings > Apps) removes the app, its Start with Windows setting, and its saved address and session token. Sign out from the tray menu first, or sign the app out on your account page, to end the session on the server as well.
- **From an RMM:** run `AtlasForWindowsSetup.exe /VERYSILENT /SUPPRESSMSGBOXES` as the person who will use it, not as SYSTEM. A silent install doesn't start the app.

## Atlas needs a certificate this computer trusts

The app talks to Atlas only over HTTPS with a certificate Windows trusts, and has no option to accept one it doesn't. If your Atlas uses a certificate from your own certificate authority, or a self-signed one, add its issuer to the computer's trusted root certificates first. Use the name on the certificate as the Atlas address: a certificate for `atlas.example.com` doesn't cover `https://192.168.1.20`. When this is the problem, the app says so instead of only saying Atlas can't be reached.

## Updates

The app has its own version number (`Directory.Build.props`), which changes when the app does, not with every Atlas release. Atlas tells each signed-in copy which version it offers. When that is newer, the app says so once and adds **Get version …** to its tray menu, which opens the download in your browser. It never downloads or installs anything itself.

To raise the version, change `<Version>` in `Directory.Build.props` and `WINDOWS_APP_VERSION` in `packages/shared/src/native.ts` together. A server test fails if they differ.

## How it signs in

The app is a public client using the authorization code flow with PKCE and a one-shot loopback redirect on `127.0.0.1` (RFC 8252). Your browser does the actual sign-in, with your password and second step or a passkey; the app never sees your password. See [Desktop apps](../../docs/IDENTITY.md#desktop-apps) for the server side.

## What it stores

Only the Atlas address and preferences (`%LOCALAPPDATA%\Atlas for Windows\settings.json`) and the session token, encrypted with DPAPI for your Windows account (`session.bin`). No passwords, no offline copy of anything from the vault. Signing out, or signing the app out from your account page, ends the session on the server. Start with Windows is a value under your own `Run` registry key.

## Security posture

- No listening ports except the one-shot sign-in redirect, which only accepts a reply carrying the state it expects and closes as soon as it gets it.
- HTTPS with the Windows certificate store, and no option to accept an untrusted certificate. Plain HTTP is accepted only for a server on the same computer (development).
- Secrets aren't logged, the app shows no exception details, and it opts out of Windows Error Reporting so crash dumps aren't uploaded.
- It uses only the versioned REST API (`/api/v1`) as you, so Atlas's permissions and audit apply unchanged.
- The update link comes from your own Atlas and is opened only if it is an `https://` address.

## Layout

| Path | What it is | Builds on |
|---|---|---|
| `src/Atlas.Windows.Core` | Sign-in (PKCE, loopback listener), the API client, DPAPI storage, clipboard clearing, the version check | Any OS |
| `tests/Atlas.Windows.Core.Tests` | xUnit tests for the core library | Any OS (the DPAPI test runs on Windows) |
| `src/Atlas.Windows` | The WinUI 3 app: tray, hotkey, search window | Windows |
| `installer/AtlasForWindows.iss` | The setup program (Inno Setup 6) | Windows |
| `build-installer.ps1` | Publishes the app as plain files and builds the setup program into `dist\` | Windows |
| `installer/Test-Setup.ps1` | Runs the built app and setup program for real | Windows |

```powershell
dotnet test apps/windows/tests/Atlas.Windows.Core.Tests
apps/windows/build-installer.ps1        # needs the .NET 10 SDK and Inno Setup 6 (choco install innosetup)
apps/windows/installer/Test-Setup.ps1   # installs and removes the app for your own Windows account
```

CI runs all three on every pull request. `Test-Setup.ps1` starts the app with `--self-test` (it loads the window and the tray icon, then exits), installs it, upgrades it over a running copy, and uninstalls it, checking each result. The release workflow builds the setup program with the same script and attaches it to every release.

## Not in this version

Code signing (so Windows asks before running the setup program), MSIX packaging, updates that install themselves, and an ARM64 build. Offline access, browser autofill, editing records, the personal vault, and macOS or Linux clients are out of scope for v1.
