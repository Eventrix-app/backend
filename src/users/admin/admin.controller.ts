import {
  Body,
  Controller,
  Delete,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateAdminDto } from './dto/update-admin.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AuditAction } from '../../common/decorators/audit-action.decorator';
import { AdminService } from './admin.service';

@ApiTags('admin')
@Roles('admin')
@Controller('admins')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Public()
  @Post('bootstrap')
  async bootstrap(@Body() createAdminDto: CreateAdminDto) {
    return await this.adminService.bootstrap(createAdminDto);
  }

  @AuditAction('admin.create', 'admin')
  @Post()
  async create(@Body() createAdminDto: CreateAdminDto) {
    return await this.adminService.create(createAdminDto);
  }

  @Get()
  async findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
  ) {
    return await this.adminService.findAll(page, limit);
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return await this.adminService.findOne(id);
  }

  @AuditAction('admin.update', 'admin')
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateAdminDto: UpdateAdminDto,
  ) {
    return await this.adminService.update(id, updateAdminDto);
  }

  @AuditAction('admin.remove', 'admin')
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    return await this.adminService.remove(id);
  }

  @AuditAction('user.ban', 'user')
  @Patch('users/:userId/ban')
  async banUser(@Param('userId', ParseUUIDPipe) userId: string, @Body('reason') reason?: string) {
    await this.adminService.banUser(userId, reason);
  }

  @AuditAction('user.unban', 'user')
  @Patch('users/:userId/unban')
  async unbanUser(@Param('userId', ParseUUIDPipe) userId: string) {
    await this.adminService.unbanUser(userId);
  }
}
