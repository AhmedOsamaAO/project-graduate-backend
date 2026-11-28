import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  appendStaffRecordHistory,
  type ChangeHistoryEntryView,
  type StaffActor,
} from '../change-history/change-history';
import { ChangeHistoryService } from '../change-history/change-history.service';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES, type ErrorCode } from '../common/errors/error-codes';
import { createPage, type PageResult } from '../common/http/page';
import type { PageQueryDto } from '../common/http/page-query.dto';
import type {
  HistoryRecordType,
  InstitutionType,
  Prisma,
} from '../generated/prisma/client';
import {
  isForeignKeyConstraintError,
  isRestrictViolationError,
  isUniqueConstraintError,
} from '../prisma/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionRunner } from '../prisma/transaction-runner';
import { isFixedFacultyId, isFixedInstitutionId } from './fixed-office';
import {
  FACULTY_AND_DEPARTMENT_SORT_FIELDS,
  INSTITUTION_SORT_FIELDS,
  buildOrderBy,
  fixedRecordProtectedError,
  normalizePagination,
  notFoundError,
  recordInUseError,
  validateCatalogName,
  validateInstitutionType,
  validateOptionalSearch,
  validatePositiveInt4,
  validationError,
  type CatalogSortField,
  type InstitutionSortField,
  type SortDirection,
} from './reference-data.validation';
import {
  departmentView,
  facultyView,
  institutionView,
  type DepartmentView,
  type EducationalInstitutionView,
  type FacultyView,
} from './reference-data.views';

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

@Injectable()
export class ReferenceDataService {
  private readonly transactions: TransactionRunner;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly changeHistory: ChangeHistoryService,
  ) {
    this.transactions = new TransactionRunner(prisma);
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
          after: institutionView(created),
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
        assertMutable: ensureInstitutionMutable,
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
            before: institutionView(before),
            after: institutionView(after),
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
    await this.deleteCatalogEntry(actor, id, expectedVersion, {
      recordType: 'EDUCATIONAL_INSTITUTION',
      lockAndFind: lockInstitution,
      notFoundMessage: 'Educational institution not found',
      assertMutable: ensureInstitutionMutable,
      deleteRow: (tx, targetId) =>
        tx.educationalInstitution.delete({ where: { id: targetId } }),
      snapshot: institutionView,
      inUseMessage:
        'Educational institution is still referenced and cannot be deleted',
    });
  }

  getInstitutionHistory(
    id: number,
    query: Partial<Pick<PageQueryDto, 'page' | 'pageSize'>> = {},
  ): Promise<PageResult<ChangeHistoryEntryView>> {
    return this.getCatalogHistory(
      'EDUCATIONAL_INSTITUTION',
      id,
      query,
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
      FACULTY_AND_DEPARTMENT_SORT_FIELDS,
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

    return this.mapConstraintErrors(
      () =>
        this.transactions.run({ institutionId, name }, async (tx, data) => {
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
            after: facultyView(created),
          });
          return facultyView(created);
        }),
      {
        uniqueCode: ERROR_CODES.FACULTY_NAME_EXISTS,
        uniqueMessage:
          'A faculty with this name already exists in the institution',
        missingParentMessage: 'Educational institution not found',
      },
    );
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

    return this.mapConstraintErrors(
      () =>
        this.runVersionedMutation(
          validId,
          expectedVersion,
          { name, institutionId },
          {
            lockAndFind: lockFaculty,
            notFoundMessage: 'Faculty not found',
            assertMutable: ensureFacultyMutable,
            execute: async (tx, before, data) => {
              if (
                data.institutionId !== undefined &&
                data.institutionId !== before.institutionId
              ) {
                const referencingDepartment = await tx.department.findFirst({
                  where: { facultyId: before.id },
                  select: { id: true },
                });
                if (referencingDepartment !== null) {
                  throw recordInUseError(
                    'Faculty is still referenced and cannot be reparented',
                  );
                }

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
                before: facultyView(before),
                after: facultyView(after),
              });
              return facultyView(after);
            },
          },
        ),
      {
        uniqueCode: ERROR_CODES.FACULTY_NAME_EXISTS,
        uniqueMessage:
          'A faculty with this name already exists in the institution',
        missingParentMessage: 'Educational institution not found',
        inUseMessage: 'Faculty is still referenced and cannot be reparented',
      },
    );
  }

  async deleteFaculty(
    actor: StaffActor,
    id: number,
    expectedVersion: number,
  ): Promise<void> {
    await this.deleteCatalogEntry(actor, id, expectedVersion, {
      recordType: 'FACULTY',
      lockAndFind: lockFaculty,
      notFoundMessage: 'Faculty not found',
      assertMutable: ensureFacultyMutable,
      deleteRow: (tx, targetId) =>
        tx.faculty.delete({ where: { id: targetId } }),
      snapshot: facultyView,
      inUseMessage: 'Faculty is still referenced and cannot be deleted',
    });
  }

  getFacultyHistory(
    id: number,
    query: Partial<Pick<PageQueryDto, 'page' | 'pageSize'>> = {},
  ): Promise<PageResult<ChangeHistoryEntryView>> {
    return this.getCatalogHistory('FACULTY', id, query, async (recordId) => {
      const row = await this.prisma.faculty.findUnique({
        where: { id: recordId },
        select: { id: true },
      });
      return row !== null;
    });
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
      FACULTY_AND_DEPARTMENT_SORT_FIELDS,
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

    return this.mapConstraintErrors(
      () =>
        this.transactions.run({ facultyId, name }, async (tx, data) => {
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
            after: departmentView(created),
          });
          return departmentView(created);
        }),
      {
        uniqueCode: ERROR_CODES.DEPARTMENT_NAME_EXISTS,
        uniqueMessage:
          'A department with this name already exists in the faculty',
        missingParentMessage: 'Faculty not found',
      },
    );
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

    return this.mapConstraintErrors(
      () =>
        this.runVersionedMutation(
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
                before: departmentView(before),
                after: departmentView(after),
              });
              return departmentView(after);
            },
          },
        ),
      {
        uniqueCode: ERROR_CODES.DEPARTMENT_NAME_EXISTS,
        uniqueMessage:
          'A department with this name already exists in the faculty',
        missingParentMessage: 'Faculty not found',
        inUseMessage: 'Department is still referenced and cannot be reparented',
      },
    );
  }

  async deleteDepartment(
    actor: StaffActor,
    id: number,
    expectedVersion: number,
  ): Promise<void> {
    await this.deleteCatalogEntry(actor, id, expectedVersion, {
      recordType: 'DEPARTMENT',
      lockAndFind: lockDepartment,
      notFoundMessage: 'Department not found',
      deleteRow: (tx, targetId) =>
        tx.department.delete({ where: { id: targetId } }),
      snapshot: departmentView,
      inUseMessage: 'Department is still referenced and cannot be deleted',
    });
  }

  getDepartmentHistory(
    id: number,
    query: Partial<Pick<PageQueryDto, 'page' | 'pageSize'>> = {},
  ): Promise<PageResult<ChangeHistoryEntryView>> {
    return this.getCatalogHistory('DEPARTMENT', id, query, async (recordId) => {
      const row = await this.prisma.department.findUnique({
        where: { id: recordId },
        select: { id: true },
      });
      return row !== null;
    });
  }

  private async deleteCatalogEntry<
    Row extends { readonly id: number; readonly version: number },
  >(
    actor: StaffActor,
    id: number,
    expectedVersion: number,
    options: {
      readonly recordType: HistoryRecordType;
      readonly lockAndFind: (
        tx: Prisma.TransactionClient,
        id: number,
      ) => Promise<Row | null>;
      readonly notFoundMessage: string;
      readonly assertMutable?: (row: Row) => void;
      readonly deleteRow: (
        tx: Prisma.TransactionClient,
        id: number,
      ) => Promise<unknown>;
      readonly snapshot: (row: Row) => Prisma.InputJsonValue;
      readonly inUseMessage: string;
    },
  ): Promise<void> {
    const validId = validatePositiveInt4(id, 'id');
    const validVersion = validatePositiveInt4(
      expectedVersion,
      'expectedVersion',
    );

    try {
      await this.runVersionedMutation(validId, validVersion, undefined, {
        lockAndFind: options.lockAndFind,
        notFoundMessage: options.notFoundMessage,
        assertMutable: options.assertMutable,
        execute: async (tx, before) => {
          await options.deleteRow(tx, before.id);
          await appendStaffRecordHistory(tx, actor, {
            recordType: options.recordType,
            recordId: before.id,
            action: 'DELETED',
            before: options.snapshot(before),
            after: null,
          });
        },
      });
    } catch (error: unknown) {
      if (isForeignKeyConstraintError(error)) {
        throw recordInUseError(options.inUseMessage);
      }
      throw error;
    }
  }

  private getCatalogHistory(
    recordType: HistoryRecordType,
    id: number,
    query: Partial<Pick<PageQueryDto, 'page' | 'pageSize'>>,
    recordExists: (recordId: number) => Promise<boolean>,
  ): Promise<PageResult<ChangeHistoryEntryView>> {
    const validId = validatePositiveInt4(id, 'id');
    const pagination = normalizePagination(query);
    return this.changeHistory.listRecordHistory(
      recordType,
      validId,
      pagination,
      recordExists,
    );
  }

  private async mapConstraintErrors<T>(
    work: () => Promise<T>,
    options: {
      readonly uniqueCode: ErrorCode;
      readonly uniqueMessage: string;
      readonly missingParentMessage: string;
      readonly inUseMessage?: string;
    },
  ): Promise<T> {
    try {
      return await work();
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          options.uniqueCode,
          options.uniqueMessage,
        );
      }
      if (options.inUseMessage && isRestrictViolationError(error)) {
        throw recordInUseError(options.inUseMessage);
      }
      if (isForeignKeyConstraintError(error)) {
        throw notFoundError(options.missingParentMessage);
      }
      throw error;
    }
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
      readonly assertMutable?: (row: NoInfer<Row>) => void;
      readonly execute: (
        tx: Prisma.TransactionClient,
        before: NoInfer<Row>,
        payload: NoInfer<Payload>,
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

function ensureInstitutionMutable(row: { readonly id: number }): void {
  if (isFixedInstitutionId(row.id)) {
    throw fixedRecordProtectedError(
      'The fixed operating institution cannot be modified or deleted',
    );
  }
}

function ensureFacultyMutable(row: { readonly id: number }): void {
  if (isFixedFacultyId(row.id)) {
    throw fixedRecordProtectedError(
      'The fixed operating faculty cannot be modified, reparented, or deleted',
    );
  }
}
