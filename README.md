# API Foundation

The API is intentionally split into modules. Each future module should keep its routes, schemas, service/use-case layer, repository boundary, and tests together.

Planned cross-cutting layers:

- `config`: validated environment and runtime configuration.
- `middleware`: security headers, request identity, authentication, authorization, validation, rate limits, and error mapping.
- `modules`: domain-oriented feature boundaries.
- `database`: PostgreSQL client, migrations, transaction helpers, and repositories.
- `audit`: append-only security and financial audit event writer.
- `observability`: structured logs, metrics, tracing, and health checks.
