# Extension settings & web access

Each extension row on **Extensions** now has a gear button (admin only) that
opens a settings panel to:

- set the **agent name**
- set the **SIP password** manually (or generate one)
- toggle **web access** — a login the agent uses to sign into the web UI

A **web** badge on the row shows when an extension has a login attached.

## How web access works

Enabling web access creates an **agent** User account:

- **username** = the extension number
- **password** = a **separate web password** you set or generate (min 8 chars)
- **role** = agent, linked to this extension

The web password is **independent of the SIP password.** Changing or
regenerating the SIP password does not affect the web login, and vice versa. To
change the web password, use **Reset password** in the same panel.

> **Why separate.** The SIP password is stored in plaintext (required for digest
> auth); the web password is bcrypt-hashed. Keeping them independent means a
> database leak of the SIP password does not also hand over the web-UI login.
> Only the display **name** is kept in sync between the two.

## Already-attached extensions

If an extension is already linked to a login that this panel didn't create — an
admin or supervisor whose account points at it, or a manually-made user — the
panel will **not** touch it. It shows who it's attached to and directs you to
**Settings → Users** to detach it first. This prevents a privileged account
being silently overwritten or deleted.

## Users page

When adding a user in **Settings → Users**, the *Linked extension* dropdown now
lists only extensions **not already attached** to a login, so linked agents
don't appear twice. When editing a user, their own current extension stays in
the list so you can keep it.

## Endpoints (admin only)

| Endpoint | Purpose |
|---|---|
| `GET /api/extensions/:ext/web-access` | attachment status for one extension |
| `POST /api/extensions/:ext/web-access` | enable, or reset the web password (body: `{ password }`, min 8) |
| `DELETE /api/extensions/:ext/web-access` | disable (remove the agent login) |
| `GET /api/extensions-available` | extensions with no login yet (for the dropdown) |

Attach/detach refuse to act on a privileged or externally-managed account and
return a 409 with the linked username.


## Extension–user integrity rules (v3.0)

The link between an extension and a login is now enforced on the server, not
just in the dropdown:

- **A user's linked extension must exist.** An invalid extension is rejected.
- **An extension can belong to at most one login.** Assigning one that another
  user already has is rejected with that user's name.
- **An agent's extension is fixed.** It is the identity of the login created for
  that extension, so it can't be reassigned from Settings → Users — only the
  password (reset) and enabled/disabled state may change there. Manage the
  agent from the Extensions page.
- The Users page reflects this: the extension field is locked (and the role
  frozen) when editing an agent, and the dropdown lists only unattached
  extensions.

### Cleaning up existing bad links

Validation prevents new double-assignments but does not undo ones made before
this fix. If an admin/supervisor account is wrongly linked to an extension that
also has its own agent login, edit that admin/supervisor in Settings → Users and
clear its *Linked extension* (set it to "— none —"). Admin and supervisor
accounts generally should not have a linked extension unless that person also
takes calls on it.
