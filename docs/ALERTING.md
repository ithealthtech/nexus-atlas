# Alerting center

Open **Administration → Email & alerts → Open alerting center**. Administrators can prepare custom email and
Microsoft Teams messages and test rules together.

This first checkpoint is a **draft workspace**. Saving a draft does not activate it or replace current alert
settings. Email and Teams continue sending their existing alerts. The links at the top open the current email
connection, Teams channel mappings, and Teams delivery history.

## Create a template

1. Choose **New template alert type**, then **New template**. The four types are expirations, document reviews,
   password breaches, and confirmed infections.
2. Name the template. Write the email subject, email message, and Teams message separately.
3. Use **Insert into**, **Field to insert**, and **Insert field** to add a client name, safe item summary, alert
   type, due date, days remaining, severity, or Atlas link. Fields are inserted at the last cursor position in the
   chosen message. Messages are plain text; HTML is displayed as text.
4. Select **Save drafts**. Templates used by a rule cannot be removed until the rule uses another template or is
   removed.

Passwords, recovery keys, and tokens are not available as fields. Password examples use a generic summary.
Examples use a fictional date of June 1, 2030, plus the selected days remaining; they do not read real item data.

## Draft and test a rule

1. Select a template and choose **New rule from template**.
2. Name the rule. Select clients, or leave them all unselected for every client. Choose item types and severities.
3. For expirations and reviews, enter reminder days before the due date. Use `0` for the due date. Select
   **Include overdue items** to match dates in the past.
4. Select active staff email recipients, the client's mapped Microsoft Teams channel, or both.
5. In **Preview & test rule**, select an example client, type, severity, and days remaining. Select **Run preview**.
6. Read the matching conditions, potential destinations, and both messages. Editing the draft or example clears
   the old preview so it cannot be mistaken for the current result.

Previews never send email, post to Teams, or look up real passwords. The destination checks use saved email and
Teams configuration and each staff member's current client access. They do not contact Microsoft or verify that
credentials still work. A matching rule with a destination marked **Ready** is still a draft.

If another administrator saves drafts first, your save is rejected to protect their work. Copy any edits you need
to keep, reload, and apply them to the latest drafts. Unsaved edits are lost when you leave or reload the page.

## Coming next

Publishing and version history, a shared delivery queue and history, explicit migration from current alert
settings, recipient groups, client overrides with precedence, test sends, schedules and digests, and escalation
are separate implementation steps. None are activated by saving drafts in this checkpoint.
