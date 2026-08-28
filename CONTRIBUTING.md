# Contributing

This is a private repository for Sin Limite IA, not an open template.
Changes land as regular branches + PRs against `main`.

## Workflow

```bash
git clone git@github.com:celsoproyect/agent_sinlimite_crm.git
cd wacrm
cp .env.local.example .env.local   # fill in Supabase + Meta creds
npm install
npm run dev
```

Full setup (Supabase migrations, WhatsApp Business API, deploy) lives in
[`docs/`](./docs/README.md).

## Before opening a PR

- Branch off the latest `main`.
- Run `npm run typecheck` and `npm run format` locally.
- One logical change per PR; commit-message first line imperative and
  terse, body explains the *why*.

## Reporting security issues

**Do not file security issues publicly.** Follow the private flow in
[SECURITY.md](./.github/SECURITY.md).

## Dev-loop reference

| Command | What it does |
| --- | --- |
| `npm run dev` | Turbopack dev server on port 3000. |
| `npm run build` | Production build. Next also runs its own typecheck here. |
| `npm run typecheck` | `tsc --noEmit`. Fast TS-only pass. |
| `npm run lint` | ESLint. |
| `npm run format` | Prettier write. |
| `npm run format:check` | Prettier in check-only mode. Useful in CI. |

## Licensing

This project is built on an MIT-licensed template ([`LICENSE`](./LICENSE)).
