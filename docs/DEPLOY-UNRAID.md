# Deploying on Unraid behind Nginx Proxy Manager

This runs a published container image of the fork on an Unraid host, reached
through Nginx Proxy Manager (NPM) at `https://godseye.pluginsynthesis.com`. The
example addresses are the ones this fork was set up with: Unraid at
`192.168.1.77`, NPM at `192.168.1.12`. Substitute your own.

```
browser --HTTPS--> NPM (SSL + Access List) --HTTP--> Unraid :3650 --> container :4173
```

## What runs, and why

The image (`deploy/Dockerfile`) contains the **built** application and serves it
with `vite preview`, not the development server.

- Every API provider mounts in the preview server's hook as well as the dev
  server's, so all data layers, the Host allowlist, the CSP headers and the
  rate limiters behave the same. `src/tooling/previewServing.test.mjs` runs both.
- Preview leaves out only development surfaces: Provider Settings
  (`/api/setup/*`, answered `404`), HMR, and the loopback-only `/mcp`. Keys are
  therefore set by editing a file (step 4), not in the browser.
- There is **no websocket** between the browser and the server (AIS and Gemini
  sockets are opened by the server toward their providers), so NPM's
  "Websockets Support" is not needed. Leaving it on is harmless.
- It is fast to start (nothing is transformed on demand) and small to run.

One trade-off: the three browser-side keys (`GOOGLE_MAPS_API_KEY`,
`CESIUM_ION_TOKEN`, `MAPILLARY_CLIENT_TOKEN`) are compiled into the bundle at
build time, so they cannot be supplied to the published image. The globe starts
on keyless Esri World Imagery; Google Photorealistic 3D, Cesium ion terrain and
Mapillary street imagery stay off. To use them, build a private image yourself
(see [Browser keys](#browser-keys-need-a-private-build)).

## Security model: read this before exposing it

**The server is a key broker.** Anyone who can reach it can use every server-side
key you configure (OpenSky, FIRMS, AISStream, TomTom, OpenAI, Gemini) and spend
its quota. Two things keep that contained here.

### Trap: never trust the proxy's address for key setup

Behind NPM, every public request reaches the container from **NPM's own
address** (`192.168.1.12`). The server decides whether a caller may use Provider
Settings by its socket address, and `GEV_KEY_SETUP_TRUSTED_PEERS` lets an
operator name addresses that count as "this machine". If NPM's address were ever
listed, **every visitor from the internet would arrive as that trusted peer** and
could read which keys exist and overwrite them.

So the production image trusts **no** peer:

- `deploy/Dockerfile` sets `GEV_KEY_SETUP_TRUSTED_PEERS=none`.
- `scripts/docker-prod-start.mjs` forces it empty at start, **ignoring any value
  you supply** (it logs that it did so), and never serves Provider Settings.
- The Unraid template has no such variable, and must not gain one.

Configure keys by editing `/mnt/user/appdata/gods-eye-view/.env` (step 4). Do
not set `GEV_KEY_SETUP_TRUSTED_PEERS` to NPM's address in any form.

### The gate is NPM's Access List

The app has no login of its own. Put an **Access List** (basic auth) on the NPM
proxy host (step 6). Keep these in mind:

- **Port `3650` bypasses the Access List.** Anyone on your LAN who opens
  `http://192.168.1.77:3650` skips NPM entirely (an IP address is always an
  accepted Host). Do not forward the port from your router, and if the LAN is not
  trusted, firewall `3650` to NPM's address only.
- **Rate limits are per peer address**, and behind NPM that is one address for
  everybody. The cost endpoints (`GEV_RATELIMIT_OPENAI_PER_MIN`,
  `GEV_RATELIMIT_GOOGLE_PER_MIN`) therefore share one bucket across all users.
  This is correct for one person; raise the values if several people share it.
  `X-Forwarded-For` is deliberately not trusted.
- Voice features (OpenAI, Gemini) are **metered**. Leave those keys unset unless
  you want them, and set a budget at the provider.
- The container runs as `99:100`, drops all capabilities and cannot gain
  privileges (see the template's Extra Parameters).

## 1. Enable Actions on the fork (manual, one time)

Forks start with GitHub Actions disabled. On GitHub open
`straplocked/gods-eye-view` → **Actions** → enable workflows. Then
**Actions → Publish image → Run workflow** once, or push to `main`.

`.github/workflows/publish.yml` builds `deploy/Dockerfile` for `linux/amd64` and
pushes `ghcr.io/straplocked/gods-eye-view` tagged `latest` and `sha-<short>`,
authenticating with the built-in `GITHUB_TOKEN` (no secret to create).

## 2. Make the package pullable

New GHCR packages are **private**. Either:

- **Public (simplest, nothing secret is in the image):** GitHub → your profile →
  **Packages** → `gods-eye-view` → **Package settings** → **Change visibility** →
  Public. Also check **Manage Actions access** lists the fork with Write.
- **Private:** create a personal access token with only `read:packages`, then on
  the Unraid terminal run `docker login ghcr.io -u straplocked` and paste it at
  the prompt (never put it in a template or a compose file).

## 3. Add the container in Unraid

1. Prepare the appdata folder, owned by the container user (`99:100` is Unraid's
   `nobody:users`):

   ```bash
   mkdir -p /mnt/user/appdata/gods-eye-view
   chown 99:100 /mnt/user/appdata/gods-eye-view
   ```

2. **Docker** tab → **Add Container**. Either pick the template from the
   *Template* list if you have copied `deploy/unraid/gods-eye-view.xml` to
   `/boot/config/plugins/dockerMan/templates-user/`, or fill the form by hand
   with the same values:

   | Field | Value |
   | --- | --- |
   | Repository | `ghcr.io/straplocked/gods-eye-view:latest` |
   | Network Type | `bridge` |
   | Port | host `3650` → container `4173` (TCP) |
   | Path | container `/data` → host `/mnt/user/appdata/gods-eye-view` (read/write) |
   | Variable `GEV_ALLOWED_HOSTS` | `godseye.pluginsynthesis.com` |
   | Extra Parameters | `--user 99:100 --cap-drop=ALL --security-opt no-new-privileges:true` |

3. **Apply.** Check the log: it should print `Key setup trusts no peer`, say
   whether it found a `.env`, and end with `Ready on port 4173.`
4. Open `http://192.168.1.77:3650/` from the LAN to confirm it works before
   adding the proxy.

If a request is refused with `Blocked request. This host is not allowed.`, the
Host the browser used is not in `GEV_ALLOWED_HOSTS` (IP addresses and
`localhost` always pass; wildcard and leading-dot entries are ignored).

## 4. Put keys in the appdata `.env`

Everything works with no key at all (earthquakes, hazards, weather, volcanoes,
space weather, aviation weather, airspace, water, citizen sensors, internet
outages, news and the other keyless layers). Keys add:

| Variable | Free? | Unlocks |
| --- | --- | --- |
| `FIRMS_MAP_KEY` | free, [register](https://firms.modaps.eosdis.nasa.gov/api/map_key/) | NASA FIRMS live active fires |
| `OPENSKY_CLIENT_ID` + `OPENSKY_CLIENT_SECRET` | free account | More flight-polling credits (anonymous works without) |
| `AISSTREAM_API_KEY` | free, [aisstream.io](https://aisstream.io) | Live AIS vessels |
| `TOMTOM_API_KEY` | free tier | Real live traffic (keyless runs a simulation) |
| `GOOGLE_MAPS_SERVER_API_KEY` | metered | Server-side Places and the CCTV Street View fallback |
| `OPENAI_API_KEY` / `GEMINI_API_KEY` | metered | Voice control |

Create the file as root on Unraid, then fix its owner and mode (it must be
readable by `99:100`; the launcher refuses to start on a `.env` it cannot read):

```bash
cat > /mnt/user/appdata/gods-eye-view/.env <<'EOF'
FIRMS_MAP_KEY=your-key-here
EOF
chown 99:100 /mnt/user/appdata/gods-eye-view/.env
chmod 600 /mnt/user/appdata/gods-eye-view/.env
```

Restart the container to load it. `.env.example` in the repo lists every
variable. Variables set in the Unraid template take precedence over `.env`.
Never put a key in the template, a compose file or the image.

### Browser keys need a private build

`GOOGLE_MAPS_API_KEY`, `CESIUM_ION_TOKEN` and `MAPILLARY_CLIENT_TOKEN` are
compiled into the JavaScript the browser downloads, so a published image cannot
carry them. To use them, build your own image on a machine with Docker and keep
it private (do not push it to a public package). Your `.env` is passed as a
BuildKit secret, mounted for the build step only and never stored in a layer:

```bash
docker build -f deploy/Dockerfile --secret id=dotenv,src=.env -t gods-eye-view:private .
```

## 5. Everything the app stores lives in one folder

`/mnt/user/appdata/gods-eye-view` holds `.env`, `.gev-cache/` (downloaded
data, safe to delete) and `.gev-logs/`. Back that folder up and you have backed
up the deployment. The image itself holds no state.

## 6. Nginx Proxy Manager

1. **Access Lists → Add Access List**: name it, add a username and password under
   *Authorization*, save. Leave *Satisfy Any* off and *Pass Auth to Host* off.
2. **Hosts → Proxy Hosts → Add Proxy Host**:
   - Domain Names: `godseye.pluginsynthesis.com`
   - Scheme `http`, Forward Hostname/IP `192.168.1.77`, Forward Port `3650`
   - *Block Common Exploits* on. *Websockets Support* is not required (see above).
   - **Access List**: select the list from step 1. This is the gate.
   - **SSL** tab: request or select a certificate, then *Force SSL* and
     *HTTP/2 Support* on.
3. Make sure DNS for `godseye.pluginsynthesis.com` points at NPM.
4. Browse to `https://godseye.pluginsynthesis.com`. You should get the basic-auth
   prompt, then the globe. NPM forwards the original Host header, which is why
   `GEV_ALLOWED_HOSTS` names that domain.

## 7. Updating

Push to `main` → the **Publish image** workflow builds and pushes `:latest` →
in Unraid's **Docker** tab choose the container's **Force update** (or enable
*Check for updates*). Pin a specific build by setting the repository to
`ghcr.io/straplocked/gods-eye-view:sha-<short>`; roll back by using an earlier
tag.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Log: `Start refused: ... .env ... cannot read it` | The appdata `.env` is not readable by `99:100`. `chown 99:100` it. |
| Log: `/data is not writable` | `chown 99:100 /mnt/user/appdata/gods-eye-view`. Caches and logs will not persist until then. |
| `403 Blocked request. This host is not allowed.` | The Host is not in `GEV_ALLOWED_HOSTS`. |
| `/api/setup/status` returns `404` | Expected. Provider Settings is never served in this image; edit `.env`. |
| A layer says `KEY REQUIRED` | It needs an optional key from the table above, then a restart. |
| Layers answer `429` for several users | Per-address limits share NPM's one address; raise the `GEV_RATELIMIT_*` values. |
| `docker pull` says `denied` | The package is private. Make it public or `docker login ghcr.io` (step 2). |
