---
title: For your clients
nav: For your clients
out: manual/client-portal.html
group: Using Atlas
order: 8
number: 8
summary: What client accounts see, how to give a client's staff access, and what to share with them.
---

# For your clients

Your clients' own staff can sign in to Atlas at the same address and see their own documentation. This is useful for an office manager who keeps a list of their staff's logins, or a client who wants to see what you've documented for them.

## What a client account sees

A client account sees only its own organization, and only what you give it:

- The documentation you've shared: assets, documents, contacts and locations.
- The passwords you've marked **Share with the client's own accounts**, read-only.
- Their ConnectWise tickets, when the client is linked to a ConnectWise company. With **Client portal tickets** on, they can also open tickets and answer replies (see [Tickets from the portal](#tickets-from-the-portal)).
- Your logo, colour and welcome message.

They never see the MSP knowledge base, other clients, your checklists, the vault for anything you haven't shared, or any administration page. They can't use the browser extension or Atlas for Windows.

## Give a client's staff access

1. Go to **Admin → People & access** and choose **Add person**.
2. Enter their name and email.
3. Choose the role:
  - **Client viewer** to read their documentation.
  - **Client editor** to also keep it up to date themselves.
4. Under **Client access**, give them their own organization.
5. Choose **Create account**. Atlas gives you a temporary password for them to change at first sign-in.

## Share passwords with the client

Open a password and tick **Share with the client's own accounts**. Their contacts can then see it when they sign in. To share several at once, tick them on the client's Passwords tab and change their client portal sharing together.

Every view is recorded for you in the password's access history. If the client requires reasons, they're asked too.

If you'd rather client viewers could see which passwords exist but not reveal them, the owner can tick **Don't let read-only accounts reveal passwords** in Vault policies.

## Tickets from the portal

With ConnectWise connected, a client account can ask you for help from Atlas. On their organization's overview, **Ticket details** has a **New ticket** button. The ticket goes straight to the ConnectWise company the client is linked to, on the board you chose, and says who asked. Each ticket's **Conversation** shows your replies marked **Visible to all** in ConnectWise, never internal notes, and lets the client answer.

An administrator turns this on under **Import & export → ConnectWise RMM → Client portal tickets**. The prerequisites, step-by-step setup, how to check it and troubleshooting are in [Client portal tickets](integrations.html#client-portal-tickets).

## The welcome message and branding

**Admin → Theme** sets your logo, accent colour, and a welcome message that client accounts see at the top of their dashboard. Use it for how to reach your help desk.

## For client contacts: using Atlas

If your IT provider gave you an account:

- **Sign in** at the address they gave you with your email and the temporary password, then choose your own password.
- **What you see** is your organization's documentation, your contacts and locations, and the passwords shared with you.
- **To view a password**, choose **Show password**. You may be asked for a reason, and each view is recorded for your provider.
- **To change something**, you need to be a *Client editor*. Otherwise, ask your provider.
- **To ask for help**, open your organization, go to **Ticket details** and choose **New ticket**. Write a one-line **Summary** and the **Details** (what happened, who it affects, what you tried; never a password), then choose **Open ticket**. You'll see the ticket number, and the ticket in the list.
- **To follow a ticket**, choose **Conversation** on it. You see your provider's replies, and can write back with **Send reply**. The status updates about once an hour.
- If you don't see **New ticket**, your provider hasn't turned it on for your organization.
