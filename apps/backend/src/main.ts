import dotenv from "dotenv";
import { existsSync } from "fs";
import { resolve } from "path";
import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

const envCandidates = [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "..", ".env"),
  resolve(process.cwd(), "..", "..", ".env"),
];

const envPath = envCandidates.find((candidate) => existsSync(candidate));
if (envPath) {
  dotenv.config({ path: envPath });
}

async function bootstrap() {
  const startedAt = Date.now();
  console.log("[Startup] Loading application and database...");
  const app = await NestFactory.create(AppModule, { cors: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: false,
      transform: true,
    }),
  );
  const port = Number(process.env.PORT ?? 4000);
  const host = process.env.BACKEND_HOST ?? "127.0.0.1";
  await app.listen(port, host);
  console.log(`[Startup] Ready at http://${host}:${port} (${Date.now() - startedAt} ms)`);
}

void bootstrap().catch((error: unknown) => {
  console.error("[Startup] Application failed to start:", error instanceof Error ? error.message : "Unknown error");
  process.exit(1);
});
