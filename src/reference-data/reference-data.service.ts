import {
  HttpStatus,
  Inject,
  Injectable,
  type OnModuleInit,
} from '@nestjs/common';
import {
  appendStaffRecordHistory,
  type ChangeHistoryEntryView,
  type StaffActor,
} from '../change-history/change-history';
import { ChangeHistoryService } from '../change-history/change-history.service';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import { createPage, type PageResult } from '../common/http/page';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type PageQueryDto,
} from '../common/http/page-query.dto';
import { MAX_POSTGRES_INT4 } from '../common/http/parse-positive-int.pipe';
import { InstitutionType, type Prisma } from '../generated/prisma/client';
import {
  isForeignKeyConstraintError,
  isUniqueConstraintError,
} from '../prisma/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionRunner } from '../prisma/transaction-runner';
import {
  assertFixedOfficeHierarchy,
  isFixedFacultyId,
  isFixedInstitutionId,
} from './fixed-office';
import {
  departmentSnapshot,
  departmentView,
  facultySnapshot,
  facultyView,
  institutionSnapshot,
  institutionView,
  type DepartmentView,
  type EducationalInstitutionView,
  type FacultyView,
} from './reference-data.views';

export const INSTITUTION_SORT_FIELDS = [
  'name',
  'institutionType',
  'createdAt',
  'id',
] as const;
export type InstitutionSortField = (typeof INSTITUTION_SORT_FIELDS)[number];

export const CATALOG_SORT_FIELDS = ['name', 'createdAt', 'id'] as const;
export type CatalogSortField = (typeof CATALOG_SORT_FIELDS)[number];

export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export interface ListInstitutionsInput {
  readonly page?: number;
  readonly pageSize?: number;
  readonly search?: string;
  readonly institutionType?: InstitutionType;
  readonly sortBy?: InstitutionSortField;
  readonly sortOrder?: SortDirection;
}

export interface CreateInstitutionInput {
  readonly name: string;
  readonly institutionType: InstitutionType;
}

export interface UpdateInstitutionInput {
  readonly expectedVersion: number;
  readonly name?: string;
  readonly institutionType?: InstitutionType;
}

export interface ListFacultiesInput {
  readonly page?: number;
  readonly pageSize?: number;
  readonly search?: string;
  readonly institutionId?: number;
  readonly sortBy?: CatalogSortField;
  readonly sortOrder?: SortDirection;
}

export interface CreateFacultyInput {
  readonly institutionId: number;
  readonly name: string;
}

export interface UpdateFacultyInput {
  readonly expectedVersion: number;
  readonly institutionId?: number;
  readonly name?: string;
}

export interface ListDepartmentsInput {
  readonly page?: number;
  readonly pageSize?: number;
  readonly search?: string;
  readonly facultyId?: number;
  readonly institutionId?: number;
  readonly sortBy?: CatalogSortField;
  readonly sortOrder?: SortDirection;
}

export interface CreateDepartmentInput {
  readonly facultyId: number;
  readonly name: string;
}

export interface UpdateDepartmentInput {
  readonly expectedVersion: number;
  readonly facultyId?: number;
  readonly name?: string;
}

const VALID_INSTITUTION_TYPES = new Set<string>(Object.values(InstitutionType));

@Injectable()
export class ReferenceDataService implements OnModuleInit {
  private readonly transactions: TransactionRunner;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly changeHistory: ChangeHistoryService,
  ) {
    this.transactions = new TransactionRunner(prisma);
  }

  async onModuleInit(): Promise<void> {
    await assertFixedOfficeHierarchy(this.prisma);
  }

  async listInstitutions(
    query: ListInstitutionsInput = {},
  ): Promise<PageResult<EducationalInstitutionView>> {
    const { page, pageSize } = normalizePagination(query);
    const search = validateOptionalSearch(query.search);
    const institutionType =
      query.institutionType !== undefined
        ? validateInstitutionType(query.institutionType)
        : undefined;
    const orderBy = buildOrderBy(
      query.sortBy,
      query.sortOrder,
      INSTITUTION_SORT_FIELDS,
    );
    const where: Prisma.EducationalInstitutionWhereInput = {
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      ...(institutionType ? { institutionType } : {}),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.educationalInstitution.count({ where }),
      this.prisma.educationalInstitution.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return createPage(rows.map(institutionView), total, page, pageSize);
  }

  async getInstitution(id: number): Promise<EducationalInstitutionView> {
    const validId = validatePositiveInt4(id, 'id');
    const row = await this.prisma.educationalInstitution.findUnique({
      where: { id: validId },
    });
    if (!row) {
      throw notFoundError('Educational institution not found');
    }
    return institutionView(row);
  }

  async createInstitution(
    actor: StaffActor,
    input: CreateInstitutionInput,
  ): Promise<EducationalInstitutionView> {
    const name = validateCatalogName(input.name, 'name');
    const institutionType = validateInstitutionType(input.institutionType);

    return this.transactions.run(
      { name, institutionType },
      async (tx, data) => {
        const created = await tx.educationalInstitution.create({ data });
        await appendStaffRecordHistory(tx, actor, {
          recordType: 'EDUCATIONAL_INSTITUTION',
          recordId: created.id,
          action: 'CREATED',
          before: null,
          after: institutionSnapshot(created),
        });
        return institutionView(created);
      },
    );
  }

  async updateInstitution(
    actor: StaffActor,
    id: number,
    input: UpdateInstitutionInput,
  ): Promise<EducationalInstitutionView> {
    const validId = validatePositiveInt4(id, 'id');
    const expectedVersion = validatePositiveInt4(
      input.expectedVersion,
      'expectedVersion',
    );
    if (input.name === undefined && input.institutionType === undefined) {
      throw validationError(
        'body',
        'At least one field to update must be provided',
      );
    }

    const name =
      input.name !== undefined
        ? validateCatalogName(input.name, 'name')
        : undefined;
    const institutionType =
      input.institutionType !== undefined
        ? validateInstitutionType(input.institutionType)
        : undefined;

    return this.runVersionedMutation(
      validId,
      expectedVersion,
      { name, institutionType },
      {
        lockAndFind: lockInstitution,
        notFoundMessage: 'Educational institution not found',
        assertMutable: (row) => {
          if (isFixedInstitutionId(row.id)) {
            throw fixedRecordProtectedError(
              'The fixed operating institution cannot be modified',
            );
          }
        },
        execute: async (tx, before, data) => {
          const after = await tx.educationalInstitution.update({
            where: { id: before.id },
            data: {
              ...(data.name !== undefined ? { name: data.name } : {}),
              ...(data.institutionType !== undefined
                ? { institutionType: data.institutionType }
                : {}),
              version: { increment: 1 },
            },
          });
          await appendStaffRecordHistory(tx, actor, {
            recordType: 'EDUCATIONAL_INSTITUTION',
            recordId: after.id,
            action: 'UPDATED',
            before: institutionSnapshot(before),
            after: institutionSnapshot(after),
          });
          return institutionView(after);
        },
      },
    );
  }

  async deleteInstitution(
    actor: StaffActor,
    id: number,
    expectedVersion: number,
  ): Promise<void> {
    const validId = validatePositiveInt4(id, 'id');
    const validVersion = validatePositiveInt4(
      expectedVersion,
      'expectedVersion',
    );

    try {
      await this.runVersionedMutation(validId, validVersion, undefined, {
        lockAndFind: lockInstitution,
        notFoundMessage: 'Educational institution not found',
        assertMutable: (row) => {
          if (isFixedInstitutionId(row.id)) {
            throw fixedRecordProtectedError(
              'The fixed operating institution cannot be deleted',
            );
          }
        },
        execute: async (tx, before) => {
          await tx.educationalInstitution.delete({ where: { id: before.id } });
          await appendStaffRecordHistory(tx, actor, {
            recordType: 'EDUCATIONAL_INSTITUTION',
            recordId: before.id,
            action: 'DELETED',
            before: institutionSnapshot(before),
            after: null,
          });
        },
      });
    } catch (error: unknown) {
      if (isForeignKeyConstraintError(error)) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          ERROR_CODES.RECORD_IN_USE,
          'Educational institution is still referenced and cannot be deleted',
        );
      }
      throw error;
    }
  }

  async getInstitutionHistory(
    id: number,
    query: PageQueryDto,
  ): Promise<PageResult<ChangeHistoryEntryView>> {
    const validId = validatePositiveInt4(id, 'id');
    const pagination = normalizePagination(query);
    return this.changeHistory.listRecordHistory(
      'EDUCATIONAL_INSTITUTION',
      validId,
      pagination,
      async (recordId) =>
        (await this.prisma.educationalInstitution.findUnique({
          where: { id: recordId },
          select: { id: true },
        })) !== null,
    );
  }

  async listFaculties(
    query: ListFacultiesInput = {},
  ): Promise<PageResult<FacultyView>> {
    const { page, pageSize } = normalizePagination(query);
    const search = validateOptionalSearch(query.search);
    const institutionId =
      query.institutionId !== undefined
        ? validatePositiveInt4(query.institutionId, 'institutionId')
        : undefined;
    const orderBy = buildOrderBy(
      query.sortBy,
      query.sortOrder,
      CATALOG_SORT_FIELDS,
    );
    const where: Prisma.FacultyWhereInput = {
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      ...(institutionId !== undefined ? { institutionId } : {}),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.faculty.count({ where }),
      this.prisma.faculty.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return createPage(rows.map(facultyView), total, page, pageSize);
  }

  async getFaculty(id: number): Promise<FacultyView> {
    const validId = validatePositiveInt4(id, 'id');
    const row = await this.prisma.faculty.findUnique({
      where: { id: validId },
    });
    if (!row) {
      throw notFoundError('Faculty not found');
    }
    return facultyView(row);
  }

  async createFaculty(
    actor: StaffActor,
    input: CreateFacultyInput,
  ): Promise<FacultyView> {
    const institutionId = validatePositiveInt4(
      input.institutionId,
      'institutionId',
    );
    const name = validateCatalogName(input.name, 'name');

    try {
      return await this.transactions.run(
        { institutionId, name },
        async (tx, data) => {
          const institution = await tx.educationalInstitution.findUnique({
            where: { id: data.institutionId },
            select: { id: true },
          });
          if (!institution) {
            throw notFoundError('Educational institution not found');
          }

          const created = await tx.faculty.create({ data });
          await appendStaffRecordHistory(tx, actor, {
            recordType: 'FACULTY',
            recordId: created.id,
            action: 'CREATED',
            before: null,
            after: facultySnapshot(created),
          });
          return facultyView(created);
        },
      );
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          ERROR_CODES.FACULTY_NAME_EXISTS,
          'A faculty with this name already exists in the institution',
        );
      }
      if (isForeignKeyConstraintError(error)) {
        throw notFoundError('Educational institution not found');
      }
      throw error;
    }
  }

  async updateFaculty(
    actor: StaffActor,
    id: number,
    input: UpdateFacultyInput,
  ): Promise<FacultyView> {
    const validId = validatePositiveInt4(id, 'id');
    const expectedVersion = validatePositiveInt4(
      input.expectedVersion,
      'expectedVersion',
    );
    if (input.name === undefined && input.institutionId === undefined) {
      throw validationError(
        'body',
        'At least one field to update must be provided',
      );
    }

    const name =
      input.name !== undefined
        ? validateCatalogName(input.name, 'name')
        : undefined;
    const institutionId =
      input.institutionId !== undefined
        ? validatePositiveInt4(input.institutionId, 'institutionId')
        : undefined;

    try {
      return await this.runVersionedMutation(
        validId,
        expectedVersion,
        { name, institutionId },
        {
          lockAndFind: lockFaculty,
          notFoundMessage: 'Faculty not found',
          assertMutable: (row) => {
            if (isFixedFacultyId(row.id)) {
              throw fixedRecordProtectedError(
                'The fixed operating faculty cannot be modified or reparented',
              );
            }
          },
          execute: async (tx, before, data) => {
            if (
              data.institutionId !== undefined &&
              data.institutionId !== before.institutionId
            ) {
              const targetInstitution =
                await tx.educationalInstitution.findUnique({
                  where: { id: data.institutionId },
                  select: { id: true },
                });
              if (!targetInstitution) {
                throw notFoundError('Educational institution not found');
              }
            }

            const after = await tx.faculty.update({
              where: { id: before.id },
              data: {
                ...(data.name !== undefined ? { name: data.name } : {}),
                ...(data.institutionId !== undefined
                  ? { institutionId: data.institutionId }
                  : {}),
                version: { increment: 1 },
              },
            });
            await appendStaffRecordHistory(tx, actor, {
              recordType: 'FACULTY',
              recordId: after.id,
              action: 'UPDATED',
              before: facultySnapshot(before),
              after: facultySnapshot(after),
            });
            return facultyView(after);
          },
        },
      );
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          ERROR_CODES.FACULTY_NAME_EXISTS,
          'A faculty with this name already exists in the institution',
        );
      }
      if (isForeignKeyConstraintError(error)) {
        throw notFoundError('Educational institution not found');
      }
      throw error;
    }
  }

  async deleteFaculty(
    actor: StaffActor,
    id: number,
    expectedVersion: number,
  ): Promise<void> {
    const validId = validatePositiveInt4(id, 'id');
    const validVersion = validatePositiveInt4(
      expectedVersion,
      'expectedVersion',
    );

    try {
      await this.runVersionedMutation(validId, validVersion, undefined, {
        lockAndFind: lockFaculty,
        notFoundMessage: 'Faculty not found',
        assertMutable: (row) => {
          if (isFixedFacultyId(row.id)) {
            throw fixedRecordProtectedError(
              'The fixed operating faculty cannot be deleted',
            );
          }
        },
        execute: async (tx, before) => {
          await tx.faculty.delete({ where: { id: before.id } });
          await appendStaffRecordHistory(tx, actor, {
            recordType: 'FACULTY',
            recordId: before.id,
            action: 'DELETED',
            before: facultySnapshot(before),
            after: null,
          });
        },
      });
    } catch (error: unknown) {
      if (isForeignKeyConstraintError(error)) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          ERROR_CODES.RECORD_IN_USE,
          'Faculty is still referenced and cannot be deleted',
        );
      }
      throw error;
    }
  }

  async getFacultyHistory(
    id: number,
    query: PageQueryDto,
  ): Promise<PageResult<ChangeHistoryEntryView>> {
    const validId = validatePositiveInt4(id, 'id');
    const pagination = normalizePagination(query);
    return this.changeHistory.listRecordHistory(
      'FACULTY',
      validId,
      pagination,
      async (recordId) =>
        (await this.prisma.faculty.findUnique({
          where: { id: recordId },
          select: { id: true },
        })) !== null,
    );
  }

  async listDepartments(
    query: ListDepartmentsInput = {},
  ): Promise<PageResult<DepartmentView>> {
    const { page, pageSize } = normalizePagination(query);
    const search = validateOptionalSearch(query.search);
    const facultyId =
      query.facultyId !== undefined
        ? validatePositiveInt4(query.facultyId, 'facultyId')
        : undefined;
    const institutionId =
      query.institutionId !== undefined
        ? validatePositiveInt4(query.institutionId, 'institutionId')
        : undefined;
    const orderBy = buildOrderBy(
      query.sortBy,
      query.sortOrder,
      CATALOG_SORT_FIELDS,
    );
    const where: Prisma.DepartmentWhereInput = {
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      ...(facultyId !== undefined ? { facultyId } : {}),
      ...(institutionId !== undefined ? { faculty: { institutionId } } : {}),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.department.count({ where }),
      this.prisma.department.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return createPage(rows.map(departmentView), total, page, pageSize);
  }

  async getDepartment(id: number): Promise<DepartmentView> {
    const validId = validatePositiveInt4(id, 'id');
    const row = await this.prisma.department.findUnique({
      where: { id: validId },
    });
    if (!row) {
      throw notFoundError('Department not found');
    }
    return departmentView(row);
  }

  async createDepartment(
    actor: StaffActor,
    input: CreateDepartmentInput,
  ): Promise<DepartmentView> {
    const facultyId = validatePositiveInt4(input.facultyId, 'facultyId');
    const name = validateCatalogName(input.name, 'name');

    try {
      return await this.transactions.run(
        { facultyId, name },
        async (tx, data) => {
          const faculty = await tx.faculty.findUnique({
            where: { id: data.facultyId },
            select: { id: true },
          });
          if (!faculty) {
            throw notFoundError('Faculty not found');
          }

          const created = await tx.department.create({ data });
          await appendStaffRecordHistory(tx, actor, {
            recordType: 'DEPARTMENT',
            recordId: created.id,
            action: 'CREATED',
            before: null,
            after: departmentSnapshot(created),
          });
          return departmentView(created);
        },
      );
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          ERROR_CODES.DEPARTMENT_NAME_EXISTS,
          'A department with this name already exists in the faculty',
        );
      }
      if (isForeignKeyConstraintError(error)) {
        throw notFoundError('Faculty not found');
      }
      throw error;
    }
  }

  async updateDepartment(
    actor: StaffActor,
    id: number,
    input: UpdateDepartmentInput,
  ): Promise<DepartmentView> {
    const validId = validatePositiveInt4(id, 'id');
    const expectedVersion = validatePositiveInt4(
      input.expectedVersion,
      'expectedVersion',
    );
    if (input.name === undefined && input.facultyId === undefined) {
      throw validationError(
        'body',
        'At least one field to update must be provided',
      );
    }

    const name =
      input.name !== undefined
        ? validateCatalogName(input.name, 'name')
        : undefined;
    const facultyId =
      input.facultyId !== undefined
        ? validatePositiveInt4(input.facultyId, 'facultyId')
        : undefined;

    try {
      return await this.runVersionedMutation(
        validId,
        expectedVersion,
        { name, facultyId },
        {
          lockAndFind: lockDepartment,
          notFoundMessage: 'Department not found',
          execute: async (tx, before, data) => {
            if (
              data.facultyId !== undefined &&
              data.facultyId !== before.facultyId
            ) {
              const targetFaculty = await tx.faculty.findUnique({
                where: { id: data.facultyId },
                select: { id: true },
              });
              if (!targetFaculty) {
                throw notFoundError('Faculty not found');
              }
            }

            const after = await tx.department.update({
              where: { id: before.id },
              data: {
                ...(data.name !== undefined ? { name: data.name } : {}),
                ...(data.facultyId !== undefined
                  ? { facultyId: data.facultyId }
                  : {}),
                version: { increment: 1 },
              },
            });
            await appendStaffRecordHistory(tx, actor, {
              recordType: 'DEPARTMENT',
              recordId: after.id,
              action: 'UPDATED',
              before: departmentSnapshot(before),
              after: departmentSnapshot(after),
            });
            return departmentView(after);
          },
        },
      );
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          ERROR_CODES.DEPARTMENT_NAME_EXISTS,
          'A department with this name already exists in the faculty',
        );
      }
      if (isForeignKeyConstraintError(error)) {
        throw notFoundError('Faculty not found');
      }
      throw error;
    }
  }

  async deleteDepartment(
    actor: StaffActor,
    id: number,
    expectedVersion: number,
  ): Promise<void> {
    const validId = validatePositiveInt4(id, 'id');
    const validVersion = validatePositiveInt4(
      expectedVersion,
      'expectedVersion',
    );

    try {
      await this.runVersionedMutation(validId, validVersion, undefined, {
        lockAndFind: lockDepartment,
        notFoundMessage: 'Department not found',
        execute: async (tx, before) => {
          await tx.department.delete({ where: { id: before.id } });
          await appendStaffRecordHistory(tx, actor, {
            recordType: 'DEPARTMENT',
            recordId: before.id,
            action: 'DELETED',
            before: departmentSnapshot(before),
            after: null,
          });
        },
      });
    } catch (error: unknown) {
      if (isForeignKeyConstraintError(error)) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          ERROR_CODES.RECORD_IN_USE,
          'Department is still referenced and cannot be deleted',
        );
      }
      throw error;
    }
  }

  async getDepartmentHistory(
    id: number,
    query: PageQueryDto,
  ): Promise<PageResult<ChangeHistoryEntryView>> {
    const validId = validatePositiveInt4(id, 'id');
    const pagination = normalizePagination(query);
    return this.changeHistory.listRecordHistory(
      'DEPARTMENT',
      validId,
      pagination,
      async (recordId) =>
        (await this.prisma.department.findUnique({
          where: { id: recordId },
          select: { id: true },
        })) !== null,
    );
  }

  private async runVersionedMutation<
    Row extends { readonly version: number },
    Payload,
    Result,
  >(
    id: number,
    expectedVersion: number,
    payload: Payload,
    hooks: {
      readonly lockAndFind: (
        tx: Prisma.TransactionClient,
        id: number,
      ) => Promise<Row | null>;
      readonly notFoundMessage: string;
      readonly assertMutable?: (row: Row) => void;
      readonly execute: (
        tx: Prisma.TransactionClient,
        before: Row,
        payload: Payload,
      ) => Promise<Result>;
    },
  ): Promise<Result> {
    return this.transactions.run(
      { id, expectedVersion, payload },
      async (tx, original) => {
        const before = await hooks.lockAndFind(tx, original.id);
        if (!before) {
          throw notFoundError(hooks.notFoundMessage);
        }
        hooks.assertMutable?.(before);
        if (before.version !== original.expectedVersion) {
          throw new ApiError(
            HttpStatus.CONFLICT,
            ERROR_CODES.STALE_VERSION,
            'Record has changed; refresh and retry with the current version',
          );
        }
        return hooks.execute(tx, before, original.payload);
      },
    );
  }
}

async function lockInstitution(tx: Prisma.TransactionClient, id: number) {
  await tx.$queryRaw`SELECT id FROM educational_institution WHERE id = ${id} FOR UPDATE`;
  return tx.educationalInstitution.findUnique({ where: { id } });
}

async function lockFaculty(tx: Prisma.TransactionClient, id: number) {
  await tx.$queryRaw`SELECT id FROM faculty WHERE id = ${id} FOR UPDATE`;
  return tx.faculty.findUnique({ where: { id } });
}

async function lockDepartment(tx: Prisma.TransactionClient, id: number) {
  await tx.$queryRaw`SELECT id FROM department WHERE id = ${id} FOR UPDATE`;
  return tx.department.findUnique({ where: { id } });
}

function validateCatalogName(value: string, field: string): string {
  if (typeof value !== 'string') {
    throw validationError(field, `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || hasControlChars(trimmed)) {
    throw validationError(
      field,
      `${field} must contain 1–200 printable characters`,
    );
  }
  return trimmed;
}

function validateOptionalSearch(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw validationError('search', 'search must be a string');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 200 || hasControlChars(trimmed)) {
    throw validationError(
      'search',
      'search must contain at most 200 printable characters',
    );
  }
  return trimmed;
}

function validatePositiveInt4(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_POSTGRES_INT4) {
    throw validationError(field, `${field} must be a positive integer`);
  }
  return value;
}

function validateInstitutionType(value: InstitutionType): InstitutionType {
  if (typeof value !== 'string' || !VALID_INSTITUTION_TYPES.has(value)) {
    throw validationError(
      'institutionType',
      'institutionType must be a valid InstitutionType',
    );
  }
  return value;
}

function normalizePagination(query: {
  readonly page?: number;
  readonly pageSize?: number;
}): { readonly page: number; readonly pageSize: number } {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_POSTGRES_INT4) {
    throw validationError('page', 'page must be a positive integer');
  }
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_PAGE_SIZE
  ) {
    throw validationError(
      'pageSize',
      `pageSize must be between 1 and ${MAX_PAGE_SIZE}`,
    );
  }
  return { page, pageSize };
}

function buildOrderBy<Field extends string>(
  sortBy: Field | undefined,
  sortOrder: SortDirection | undefined,
  allowedFields: readonly Field[],
): Array<Record<string, SortDirection>> {
  const field = sortBy ?? ('name' as Field);
  if (!allowedFields.includes(field)) {
    throw validationError('sortBy', 'Unsupported sortBy field');
  }
  const direction = sortOrder ?? 'asc';
  if (direction !== 'asc' && direction !== 'desc') {
    throw validationError('sortOrder', 'sortOrder must be asc or desc');
  }
  if (field === 'id') {
    return [{ id: direction }];
  }
  return [{ [field]: direction }, { id: 'asc' }];
}

function hasControlChars(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function validationError(field: string, message: string): ApiError {
  return new ApiError(
    HttpStatus.BAD_REQUEST,
    ERROR_CODES.VALIDATION_ERROR,
    'Validation failed',
    [{ field, message }],
  );
}

function notFoundError(message: string): ApiError {
  return new ApiError(HttpStatus.NOT_FOUND, ERROR_CODES.NOT_FOUND, message);
}

function fixedRecordProtectedError(message: string): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.FIXED_RECORD_PROTECTED,
    message,
  );
}
