# P1 fixes — feature codes, overnight schedules, path traversal

## 1. Monitor feature codes were unreachable

`*11{ext}` (listen), `*12{ext}` (whisper) and `*13{ext}` (barge) never worked.
`_extractExtFromUri()` only accepted a numeric SIP userpart, so `sip:*112001@…`
parsed to `null`, and the `if (!toExt) return 404` guard rejected the INVITE
several lines before the monitor check — which was therefore dead code.

Fixed by classifying feature codes in the parser (`_isFeatureCode()`) and
dispatching them **before** the numeric-extension validation, after the caller
is confirmed to be a registered extension. Numeric extensions, external SIP
users and unknown `*`-codes are unaffected.

## 2. Overnight time conditions matched the wrong day

An overnight window such as **Mon 22:00 → 06:00** was evaluated against a single
`dayOfWeek` entry. At Tue 02:00 the Monday entry was skipped (Tuesday not in its
days) while the Tuesday entry's overnight branch wrongly matched the morning
half — so early Tuesday followed Tuesday's rule, not Monday's. And Mon 02:00
incorrectly matched Monday's own overnight rule, though that time belongs to
Sunday night.

Fixed by treating an overnight window as two intervals owned by different
calendar days:

- evening `[start, 24:00)` → the entry's own day (today)
- morning `[00:00, end)` → the **previous** day's entry

`start == end` is treated as an all-day match. Verified across same-day,
overnight, Friday-into-Saturday and all-day cases.

## 3. Path traversal in file APIs

Audio play/rename/delete, backup download/delete, and the appointment audio
webhook built filesystem paths from request input with either no check or a
bypassable `name.replace(/\.\./g, '')` (which `....//` defeats). A crafted name
could read or delete files outside the intended directory — and with the API
now properly authenticated, this was the remaining way to reach the filesystem.

Fixed centrally: `src/utils/safe-path.js` resolves the full path and requires it
to equal the base directory or sit beneath it, rejecting absolute paths, NUL
bytes and any escape with a 400. Every HTTP-derived path now goes through
`safeResolve(baseDir, name)`:

- `src/routes/api.js` — audio play, rename (both old and new names), delete
- `src/app.js` — audio play
- `src/routes/settings-api.js` — backup download, delete
- `src/services/appointment-handler.js` — Twilio audio webhook

Use `safeResolve` for any future path built from a request.
