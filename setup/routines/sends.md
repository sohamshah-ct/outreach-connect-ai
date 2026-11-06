Weekday send for {{NAME}}'s outreach desk ({{DESK_URL}}). This fires every hour from about 8am to 3pm Eastern. {{FIRST}} set it up at sign-up so approved emails go out on their own, spread through the day so Gmail doesn't see them as spam. Each run sends only its share of the day's emails, with a few minutes between each one. "queued" drafts were either approved by {{FIRST}} on the desk or passed the morning pre-send check. Follow-ups also go out on their own.

EVERY email must be sent with both body AND htmlBody exactly as scripts/mail-bodies.js (or the follow-up plan) produces them. Never send body-only.

0. Get the code: Artifact tool, action "read", url above, path "research-code.json"; unpack it into ./outreach:
   node -e 'const fs=require("fs"),p=require("path");const {files}=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));for(const [r,t] of Object.entries(files)){const o=p.join("outreach",r);fs.mkdirSync(p.dirname(o),{recursive:true});fs.writeFileSync(o,t)}' <saved file>
   cd outreach && npm install --silent. Load ArtifactData with ToolSearch "select:ArtifactData" if needed. ArtifactData `get` meta/status and save its `settings` object to ./settings.json.

WORK OUT THIS RUN'S SHARE
1. ArtifactData query, collection "prospects", where status == "queued", out_dir ./queued. Note each doc's version.
2. ArtifactData query, collection "prospects", where status == "sent", out_dir ./fu/docs. Note each doc's version. Run node scripts/outreach-followups.js --docs ./fu/docs/prospects --out ./fu/out --max 40 --settings ./settings.json and read ./fu/out/plan.json.
3. Count first emails already sent today (Eastern date of sent_at, across all prospects; query status in sent/followed_up/replied/bounced/not_interested). Daily limit for first emails: settings.daily_cap (default 20). Follow-ups don't count toward it.
4. node scripts/send-slot.js --limit <limit> --sent-today <count> --followups-due <entries in plan.json>. It prints first_quota, followup_quota, gaps_min, first_run and last_run. Send at most first_quota first emails and followup_quota follow-ups this run.
5. If both quotas are 0, skip to PART C (if first_run or last_run) or stop quietly.

SPACING: after each email, before the next one, wait the next number of minutes from gaps_min (Bash run_in_background: sleep <minutes*60>). Never send two emails back to back without the wait.

PART A: approved first emails (up to first_quota)
6. For each queued doc, highest fit_score first, one at a time:
   a. Check it first: the greeting name must match the person the email goes to, the body must not say "Hi there", and the email address and street address must not match one already emailed (status sent/followed_up/replied/bounced; if it does, set status "skipped" with skip_reason). If the greeting fails, set status "needs_check" with check_reason and skip it.
   b. Claim it: ArtifactData update {status: "sending"} with if_version = its version. If refused, re-get it; skip unless it's still "queued" (then claim with the new version).
   c. Build the bodies: node scripts/mail-bodies.js <its saved JSON file> ./settings.json.
   d. Gmail send_message: to [email], cc [{{CC}}] (leave cc out if that's empty), subject, body and htmlBody from step c.
   e. Update the doc (pinned to the claim's version): status "sent", sent_at now (ISO), thread_id and message_id from the Gmail result, updated_at now, and append to log {at: now, what: "Emailed <contact_name> at <email>"} (or "Emailed <email>").
   f. Class CRM (Connect AI), if crm_org_id is set: node scripts/crm-entry.js <its saved JSON file> --sent-at <sent_at> --settings ./settings.json. Then crm_log_touchpoint {org: crm_org_id, ...touchpoint} (if the contact name is refused, retry without contact), and crm_update_org {org: crm_org_id, ...update}. If add_contact is set and crm_get_org shows no contacts, crm_add_contact {org: crm_org_id, ...add_contact}. Then update the doc crm_stage "contacted".
   g. If the Gmail send fails, set the doc back to "queued" with a log line naming the error; keep going.

PART B: automatic follow-ups (up to followup_quota; one per business, after 4 business days with no reply)
7. Search Gmail once for replies from the addresses in plan.json (from:(a OR b ...) newer_than:30d -in:sent) and for bounces (from:(mailer-daemon OR postmaster) newer_than:30d). Also skip anyone whose Gmail thread (thread_id) has a message from someone other than {{FIRST}}: owners often answer from a different address. Skip anyone who wrote back or bounced (mark bounced ones "bounced"). For each remaining entry, oldest first:
   a. Claim: ArtifactData update {status: "sending"} with if_version; skip if refused and it's no longer "sent".
   b. Gmail send_message: to, cc (from the plan; leave it out when empty), subject, body AND htmlBody from the plan, replyToMessageId = reply_to_message_id (not replyThreadId: replying to the first email is what makes Outlook and other mail apps show it under the original, with the original quoted below).
   c. ArtifactData update with file_path = after_file, pinned to the claim's version. If the send failed, set status back to "sent" with a log line.
   d. If "crm" is set: crm_log_touchpoint {org: crm.org, kind: "email", body: crm.body} and crm_update_org {org: crm.org, ...crm.update}.

8. Only on the last run of the day (last_run true): say in one or two plain sentences how many first emails and follow-ups went out today, how many are still queued, and anything held back or failed.

PART C: health check (first and last run of the day only)
9. Problems to look for: a Gmail send failed, or a doc is still "sending" from an earlier run (over an hour old); meta/status has `blocked` set, or last_run_at is more than 2 days old on a weekday; fewer than 15 "ready" drafts left; anything else that stopped part of this run.
10. If any problem is found, send ONE email with Gmail send_message to [{{NOTIFY}}], subject "Outreach desk: something needs a look", plain-text body listing each problem in a plain sentence (what happened, what it means for today's emails, whether it fixes itself), ending with the desk link. Don't send the same problem twice in one day. If nothing is wrong, send nothing.
