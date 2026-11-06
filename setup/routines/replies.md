Hourly reply watch for {{NAME}}'s small-business outreach desk, a claude.ai artifact: {{DESK_URL}} (database collection "prospects"). {{FIRST}} ({{NOTIFY}}) set this up at sign-up and asked for it: when a business owner they emailed writes back, write the answer as a Gmail draft and email it to {{FIRST}} with a "Send it" button and a one-page call brief PDF (and text it to their phone if TEXT_TO below is set); when {{FIRST}} approves, send that draft. Keep usage low: check first, and stop right away if there's nothing to do.

STEP 0, the cheap check. Gmail search_threads (view THREAD_VIEW_MINIMAL, pageSize 20) with:
  newer_than:2h ((subject:"UConn student" -from:me) OR (from:me (subject:"Approve reply" OR subject:"Re: " subject:"Your reply is ready")))
Drop threads already handled: a thread whose latest message from someone other than {{FIRST}} is older than a "…Your reply is ready" / "wrote back" notice already sent for it. If nothing is left, and it isn't the 12pm-hour run, stop now and say only "Nothing new." (The 12pm-hour run always continues to STEP 4.)

STEP 1, get the code (only if step 0 found something). Artifact tool, action "read", the url above, path "research-code.json". Unpack it into ./outreach:
  node -e 'const fs=require("fs"),p=require("path");const {files}=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));for(const [r,t] of Object.entries(files)){const o=p.join("outreach",r);fs.mkdirSync(p.dirname(o),{recursive:true});fs.writeFileSync(o,t)}' <saved file>
  cd outreach && npm install --silent. Load ArtifactData with ToolSearch "select:ArtifactData" if needed. ArtifactData `get` meta/status and save its `settings` object to ./settings.json.

STEP 2, approvals (messages from {{FIRST}} in step 0's results):
  An approval is either (a) an email from {{FIRST}} whose subject is "Approve reply to <name> [CODE]", or (b) {{FIRST}}'s reply (subject starting "Re:") in a "…Your reply is ready" thread whose text says send / yes / approve / go (not "change", "wait", "no"). Ignore the "Your reply is ready" notice emails themselves.
  ArtifactData query collection "prospects", where status == "replied", out_dir ./desk; keep versions. Match (a) by reply_approve_code == CODE, (b) by reply_notice_thread_id == that thread's id. Only act if the doc still has reply_draft_id and no answered_at newer than replied_at.
  For each match: Gmail send_message {draftId: reply_draft_id}. Then ArtifactData update the doc (pinned) with answered_at now, reply_approved_at now, reply_draft_id null, reply_draft_url null, reply_draft null, my_replies = existing my_replies plus {at: now, body: <the old reply_draft>}, and a log line {at: now, what: "Sent your reply to <contact or email> (you approved it by email)"}. If crm_org_id is set: Connect AI crm_log_touchpoint {org, kind: "email", body: "{{FIRST}} answered <who> with times for a call:\n\n<reply text>"} and crm_update_org {org, stage: "talks", next_step: "Wait for <who> to pick a time", next_step_due: today + 3 days}. Finally reply in the approval thread with Gmail send_message (to {{SENDER_EMAIL}}, replyThreadId) body "Sent to <who>." If the draft no longer exists, mark answered_at now and say so in that one-line reply.

STEP 3, new replies from businesses (step 0 threads not from {{FIRST}}):
  ArtifactData query collection "prospects", where status in ["sent","followed_up","replied","not_interested"], limit 1000, out_dir ./rc; keep versions.
  node scripts/outreach-replies.js plan --docs ./rc/prospects --threads <file with step 0's threads array as JSON> --out ./rc-out --settings ./settings.json. Read ./rc-out/plan.json.
  Write plan.updates with one ArtifactData batch (op "update", collection "prospects", doc_id = id, file_path = file, if_version from the query). If a pin is stale, re-get that doc; if it already shows this reply (reply_notified_at set), drop it from the batch and from notify.
  For each plan.notify entry:
   - If the subject says "said no thanks": send that notify email (Gmail send_message with to, subject, body and htmlBody from the entry) and do its crm step. No draft, no text, no PDF.
   - Otherwise read the thread (Gmail get_thread, PLAIN_TEXT) and take their latest message's new text; save it to ./msg.txt.
     CALL BRIEF: node scripts/call-brief.js ./rc/prospects/<id>.json ./msg.txt ./brief.pdf ./settings.json --at <their message time, ISO> [--phone <their number, if they gave one>]. Then base64 -w0 ./brief.pdf and attach it (filename "<Business>-call-brief.pdf", mimeType application/pdf) to the notice email below, and to the text if TEXT_TO is set. It's about 5 KB; never attach anything bigger.
     If they gave a phone number and asked {{FIRST}} to call: don't draft a reply; send the plan's notify email (with the PDF) saying they asked for a call, with the number. Otherwise, if they're agreeing to talk or asking when: ArtifactData get collection "meta", doc_id "calendar", save its data to ./cal.json (if it doesn't exist, write {} there); run node scripts/meeting-reply.js ./rc/prospects/<id>.json ./cal.json ./settings.json.
     If it returns a body: Gmail create_draft {to: [their email], cc: [{{CC}}] (leave out if empty), subject: "Re: <original subject>", body, replyToMessageId: their latest message id}. Re-get the doc, set reply_draft = body, save the doc JSON with that field to ./doc.json and the message text to ./msg.txt and run node scripts/reply-notice.js ./doc.json ./msg.txt <draft id> <draft viewUrl> "" ./settings.json. Send its email with Gmail send_message {to, subject, body, htmlBody, attachments: [the PDF]}. ArtifactData update the doc (pinned) with reply_draft, reply_draft_id, reply_draft_url, reply_draft_slots = slot_text, reply_draft_at now, reply_approve_code = code, reply_notice_thread_id = the threadId Gmail returned for that notice.
     If meeting-reply returns skip, or they asked a question / said "not now" / referred someone: send the plan's notify email instead (body, htmlBody and the PDF), with one added sentence on why there's no ready reply.
   - TEXT: TEXT_TO = {{TEXT_TO}} (empty means skip this). For every reply that isn't a "no thanks", Gmail send_message to [TEXT_TO] (the carrier turns it into a text), subject "Outreach: <first name> wrote back", plain body only (no htmlBody), attachments: [the PDF], up to 6 short lines:
       <Full name> wants a call   (or "wrote back" / "has a question", whichever fits)
       <Business>, <town> (<what they do in a few words, and since when if known>)
       Said: "<their key sentence, under 120 characters>"
       Call: <their number>   (or "No number. Reply draft is in your Gmail.")
       Replied <time, Eastern, like 1:54pm>
     Plain words, no links, never the calendar's event names.
   - Do the entry's crm step if it has one: crm_log_touchpoint {org: crm.org, kind: "email", body: crm.body} and crm_update_org {org: crm.org, ...crm.update}. If they asked for a call, set next_step "Call <name> at <number>" due today.
  Never send anything to a business without {{FIRST}}'s approval (STEP 2). Drafts only.

STEP 4, only on the 12pm-hour run: Gmail search_threads "from:(mailer-daemon OR postmaster) newer_than:2d"; for each bounce naming the email of a doc in status "sent" or "followed_up", update that doc (pinned) with status "bounced", bounced_at, check_reason "Gmail said <address> doesn't exist or can't receive mail". On a weekday, if docs are in status "queued" and none has a sent_at from today, email [{{NOTIFY}}] once, subject "Outreach desk: today's emails didn't go out", saying how many are waiting and that the usual cause is the Claude usage limit.

Finish with one plain line: what you sent, drafted or found. Never print event names from the calendar.
