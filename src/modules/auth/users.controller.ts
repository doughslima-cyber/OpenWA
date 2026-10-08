import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentApiKey, RequireRole, RequireUnscopedKey } from './decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { User } from './entities/user.entity';
import { CreateUserDto, UpdateUserDto, UserResponseDto } from './dto/user.dto';
import { UsersService } from './users.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';

export function toUserResponse(user: User): UserResponseDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt ?? undefined,
    createdAt: user.createdAt,
  };
}

@ApiTags('users')
@Controller('users')
// User management mints access (a user signs in as their role), so a session-scoped admin key
// must not reach it, exactly like the API-key lifecycle routes.
@RequireUnscopedKey()
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly auditService: AuditService,
  ) {}

  private auditContext(req: Request, actor?: ApiKey) {
    return { apiKey: actor, method: req.method, path: req.path };
  }

  @Get()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List dashboard users (admin only)' })
  @ApiResponse({
    status: 200,
    description: 'All dashboard users (password hashes are never returned).',
    type: [UserResponseDto],
  })
  async findAll(): Promise<UserResponseDto[]> {
    return (await this.usersService.findAll()).map(toUserResponse);
  }

  @Post()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Create a dashboard user (admin only)' })
  @ApiResponse({ status: 201, description: 'User created.', type: UserResponseDto })
  @ApiResponse({ status: 400, description: 'Validation failed, or the body carries a field the DTO does not declare.' })
  @ApiResponse({ status: 409, description: 'A user with this email already exists.' })
  async create(
    @Body() dto: CreateUserDto,
    @Req() req: Request,
    @CurrentApiKey() actor?: ApiKey,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.create(dto);
    await this.auditService.logInfo(AuditAction.USER_CREATED, {
      ...this.auditContext(req, actor),
      metadata: { targetUserId: user.id, email: user.email, role: user.role },
    });
    return toUserResponse(user);
  }

  @Patch(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Update a dashboard user (admin only)' })
  @ApiResponse({ status: 200, description: 'The updated user.', type: UserResponseDto })
  @ApiResponse({ status: 400, description: 'Validation failed, or the body carries a field the DTO does not declare.' })
  @ApiResponse({ status: 404, description: 'No user with this id.' })
  @ApiResponse({
    status: 409,
    description: 'The change would remove your own admin access, or leave no active admin user.',
  })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: Request,
    @CurrentApiKey() actor?: ApiKey,
  ): Promise<UserResponseDto> {
    const actorUser = actor ? await this.usersService.findByApiKey(actor.id) : null;
    const before = await this.usersService.findOne(id);
    const snapshot = { name: before.name, role: before.role, isActive: before.isActive };
    const user = await this.usersService.update(id, dto, actorUser, actor?.id);
    await this.auditService.logInfo(AuditAction.USER_UPDATED, {
      ...this.auditContext(req, actor),
      metadata: {
        targetUserId: user.id,
        email: user.email,
        before: snapshot,
        after: { name: user.name, role: user.role, isActive: user.isActive },
        passwordChanged: dto.password !== undefined,
      },
    });
    return toUserResponse(user);
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a dashboard user (admin only)' })
  @ApiResponse({ status: 204, description: 'User deleted and signed out everywhere.' })
  @ApiResponse({ status: 404, description: 'No user with this id.' })
  @ApiResponse({ status: 409, description: 'The user is yourself, or the last active admin user.' })
  async remove(@Param('id') id: string, @Req() req: Request, @CurrentApiKey() actor?: ApiKey): Promise<void> {
    const actorUser = actor ? await this.usersService.findByApiKey(actor.id) : null;
    const user = await this.usersService.remove(id, actorUser);
    await this.auditService.logInfo(AuditAction.USER_DELETED, {
      ...this.auditContext(req, actor),
      metadata: { targetUserId: user.id, email: user.email },
    });
  }
}
