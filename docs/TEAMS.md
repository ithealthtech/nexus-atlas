# Microsoft Teams integration

Atlas maps each client to an existing Teams channel. Staff can read channel posts and replies from the client's
**More → Teams** page, create posts and replies, and edit messages they created through Atlas. Administrators manage
the connection and automatic notifications under **Administration → Microsoft Teams**.

## One Microsoft account connection

- **Discussions and automatic notifications** use a Microsoft work account, connected through the authorization-code flow with PKCE. Microsoft
  enforces that account's channel access. Posts appear under that Microsoft account; Atlas's security log records
  the Atlas staff member who created or edited them. Atlas only offers edits on your own Atlas-created messages.
- Atlas refreshes the account's access in the background. Notifications continue while no technician is signed in
  to Atlas and while no Teams browser or desktop window is open. The Atlas server must be running.
- An Azure Bot resource, Bot Connector registration, custom Teams app package, bot hosting, or bot installation is
  not required. Use an existing Teams-licensed work account with access to the destination channels. Choosing a new
  dedicated notification account may require another Microsoft 365 licence.

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
3. In Atlas, save the tenant ID, application ID and secret. Saving settings does not grant Microsoft permissions.
4. Choose **Connect Microsoft account** in Atlas. Sign in with a work account that is a member of the
   mapped channels, including each security destination. This connection is separate from Atlas SSO and the Microsoft 365 GDAP connection.
5. Add each client's team ID, channel ID, and a readable channel name. **Get link to channel** in Teams exposes the
   encoded channel ID and the `groupId` (team ID). Atlas expects the decoded `19:…@thread.tacv2` channel ID.
6. Save, then choose **Send test notification**. This posts a clearly labelled test to the saved client channel under
   the connected Microsoft account.

The initial implementation targets the commercial Microsoft cloud. Sovereign-cloud and cross-tenant shared
channels are not supported. The connected account must have permission to post in every mapped channel.

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

Check **Delivery history** for errors. Teams throttling
is retried with backoff, up to five attempts. If a response is lost or a worker stops during delivery, Atlas holds
the outcome as **uncertain** to avoid automatic duplicates. Inspect the channel before explicitly retrying it.
Disconnecting disables the integration, clears the Microsoft refresh token, and invalidates pending sign-ins.
Changing the tenant, application, or secret requires connecting the Microsoft account again.

If Microsoft revokes access or requires sign-in again, notifications remain pending without consuming delivery
attempts. Choose **Connect Microsoft account** again; queued notifications resume on the next delivery cycle. An
account's channel permissions still apply to every notification.

## Upgrading from 2.1.0

Existing application settings, connected accounts, client mappings and delivery history are preserved. The Teams
app-package download and its website/privacy/terms fields have been removed because Graph delivery does not use
them. No bot credentials or bot endpoints are used after the update.

Pending notifications use the connected account. New incident resolutions reply to their original Graph message.
If the original notification was sent by the old bot, the first resolution after upgrading starts a new post;
Atlas keeps the old delivery record and does not interpret bot activity IDs as Graph message IDs. If you configured
an Azure Bot for 2.1.0, verify a test notification through the account connection before retiring that resource.

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

Migration `0044_teams_integration` adds post ownership and the persistent delivery queue. Migration
`0045_teams_graph_messages` adds a separate Graph message ID while retaining historical bot IDs. They run through Atlas's
normal startup migration process. Application secrets and Microsoft refresh tokens are encrypted under the master
key, bound to the organization and field, and included in key re-wrapping. Outbound hosts are fixed to Microsoft;
pagination is constrained to the currently mapped channel. Settings changes, posts, edits, tests, and retries are
recorded in the security log without message bodies or credentials.

Tests: `teams-unit.test.ts` covers input, routing boundaries, text rendering and Graph delivery errors; `teams.test.ts`
covers storage, token rotation, client isolation, permissions, post ownership, threads, deduplication, throttling,
and ambiguous deliveries against PostgreSQL. `e2e/teams.spec.ts` checks the user flows and accessibility. Microsoft
responses in tests are synthetic; an account connection and Microsoft consent are still required for live verification.

Microsoft references: [channel messages](https://learn.microsoft.com/en-us/graph/api/chatmessage-post?view=graph-rest-1.0),
[editing messages](https://learn.microsoft.com/en-us/graph/api/chatmessage-update?view=graph-rest-1.0),
[thread replies](https://learn.microsoft.com/en-us/graph/api/chatmessage-post-replies?view=graph-rest-1.0), and
[account token renewal](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens).
