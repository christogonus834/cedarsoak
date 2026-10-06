import { Module } from '@nestjs/common';
import { CooperativesController } from './cooperatives.controller';
import { CooperativesService } from './cooperatives.service';

@Module({
  controllers: [CooperativesController],
  providers: [CooperativesService],
  exports: [CooperativesService],
})
export class CooperativesModule {}
