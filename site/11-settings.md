---
title: Settings
nav: Settings
out: manual/settings.html
group: Running Atlas
order: 11
number: 11
summary: Email and alerts, monitoring rules, sign-in, API keys, webhooks, and your logo and colours.
---

# Settings

Settings has its own group in the Admin menu, one page per job. This chapter goes through each one.

| Page | What you set there |
|---|---|
| **Email & alerts** | How Atlas sends email, when expiry alerts go out, and how long logs are kept. |
| **Monitoring** | What counts as healthy: RMM health, warranties, asset statistics, domain and SSL trackers. |
| **Sign-in** | Microsoft Entra ID and SAML single sign-on for staff. |
| **API keys** | Keys for your RMM and scripts. |
| **Theme** | Your logo, colours and the welcome message for client accounts. |

**Webhooks** is in the System group, and is covered at the end of this chapter.

## Email & alerts

![The Email & alerts page](../images/manual/email.png "Admin → Email & alerts.")

Atlas sends password reset links, expiry alerts and a Monday digest. Tick **Send email from Atlas**, then choose a mail service.

### Microsoft 365 (app registration), recommended

Atlas signs in as an app registration and sends through Microsoft Graph. No mailbox password or SMTP sign-in is involved.

1. In the Microsoft Entra admin center, open **App registrations → New registration** (single tenant, no redirect address).
2. Under **API permissions**, add **Microsoft Graph → Application permissions → Mail.Send**, then **Grant admin consent**.
3. Under **Certificates & secrets**, create a client secret and copy its value. Note when it expires.
4. In Atlas, enter the **Directory (tenant) ID**, **Application (client) ID** and **Client secret**, then the **From address** and **From name**.
5. Choose **Save**, then **Send test**.

> [!tip] Limit what the app can send as
> An Exchange Online application access policy, or RBAC for Applications, can limit the app to the From mailbox so it can't send as anyone else.

### Other mail services

- **Microsoft 365 SMTP (legacy)** fills in Office 365's server and port. Microsoft is retiring basic authentication for SMTP, so prefer the app registration.
- **Other SMTP server** takes an **SMTP server**, **Port**, **Encryption**, **Username** and **Password**.

**Send test** shows the mail server's own error if something is wrong.

### Alerts and logs

- **Email an alert this many days before something is due.** For example, 30, 14 and 7 days.
- **Send a weekly digest on Monday mornings,** listing everything overdue or due in the coming weeks.
- **Keep security and password logs for** a number of years, or forever (the default).

People choose whether they receive alerts with **Email me about expirations** on their own account page.

## Monitoring

![The Monitoring settings page](../images/manual/monitoring.png "Admin → Monitoring.")

| Section | Settings |
|---|---|
| **RMM health** | **Stale after (days)** and **Very stale after (days)**: when an agent that hasn't checked in counts as stale. |
| **Asset warranty** | **Expiring soon within (days)**, and **Look up warranties automatically** for Dell, Lenovo and HP. |
| **Asset statistics** | Which asset layouts count as servers, workstations and other devices. |
| **Domain and SSL trackers** | **Check on a schedule** (domains weekly, daily within 60 days of expiry; certificates daily), and **Add SSL certificates for domains**. |

## Sign-in

Single sign-on with Microsoft Entra ID and SAML is described in [People and access](people-and-access.html#single-sign-on).

## API keys

![The API keys page](../images/manual/api-keys.png "Admin → API keys.")

API keys let your RMM, PSA or scripts read and update Atlas through its REST API.

1. Choose **New key**. Atlas asks for your password again.
2. Give it a **Name**, choose its scopes (`read`, `write`, and optionally `passwords`), and when it **Expires** (a year unless you choose otherwise).
3. Copy the key. It's shown once; Atlas keeps only a hash of it.

- **The key acts as you,** with your access, limited to its scopes.
- Keys can only reach documentation and vault endpoints, never accounts, people, settings, backups or logs.
- Every use is in the security log. **Revoke** keys you no longer use.
- The API is at `/api/v1` on your Atlas, described at `/api/v1/openapi.json`. Within v1, updates only add to it, so your scripts keep working. The other `/api` addresses are the web app's own and can change in any release.

## Theme

![The Theme page](../images/manual/theme.png "Admin → Theme. Changes preview as you make them, and apply for everyone once saved.")

**Admin → Theme** sets the **Brand name**, **Tagline**, **Browser tab title**, **Favicon**, a **Logo** (and one for dark mode), the **Accent** colour (and one for dark mode), and the **Welcome message** client accounts see on their dashboard. Text on the accent switches between light and dark to stay readable. Changes preview as you make them, and apply for everyone once you save.

## Webhooks

![The Webhooks page](../images/manual/webhooks.png "Admin → Webhooks.")

**Admin → Webhooks** makes Atlas post a short message to an address of yours whenever something changes, so a chat channel, an automation or another tool can react.

1. Choose **New webhook**, give it a name and an `https://` address, and tick the kinds of item it should hear about: clients, assets, documents, passwords, contacts, locations, checklists.
2. Copy the **signing secret**, shown once. The receiver uses it to check a message came from Atlas.
3. Choose **Send test** to post a `ping`.

A message names the event (such as `asset.updated` or `password.rotated`), who did it, the client, and the item's name and address. It never carries the item's contents, and a password message gives only the entry's name.

**Delivery.** Anything other than a 2xx answer within 10 seconds is a failure, tried again after 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours. After ten messages in a row have been given up on, the webhook is paused; fix the receiver and choose **Resume**. **Deliveries** shows the latest 50 and why any failed.

> [!tip] Keep chat channels quiet
> An RMM sync changes many assets at once, and each change is a message. Leave **Assets** unticked on a webhook that posts to a chat channel.

The signature format and headers are in the [administrator guide](https://github.com/ithealthtech/nexus-atlas/blob/main/docs/ADMIN-GUIDE.md#webhooks).
