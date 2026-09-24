# User guide

For technicians who document clients and use the password vault, and for client contacts who sign in to see their own documentation. Administrators: see the [Administrator guide](ADMIN-GUIDE.md).

## Signing in

- **First sign-in:** sign in with your email and the temporary password you were given, then choose your own password (12 characters or more; a few words work well). Staff then set up two-step verification: scan the QR code with an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password, and so on), or add a passkey.
- **Passkeys:** Windows Hello, Touch ID, your phone, or a security key. Add one under **Account → Sign-in options**, then use **Sign in with a passkey** without typing a password.
- **Remember this browser:** tick it at the second step to skip the code on that browser for 30 days. Only do this on your own device.
- **Recovery codes:** keep them somewhere safe. Each one works once if you lose your phone.
- **Forgot your password?** Use **Forgot password** on the sign-in page; the link in the email works once, for an hour.
- **Signed in somewhere you shouldn't be?** **Account → Where you're signed in** lists your sessions; sign any of them out.

## Finding things

- **Ctrl+K** (⌘K on a Mac) opens search from anywhere. Type a client, an asset name, an IP address, a serial number, a contact, or words from a document. Use the arrow keys and Enter to open a result.
- **Clients** lists everyone you have access to; each client has tabs for **Assets**, **Documents**, **Passwords**, **Contacts**, **Locations**, and **Activity**.
- **Expirations** shows what's coming up: domains, certificates, licences, warranties, password rotations, and document reviews.

## Documenting a client

- **Assets** use layouts (templates) such as Configurations, Networks, Domains, SSL certificates, and Licenses. Choose **Add asset**, pick the layout, and fill in the fields. Fields are checked as you save; an IP address or date in the wrong format is pointed out.
- **Documents** are runbooks, procedures, and notes. The editor has headings, checklists, tables, code blocks, and links. Templates for a runbook and an onboarding checklist are there to start from. Set a **review date** to be reminded to check a document.
- **The MSP knowledge base** (under **Knowledge base**) is for your own procedures that apply to every client. Client accounts never see it.
- **Relationships:** on any item, choose **Link** to connect it to related assets, documents, contacts, or locations. For example, link the firewall runbook to the firewall.
- **Files:** drag files onto an item to attach them.
- **History:** every save keeps the previous version. **History** shows the changes line by line and can restore an old version. If someone else saved while you were editing, Atlas tells you instead of overwriting their work.

## Passwords

You see a client's passwords only with *edit + passwords* access to that client.

- **Reveal** shows a password, **Copy** puts it on the clipboard (cleared after 30 seconds), and the six-digit code for accounts with one-time codes updates live. Some clients require a short reason first. Every reveal and copy is recorded.
- **Adding a password:** use the generator for a random password or a passphrase. Atlas warns when a password is weak or already used elsewhere.
- **Rotation:** set how often a password should change, and it appears in **Expirations** when it's due. Changing it keeps the old one in **History**.
- **BitLocker keys:** choose the BitLocker type. The 48-digit key is checked for typos.
- **Sharing with someone outside Atlas:** **Share** creates a one-time link that expires. The password is encrypted in your browser, and the key is only in the link, so send the link through a different channel from the username.
- **Sharing with the client's own staff:** tick *Share with the client's own accounts* so the client's contacts can see it when they sign in.

## For client contacts

When your IT provider gives you an account, you sign in at the same address and see only your organization.

- **What you see:** the documentation your provider has shared, your contacts and locations, and the passwords shared with you.
- **Change requests:** you can't change anything unless your provider made you a *Client editor*. Ask them if something needs updating.
- **Viewing a password:** choose **Show password**. You may be asked for a reason, and each view is recorded for your provider.

## Keyboard and accessibility

- **Skip link:** Tab from the top of any page reaches **Skip to content** first.
- **Search:** Ctrl+K opens it from anywhere. Escape closes dialogs and menus, and focus returns to where you were.
- **Appearance:** light and dark themes are under the account menu. The layout works on a phone.
- **Standard:** Atlas is tested against WCAG 2.2 AA on every screen.
