# Updating an outreach desk that's already set up

For a Claude Code session working for a student who set up their desk with SETUP.md earlier. Their routines run the code that was saved on their desk at setup, so new fixes only reach them when you do this. Tell the student in one short line what you're doing at each step. If a step fails, say exactly what failed and stop.

## 1. Get the latest code

Clone (or `git pull`) https://github.com/sohamshah-ct/outreach-connect-ai, then `npm install` and `npm test`. Every test should pass.

## 2. Find their desk and profile

Ask the student for their desk link if you don't have it. Read it with the Artifact tool (`action: "read"`), then `ArtifactData get` collection `meta`, doc `status`, and write its `settings` object to `profile.json` in the repo root.

## 3. Republish the desk with the new code

```bash
node scripts/bundle-for-desk.js > research-code.json
```

Publish `artifact/outreach-desk.html` to their desk URL (`url` set, so it updates the same link) with `files: {"research-code.json": "research-code.json"}`. Leave `capabilities` out so the page keeps what it has. If the publish is refused because the page changed since you read it, read it again and retry.

## 4. Update their routines

`list_triggers`, and find their four "Outreach desk:" routines. Fill in `setup/routines/sends.md` and `setup/routines/replies.md` again with the same placeholders as SETUP.md step 7 (values come from the profile). For `{{TEXT_TO}}`, ask the student the question in SETUP.md. Then `update_trigger` the "weekday sends" and "reply watch" routines with the new prompts. Don't change their schedules, connectors or the other two routines.

## 5. Tell the student what changed

In plain words:

- New **Calls** tab: every call or meeting you recorded with "Start a session", newest first, with the summary, what you learned, the next step, and whether the thank-you went out. Click one to see who said what and play the recording. Each business's page also lists its recorded calls.
- Calls are offered by phone, Teams or Google Meet (no Zoom), and replies waiting for you can be edited right on the desk before sending.
- Follow-ups now go out as replies to the first email, so Outlook and other mail apps show them in the same conversation, with the original quoted underneath.
- Replies from an owner's other email address (same thread) are now caught.
- When an owner writes back, the email comes with a one-page call brief PDF: their number, what they said, sourced facts about the business, questions to ask, and what's been sent. If they gave a number for texts, the same goes to their phone.
- If an owner just says "call me" with a number, they get the number instead of a drafted reply.
