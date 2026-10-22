---
title: Getting started
nav: Getting started
out: manual/getting-started.html
group: Using Atlas
order: 2
number: 2
summary: Signing in for the first time, two-step verification, finding your way around, and what your role lets you do.
---

# Getting started

This chapter takes you from the email with your temporary password to knowing your way around. It takes about ten minutes.

## Sign in for the first time

Your administrator gives you the Atlas address, your email, and a temporary password.

1. Open the Atlas address in your browser and sign in with your email and the temporary password.
2. Choose your own password. It must be at least 12 characters; a few unrelated words work well.
3. Set up two-step verification. Staff can't do anything else until it's on. Scan the QR code with an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password and so on) and enter the six-digit code, or add a passkey instead.
4. Save your recovery codes. They are shown once. Each one gets you in once if you lose your phone. Keep them somewhere other than Atlas.

> [!tip] Remember this browser
> At the second step you can tick **Remember this browser for 30 days** so your own computer doesn't ask for a code every time. Only do this on a device that is yours.

### Passkeys

A passkey is Windows Hello, Touch ID, your phone, or a security key. Add one under **Profile & sign-in → Passkeys** (open the account menu with your initials in the top-right header). After that, **Sign in with a passkey** on the sign-in page signs you in without typing a password, and can't be phished.

### Signing in with Microsoft or your identity provider

If your company has set it up, the sign-in page shows **Sign in with Microsoft** or **Sign in with** your provider's name. Your account must already exist in Atlas. The first time you use it, an administrator confirms that the Microsoft or provider account is really yours, and until they do, Atlas asks you to wait.

### Forgot your password

Choose **Forgot your password?** on the sign-in page. The link in the email works once, for an hour. If you have also lost your phone and recovery codes, an administrator can reset your sign-in.

## Find your way around

![The Atlas overview](../images/manual/dashboard.png "The overview with the unified application sidebar and header search. Synthetic example data.")

Atlas is organized into five areas. Each area has a handful of pages.

| Area | Pages | Who sees it |
|---|---|---|
| **Overview** | Dashboard, Expirations, Reports | Everyone |
| **Clients** | Client directory and client workspaces | Everyone |
| **Documentation** | Assets, Knowledge base, Checklists | Everyone; the knowledge base and checklists are for staff |
| **Password Vault** | Passwords, My vault, Password health, Send; Password rotation and BitLocker collector for administrators | Staff |
| **Administration** | People and security, data, system, and settings pages | Administrators |

Your account menu, with your initials, is in the top-right header. It has **Profile & sign-in**, light and dark appearance, and **Sign out**.

### Search everything with Ctrl+K

![The search window open over the dashboard](../images/manual/search.png "Ctrl+K searches clients, assets, documents, passwords, contacts and locations you can see.")

Press **Ctrl+K** (or **⌘K** on a Mac) anywhere in Atlas, or click **Search** in the header. Type a client, an asset name, an IP address, a serial number, a contact, or words from a document. Use the arrow keys and **Enter** to open a result, or **Esc** to close. Results only include what you have access to.

### Navigation and workspace tabs

Atlas uses a single sidebar for **Overview**, **Clients**, **Documentation**, **Password Vault**, and **Administration**. Page links appear in the current workspace. Where the menu doesn't list them (on a phone, with the sidebar collapsed, or in the top menu style), they appear as tabs along the top of the page. **Administration** has many pages, so its tabs show the section you're in, such as People and security, and **More** lists the rest under their headings. The client directory stays in **Clients**, global search, and the client switcher in the header rather than filling a second sidebar.

Choose **Collapse sidebar** at the bottom of the sidebar to make more space for tables. **Expand sidebar** restores labels. Atlas remembers this choice in your browser. On phones, choose **Open navigation** in the header; Escape closes the menu and returns focus to its trigger.

### Favourites and the dashboard

Click the star beside a client, asset or document to add it to the **Favorites** card on your dashboard.

Choose **Customize** on the dashboard to show, hide and reorder its cards. Your layout is yours alone. **Reset to default** puts the standard layout back.

### Light and dark

Choose the appearance in the account menu. Atlas remembers it per browser.

## What's new

After an update with new features, your dashboard shows a **Welcome** card. **See what's new** opens a page describing each new part in plain words, with a link to try it. Opening the page, or choosing **Dismiss**, puts the card away for you; the page stays under **What's new** in the account menu (your initials, top right) to come back to.

## What you can do depends on your role

Everyone in Atlas has one role, plus an access level for each client.

| Role | Who it's for | Clients | Administration |
|---|---|---|---|
| **Owner** | The person responsible for Atlas | Every client, including passwords | Everything, including other owners and vault policies |
| **Administration** | Service managers, senior technicians | Every client, including passwords | People, settings, imports, system |
| **Technician** | Your technicians | The clients they're given, up to editing passwords | None |
| **Read-only technician** | Trainees, auditors | The clients they're given, read-only | None |
| **Client editor** | A client's own staff who keep their documentation | Their own organization, can edit | None |
| **Client viewer** | A client's own staff | Their own organization, read-only | None |

For each client, a person's access is one of **No access**, **Read**, **Edit**, or **Edit + passwords**. Only **Edit + passwords** shows the client's vault. Your access to a client is shown under its name.

> [!note] Can't see a client?
> A client you have no access to looks exactly like one that doesn't exist, on purpose. Ask an administrator to give you access under **Admin → People & access** or through a group.

## Look after your own account

**Profile & sign-in** is where you manage your own security:

- **Change password.** Changing it signs out your other devices.
- **Two-step verification**, **Authenticator app**, **Passkeys** and **Recovery codes.** Add a second method so losing your phone doesn't lock you out.
- **Where you're signed in.** Every browser session, with **Sign out** for each one you don't recognize.
- **Remembered browsers.** Forget any browser that no longer needs to skip the code.
- **Signed-in apps** and **Desktop apps.** The browser extension and Atlas for Windows, with **Sign out** for each.
- **Email notifications.** Tick **Email me about expirations** for alerts when certificates, domains, licences, warranties, password rotations and document reviews come due, plus a Monday digest.

![Your Profile & sign-in page](../images/manual/account.png "Profile & sign-in, with the Menu card and Sign-in security.")

## Keyboard and accessibility

- **Tab** from the top of any page reaches **Skip to content** first.
- **Ctrl+K** opens search anywhere. **Esc** closes dialogs and menus, and focus returns to where you were.
- Every screen is tested against WCAG 2.2 AA in light and dark, and at phone width.
