# Vision

PFAT helps a self-directed investor be honest with themselves.

Every investment starts with a reason. Most people never write it down, so they can't tell later whether the
reason still holds, or whether it was ever right. PFAT makes the reason a first-class object — a **thesis**
with testable **triggers** and re-checkable **claims** — and turns its checks into a to-do list. When a
position closes, PFAT asks whether the thesis played out, so your decision-making improves over time.

Alongside that, PFAT keeps an approximate balance sheet so each decision is made with your whole financial
picture in view.

## Principles

1. **Your data is yours.** Everything lives in SQLite on a server you run. Nothing leaves it without a consent
   prompt that says exactly what is sent and where.
2. **Approximate beats perfect.** PFAT is not a ledger or tax tool. Notes, not calculations, for tax, fees and
   jurisdiction rules.
3. **History is never overwritten.** Changes to theses, claims and triggers are appended with a reason.
4. **Notifications are work, not noise.** Each one asks for a decision and stays until you make it.
5. **Small and boring tech.** Few dependencies, no build step, easy to self-host and audit.

## Why local data?

_Isn't it easier to use cloud-based services?_

I remember when Hotmail first launched, and I assumed it would fail, as it required a new social contract:

- **You** give us all your data.
- **We** will provide you a service, albeit on our terms.

At the time I thought this would fail because:

1. People wouldn't be willing to give away their private data.
2. Providers couldn't possibly afford to host everyone's data **and** develop software at the same time.

This was the late '90s, and as we all know, I ended up being completely wrong on both counts.

Now that we have some context, however, I can explain why I wanted to build this app as 100% self-hosted.
First, I believe the social contract needs to shift.

1. **Dramatically lower software cost.** Due to "AI", software development is no longer the bottleneck, and
   app development is democratizing at a rapid pace. Truly private cloud hosting options are readily available
   and low cost.
2. **Eroded trust.** We all know that regardless of how genuine a third party is in protecting your personal
   data, it will eventually end up in someone else's hands. Companies go broke, get acquired, are hacked, and
   change their privacy policies.
3. **IMHO, the "I don't have anything to hide" argument no longer holds.** For a long time someone could cling
   to the classic arguments: "I'm not doing anything wrong" and "I'm not interesting enough to investigate".
   The age of advertising has shown us how truly valuable this information is, as it is routinely used for a
   wide range of tasks such as selling you products, shifting public opinion, and influencing voting habits.
   The largest companies in the world are now the ones who own and control this data. As we move from the age
   of advertising to AI, both of these arguments collapse, and the release of even partially sensitive data,
   especially financial data, is ripe for abuse.

**The bottom line:** the "service" provided by this app is by no means special or interesting enough for you
to expose yourself to the risks involved with sharing this information with third parties. You no longer have
to. Don't.

## Non-goals

- Double-entry bookkeeping, budgeting, or bank-feed aggregation
- Tax calculation, cost-basis reporting for tax filing
- Trade execution or broker integration
- Multi-user / multi-tenant hosting (one person per instance)
