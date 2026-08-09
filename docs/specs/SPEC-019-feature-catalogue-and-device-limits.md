# SPEC-019 — Feature catalogue and device limits

> Extends SPEC-017. Two changes: features become data you manage instead of a hard-coded pair, and a
> plan gains a device allowance — the other half of the quota hole.

## Why

**Features are hard-coded.** `auto-reject` and `po-analytics` are a fixed vocabulary in the portal
UI and nowhere else. Selling anything new means a code change to a list, which is the wrong place for
a commercial decision to live.

**Devices are unlimited.** SPEC-017 moved the client quota onto the person, but nothing caps how many
browsers a person registers. That is how the live four-device account happened: each registration
minted its own record with its own allowance. Capping clients without capping devices leaves the door
it came through wide open.

## Feature catalogue

```sql
CREATE TABLE IF NOT EXISTS features (
  id          TEXT PRIMARY KEY,     -- slug, e.g. 'auto-reject'
  name        TEXT,                 -- shown in the portal
  description TEXT,                 -- what the customer gets
  active      INTEGER DEFAULT 1,    -- inactive: keeps working where granted, cannot be newly granted
  created_at  TEXT
);
```

Seeded idempotently in `ensureSchema()`:

| id | name |
|---|---|
| `auto-reject` | Auto rejection — the Rejection tab and its scan/submit flow |
| `po-analytics` | PO reconciliation — the purchase-order matching card |

```
GET  /api/features                          → { features:[…] }
POST /api/feature { id, name, description, active }   upsert (id is immutable once created)
POST /api/feature/delete { id }             refused while any plan or user grants it, naming counts
```

**Validation.** `setFeatures` on a plan or a user accepts only ids present and `active` in the
catalogue. A typo currently produces a feature nobody will ever hold and no error — the whole point
of a catalogue is that it can say no.

**Grandfathering.** Deactivating a feature does NOT revoke it where already granted. It only stops
new grants. Revoking mid-quarter is a support call, not a config change.

### The honest limit

A catalogue row does not gate anything by itself. `auto-reject` gates the Rejection tab because
`src/ui/flow.js` asks for it by name. A NEW feature is a sellable label until someone wires the one
line in the drawer that checks it. The portal must say so where features are created, or the first
new feature will be sold and appear to do nothing.

## Device allowance

`plans` gains `device_quota INTEGER DEFAULT 1`; `users` gains `device_quota INTEGER` (per-account
override, NULL = inherit the plan). Defaults:

| plan | clients | devices |
|---|---|---|
| `free` | 1 | 1 |
| `standard` | 5 | 3 |
| `pro` | 25 | 10 |

**Enforced in `/register`, and only there.** A returning device (a `deviceId` already on record) is
never a new device and must never be refused — losing your own registration because you cleared a
cache would be worse than the hole.

Refusal is its own reason so the drawer can explain it:

```
{ ok:false, error:'device limit reached', reason:'device_limit',
  held:<n>, allowed:<n> }
```

**Grandfathered**, exactly as clients are: a user already over the cap keeps every device and simply
cannot add another. Nothing is ever unregistered automatically.

Effective allowance is `MAX(user.device_quota, plan.device_quota)` — same rule as the client quota,
so assigning a bigger plan is never a downgrade by accident.

## Custom accounts

Some accounts are negotiated, not chosen from a menu. `plan = 'custom'` detaches an account from the
plan table entirely: its client allowance, device allowance and feature set are whatever is written
on the account, and no edit to `pro` ever touches it.

- `users.plan = 'custom'` is a reserved id — `POST /api/plan` refuses to create a plan called
  `custom`, or the two meanings would collide.
- On a custom account the overrides are the ONLY source: `quota`, `device_quota` and `features` are
  read as-is, and the `MAX(user, plan)` rule does not apply — there is no plan to compare against.
  Applying MAX here would make it impossible to negotiate a cap *lower* than a standard plan, which
  is the main reason a custom account exists.
- Switching an account off `custom` back to a named plan restores inheritance, and the portal must
  warn that the negotiated numbers will be replaced by the plan's.

The portal shows, for every account, both what it gets and where that came from: `25 clients
(from pro)` versus `12 clients (custom)`. An admin must never have to guess which.

## Test cases

| ID | Case |
|---|---|
| T-176 | Catalogue seeds idempotently; a second `ensureSchema()` changes nothing |
| T-177 | `setFeatures` rejects an id absent from the catalogue |
| T-178 | `setFeatures` rejects an id present but inactive |
| T-179 | Deactivating a feature leaves existing grants working |
| T-180 | `POST /api/feature/delete` is refused while a plan grants it, naming the count |
| T-181 | `/register` refuses device N+1 with `reason:'device_limit'` and the two counts |
| T-182 | A returning deviceId is never refused, even when the user is over the cap |
| T-183 | A user already over the cap keeps every device (grandfathered) |
| T-184 | Effective device allowance is MAX(user override, plan) |
| T-186 | A custom account ignores plan edits entirely |
| T-187 | On a custom account the override is used verbatim, including a cap LOWER than any plan |
| T-188 | POST /api/plan refuses to create a plan whose id is `custom` |
| T-185 | The drawer surfaces `device_limit` as its own message, not a generic failure |
