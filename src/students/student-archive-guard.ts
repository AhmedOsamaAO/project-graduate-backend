import { Injectable } from '@nestjs/common';
import type { Prisma, Student } from '../generated/prisma/client';
import { notFoundError, studentArchivedError } from './students.validation';

/**
 * Transaction-scoped guard contract registered by dependent modules
 * (for example, pending document deletion) to block archiving a student
 * without creating cyclic Nest provider dependencies.
 */
export interface StudentArchiveGuard {
  readonly name: string;
  assertCanArchive(
    tx: Prisma.TransactionClient,
    studentId: number,
  ): Promise<void>;
}

@Injectable()
export class StudentArchiveGuardRegistry {
  private readonly guards = new Map<string, StudentArchiveGuard>();

  register(guard: StudentArchiveGuard): () => void {
    if (this.guards.has(guard.name)) {
      throw new Error(
        `Student archive guard "${guard.name}" is already registered`,
      );
    }

    this.guards.set(guard.name, guard);
    return () => {
      if (this.guards.get(guard.name) === guard) {
        this.guards.delete(guard.name);
      }
    };
  }

  async assertCanArchive(
    tx: Prisma.TransactionClient,
    studentId: number,
  ): Promise<void> {
    for (const guard of this.guards.values()) {
      await guard.assertCanArchive(tx, studentId);
    }
  }
}

/**
 * Acquires a row-level share lock on the student inside the caller's
 * transaction and ensures the student exists and is not archived.
 */
export async function assertStudentActiveInTransaction(
  tx: Prisma.TransactionClient,
  studentId: number,
): Promise<Student> {
  await tx.$queryRaw`SELECT id FROM student WHERE id = ${studentId} FOR SHARE`;
  const student = await tx.student.findUnique({ where: { id: studentId } });
  if (!student) {
    throw notFoundError('Student not found');
  }
  if (student.archivedAt !== null) {
    throw studentArchivedError(
      'Archived student must be restored before making changes',
    );
  }
  return student;
}
