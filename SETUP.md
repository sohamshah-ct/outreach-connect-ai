# Setting up a classmate's outreach desk

These are instructions for Claude Code, run on the classmate's own Claude account. The sign-up page starts this session and pastes the student's profile (JSON) into the first message. Everything you create lives on **their** account: their desk page, their scheduled runs, their Gmail and their Connect.AI login. Never email a business during setup.

Work through the steps in order. Tell the student in one short line what you're doing at each step. If a step fails, say exactly what failed and what they need to do, then stop.

## 1. Save the profile

Write the profile from the first message to `profile.json` in the repo root. Check it has `sender_name`, `sender_major`, `school_email` (an @uconn.edu address), `sender_email` and `why`. If anything is missing, ask the student for it.

## 2. Check the connectors

You need the student's **Gmail** and **Connect AI** connectors (tools named `mcp__Gmail__*` and `mcp__Connect_AI__*`; load them with ToolSearch if they're deferred).

- If either is missing, tell the student: "Turn on Gmail and Connect AI in claude.ai → Settings → Connectors (sign in to Connect AI with your class login), then tell me to continue." Stop until they do.
- Call Connect AI `whoami`. Its name should match `sender_name`. If it doesn't, ask the student which is right.
- Call Gmail `search_threads` with `{"query": "in:sent", "pageSize": 1}` to confirm Gmail works. Don't read or show any email.

## 3. Install and test

```bash
npm install
npm test
node scripts/bundle-for-desk.js > research-code.json
```

All tests must pass. `research-code.json` is the code the scheduled runs read from the desk.

## 4. Publish the desk

Publish `artifact/outreach-desk.html` with the Artifact tool. This is a **new** artifact on the student's account (no `url`):

- `file_path`: `artifact/outreach-desk.html`
- `files`: `{"connectai.png": "artifact/connectai.png", "research-code.json": "research-code.json"}`
- `icon`: `mail`
- `description`: `<First name>'s small-business outreach for Connect.AI: research, drafts, sends and replies.`
- `capabilities`, exactly:

```json
{
  "mcp": {"servers": [
    {"server": "Connect AI", "tools": ["crm_list_orgs", "crm_create_org", "crm_log_touchpoint", "crm_update_org"]},
    {"server": "Gmail", "tools": ["send_message", "get_thread", "reply", "create_draft", "search_threads"]}
  ]},
  "sample": {},
  "user": {},
  "db": {"rules": [
    {"path": "", "read": "view", "write": "owner"},
    {"path": "meta/calendar", "read": "owner", "write": "owner"}
  ]}
}
```

Keep the URL it returns. This is `DESK_URL` below.

## 5. Save the profile on the desk

ArtifactData `set` on the desk (`url` = DESK_URL), collection `meta`, doc_id `status`, data:

```json
{ "settings": { ...everything in profile.json..., "desk_url": "<DESK_URL>" }, "created_at": "<now, ISO>" }
```

Read it back once with `get` to confirm it saved.

## 6. Pick an environment with full network access

The research run reads business websites, OpenStreetMap and the CT business registry, so its environment needs **full** network access. The calendar step also needs `outlook.office365.com`.

1. Call `list_environments`, then `get_environment` on each until you find one whose network access is unrestricted.
2. If none is unrestricted, tell the student: "In claude.ai/code, open the environment menu → Add environment, name it 'Outreach (full network)', set Network access to Full, and save. Then tell me to continue." Wait, then look again.

Keep its id. This is `ENV_ID` below.

## 7. Create the scheduled runs

Fill in each template in `setup/routines/` by replacing these placeholders:

| Placeholder | Value |
|---|---|
| `{{NAME}}` | `sender_name` |
| `{{FIRST}}` | first word of `sender_name` |
| `{{DESK_URL}}` | the desk URL |
| `{{STATES}}` | `states` written out, e.g. "Connecticut and Massachusetts" |
| `{{SENDER_EMAIL}}` | `sender_email` |
| `{{CC}}` | `"<school_email>"` (quoted), or nothing if it's empty |
| `{{NOTIFY}}` | `"<school_email>", "<sender_email>"` (quoted, comma separated) |
| `{{ICS_URL}}` | `calendar_ics_url` |
| `{{TEXT_TO}}` | the address that texts their phone, or `""` for none. Ask the student once: "Want a text (with a one-page brief on the business) when an owner writes back? If so, what's your cell number and carrier?" Verizon: `<10 digits>@vzwpix.com`, T-Mobile: `<10 digits>@tmomail.net`, others: look up their carrier's MMS email gateway. AT&T no longer has one, so use `""`. Never put this number anywhere else. |
| `{{ICS_URL_SET}}` | `true` if `calendar_ics_url` is set, otherwise `false` (and delete step 6 of presend.md) |

Then create four routines with `create_trigger`. For every one: `create_new_session_on_fire: true`, `environment_id: ENV_ID`, `connectors: ["Gmail", "Connect AI"]`, and `initiation: "human_request"`, because the student asked for these at sign-up. To spread out the class's runs, pick a minute M at random between 2 and 28 and use it as below.

| Name | Template | Schedule |
|---|---|---|
| Outreach desk: daily research | `research.md` | `CRON_TZ=America/New_York M+30 6 * * 1-5` (6:32 to 6:58am) |
| Outreach desk: pre-send check | `presend.md` | `CRON_TZ=America/New_York M 7 * * 1-5` |
| Outreach desk: weekday sends | `sends.md` | `CRON_TZ=America/New_York M+30 8-15 * * 1-5` |
| Outreach desk: reply watch | `replies.md` | `CRON_TZ=America/New_York M+20 8-22 * * *` |

Set `notifications: {"push": true}` on the research run only.

If `create_trigger` warns that the routine stores no connectors, tell the student plainly: open claude.ai → Routines, open each of the four "Outreach desk" routines, and add Gmail and Connect AI under connectors. The runs can't send or log anything until they do.

## 8. Start the first research run

Fire the research routine once with `fire_trigger` so the desk has businesses on it today, instead of waiting for tomorrow morning.

## 9. Tell the student what's next

Finish with a short message in plain words:

- Their desk link (DESK_URL). Open it once and allow Gmail, Connect AI and Claude when it asks.
- The first research run is going now. Businesses show up under **Review** over the next half hour, each with a draft.
- Nothing goes out until they approve drafts (or, from tomorrow, until the morning check proves each one against the business's own website). Approved emails go out between about 8am and 3pm on weekdays, a few minutes apart, from their Gmail, copying their UConn address.
- When an owner writes back, they get an email with a ready reply, a "Send it" button and a one-page call brief PDF, plus a text if they gave their number.
- The **Class board** tab shows who in the class is talking to which business.
- Their usage: the research run and the hourly checks use their own Claude usage.

Don't paste the routine prompts or profile JSON into this message.
