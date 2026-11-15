import type { PrismaClient } from '../generated/prisma/client';

/** Refuse privileged/misconfigured runtime connections rather than weakening history. */
export async function assertRuntimeRole(prisma: PrismaClient): Promise<void> {
  const [result] = await prisma.$queryRaw<Array<{ safe: boolean }>>`
    SELECT (
      NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
      AND NOT r.rolreplication AND NOT r.rolbypassrls
      AND pg_has_role(current_user, 'graduate_runtime', 'MEMBER')
      AND has_table_privilege(current_user, 'change_history', 'SELECT')
      AND has_table_privilege(current_user, 'change_history', 'INSERT')
      AND NOT has_table_privilege(current_user, 'change_history', 'UPDATE')
      AND NOT has_table_privilege(current_user, 'change_history', 'DELETE')
      AND NOT has_table_privilege(current_user, 'change_history', 'TRUNCATE')
      AND NOT has_schema_privilege(current_user, 'public', 'CREATE')
      AND NOT EXISTS (
        SELECT 1 FROM pg_roles p
        WHERE pg_has_role(current_user, p.oid, 'MEMBER') AND (
          p.rolname NOT IN (current_user, 'graduate_runtime')
          OR
          p.rolsuper OR p.rolcreaterole OR p.rolcreatedb OR p.rolreplication OR p.rolbypassrls
          OR p.oid = (SELECT relowner FROM pg_class WHERE oid = 'change_history'::regclass)
          OR p.oid = (SELECT datdba FROM pg_database WHERE datname = current_database())
          OR p.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'public')
        )
      )
    ) AS safe FROM pg_roles r WHERE r.rolname = current_user
  `;
  if (!result?.safe)
    throw new Error('Runtime database role does not protect change history');
}
