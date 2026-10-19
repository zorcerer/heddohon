# Contributing to Heddohon

Bug reports, ideas and pull requests are welcome. This page covers how to send
each one so it can be acted on.

Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting a bug

Open an issue with the **Bug report** form. It asks for:

- the Heddohon version, shown at the foot of Settings and on the sign-in page;
- the music server and its version (Navidrome, another Subsonic server, or
  Jellyfin);
- the browser and device, and how Heddohon is installed (Docker, Unraid, or
  Node);
- what you did, what happened and what you expected.

Server logs help with anything that fails on the server side. Set
`HEDDOHON_LOG_LEVEL=debug`, reproduce the problem, and include the lines around
it. Remove hostnames and usernames you do not want public; the log never
contains passwords or session tokens.

**Security problems do not go in issues.** Report them privately through the
**Report a vulnerability** button on the Security tab. [SECURITY.md](SECURITY.md)
has the details.

## Suggesting a feature

Open an issue with the **Feature request** form. Describe what you are trying
to do and where the current behaviour gets in the way, rather than only the
change you have in mind. Heddohon plays what a Navidrome, Subsonic or Jellyfin
server holds; features that need the music server to store something new
depend on that server's API supporting it.

## Pull requests

**Start with an issue for anything beyond a small fix.** A typo, a broken link
or a clear bug with an obvious fix can go straight to a pull request. For a new
feature, a behaviour change or a larger refactor, open an issue first, so the
approach is agreed before you spend time on it.

Pull requests go against the `dev` branch of
[zorcerer/heddohon](https://github.com/zorcerer/heddohon), where development
happens; `main` holds the released code. An accepted pull request is merged
into `dev`, is in the next day's `:dev` image once its checks pass, and ships
in the next release, whose notes credit you.

### Setting up

Node 22 or later.

```bash
git clone -b dev https://github.com/zorcerer/heddohon.git && cd heddohon
npm ci
npm run dev:mock
```

`npm run dev:mock` starts the app in development against the mock Navidrome
and Jellyfin the test suites use, so no music server is needed. Sign in to
"Mock Navidrome" as `testuser` / `testpass` (an administrator) or to "Mock
Jellyfin" as `jfuser` / `jfpass`. Every track plays 30 seconds of silence, and
the mocks answer what the suites expect, so some pages show less than a real
server would. `npm run dev:mock -- --host` opens it on the local network.

Against a real music server instead:

```bash
export HEDDOHON_SECRET="$(openssl rand -base64 48)"
export HEDDOHON_SUBSONIC_URL=http://192.168.1.10:4533   # or HEDDOHON_JELLYFIN_URL
export HEDDOHON_DATA_DIR=./data
npm run dev
```

The server reads its settings from the environment; `.env.example` lists them
all, and the wiki's [Configuration](https://github.com/zorcerer/heddohon/wiki/Configuration) page describes each one.

### Before you open the pull request

A pull request runs `npm run check` in CI and nothing more. The three suites
run once it is merged into `dev`, and a failure there holds back the `:dev`
image for everyone, so run them yourself first:

```bash
npm run check          # type check; zero errors and zero warnings
npm run build
npm run test:e2e       # HTTP suite against mock music servers
npx playwright install chromium
npm run test:browser   # browser suite in Chromium
tests/e2e/run.sh       # curl suite; needs curl and jq
```

None of them needs a real music server: the suites start mock Navidrome and
Jellyfin servers of their own (`tests/e2e/mocks.mjs`). Run one suite at a
time: they share ports. A fix for a bug should come with a test that fails
without it, in whichever suite fits; a new feature with tests of what it does.

The desktop app in `electron/` and the Android app in `android/` have suites
of their own, which CI runs when those directories change. Their READMEs say
how to run them.

### How the code fits together

The browser talks only to Heddohon, and the Node server alone talks to the
music server. The wiki's [Architecture](https://github.com/zorcerer/heddohon/wiki/Architecture)
page follows a request through it. Where things are:

| Path | What it holds |
| --- | --- |
| `src/hooks.server.ts` | Every request first: the origin check, the session, the gate on private routes, the security headers |
| `src/lib/server/config.ts` | Every environment variable, parsed and checked once |
| `src/lib/server/backends/` | Navidrome and Subsonic (`subsonic.ts`) and Jellyfin (`jellyfin.ts`) behind one interface (`types.ts`) |
| `src/lib/server/` | The rest of the server: accounts and sessions (`auth.ts`), the database (`db.ts`), settings, history, caches, media proxying |
| `src/routes/` | Pages, each with its `+page.server.ts` loader, and the JSON API under `src/routes/api/` |
| `src/lib/client/` | State in the browser: the player (`player.svelte.ts`), the queue, favourites, the right-click menu |
| `src/lib/components/` | Svelte components; `src/lib/styles/` the themes |
| `tests/` | The three suites and their mock music servers |

### Rules the code relies on

The design depends on these. A change that breaks one is a security or a
behaviour decision, not a refactor: raise it in the issue first.

- **The music server's address and credentials stay in the server.** The
  browser is given a label for each server and never a URL or a password.
  Upstream addresses come from configuration alone, never from a request.
- **A stored credential is used within the request that opened it.** Work
  that goes on after a response (a background refresh, a timer) must not hold
  one.
- **Every write passes the origin check** in `hooks.server.ts`, with no path
  condition. Do not add exemptions.
- **Every route is private** unless listed in `PUBLIC_ROUTES` in
  `hooks.server.ts`. An API route checks `locals.session` first and answers
  401 without one.
- **Requests to the music server go through `backends/http.ts`**
  (`upstreamFetch`, `readJson`): a timeout, a size cap, and redirects only
  within the configured server. Proxied audio and covers keep their content
  type and sandbox headers (`proxy.ts`).
- **The page loads from its own origin only.** The Content-Security-Policy in
  `vite.config.ts` allows nothing else: no external scripts, fonts, images or
  `data:` URLs. Serve an asset from the app, or proxy it.
- **The music server decides what an account may see.** Calls use the
  account's own credential, and anything cached from the library is keyed by
  account.
- **Input is bounded.** An API route checks every field by type and size; a
  new bound goes in the **Input bounds** table in [SECURITY.md](SECURITY.md).

### What has to change together

- **A new environment variable:** `config.ts`; `.env.example`;
  `templates/heddohon.xml` (the Unraid template), or `LEFT_OUT` in
  `tests/e2e/template.test.mjs` with the reason it is not there; and a line in
  the pull request for the wiki's Configuration page.
- **A feature that sends anything to a third party:** off by default, and
  listed in `FEATURES` in `src/lib/server/features.ts`, which puts its switch
  under Settings, Features and in the first-run setup; a section in
  SECURITY.md saying what is sent where.
- **A database change:** prefer a new table to a new column. A new column on
  an existing table goes in `ADDED_COLUMNS` in `db.ts`, or existing installs
  never get it; a new table is added to `COPIED_TABLES` there, or the reason
  it is left out of a backup is written beside it.
- **A cache:** keyed by account, bounded in size, with a lifetime and what
  clears it.
- **A call to the music server:** a method on `MediaBackend` in
  `backends/types.ts`, implemented for both servers; where one server has no
  such thing, say so in the method's comment and return an empty result.
- **A new page:** its path in `PAGE_PATHS` in `src/routes/+layout.svelte` and
  in the page lists of `tests/browser/browser.test.mjs`.
- **A new log event:** named in kebab case, and listed in the pull request
  for the wiki's Configuration page.
- **The interface:** looked at in all four themes (Terminal, the default;
  Liquid; Paper; Phosphor), at a phone's width and a desktop's.

### Conventions

- **One change per pull request**, with a description of what it changes for
  someone using Heddohon and how you checked it.
- **Formatting:** tabs, single quotes, TypeScript strict. `.editorconfig` sets
  the basics for your editor. No formatter is run over the tree: format only
  the lines you change, and do not run prettier over a file, which rewrites it
  to spaces and double quotes.
- **Match the surrounding code** for naming, comment density and idiom.
  Comments say why something is the way it is, particularly where the obvious
  approach was tried and did not work, and keep the measured values when a
  decision was made from a measurement.
- **Commit titles** follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat: …`, `fix(player): …`, `docs: …`, `test: …`, `ci: …`. They are the
  release notes: a merge into `main` releases a new version when a title since
  the last release is `feat` (a minor release), `fix` or `perf` (a patch), or
  carries `!` (a major one), and lists each title under its kind.
- **Documentation and commit messages** state behaviour and specific values:
  "10 failures per username in 15 minutes" rather than "aggressive rate
  limiting". They do not use em dashes.
- **Interface changes** follow the [design notes](https://github.com/zorcerer/heddohon/wiki/Design-notes). In particular,
  the panels are glass, and animating opacity, filters or masks on an element
  that contains glass makes its blur drop out; the design notes explain what to
  animate instead. Include a screenshot or a short recording.
- **New dependencies** need a reason in the pull request. The server keeps the
  music server's credentials, so every package it loads is part of what has to
  be trusted.

## License

Heddohon is [MIT licensed](LICENSE). By opening a pull request you agree that
your contribution is licensed the same way.
