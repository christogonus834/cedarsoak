import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MonnifyProvider } from './providers/monnify.provider';
import { VanProviderAdapter } from './interfaces/van-provider.interface';

const ACTIVE_PROVIDER_SETTING_KEY = 'active_van_provider';

// This registry is the ONLY place that decides "which provider is active right
// now." Everything else (wallet provisioning, webhook routing) asks this
// service, never hardcodes a provider. Backup providers (BACKUP_PROVIDER_A/B)
// get registered here the same way Monnify is, once their documentation is
// reviewed and an adapter class is written for each.
@Injectable()
export class VanProviderRegistry {
  private readonly logger = new Logger(VanProviderRegistry.name);
  private readonly providers = new Map<string, VanProviderAdapter>();

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    monnifyProvider: MonnifyProvider,
    // Future: inject BackupProviderA, BackupProviderB here once built, and
    // register them below the same way Monnify is registered.
  ) {
    this.register(monnifyProvider);
  }

  private register(provider: VanProviderAdapter) {
    this.providers.set(provider.providerName, provider);
  }

  getProviderByName(name: string): VanProviderAdapter {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new ServiceUnavailableException(`VAN provider "${name}" is not registered.`);
    }
    return provider;
  }

  // The admin-facing "Active VAN Provider" toggle reads/writes this setting.
  // Falls back to the .env default if no override has ever been set.
  async getActiveProviderName(): Promise<string> {
    const setting = await this.prisma.platformSetting.findUnique({
      where: { key: ACTIVE_PROVIDER_SETTING_KEY },
    });
    return setting?.value || this.configService.get<string>('defaultVanProvider') || 'MONNIFY';
  }

  async getActiveProvider(): Promise<VanProviderAdapter> {
    const activeName = await this.getActiveProviderName();
    return this.getProviderByName(activeName);
  }

  // Manual override — called from the admin dashboard endpoint. Every call is
  // expected to be wrapped in an @Audit() at the controller level so switching
  // providers is always traceable to a specific admin action.
  async setActiveProvider(providerName: string, adminUserId: string) {
    // Ensure the provider actually exists before allowing the switch — avoids
    // an admin accidentally locking out all new account generation with a typo.
    this.getProviderByName(providerName);

    return this.prisma.platformSetting.upsert({
      where: { key: ACTIVE_PROVIDER_SETTING_KEY },
      create: { key: ACTIVE_PROVIDER_SETTING_KEY, value: providerName, updatedByUserId: adminUserId },
      update: { value: providerName, updatedByUserId: adminUserId },
    });
  }

  // Health status of every registered provider — surfaced on the admin
  // dashboard per our design. Auto-failover (switching the active provider
  // automatically when the current one is unhealthy) is a scheduled job that
  // calls this and, if the active provider is down, calls setActiveProvider()
  // to the next healthy one — to be added as a cron job once we have more
  // than one real provider registered.
  async getAllProviderHealth(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    for (const [name, provider] of this.providers.entries()) {
      results[name] = await provider.checkHealth().catch(() => false);
    }
    return results;
  }
}
