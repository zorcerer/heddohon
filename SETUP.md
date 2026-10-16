# Setting up Heddohon

What you need: Docker (or Node 22 or later), and a Navidrome, Subsonic or
Jellyfin server that Heddohon can reach. Every setting is described in
[Configuration](https://github.com/zorcerer/heddohon/wiki/Configuration); this
page is the order to do things in.

## 1. Start it

```bash
git clone https://github.com/zorcerer/heddohon.git && cd heddohon
docker compose up -d
docker compose logs heddohon
```

On Unraid, install it from Community Applications instead. Only the port and
the appdata path are required.

## 2. The setup page

The log shows a setup code. Open `http://<server>:3000` and enter it. The page
asks for:

- the address of your music server (as Heddohon reaches it, so a LAN address is
  fine) and a name for it;
- the address Heddohon is opened at, filled in from your browser;
- the database: SQLite in the data directory, or a PostgreSQL server, with a
  button that tests the connection;
- the size of the cover cache, the default theme, and three switches.

It makes the secret and saves everything in `setup.json` in the data directory.
Sign in with your account on the music server.

**Then move the secret out of the data directory.** The last step shows it once
with the line to set it as `HEDDOHON_SECRET`. Set that in the environment,
remove it from `setup.json` from the same step, and restart. While it sits in
the data directory, anyone with a copy of that directory can read the stored
credentials.

To skip the setup page and configure everything by environment variables:

```bash
cp .env.example .env
echo "HEDDOHON_SECRET=$(openssl rand -base64 48)" >> .env
echo "HEDDOHON_SUBSONIC_URL=http://10.0.0.10:4533" >> .env
docker compose up -d
```

## 3. Putting it on the internet

Skip this if it stays on your own network.

1. **Run it behind a reverse proxy with TLS** (Caddy, Traefik, nginx), and
   publish the port on loopback only (`127.0.0.1:3000:3000`). Docker's port
   rules go around host firewalls such as ufw.
2. **Save the public address.** Add it under Settings, Storage, This server, or
   set `ORIGIN=https://music.example.com`. Without either, Heddohon takes the
   `Host` the proxy passes on and assumes https; anything else has its writes
   refused, sign-in included.
3. **Tell Heddohon where the visitor's address is.** Set `ADDRESS_HEADER` to a
   header your proxy sets itself: `X-Real-IP` from nginx, or `X-Forwarded-For`
   with `XFF_DEPTH` set to the number of proxies in front. Without it, every
   visitor has the proxy's address, and the sign-in and listen-together limits
   can't tell them apart. Set it only if every request comes through the proxy:
   a request without the header is answered with an error.
4. **Let Heddohon's own security headers through.** A proxy that sets its own
   `Content-Security-Policy`, `Referrer-Policy` or similar on every site
   replaces Heddohon's, which are stricter. Leave those off for Heddohon.
5. **Keep the music server private.** Only Heddohon needs to reach it.

## 4. Keep these private

- **The data directory**: sealed credentials, session digests and the history.
  With PostgreSQL, the database and its backups too.
- **Backups made from Settings**: they hold every account's history and sealed
  credentials, and restore only with the `HEDDOHON_SECRET` they were made
  under. Keep the secret somewhere else.

## 5. Optional

These are off until you turn them on. Each is in
[Configuration](https://github.com/zorcerer/heddohon/wiki/Configuration):

- AI assistants over MCP: an administrator under Settings, AI, or `HEDDOHON_MCP`.
- The plugin for Navidrome: `HEDDOHON_NAVIDROME_PLUGIN_TOKEN`, from `openssl rand -hex 32`.
- Lyrics from LRCLIB, AutoEq headphone corrections, Discord and ListenBrainz.

## Updating

Pull the image and recreate the container: `docker compose pull && docker compose up -d`.
`latest` is the newest release. `dev` is built from the development branch, can
break, and may migrate the database so that the release before it no longer
opens it.

The full list of what to check, with the reasons, is the
[operator checklist](SECURITY.md#operator-checklist) in SECURITY.md.
