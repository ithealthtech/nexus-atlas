# Alerting center

Open **Administration → Email & alerts → Open alerting center**. Administrators can prepare custom email and
Microsoft Teams messages and test rules together.

You work in four steps: **draft** templates and rules, **test** them, **publish** a version, then **go live**.
Until you go live, Atlas keeps sending its classic alerts and nothing here sends. Saving drafts never sends. The
links at the top open the email connection and the Teams channel mappings.

## Create a template

For a ready-made message, select **Ready-made Teams template** and choose **Use template**. Eight presets cover
expirations, document reviews, password breaches and confirmed infections, each in detailed and compact form.
Detailed versions contain key facts, next steps and a request to coordinate in the thread; compact versions suit
busy channels. Each includes a separate email companion. Using a preset creates an editable copy and never
overwrites another template. Preview its fields and select recipients when creating a rule.

**Teams formatting → Formatted message** supports `## headings`, `**bold text**`, `- list items` and a web address
on its own line, displayed as an **Open in Atlas** link. HTML supplied in messages or field values is escaped.
The preview approximates the layout; Teams clients control their own appearance. Existing templates default to
plain text. Thread prompts are instructions for people, not automatic acknowledgments or escalation actions.
These templates remain drafts until saved/published, and custom automatic delivery is still a future step.

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
Choose a real example client before the preview can report an email recipient as ready.

If another administrator saves drafts first, your save is rejected to protect their work. Copy any edits you need
to keep, reload, and apply them to the latest drafts. Unsaved edits are lost when you leave or reload the page.
Deleted clients and unavailable staff remain visible in a saved rule so you can remove their selections before
saving again.

## Who gets it, and when

- **Email groups** in a rule email every active member of a staff group (Administration → Groups) who can open
  the client. Someone chosen directly and through a group gets one email.
- **Send as** chooses **Each alert as it happens** or **One daily summary**: one email per person (or one post per
  Teams channel) at the summary hour, listing everything that rule has to say that day. Breaches and infections
  always go straight away.
- **Timing** sets the time zone, **quiet hours** and the hour daily summaries go. During quiet hours, routine
  reminders (expirations and reviews) wait until the hours end; breaches and infections never wait. Set both quiet
  hours to the same time for none, which is the default.

Timing and these rule settings are saved with your drafts and take effect once published.

## Publish and restore versions

After saving and previewing your drafts, enter a **Version note** and choose **Publish saved drafts**.
This keeps a fixed copy of all templates and rules, with who published it and when. Later draft edits do not
change that copy. **View version** shows its messages and rule summaries; **Older versions** loads earlier history.

**Restore version … to drafts** replaces saved drafts after confirmation and creates a new draft revision.
Save any unsaved edits first. Review restored selections: a client may have been deleted or a recipient disabled
since publication. Correct unavailable selections before publishing again. Concurrent changes are rejected;
reload drafts or refresh version history before retrying.

While the alerting center is live, the newest published version is what sends: publishing a new version changes
what sends from the next minute. Restoring only changes drafts. Versions are retained with the organization’s configuration and included in database backups. Keep
passwords and other secrets out of templates and version notes.

## Send a test

Below the template editor, **Send a test** sends the selected template as saved, with example details and marked
**[Test]**: to your own email, or to a client's mapped Teams channel. Tests appear in the delivery history. Save
your drafts first to test your latest changes.

## Preview what would send

**Delivery → Preview what would send** checks the latest published version against what Atlas knows right now:
every current expiration, document review, breached password and infected Bitdefender endpoint. For each match it
shows the rule, the reason (for example **14-day reminder** or **Overdue**) and each destination, marked
**Would send**, **Already sent**, or why it can't (for example **Can't open this client** or **No Teams channel is
mapped to this client**). Nothing is sent from the preview.

## Go live

Choose **Delivery → Go live**. The confirmation lists what stops, so nothing is sent twice:

- the daily **Expiring soon** emails (the Monday digest keeps coming);
- **Bitdefender infection** emails;
- **Teams notifications** for expirations, document reviews, password breaches and infections.

Reminders that are already due at that moment were most likely sent by the classic alerts, so they're recorded as
done rather than sent again. Tick **Also send reminders that are already due** to send them anyway. From then on,
Atlas checks every minute and sends each reminder once:

- **Expirations and reviews:** each reminder day in a rule fires once, when the item reaches it. If the server was
  off on the day, the reminder goes the next time it runs. **Overdue** fires once, if the rule includes it. A new
  date (a renewed certificate, say) starts the reminders again.
- **Password breaches:** once per breach, until the password changes.
- **Infections:** when GravityZone reports an endpoint infected, then once a week while it stays infected.

Just before each email, Atlas checks the recipient is still an active staff member who can open the client.
Someone who turned off alert emails on their profile doesn't get routine reminders, but still gets breaches and
infections. Teams posts go to the client's mapped channel, or its security channel for breaches and infections.

**Switch back to classic alerts** at any time. The classic alerts carry on, and nothing already sent is sent
again. Going live and switching back are recorded in the security log.

## Acknowledge and escalate

Every alert email has an **Acknowledge or open** button, and every Teams post an **Acknowledge** link, to the
alert's page in Atlas. Anyone on the team who can open the client can choose **Acknowledge** there: it's recorded
for everyone the alert went to, with who did it, and it stops the alert escalating.

In a rule, **Escalation** chooses people and groups and a time, from 15 minutes to a day. If nobody acknowledges
an alert in that time, it goes once more to them by email, marked **Escalated**, whatever their alert email
setting. Each alert escalates once. Choose nobody for no escalation, which is the default.

## Delivery history

**Delivery history** lists every alert the alerting center sent or tried to send, newest first: the message, the
rule, why it went, the item, who it went to, and the outcome. Filter it by status.

- **Sent:** the email server or Teams accepted it. For email that means accepted for delivery, not read.
- **Waiting:** queued, or retrying after a temporary failure (up to five tries, further apart each time).
- **Failed:** it couldn't be sent, with the reason. **Send again** queues it once more.
- **Check before retrying:** Atlas can't tell whether it arrived, for example because the server restarted while
  sending. Check the inbox or channel first; **Send again** asks you to confirm, since it may arrive twice.
- **Not sent:** the recipient couldn't receive it (no longer has access, or turned alert emails off), or it was
  already due when you went live.

## Still to come

Client overrides with precedence are a separate step.
