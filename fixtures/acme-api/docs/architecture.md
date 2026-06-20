# Architecture

How a request flows through **acme-api** — and where the audit found issues.

```mermaid
flowchart LR
    Client[Client] -->|HTTP| Router[Router]
    Router --> Auth[Auth middleware]
    Auth --> Handler[Route handler]
    Handler --> Rate[Rate limiter]
    Handler --> DB[(SQLite)]
    Rate -. flagged .-> Pool[Connection pool]
    DB --- Pool
```

- **Auth middleware** runs before every handler.
- The **rate limiter** and **connection pool** are the two areas flagged in the current audit (see `notes.txt`).
