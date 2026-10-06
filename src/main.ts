import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  // `rawBody: true` makes Nest/Express preserve the original, unparsed request
  // bytes on `req.rawBody` in ADDITION to the normal parsed `req.body`. This
  // is required for webhook signature verification (see MonnifyWebhookGuard)
  // — HMAC signatures are computed over the exact bytes the provider sent,
  // and re-serializing the parsed JSON body would not reliably reproduce
  // those same bytes (key order, whitespace, and number formatting can all
  // differ), causing valid signatures to fail or, worse, a subtly broken
  // verification implementation to falsely pass.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const configService = app.get(ConfigService);

  // Makes req.ip reflect the real client behind a load balancer. Off (0) by
  // default: trusting X-Forwarded-For without a real proxy in front would let
  // any client spoof its own IP and defeat network-based risk checks.
  const trustProxyHops = configService.get<number>('trustProxyHops') || 0;
  if (trustProxyHops > 0) {
    (app.getHttpAdapter().getInstance() as any).set('trust proxy', trustProxyHops);
  }

  // Sets a range of security-related HTTP headers (X-Content-Type-Options,
  // X-Frame-Options, etc.) — cheap, standard, and non-negotiable.
  app.use(helmet());

  // Strict CORS allowlist. Update this list as real frontend/admin domains are
  // known — never use a wildcard origin for an app that handles authenticated,
  // money-related requests.
  app.enableCors({
    origin: configService.get<string>('nodeEnv') === 'production'
      ? ['https://app.cedaroaks.example', 'https://admin.cedaroaks.example']
      : true, // permissive only in local development
    credentials: true,
  });

  // Global validation: every DTO is validated by class-validator automatically.
  // `whitelist: true` strips any field not declared in the DTO — this is the
  // concrete enforcement of "never trust extra fields the client might send."
  // `forbidNonWhitelisted: true` goes further and rejects the request outright
  // if unexpected fields are present, rather than silently dropping them.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  app.setGlobalPrefix('api/v1');

  // ── Swagger / OpenAPI docs ────────────────────────────────────────────
  // Served at /api/docs (interactive UI) and /api/docs-json (raw OpenAPI
  // spec, importable into Postman/Insomnia). This is the contract the
  // mobile and web frontend teams build against — every DTO's validation
  // rules (via the CLI plugin configured in nest-cli.json) and every
  // route's auth requirement are reflected here automatically, so this
  // stays truthful as the API evolves rather than becoming a stale
  // hand-written doc.
  //
  // Left ON by default in non-production. In production, gated behind an
  // explicit env flag rather than assumed safe — publicly exposing a full
  // API schema (including every field name and validation rule) is a minor
  // information-disclosure consideration worth a deliberate decision, not
  // a default.
  const isProduction = configService.get<string>('nodeEnv') === 'production';
  const swaggerEnabled = !isProduction || process.env.ENABLE_SWAGGER_IN_PRODUCTION === 'true';

  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('CedarOaks Cooperative Platform API')
      .setDescription(
        'API for the CedarOaks cooperative savings, loans, and payments platform. ' +
          'All endpoints are prefixed with /api/v1 (already reflected in the paths below). ' +
          'Authenticate via POST /auth/login or /auth/register, then click "Authorize" above ' +
          'and paste the returned accessToken (without the word "Bearer") to test protected routes directly from this page.',
      )
      .setVersion('1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Paste the accessToken returned from /auth/login or /auth/register.',
        },
        'access-token', // must match the name used in @ApiBearerAuth('access-token') on controllers
      )
      .addTag('Auth', 'Registration, login, token refresh, logout')
      .addTag('Users', 'Authenticated user profile')
      .addTag('Cooperatives', 'Cooperative creation and lookup')
      .addTag('Memberships', 'Joining cooperatives and viewing memberships')
      .addTag('Wallet', 'Wallet balance, virtual account funding, withdrawals')
      .addTag('Contributions', 'Monthly contribution payments per membership')
      .addTag('Admin', 'Cooperative admin and super admin: dashboard, members, announcements, payment adjustments, VAN provider management, role assignment')
      .addTag('Loans', 'Loan eligibility, requests, repayments, and guarantor-backed borrowing')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true }, // keeps your pasted token filled in across page reloads
    });
  }

  const port = configService.get<number>('port') || 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`CedarOaks API running on port ${port}`);
  if (swaggerEnabled) {
    // eslint-disable-next-line no-console
    console.log(`API docs available at http://localhost:${port}/api/docs`);
  }
}

bootstrap();
