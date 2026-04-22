/**
 * Graceful shutdown coordinator.
 *
 * Services register cleanup hooks (close HTTP server, drain RabbitMQ, close
 * Mongo, etc.) via onShutdown(). On SIGTERM / SIGINT, hooks run in
 * reverse-registration order so later-initialised resources are torn down
 * before the ones they depend on.
 *
 * Why reverse order?
 *   1. connect DB
 *   2. connect Rabbit
 *   3. start HTTP server
 * On shutdown we want: stop HTTP → drain Rabbit → close DB.
 *
 * A watchdog timer force-exits the process if hooks hang — a stuck shutdown
 * is worse than an ungraceful one under an orchestrator like Kubernetes,
 * which will SIGKILL after its own grace period anyway.
 */

type ShutdownHook = () => Promise<void> | void;

const hooks: ShutdownHook[] = [];
let installed = false;
let shuttingDown = false;

const DEFAULT_TIMEOUT_MS = 15_000;

export interface ShutdownOptions
{
  timeoutMs?: number;
}

/**
 * Register a hook that runs on SIGTERM / SIGINT.
 * Safe to call multiple times — the signal handlers are installed lazily.
 */
export function onShutdown(hook: ShutdownHook, options?: ShutdownOptions): void
{
  hooks.push(hook);
  if (!installed)
  {
    installed = true;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    process.on('SIGTERM', () => { void runShutdown('SIGTERM', timeoutMs); });
    process.on('SIGINT',  () => { void runShutdown('SIGINT',  timeoutMs); });
  }
}

async function runShutdown(signal: string, timeoutMs: number): Promise<void>
{
  if (shuttingDown)
  {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down gracefully...`);

  const watchdog = setTimeout(() =>
  {
    console.error(`Shutdown hooks did not complete within ${timeoutMs}ms — forcing exit`);
    process.exit(1);
  }, timeoutMs);
  // Don't let the watchdog itself keep the event loop alive.
  watchdog.unref();

  // Run hooks in reverse-registration order.
  for (let i = hooks.length - 1; i >= 0; i--)
  {
    try
    {
      await hooks[i]();
    }
    catch (err)
    {
      console.error('Shutdown hook failed:', (err as Error).message);
    }
  }

  clearTimeout(watchdog);
  console.log('Shutdown complete');
  process.exit(0);
}
