import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { BankAccountService } from './bank-account.service';
import { ConfirmPennyDropDto, RejectBankAccountDto, SubmitBankAccountDto } from './dto/bank-account.dto';
import { JwtPayload } from '../../auth/jwt.util';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditAction } from '../../common/decorators/audit-action.decorator';

// Payout destinations. Class-level @Roles('admin') matches OrganizerController's posture:
// admin by default, opened up per-route only where an organizer must act on their own data.
//
// Its own controller rather than more routes on OrganizerController because the paths are
// static ('bank-account/...') and OrganizerController's bare `:id` route would swallow them
// — Nest matches in declaration order, and that route is already load-bearing.
@Roles('admin')
@ApiTags('organizers')
@Controller('organizers/bank-account')
export class BankAccountController {
  constructor(private readonly bankAccountService: BankAccountService) {}

  // --- Organizer self-service ---

  @Roles('organizer', 'admin')
  @Get('me')
  async getMine(@Request() req: Request & { user: JwtPayload }) {
    return await this.bankAccountService.getMine(req.user.id);
  }

  // PUT, not POST: submitting again replaces the organizer's account rather than adding a
  // second one, and it is idempotent in the sense that matters — the end state is "this is
  // my account", however many times it is called.
  @AuditAction('organizer.bank-account.submit', 'organizer')
  @Roles('organizer', 'admin')
  @Put('me')
  async submit(@Body() dto: SubmitBankAccountDto, @Request() req: Request & { user: JwtPayload }) {
    return await this.bankAccountService.submit(req.user.id, dto);
  }

  // --- Admin review ---

  @Get('pending')
  async getPending() {
    return await this.bankAccountService.getPendingReview();
  }

  // Returns DECRYPTED details — an admin cannot check an account against a KYC document
  // without seeing it. Audited for exactly that reason.
  @AuditAction('organizer.bank-account.view', 'organizer')
  @Get(':id')
  async getForReview(@Param('id', ParseUUIDPipe) id: string, @Request() req: Request & { user: JwtPayload }) {
    return await this.bankAccountService.getForReview(req.user.id, id);
  }

  @AuditAction('organizer.bank-account.approve', 'organizer')
  @Post(':id/approve')
  async approve(@Param('id', ParseUUIDPipe) id: string, @Request() req: Request & { user: JwtPayload }) {
    return await this.bankAccountService.approve(req.user.id, id);
  }

  @AuditAction('organizer.bank-account.reject', 'organizer')
  @Post(':id/reject')
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectBankAccountDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.bankAccountService.reject(req.user.id, id, dto.reason);
  }

  // Records a human's confirmation that a real ₹1 transfer landed. The transfer itself is
  // manual — there is no disbursement integration to send it with yet.
  @AuditAction('organizer.bank-account.penny-drop', 'organizer')
  @Post(':id/penny-drop')
  async confirmPennyDrop(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmPennyDropDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.bankAccountService.confirmPennyDrop(req.user.id, id, dto.reference);
  }
}
