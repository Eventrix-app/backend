import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreateEventDto } from './create-event.dto';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { EventApprovalStatus } from '../../entities/event.entity';

// Ticket types are not editable through the generic event-update endpoint — nested
// create/edit-tier endpoints (with the "locked once approved and sold" rule) are Phase 1.
export class UpdateEventDto extends PartialType(OmitType(CreateEventDto, ['ticketTypes'] as const)) {
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
