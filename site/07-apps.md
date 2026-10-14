---
title: Browser extension and Windows app
nav: Extension and Windows app
out: manual/apps.html
group: Using Atlas
order: 7
number: 7
summary: Filling logins in Edge and Chrome with the Atlas extension, and quick search and copying from anywhere in Windows with Atlas for Windows.
---

# Browser extension and Windows app

Two small apps put the vault where you work: the extension fills logins in your browser, and Atlas for Windows searches and copies from anywhere in Windows. Both are for staff; client accounts can't use them. Neither stores passwords: they ask Atlas each time, and every fill or copy is recorded like a reveal.

## The browser extension

The Atlas extension for Microsoft Edge and Google Chrome fills logins from the vault on the site you're on.

### Sign the extension in

1. Click the Atlas button in the browser toolbar.
2. Enter your Atlas address and choose **Sign in through Atlas**.
3. Atlas opens in a new tab. Check it shows the same code as the extension, then choose **Allow**. You may be asked for your password.

You never type a password into the extension itself.

### Fill a login

1. On a sign-in page, click the Atlas button, or press **Alt+Shift+A**.
2. Logins saved for that site are listed first, then logins elsewhere on the same domain, marked *Same domain*. Your own logins from My vault are marked *My vault*.
3. Choose **Fill**. The username and password go into the page.

On sites that ask for the username first, fill once for the username and again on the password page. Clients that require a reason ask for one first.

### Copy instead

Search by name, username, address or client to copy a password, username or one-time code for any login you can use. The extension can't clear the clipboard after it closes, so prefer **Fill** when you can.

### Which logins match a site

A login matches when its **Website or address** has the same host as the page, or the same domain, so a login saved for `login.example.com` is offered on `portal.example.com`.

- Addresses on shared hosting, such as `*.github.io`, and IP addresses only match exactly.
- An `https://` login is never offered on a plain `http://` page.

### Signing out

Use **Sign out** in the extension, or **Signed-in apps** on your account page. The extension also signs itself out after 7 days unused, 30 days after signing in, and whenever your password changes or an administrator signs you out.

### For administrators: installing the extension

- `npm run build:extension` builds it. The unpacked extension goes to `apps/extension/dist`, and a zip to `apps/extension/package`.
- To try it, open `edge://extensions` or `chrome://extensions`, turn on developer mode, and **Load unpacked** with the `dist` folder.
- For your team, publish the zip privately in the Edge Add-ons or Chrome Web Store dashboard, or host it and force-install it with the `ExtensionInstallForcelist` group policy.
- It can only read and fill the tab you open it on, and it asks to reach one address: your Atlas. It stores the Atlas address, a session token and a signing key the browser won't let it export. No passwords, codes or lists of logins.

## Atlas for Windows

A small app in the notification area, for looking things up without opening a browser tab.

### Install it

1. Open your account page in Atlas and find **Desktop apps**.
2. Choose **Download** and run `AtlasForWindowsSetup.exe`.
3. Windows may say it doesn't recognize the publisher, because the app isn't code-signed yet. Choose **More info**, then **Run anyway**.

It installs for you only and doesn't need an administrator. The `.sha256` file beside each download in the GitHub release lets you check the file.

> [!note] The certificate must be trusted
> Atlas for Windows refuses a certificate Windows doesn't trust, and has no way to override that. If your Atlas was installed at an IP address, install its certificate authority first. See [Keeping Atlas healthy](looking-after-atlas.html#the-certificate).

### Sign in

Enter your Atlas address and choose **Sign in with your browser**. Your browser opens, you sign in as usual, and you approve the app. The app never sees your password.

### Search and copy

1. Press **Ctrl+Shift+Space** anywhere in Windows, or click the Atlas icon in the notification area.
2. Type. It searches the clients, assets, documents, contacts, locations and passwords you can see.
3. With a password selected, **Enter** copies it. The buttons copy the username or the one-time code, or open the sign-in address.

A copy is recorded like a reveal in the browser, asks for a reason where the client requires one, is kept out of Windows clipboard history, and is cleared from the clipboard after 30 seconds. Your personal vault isn't available in the app.

### Updates

When a newer version is out, the app tells you once and adds **Get version …** to its menu, which opens the download in your browser. Run the new setup program over the old one; you stay signed in. The app never downloads or installs anything by itself.

### Sign out

**Sign out** in the app's menu, or **Desktop apps** on your account page. Use the account page if the computer is lost: it ends the app's session at once.

### For administrators: rolling it out

Run `AtlasForWindowsSetup.exe /VERYSILENT /SUPPRESSMSGBOXES` from your RMM as the signed-in person, not as SYSTEM, because it installs per person. **Sign out everywhere** on the People & access page, disabling an account, or resetting its sign-in also ends the app's session.
