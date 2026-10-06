import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ClientContextData, extractClientContext } from '../utils/client-context.util';

// Usage: async login(@ClientContext() ctx: ClientContextData) { ... }
// Derives network + device signals from the request itself. Nothing here is
// trusted as proof of identity — these are inputs to risk scoring only.
export const ClientContext = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ClientContextData => {
    return extractClientContext(ctx.switchToHttp().getRequest());
  },
);
