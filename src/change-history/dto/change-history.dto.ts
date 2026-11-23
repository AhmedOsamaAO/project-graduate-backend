import { ApiProperty } from '@nestjs/swagger';
import {
  HistoryAction,
  HistoryActorKind,
  HistoryRecordType,
} from '../../generated/prisma/client';

export class HistoryStaffActorDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'office.user' })
  username!: string;

  @ApiProperty({ example: 'Office User' })
  fullName!: string;
}

export class ChangeHistoryEntryDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({
    enum: HistoryRecordType,
    example: HistoryRecordType.EDUCATIONAL_INSTITUTION,
  })
  recordType!: HistoryRecordType;

  @ApiProperty({ type: Number, nullable: true, example: 2 })
  recordId!: number | null;

  @ApiProperty({ enum: HistoryAction, example: HistoryAction.CREATED })
  action!: HistoryAction;

  @ApiProperty({ enum: HistoryActorKind, example: HistoryActorKind.STAFF })
  actorKind!: HistoryActorKind;

  @ApiProperty({ type: HistoryStaffActorDto, nullable: true })
  staffUser!: HistoryStaffActorDto | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  operatorAttribution!: string | null;

  @ApiProperty({
    format: 'date-time',
    example: '2026-11-23T12:00:00.000Z',
  })
  occurredAt!: string;

  @ApiProperty({
    type: Object,
    nullable: true,
    additionalProperties: true,
    example: null,
  })
  before!: unknown;

  @ApiProperty({
    type: Object,
    nullable: true,
    additionalProperties: true,
    example: { id: 2, name: 'Cairo University' },
  })
  after!: unknown;
}
