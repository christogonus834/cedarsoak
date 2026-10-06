import { IsString, MinLength } from 'class-validator';

export class JoinCooperativeDto {
  @IsString()
  @MinLength(3)
  cooperativeCode: string;
}
