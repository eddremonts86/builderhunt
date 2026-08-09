# Host Maintenance — `conductor-01`

Patching, resizing and rebooting the single VPS that runs everything. Written 2026-08-07.

Everything in production lives on one machine: the app container, Coolify itself, Postgres,
Redis, and the cron entries in [`../runbook.md`](../runbook.md). There is no second host and no
load balancer, so every line below causes user-visible downtime unless it says otherwise.

Companion docs: [`external-services-register.md`](./external-services-register.md#1-accounts-that-already-exist)
(the account and the line item), [`deploy-runbook.md`](./deploy-runbook.md) (how code reaches the
host), [`../runbook.md`](../runbook.md) (the cron schedule and the backup chain),
[`database-restore.md`](./database-restore.md) (recovering the data).

---

## What the host is

| | |
| --- | --- |
| Name / ID | `conductor-01` / `129078065` |
| Type | `cax21` — 4 vCPU (ARM/Ampere), 8 GB RAM, 80 GB disk |
| OS | Ubuntu 24.04 LTS (standard support to April 2029) |
| Public IPv4 | `178.105.106.79` |
| Created | 2026-05-04 |
| Cost | €13.11/month |

The architecture is **ARM**, not x86. Nothing pins a platform anywhere — Coolify builds on this
same host, so images come out `arm64` by construction and the Dockerfile never had to say so.
The consequence only shows up when it breaks: a base image or a native dependency published for
`amd64` alone fails here, and it fails during the build rather than at runtime. It is also why an
image built on an x86 laptop cannot simply be pushed to this host.

### Current headroom

CPU over the seven days to 2026-08-07: **36.4 % average, 50.2 % peak** (Hetzner metrics API,
hourly samples). That is a machine doing steady work with room left, so a resize is not currently
justified by load. Revisit when the average sits above ~70 % or the peak reaches 100 % for
sustained periods.

Memory and disk usage are **not** in the Cloud API — checking them needs a shell on the box:

```bash
ssh root@178.105.106.79 'free -h; df -h /; docker system df'
```

---

## Patching the OS

24.04 is an LTS release, so this is security patches, never a distribution upgrade. There is
nothing to do about the release itself until 2029.

```bash
ssh root@178.105.106.79 'apt-get update && apt-get -y upgrade'
ssh root@178.105.106.79 'test -f /var/run/reboot-required && cat /var/run/reboot-required.pkgs'
```

A kernel or libc update sets `/var/run/reboot-required`. **Rebooting takes the whole product
down** — app, Coolify, database and every cron — for as long as the boot takes. Schedule it, do
not let it happen as a side effect of an upgrade you ran to be tidy:

```bash
ssh root@178.105.106.79 'systemctl reboot'
```

Nothing here restores itself selectively: Coolify brings its containers back on boot, so the
recovery path is "wait, then check `/api/health`", not a sequence of manual starts.

> **Unverified:** whether `unattended-upgrades` is installed and what it is allowed to do. If it
> is enabled with automatic reboots, the host can restart itself in the middle of the day. Worth
> confirming with `systemctl status unattended-upgrades` and
> `cat /etc/apt/apt.conf.d/50unattended-upgrades` before assuming either way.

---

## Resizing

The ARM line, with the Frankfurt monthly gross price as of 2026-08-07:

| Type | vCPU | RAM | Disk | €/mo |
| --- | --- | --- | --- | --- |
| `cax11` | 2 | 4 GB | 40 GB | 7.49 |
| **`cax21`** | **4** | **8 GB** | **80 GB** | **13.11** ← current |
| `cax31` | 8 | 16 GB | 160 GB | 26.24 |
| `cax41` | 16 | 32 GB | 320 GB | 51.24 |

Two things decide how this goes, and one of them is irreversible:

1. **The server must be powered off.** Not a reboot — a stop, the type change, then a start.
2. **Disk growth is one-way.** `--keep-disk` changes CPU and RAM only and can be undone later.
   Without it the disk grows to the new type's size and the server can **never** be moved back
   to a smaller type. Use `--keep-disk` unless disk is the actual reason for the resize.

```bash
hcloud server poweroff conductor-01
hcloud server change-type conductor-01 cax31 --keep-disk
hcloud server poweron conductor-01
```

Then confirm the product actually came back, rather than assuming the API's success means the
app is serving:

```bash
curl -fsS https://builderhunt.dev/api/health
```

---

## What survives losing this machine

The distinction matters and is easy to get backwards.

**The data is backed up off-box.** [`../runbook.md`](../runbook.md) documents the chain: Coolify
dumps `builderhunt-db` at 03:00, `builderhunt-backup-sync.sh` rsyncs it to the Hetzner Storage
Box at 03:30, and the Storage Box snapshots at 05:00. A restore from that copy was performed and
recorded, so it is a tested path and not a hope.

**The host itself is not imaged.** Hetzner Cloud automatic backups (server snapshots) are
**disabled** on `conductor-01`. Losing the machine therefore means rebuilding it — provision,
install Coolify, restore the database, re-enter the environment variables — rather than rolling
back to an image.

That is a defensible trade while the app is reproducible from git and Coolify holds the
configuration. It stops being defensible once something exists on the box that is not in version
control. Enabling snapshots costs 20 % of the server price (≈€2.62/month at the current type):

```bash
hcloud server enable-backup conductor-01
```

The thing to check before deciding is what is on the host that no repository knows about. At
least one such item is already recorded: `../runbook.md` notes that
`/usr/local/bin/builderhunt-backup-sync.sh` on the host is an **older** version than the copy in
`scripts/ops/`.

---

## Hardening SSH

**State as of 2026-08-09, measured from outside the host:** the server advertises
`publickey,password` for `root`, on `OpenSSH_9.6p1 Ubuntu-3ubuntu13.18` (current for 24.04). So
password authentication is live on an account this document tells people to log in as, on an IP that
`builderhunt.eduardoinerarte.dk` resolves to publicly. Making the repository public does not leak
that address — DNS already does — but it does raise how many people look.

Two changes close it. **Do them in this order, and keep a second SSH session open the whole time**:
a mistake in `sshd_config` is only recoverable through the Hetzner console once you have been
disconnected.

```bash
# 1. Prove a key works BEFORE removing the password route.
ssh -i ~/.ssh/<your-key> root@178.105.106.79 'echo ok'

# 2. Find every file that sets these. This is the step people skip.
sudo grep -rnE 'PasswordAuthentication|PermitRootLogin' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/
```

Ubuntu 24.04 ships `/etc/ssh/sshd_config.d/50-cloud-init.conf`, and **a file in that directory wins
over `sshd_config`** — cloud images routinely set `PasswordAuthentication yes` there. Editing only
the main file is the classic way to believe you have hardened a host that is exactly as open as it
was. Set the values wherever the grep found them:

```bash
PasswordAuthentication no
PermitRootLogin prohibit-password   # keys still work; passwords never do
```

```bash
# 3. Validate the syntax, then reload. Never reload without the check.
sudo sshd -t && sudo systemctl reload ssh

# 4. From a different terminal, confirm the password route is gone:
ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no root@178.105.106.79
# expected: "Permission denied (publickey)" — note the list no longer contains `password`
```

Then rate-limit what is left:

```bash
sudo apt-get install -y fail2ban && sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd
```

`HETZNER_PASSWORD` in `ai-os/dev-env/env-config/.env` stops being an SSH credential once this is
done. It remains the Hetzner *console* password, which is the recovery route if a key is ever lost —
so it should stay in the file, and stay correct.


## Access

The root password and the API token live in `ai-os/dev-env/env-config/.env` (`HETZNER_PASSWORD`,
`HETZNER_API_TOKEN`). If SSH refuses the key, the two recovery routes are Coolify's own stored
key via its API, or a password reset through the Cloud API:

```bash
hcloud server reset-password conductor-01
```

A reset invalidates the value currently in the env file — update it there in the same sitting,
or the next person to look will trust a password that no longer works.

> **Known broken as of 2026-08-07:** `COOLIFY_API_TOKEN` in that same file returns **401**, and
> `COOLIFY_API_URL` is `http://178.105.106.79:8000` — the web UI, missing the `/api/v1` suffix the
> API actually needs. Both need fixing before any script that reads them can be trusted; today
> they fail in a way that looks like the server is down.
