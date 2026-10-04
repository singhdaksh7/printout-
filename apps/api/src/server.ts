import { createApp } from './app.js';
import { ConfigError } from './config.js';

let built: ReturnType<typeof createApp>;
try {
  built = createApp();
} catch (error) {
  // Fail closed with a readable list of problems (variable names and reasons only, never values).
  console.error(error instanceof ConfigError ? error.message : `Failed to start: ${error instanceof Error ? error.name : 'unknown error'}`);
  process.exit(1);
}
const { app, prisma, config } = built;

let stopping = false;
const stop = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  try {
    await app.close();
    await prisma.$disconnect();
  } finally {
    process.exit(code);
  }
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

app.listen({ port: config.API_PORT, host: '0.0.0.0' }).catch(async (err) => {
  app.log.error(err);
  await stop(1);
});
