# API and WebSocket contract

All REST requests accept `Authorization: Bearer <demo email>`. Responses are JSON. A request to an entity outside the caller's tenant returns `403` or `404` without revealing its contents.

## Optimistic concurrency

`PATCH /api/tasks/:id` requires `If-Match` (or `version` in the JSON body). The server atomically updates only when the supplied version matches. A stale update returns:

```json
{ "error": { "message": "Conflict: task has changed", "current": {} } }
```

## WebSocket

Connect to `/ws?tenant_id=<id>`. The server validates membership before completing the upgrade. Events:

- `connected`: connection acknowledged.
- `task.updated`: the tenant's board should be refreshed.
- `presence`: `{ user, state: "online"|"offline" }`.

Clients send `{ "type": "presence", "state": "online" }` after connecting.
