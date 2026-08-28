# Security Policy

Thanks for taking the time to look into the security of this project.

## Reporting a vulnerability

**Do not open a public GitHub issue for security bugs.** Public issues are
indexed by search engines and visible to anyone before a fix lands.

Instead, please report privately via:

- [GitHub Security Advisories](https://github.com/celsoproyect/agent_sinlimite_crm/security/advisories/new)
  (preferred — keeps the disclosure, fix, and CVE all in one place).

Include, if you can:

- A description of the issue and the impact.
- Reproduction steps or a proof-of-concept.
- The commit or release you're testing against.

## What to expect

- **Acknowledgement** within 72 hours.
- **Initial assessment** (severity, affected versions, whether a workaround
  exists) within one week.
- **Fix + coordinated disclosure** on a timeline proportional to severity.
  Critical issues ship a patch as soon as one's ready; medium issues bundle
  with the next release.

## Scope

In scope:
- Anything in this repository, including webhook and auth flows, token
  encryption, RLS policies, and the built-in cron endpoints.
- Default configurations shipped in `docs/` — e.g. if the setup guide leaves
  an unsafe default.

Out of scope:
- Vulnerabilities in Supabase, Next.js, Node.js, or other upstream
  dependencies — please report those to their maintainers.
- Issues that require a pre-compromised deployment (e.g. a leaked
  service-role key) unless they widen the blast radius beyond the initial
  compromise.
- Social engineering or physical attacks.

## Safe harbor

Research conducted under this policy is authorized. We won't pursue legal
action against anyone who:

- Makes a good-faith effort to avoid data destruction, privacy violations,
  or service disruption.
- Gives us reasonable time to respond before any public disclosure.
- Doesn't exploit the issue beyond what's necessary to demonstrate it.

Thanks for helping keep this project safe.
