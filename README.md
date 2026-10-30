# ReviewClock

ReviewClock is a live pull-request review tracker designed to eliminate review problems. It listens to GitHub webhooks, computes who each pull request is waiting on, and displays them on a real-time board. It uses Node.js, Express, MongoDB, and Server-Sent Events to stream state updates without page refreshes. The system handles duplicate deliveries safely via unique indexing and processes events asynchronously from an inbox collection.

## Project flow

1. The React/Vite frontend registers and authenticates a user through the Express API.
2. The API stores repository sources in MongoDB and returns a unique GitHub webhook URL and signing secret.
3. GitHub sends signed webhook bytes. The API verifies `X-Hub-Signature-256` against those exact raw bytes before accepting a delivery.
4. A unique `(sourceId, deliveryID)` MongoDB index prevents duplicate inbox rows; duplicate attempts are logged and acknowledged.
5. The worker claims inbox rows, applies events to pull-request facts, and derives the current review state. Stale `processing` rows are reclaimed after the configured lease to recover from a worker crash. Delivery-keyed activity records prevent replay from emitting a duplicate update.
6. The API streams activity updates to the frontend over Server-Sent Events.

## Local development

- Backend: `cd backend && npm ci && npm start`
- Worker: `cd backend && npm run worker`
- Frontend: `cd frontend && npm ci && npm run dev`
- Backend tests: `cd backend && MONGODB_URI_TEST=mongodb://127.0.0.1:27017/reviewclock_test npm test`
- Worker database integration test: `cd backend && MONGODB_URI_TEST=mongodb://127.0.0.1:27017/reviewclock_test npm run test:integration`
- Frontend production build: `cd frontend && npm ci && npm run build`

GitHub Actions runs the backend suite and worker integration test against its MongoDB service, then builds the frontend on pushes and pull requests. The CI badge above reflects the latest workflow run after the workflow has been pushed to GitHub.

Set `MONGODB_URI`, `JWT_SECRET` (at least 32 characters), and `FRONTEND_ORIGIN` for the backend. `FRONTEND_ORIGIN` defaults to `http://localhost:5173`. See [failure drill results](docs/failure-modes.md) for current verification status and repeatable manual drills.
