# EcoFlow AI — Hyderabad Smart Waste Operations

EcoFlow AI is a runnable Hyderabad smart-waste operations prototype built around a closed-loop local agent: **observe -> analyze -> predict -> plan -> execute -> verify -> audit**. It monitors realistic Hyderabad locality seed data, forecasts bin overflow, prioritizes urgent bins, assigns a vehicle, optimizes a route with nearest-neighbor selection, creates a collection task, notifies the operator, and records the result. Operational values are demo data; map tiles come from OpenStreetMap.

## Run locally

Requirements: Node.js 18+.

```powershell
npm.cmd install --prefix backend
npm.cmd install --prefix frontend
Copy-Item backend/.env.example backend/.env
npm.cmd run dev
```

Open `http://localhost:5173`. The API runs at `http://localhost:4000`.

Demo accounts are configured for the supplied admin, operator, and viewer users. State-changing endpoints require a signed bearer token; admin actions include AI optimization, while operators can update bins and collection tasks.

For a production client build:

```powershell
npm.cmd run build
```

## Demo flow

1. Open Overview and inspect live Hyderabad bins, fleet state, metrics, charts, and the operations queue.
2. The backend automatically runs optimization on startup and every five minutes, creating verified collection tasks for urgent bins with available vehicles.
3. Click **Run AI optimization** to trigger an additional immediate run when needed.
4. Open **AI Command Center** to see the verified action trace.
5. Observe the new collection task, assigned vehicle, operator notification, and audit event through the API.

Automation can be configured with `AI_AUTOMATION_INTERVAL_MS` (minimum 60000 milliseconds) or disabled with `AI_AUTOMATION_ENABLED=false`.

When `OPENAI_API_KEY` or `LLM_API_KEY` is configured in `backend/.env`, the backend uses the provider for reasoning and tool selection. The key is never sent to the frontend. OpenAI keys use the OpenAI Chat Completions endpoint; OpenRouter-compatible `sk-or-` keys use OpenRouter automatically. Set `LLM_MODEL` to a provider-supported model such as `gpt-4o-mini` or `openai/gpt-4o-mini`, then restart the backend. If the provider is unavailable, the validated local rule engine remains the fallback.

## API surface

`GET /api/dashboard`, `GET /api/bins`, `GET /api/vehicles`, `GET /api/collections`, `GET /api/notifications`, `GET /api/audit-logs`, `GET /api/ai/status`, `GET /api/ai/runs`, `POST /api/ai/run`, `POST /api/agent/query`, `PATCH /api/bins/:id`, and `PATCH /api/collections/:id` are available from the backend.

## Architecture notes

- `backend/src/store.js` is the replaceable persistence boundary for this demo seed store and centralizes Hyderabad areas, coordinates, bins, and routes.
- `backend/src/agent.js` owns prediction, configurable-style priority logic, route optimization, tool execution, verification state, and audit creation.
- `frontend/src/main.jsx` is a responsive operations console; all dashboard metrics are loaded from API responses.
- The next production hardening step is replacing the in-memory store with PostgreSQL/Prisma and moving demo credentials into a proper user table with password hashing and rotation.