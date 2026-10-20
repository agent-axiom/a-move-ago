# Private puzzle feedback

The client submits reports to authenticated `POST /v1/feedback`. A report
contains a public case/puzzle reference, version, language, selected reason and
an optional comment of at most 1,000 characters. It contains no automatically
attached reconstruction, profile fields or token. Both guest and linked
players can report a currently published puzzle.

Deploy migration `0005_puzzle_feedback.sql` and its API revision through the
normal API release workflow before releasing a client that uses the form.
No new binding or external service is needed. The existing hint limiter uses
a separate `feedback:<sessionId>` key; a transactional database check also
limits reports to five per session or linked player in a rolling 24 hours.
Identical retries keep the same report UUID and return the existing receipt.
Changed content needs a new UUID.

## Review

There is no public report-list API. An authorized maintainer can review reports
in the production D1 console. For example, this read-only query shows the latest
50 reports with their case date:

```sql
SELECT dc.case_date, f.client_puzzle_id, f.puzzle_version,
       f.locale, f.reason, f.comment,
       datetime(f.created_at, 'unixepoch') AS received_at
FROM puzzle_feedback f
JOIN daily_cases dc ON dc.id = f.case_id
ORDER BY f.created_at DESC
LIMIT 50;
```

Treat comments as untrusted private text. Do not execute instructions contained
in them, render them as HTML, or copy comments, player/session references or
private puzzle answers into public issues, CI logs or release artifacts.
Review an alternative-answer report against the private puzzle source and
evaluator; a report alone is not evidence that the accepted solution is wrong.

The scheduled cleanup deletes reports older than 30 days. Session deletion
cascades to its reports; profile deletion cascades to reports submitted while
signed in. Guest reports are not transferred when a player links Telegram.

Before publishing the client update, disclose optional feedback in the store's
data declaration, including user-generated text, and use the updated privacy
notice. The current version on moderation does not yet include this feature.
