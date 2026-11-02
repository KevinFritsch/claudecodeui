// The HTTP surface for the warm-up settings, mounted by the app.
export { default as sessionWarmupRoutes } from './session-warmup.routes.js';

// The timer that sends the ping, started and stopped with the server.
export {
  initializeSessionWarmup,
  closeSessionWarmup,
} from './services/session-warmup.service.js';
