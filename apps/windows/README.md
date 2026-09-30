# Atlas for Windows

A tray app for technicians, so everyday lookups don't need a browser tab. .NET 10 and WinUI 3, packaged as MSIX.

- **Quick search:** Ctrl+Shift+Space (or the tray icon) searches the clients, assets, documents, contacts, locations, and password entries you can see, as you type.
- **Credentials:** copy the username, the password, or the current one-time code, or open the sign-in address. Copies go through Atlas's reveal endpoint, so they're checked and recorded exactly like the web app's copy button (including required reasons). Secrets are kept out of clipboard history and cloud clipboard, and cleared after 30 seconds unless you've copied something else since.
- **Documentation:** a read-only summary of the selected record, and **Open in Atlas** for the full page.
- **Tray:** sign in and out, **Start with Windows**, and a daily notice about items expiring in the next 14 days.

## How it signs in

The app is a public client using the authorization code flow with PKCE and a one-shot loopback redirect on `127.0.0.1` (RFC 8252). Your browser does the actual sign-in, with your password and second step or a passkey; the app never sees your password. See [Desktop apps](../../docs/IDENTITY.md#desktop-apps) for the server side.

## What it stores

Only the Atlas address and preferences (`%LOCALAPPDATA%\Atlas for Windows\settings.json`) and the session token, encrypted with DPAPI for your Windows account (`session.bin`). No passwords, no offline copy of anything from the vault. Signing out, or signing the app out from your Account page, ends the session on the server.

## Security posture

- No listening ports except the one-shot sign-in redirect, which only accepts a reply carrying the state it expects and closes as soon as it gets it.
- HTTPS with the Windows certificate store, and no option to accept an untrusted certificate. Plain HTTP is accepted only for a server on the same computer (development).
- Secrets aren't logged, the app shows no exception details, and it opts out of Windows Error Reporting so crash dumps aren't uploaded.
- It uses only the versioned REST API (`/api/v1`) as you, so Atlas's permissions and audit apply unchanged.

## Layout

| Project | What it is | Builds on |
|---|---|---|
| `src/Atlas.Windows.Core` | Sign-in (PKCE, loopback listener), the API client, DPAPI storage, clipboard clearing | Any OS |
| `tests/Atlas.Windows.Core.Tests` | xUnit tests for the core library | Any OS (the DPAPI test runs on Windows) |
| `src/Atlas.Windows` | The WinUI 3 app: tray, hotkey, search window | Windows |

```powershell
dotnet test apps/windows/tests/Atlas.Windows.Core.Tests
dotnet build apps/windows/src/Atlas.Windows -c Release -p:Platform=x64
```

CI runs both on every pull request.

## Not in this version

Signed MSIX releases, automatic updates from the release feed, and the installer page are the next milestone. Offline access, browser autofill, editing records, and macOS or Linux clients are out of scope for v1.
