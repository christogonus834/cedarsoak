import { IsString, MinLength } from 'class-validator';

export class SetActiveVanProviderDto {
  @IsString()
  @MinLength(2)
  providerName: string; // e.g. "MONNIFY" — validated against registered providers in the service layer
}
