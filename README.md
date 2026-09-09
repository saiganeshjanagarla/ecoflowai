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
2. Click **Run AI optimization**. The API runs the local rule engine against current bin and vehicle data.
3. Open **AI Command Center** to see the verified action trace.
4. Observe the new collection task, assigned vehicle, operator notification, and audit event through the API.

The local rule engine is intentional: no LLM key is required and the UI labels the active mode. `LLM_API_KEY` is reserved for adding a provider adapter without making the operational workflow depend on an external service.

## API surface

`GET /api/dashboard`, `GET /api/bins`, `GET /api/vehicles`, `GET /api/collections`, `GET /api/notifications`, `GET /api/audit-logs`, `GET /api/ai/status`, `GET /api/ai/runs`, `POST /api/ai/run`, `POST /api/agent/query`, `PATCH /api/bins/:id`, and `PATCH /api/collections/:id` are available from the backend.

## Architecture notes

- `backend/src/store.js` is the replaceable persistence boundary for this demo seed store and centralizes Hyderabad areas, coordinates, bins, and routes.
- `backend/src/agent.js` owns prediction, configurable-style priority logic, route optimization, tool execution, verification state, and audit creation.
- `frontend/src/main.jsx` is a responsive operations console; all dashboard metrics are loaded from API responses.
- The next production hardening step is replacing the in-memory store with PostgreSQL/Prisma and moving demo credentials into a proper user table with password hashing and rotation.