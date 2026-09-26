# First-run admin account

**There is no default password. `admin/admin` is never created.**

When ShadowPBX starts against an empty user table, it creates the first admin
account one of two ways:

## You set `ADMIN_PASSWORD` (recommended)

Put `ADMIN_PASSWORD=your-strong-password` (≥ 8 chars) in `.env` before the first
start. The admin account is created with that password and is ready to use.

## You didn't set it

A strong 24-character password is generated and printed **once** to the log at
first start:

```
============================================================
  FIRST-RUN ADMIN ACCOUNT CREATED
  username: admin
  password: <random-24-chars>
  This password is shown ONCE. Log in now and change it —
  you will be required to set a new one on first login.
============================================================
```

Find it with:

```bash
grep -A6 "FIRST-RUN ADMIN" /var/log/shadowpbx/$(ls -t /var/log/shadowpbx/ | head -1)
```

Log in with it, and you'll be **forced to set a new password** before you can
use the app (the account is flagged `mustChangePassword`). After that the temp
password is gone.

## Notes

- A too-short `ADMIN_PASSWORD` (< 8 chars) is ignored and a temp password is
  generated instead.
- The `.env` fallback login only works when `ADMIN_PASSWORD` is set — with it
  unset there is no env login path at all.
- Any account can be flagged `mustChangePassword` to force a change at next
  login; the change-password page is at `/change-password`.
- Once you've logged in and changed the password, remove `ADMIN_PASSWORD` from
  `.env` if you set it — it's only needed for bootstrap, and the app warns if
  the env-fallback login is used while real DB admins exist.
