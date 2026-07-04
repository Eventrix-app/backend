import { PartialType } from '@nestjs/mapped-types';
import { CreateEventDto } from './create-event.dto';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { EventApprovalStatus } from '../../entities/event.entity';

export class UpdateEventDto extends PartialType(CreateEventDto) {
  @IsOptional()
  @IsEnum(EventApprovalStatus, { message: 'Invalid approval status' })
  approvalStatus?: EventApprovalStatus;

  @IsOptional()
  @IsString()
  rejectionReason?: string;

  @IsOptional()
  @IsUUID()
  approvedBy?: string;

  @IsOptional()
  @IsUUID()
  rejectedBy?: string;

  @IsOptional()
  @IsUUID()
  updatedBy?: string;
}
