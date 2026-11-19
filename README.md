# Paydown

A self-hosted web app for tracking credit cards, personal loans, auto loans and mortgages:
balances, APR and interest rates, purchases, payments split into interest and principal,
a running balance after every transaction, a calendar of payment due dates, and storage for
loan agreements and monthly statements (PDF).

Checking and savings accounts can be tracked alongside your debts: log deposits, purchases/withdrawals,
fees and interest earned, with a running balance after each entry. Savings accounts have an APY, used to
estimate monthly interest. Cash accounts are kept out of debt totals, APR averages and the due-date calendar.

Single-user, password-protected, no external dependencies. The backend is one Python file (standard library only)
and data is a single JSON file on the server.

## Install (Debian / Ubuntu, e.g. a Proxmox LXC)

As root inside the container:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/jacobnoori/paydown/main/install.sh)"
```

The installer:

- installs `python3`, `git` and `curl`
- creates a `paydown` system user
- clones the app to `/opt/paydown`
- creates the data directory `/var/lib/paydown`
- writes settings to `/etc/paydown.env`
- sets up and starts the `paydown` systemd service on port **8787**
- asks you to choose a login password

Then open `http://<container-ip>:8787`.

Re-running the installer is safe: it updates the code and service but never touches data or the password.

## Managing it

```sh
paydown status          # service status
paydown logs            # recent logs
paydown update          # pull the latest code from git and restart (data untouched)
paydown passwd          # change the password (signs out all devices)
paydown backup [FILE]   # data.json + uploaded PDFs as a .tar.gz
paydown restore FILE    # replace all data with a backup archive (keeps the password)
paydown restart
```

You can also change the password in the app (sidebar → Password).

## Where things live

| Path | What |
|---|---|
| `/opt/paydown` | app code (git checkout) |
| `/var/lib/paydown/data.json` | all accounts and transactions |
| `/var/lib/paydown/files/` | uploaded PDFs (agreements, statements) |
| `/var/lib/paydown/auth.json` | password hash and session key (mode 600) |
| `/etc/paydown.env` | `PAYDOWN_HOST`, `PAYDOWN_PORT`, `PAYDOWN_DATA_DIR` |

## Backups and moving

Paydown keeps no backup copies of its own: back up the container (e.g. nightly to Proxmox Backup Server, which can
also restore just `/var/lib/paydown/data.json` or a single PDF). Deleted PDFs are removed immediately.

To move to a new container, take a portable copy and restore it after installing there:

```sh
paydown backup /root/paydown.tar.gz     # on the old container
paydown restore /root/paydown.tar.gz    # on the new one, after install.sh
```

`restore` only accepts archives made by `paydown backup`, shows what it contains, and asks before replacing anything.
The new container keeps the password set during its install.

## Security notes

- Sign-in uses a password (PBKDF2-SHA256) and an HttpOnly, SameSite=Strict session cookie valid for 30 days.
  After 5 failed attempts in 10 minutes, sign-in is paused for that client.
- The app speaks plain HTTP. To use it outside your LAN, put it behind your reverse proxy with HTTPS
  (cookies are marked `Secure` when the proxy sends `X-Forwarded-Proto: https`), or reach it over a VPN.
  Don't expose port 8787 directly to the internet.
- Behind a reverse proxy, the lockout counts attempts by the client IP in `X-Forwarded-For`.
  When the app is reachable directly, a client can set that header to dodge the lockout,
  so another reason to keep 8787 LAN-only.
- Only the app's own UI files are served; the source, data and config are never served over HTTP.
- Health check: `GET /healthz` (no login required).

## Documents

Each account has a section for its agreement (loan agreement, mortgage note, or cardholder agreement) and
for monthly statements, each tagged with its statement month. You can also attach the agreement when adding
or editing an account. PDFs only, up to 25 MB each.

PDFs are stored only in the data directory on the server and are served only to signed-in users. They never go into
the git repository: the server refuses to use a data directory inside the app's git checkout (except the
git-ignored `./data` used for development), and `.gitignore` excludes PDFs and data files.

**Reverse proxy upload limit:** nginx-based proxies (including Nginx Proxy Manager) reject uploads over 1 MB by default.
Add `client_max_body_size 25m;` (in NPM: the proxy host's *Advanced* tab). Caddy and Traefik have no small default limit.

## Multiple devices

Open it from any browser. Open pages pick up changes from other devices within a few seconds. If two devices
save at nearly the same moment, the server rejects the out-of-date save and the app merges the two
versions entry by entry (newest edit wins, deletions included) before saving again.

## Development

```sh
python3 server.py passwd --data-dir ./data
python3 server.py --host 127.0.0.1 --data-dir ./data
```

`data/` is git-ignored.
