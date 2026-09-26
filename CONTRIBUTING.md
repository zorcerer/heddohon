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

Pull requests go against `main` on
[zorcerer/heddohon](https://github.com/zorcerer/heddohon). Heddohon is
developed in a separate repository, so an accepted pull request is merged here
and carried over by the maintainer; it ships in the next release, and the
release notes credit you.

### Setting up

Node 22 or later.

```bash
git clone https://github.com/zorcerer/heddohon.git && cd heddohon
npm ci
export HEDDOHON_SECRET="$(openssl rand -base64 48)"
export HEDDOHON_SUBSONIC_URL=http://192.168.1.10:4533   # or HEDDOHON_JELLYFIN_URL
export HEDDOHON_DATA_DIR=./data
npm run dev
```

The server reads its settings from the environment; `.env.example` lists them
all, and [docs/configuration.md](docs/configuration.md) describes each one.

### Before you open the pull request

These are the checks CI runs on every pull request. They need to pass:

```bash
npm run check          # type check; zero errors and zero warnings
npm run build
npm run test:e2e       # HTTP suite against mock music servers
npx playwright install chromium
npm run test:browser   # browser suite in Chromium
tests/e2e/run.sh       # curl suite; needs curl and jq
```

None of them needs a real music server: the suites start mock Navidrome and
Jellyfin servers of their own. A fix for a bug should come with a test that
fails without it, in whichever suite fits.

### Conventions

- **One change per pull request**, with a description of what it changes for
  someone using Heddohon and how you checked it.
- **Match the surrounding code** for naming, comment density and idiom.
  Comments say why something is the way it is, particularly where the obvious
  approach was tried and did not work, and keep the measured values when a
  decision was made from a measurement.
- **Documentation and commit messages** state behaviour and specific values:
  "10 failures per username in 15 minutes" rather than "aggressive rate
  limiting". They do not use em dashes.
- **Interface changes** follow [docs/design.md](docs/design.md). In particular,
  the panels are glass, and animating opacity, filters or masks on an element
  that contains glass makes its blur drop out; the design notes explain what to
  animate instead. Include a screenshot or a short recording.
- **New dependencies** need a reason in the pull request. The server keeps the
  music server's credentials, so every package it loads is part of what has to
  be trusted.

## License

Heddohon is [MIT licensed](LICENSE). By opening a pull request you agree that
your contribution is licensed the same way.
