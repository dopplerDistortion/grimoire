# Security policy

## Reporting a vulnerability

Please report security problems privately, through GitHub's
[private vulnerability reporting](https://github.com/dopplerDistortion/grimoire/security/advisories/new)
(the repo's **Security** tab, then **Report a vulnerability**). Don't open a public issue for them.

Include the grimoire version (`grimoire --version`), your OS and Node version, and the steps that show the problem. You'll get a reply within a week.

## Supported versions

Only the latest release of `@goksening/grimoire` gets security fixes. A fix ships as a patch release, and the release it supersedes is deprecated with a pointer to it.

## Scope

grimoire runs locally: the MCP server talks over stdio, the dashboard listens only on 127.0.0.1, behind a Host allowlist and a browser sign-in, and issue state syncs only through git. Of most interest are anything that lets another local user or a web page reach the dashboard or the control channel, a secret that survives redaction into a committed trace excerpt, and a write that escapes the repo it was started in.
