# Microsoft Teams integration

Atlas maps each client to an existing Teams channel. Staff can read channel posts and replies from the client's
**More → Teams** page, create posts and replies, and edit messages they created through Atlas. Administrators manage
the connection and automatic notifications under **Administration → Microsoft Teams**.

## Two identities, one application

- **Discussions** use a Microsoft work account, connected through the authorization-code flow with PKCE. Microsoft
  enforces that account's channel access. Posts appear under that Microsoft account; Atlas's security log records
  the Atlas staff member who created or edited them. Atlas only offers edits on your own Atlas-created messages.
- **Automatic notifications** use a single-tenant Teams bot, independently of interactive sign-in. Install the bot
  in each destination team. It can send notifications while no technician is signed in.

Atlas's own client access applies before every Teams request. Client portal accounts and ordinary API keys cannot
read or manage discussions. API keys with **write** access can submit confirmed infection events to the feed below.
Do not give the connected Microsoft account access to channels it does not need.

## Microsoft setup

1. Register a **single-tenant** application in Microsoft Entra ID. Record its directory ID, application ID, and
   client-secret **value**. Create a Web redirect URI exactly matching
   `https://YOUR-ATLAS/api/integrations/teams/callback`.
2. Add Microsoft Graph **delegated** permissions `ChannelMessage.Read.All`, `ChannelMessage.Send`, and
   `ChannelMessage.ReadWrite`, plus `openid`, `profile`, `email`, and `offline_access`. Have your administrator grant
   the consent your tenant requires. Do not use migration-only application permissions to send ordinary messages.
3. Register an Azure Bot using that application identity, with the single-tenant type and your tenant ID. Enable
   its **Microsoft Teams** channel. This integration sends notification-only messages through the Bot Connector;
   it does not ingest incoming bot messages or expose a bot command endpoint. Teams posts and replies are read
   through Microsoft Graph instead.
4. In Atlas, save the tenant ID, application ID and secret. Expand **Teams app package**, enter your organization's
   website, privacy-notice and terms URLs, save, then choose **Download Teams app**. The ZIP contains a manifest and
   the required icons; it contains no credentials.
5. Upload this custom app in Teams and add it to each destination team. Your Teams administrator may need to permit
   custom apps. Saving Atlas settings alone does not install the bot or grant Microsoft permissions.
6. Choose **Connect Microsoft account** in Atlas. Sign in with a dedicated staff account that is a member of the
   mapped channels. This connection is separate from Atlas SSO and the Microsoft 365 GDAP connection.
7. Add each client's team ID, channel ID, and a readable channel name. **Get link to channel** in Teams exposes the
   encoded channel ID and the `groupId` (team ID). Atlas expects the decoded `19:…@thread.tacv2` channel ID.
8. Save, then choose **Send test notification**. This posts a clearly labelled test to the saved client channel.

The initial implementation targets the commercial Microsoft cloud. Sovereign-cloud and cross-tenant shared
channels are not supported. Check private-channel bot support and policies in your tenant before mapping one.

## Routing and notifications

Each client needs its own discussion channel. A shared **security channel ID** in the same team may receive breach
and infection alerts for several clients; it must not be a client's discussion channel. Administrators must ensure
every destination's membership is appropriate for the information sent. Teams channel membership is managed in
Teams, separately from Atlas's client grants.

- **Breaches and infections:** checked every minute, sent as soon as their source data is available. A repeated
  infection event is deduplicated, and its resolution is posted into the original notification thread. Breaches
  use Atlas's latest completed breach checks; delivery does not make those checks instantaneous.
- **Expirations and reviews:** new reminder milestones are grouped into a digest after the configured local hour.
  Defaults are 30, 14, 7, 1, and 0 days. If Atlas missed the exact day, the next run picks the latest reached
  milestone. Zero includes overdue items. Quiet days send nothing. Time zones use IANA names such as
  `America/New_York` and follow daylight saving time.
- Notifications include a summary and an authenticated Atlas link. Vault notifications do not include the password
  name, username, secret, notes, or recovery keys. Teams conversation content is shown as text in Atlas and omitted
  from verbose request logs.

The bot needs to be installed, even when discussions work. Check **Delivery history** for errors. Teams throttling
is retried with backoff, up to five attempts. If a response is lost or a worker stops during delivery, Atlas holds
the outcome as **uncertain** to avoid automatic duplicates. Inspect the channel before explicitly retrying it.
Disconnecting disables the integration, clears the Microsoft refresh token, and invalidates pending sign-ins.
Changing the tenant, application, or secret requires connecting the Microsoft account again.

## Confirmed infection-event feed

Configure your monitoring tool to POST confirmed events to:

```text
POST https://YOUR-ATLAS/api/v1/clients/CLIENT-ID/teams/infections
Authorization: Bearer YOUR-ATLAS-API-KEY
Content-Type: application/json
```

```json
{
  "eventId": "incident-4821",
  "assetId": "ASSET-UUID",
  "status": "active",
  "source": "Your monitoring tool"
}
```

Use a stable `eventId` and source for an incident. Send the same event with `status: "resolved"` when it is cleared.
The asset must belong to that client, and the API key's creator must still be staff with edit access. The feed
returns 202 after queuing; it returns 409 if infection alerts are disabled or the client is unmapped. No arbitrary
message text, credentials, or raw monitoring payloads are accepted. This integration does not diagnose infections.

## Operators and developers

Migration `0044_teams_integration` adds post ownership and the persistent delivery queue. It runs through Atlas's
normal startup migration process. Application secrets and Microsoft refresh tokens are encrypted under the master
key, bound to the organization and field, and included in key re-wrapping. Outbound hosts are fixed to Microsoft;
pagination is constrained to the currently mapped channel. Settings changes, posts, edits, tests, and retries are
recorded in the security log without message bodies or credentials.

Tests: `teams-unit.test.ts` covers input, routing boundaries, text rendering and app packaging; `teams.test.ts`
covers storage, token rotation, client isolation, permissions, post ownership, threads, deduplication, throttling,
and ambiguous deliveries against PostgreSQL. `e2e/teams.spec.ts` checks the user flows and accessibility. Microsoft
responses in tests are synthetic; a tenant installation and consent are still required for live verification.

Microsoft references: [channel messages](https://learn.microsoft.com/en-us/graph/api/chatmessage-post?view=graph-rest-1.0),
[editing messages](https://learn.microsoft.com/en-us/graph/api/chatmessage-update?view=graph-rest-1.0), and
[proactive bot notifications](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages).
