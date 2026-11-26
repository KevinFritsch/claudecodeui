// The Work dashboard (Jira tasks, pull requests, personal to-dos) per project, mounted at /api/work.
export { default as workRoutes } from './work.routes.js';
// Kvn: Work items per session, shown on the sessions overview cards.
export { workItemsBySession, type SessionWorkItem } from './services/session-items.service.js';
