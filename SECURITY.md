# Security policy

## Reporting a vulnerability

Please report security issues **privately**, never in a public issue or pull request:

- GitHub: [open a private security advisory](https://github.com/KevY007/provider-proxy/security/advisories/new), or
- contact the repository owners directly.

Include what you found, how to reproduce it (request ids from the `x-request-id` header help), and the impact you
expect. We acknowledge reports within 3 business days and keep you updated until a fix ships.

Do not access other customers' data, run load or denial-of-service tests against production, or use real upstream
provider credentials you do not own while investigating.

## Scope

The gateway (`/v1/*`, `/v1beta/*`, `/upload/*`), the customer dashboard, the admin console, billing and webhooks,
and the deployment configuration in this repository.

## Audit

The last full internal audit and its fixes are documented in [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md).
